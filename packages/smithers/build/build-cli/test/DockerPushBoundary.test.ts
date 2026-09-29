import * as Stamp from "@smthrs/targets/Stamp"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import type * as HostProbes from "../src/internal/HostProbes.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"

const directories: Array<string> = []
const installedDocker = PackageTree.findOnPath("docker")
let planningPath: string
beforeAll(async () => {
  planningPath = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-host-"))
  directories.push(planningPath)
  await Fs.writeFile(Path.join(planningPath, "docker"), "#!/bin/sh\nexit 97\n", { mode: 0o755 })
})
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

// Host availability is the only modeled boundary. Planning and tag rendering
// stay real; actual Docker parsing below never receives a reachable daemon.
const healthyProbes: HostProbes.HostProbes = {
  once: async <A>(key: ReadonlyArray<unknown>): Promise<A> => {
    expect([["--version"], ["info", "--format", "{{.ServerVersion}}"], ["buildx", "ls"]]).toContainEqual(key[2])
    return { exitCode: 0, output: "fixture engine" } as A
  }
}
const plan = (tags: ReadonlyArray<unknown>) =>
  DockerExec.plan({
    rule: "Docker.Push",
    packagePath: "images",
    attrs: { registry: "127.0.0.1:1", name: "fixture", tags } as never,
    environment: { PATH: planningPath },
    probes: healthyProbes
  })

describe("Docker push public boundary", () => {
  it("defers real public stamps until execution", async () => {
    for (const stamp of [Stamp.commit, Stamp.buildTime, Stamp.versionMeta]) {
      const planned = await plan([stamp])
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.[0]?.at(-1)).toContain("{smthrs:stamp:")
    }
  })
  for (const tag of [" ", "bad:tag", "bad/tag", ".bad", "a".repeat(129), "one\n", "one\r\n"]) {
    it(`refuses invalid literal Docker tag ${JSON.stringify(tag)}`, async () => {
      const planned = await plan([tag])
      expect.soft(planned.refusal).toBeTruthy()
      expect(planned.commands).toBeUndefined()
    })
  }
  for (const tag of ["a", "_", "A-0._", "a".repeat(128)]) {
    it(`accepts valid Docker tag boundary ${JSON.stringify(tag)}`, async () => {
      const planned = await plan([tag])
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.[0]?.at(-1)).toBe(`127.0.0.1:1/fixture:${tag}`)
    })
  }
  it("keeps one image argument per command in declaration order", async () => {
    for (const tags of [["latest"], ["two", "one", "two"]]) {
      const planned = await plan(tags)
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.map((command) => command.slice(1))).toEqual(
        tags.map((tag) => ["push", `127.0.0.1:1/fixture:${tag}`])
      )
      expect(planned.argv).toEqual(planned.commands?.[0])
      expect(planned.outDirs).toEqual([])
    }
  })

  const refusedTags: ReadonlyArray<ReadonlyArray<unknown>> = [[], [{ unresolved: true }], [""], ["one", ""], [
    "",
    "one"
  ]]
  for (const tags of refusedTags) {
    it(`refuses all commands for unresolved or empty tags ${JSON.stringify(tags)}`, async () => {
      const planned = await plan(tags)
      expect.soft(planned.refusal).toBeTruthy()
      if (tags.includes("")) expect.soft(planned.refusal).toBe("Docker.Push requires a non-empty value for every tag")
      expect.soft(planned.argv).toBeUndefined()
      expect(planned.commands).toBeUndefined()
    })
  }

  it.skipIf(installedDocker === undefined)(
    "passes every image through installed Docker parsing without contacting a registry",
    async () => {
      const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-parser-"))
      directories.push(directory)
      const planned = await plan(["one", "two"])
      expect(planned.commands).toHaveLength(2)
      for (const command of planned.commands!) {
        const result = spawnSync(installedDocker!, command.slice(1), {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, DOCKER_HOST: `unix://${Path.join(directory, "missing.sock")}`, DOCKER_CONTEXT: "" }
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(`${result.stdout}${result.stderr}`).toContain("missing.sock")
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/requires exactly|invalid reference format/)
      }
    }
  )

  for (const args of [["//:dockerPush", "--plan"], ["//:dockerPush"]]) {
    it(`refuses approval through the public CLI ${args.join(" ")}`, async () => {
      const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-approval-"))
      directories.push(root)
      await Fs.cp(Path.join(import.meta.dirname, "fixtures/chain-exec"), root, { recursive: true })
      const packageFile = Path.join(root, "PACKAGE.ts")
      const source = await Fs.readFile(packageFile, "utf8")
      const secretDeclaration =
        "secrets: [S.HttpSecret(S.Secret(\"CHAIN_DOCKER_TOKEN\"), [\"https://registry-1.docker.io\"])],"
      expect(source).toContain(secretDeclaration)
      expect(source).toContain("tags: [\"latest\"]")
      await Fs.writeFile(
        packageFile,
        source
          .replace("tags: [\"latest\"]", "tags: [\"two\", \"one\"]")
          .replace(
            "secrets: [S.HttpSecret(S.Secret(\"CHAIN_DOCKER_TOKEN\"), [\"https://registry-1.docker.io\"])],",
            "secrets: [],"
          )
      )
      const bin = Path.join(root, "controlled-bin")
      await Fs.mkdir(bin)
      const calls = Path.join(root, "docker-calls.txt")
      await Fs.writeFile(
        Path.join(bin, "docker"),
        `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
--version|info|buildx) echo 'fixture engine';;
*) exit 97;;
esac
`,
        { mode: 0o755 }
      )
      const result = await serve(root, args, {
        environment: { ...process.env, PATH: `${bin}${Path.delimiter}${process.env["PATH"] ?? ""}` }
      })
      expect(`${result.output}${result.logs}`).toContain("approval required")
      expect(result.exitCode).toBe(args.includes("--plan") ? 0 : 1)
      // A successful inert plan is not approval or successful execution.
      if (args.includes("--plan")) {
        expect(result.output).toContain("registry.example.invalid/fixture:two")
        expect(result.output).toContain("registry.example.invalid/fixture:one")
        expect(result.output).toContain("commands")
      }
      expect(`${result.output}${result.logs}`).not.toContain("docker daemon did not answer")
      const observed = await Fs.readFile(calls, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      expect(observed.split("\n").filter((line) => line.startsWith("push"))).toEqual([])
      expect(observed.split("\n")).toEqual(expect.arrayContaining([
        "--version",
        "info --format {{.ServerVersion}}",
        "buildx ls"
      ]))
    })
  }
})
