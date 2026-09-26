import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

interface Observation {
  readonly tool: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly profile: string | null
}

const dockerTargets = 5
const anvilTargets = 2
const forgeTargets = 2

/**
 * Every Docker target needs the same three host facts (`docker --version`,
 * `docker info`, `docker buildx ls`), every Anvil fork the same `anvil
 * --version`, and every Foundry target the same forge identity. One plan
 * invocation must measure each fact once and share it across targets; the
 * project-specific `forge config` query stays keyed by cwd, config and
 * profile, so two targets of one project share it and a distinct profile
 * does not.
 */
it.skipIf(process.platform === "win32")(
  "shares Docker, Anvil and Foundry host probes across every target of one plan",
  async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-host-probe-sharing-")))
    const savedPath = process.env["PATH"]
    const trace = Path.join(root, "probe.jsonl")
    const binDir = Path.join(root, "bin")
    const write = async (relative: string, contents: string, mode?: number): Promise<void> => {
      const path = Path.join(root, relative)
      await Fs.mkdir(Path.dirname(path), { recursive: true })
      await Fs.writeFile(path, contents, mode === undefined ? {} : { mode })
    }
    const record = (tool: string): string =>
      `node -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({ tool: ${
        JSON.stringify(tool)
      }, args: process.argv.slice(2), cwd: process.cwd(), profile: process.env.FOUNDRY_PROFILE ?? null }) + "\\n")' ${
        JSON.stringify(trace)
      } "$@"\n`
    try {
      await write("package.json", "{\"name\":\"owned-host-probe-sharing\",\"private\":true,\"type\":\"module\"}\n")
      await write("foundry.toml", "[profile.default]\nsrc = \"src\"\n")
      await write("Dockerfile", "FROM scratch\n")
      await write(
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
const foundry = S.Foundry.Toolchain({ config: S.file("//foundry.toml") })
export const Workspace = S.Workspace("owned-host-probe-sharing", {
  repository: "git+https://example.invalid/owned-host-probe-sharing.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  toolchains: [foundry],
  host: S.Host({ bins: ["docker", "anvil", "forge"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`
      )
      const targets = [
        ...Array.from(
          { length: dockerTargets },
          (_, i) =>
            `docker${i}: S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", buildArgs: { N: ${i} } })`
        ),
        ...Array.from({ length: anvilTargets }, (_, i) => `anvil${i}: anvil${i}`),
        ...Array.from(
          { length: forgeTargets },
          (_, i) => `forge${i}: S.Foundry.Build({ outDirs: ["out${i}"] })`
        ),
        `forgeProfiled: S.Foundry.Build({ outDirs: ["out-profiled"], profile: "ci" })`
      ]

      await write(
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const anvil0 = S.Anvil.Fork({ forkUrl: S.Secret("FORK_URL"), forkBlockNumber: "latest", port: 8545 })
const anvil1 = S.Anvil.Fork({ forkUrl: S.Secret("FORK_URL"), forkBlockNumber: "latest", port: 8546 })
export const Package = S.Package({ targets: {\n${targets.join(",\n")}\n} })\n`
      )
      await write(
        "bin/docker",
        `#!/bin/sh\n${record("docker")}case "$1" in\n` +
          `  --version) echo 'Docker version 27.0.0' ;;\n` +
          `  info) echo '27.0.0' ;;\n` +
          `  buildx) printf '%s\\n' 'NAME/NODE DRIVER/ENDPOINT STATUS' 'shared   docker-container' ;;\n` +
          `  *) exit 97 ;;\nesac\n`,
        0o755
      )
      await write("bin/anvil", `#!/bin/sh\n${record("anvil")}echo 'anvil 1.0.0'\n`, 0o755)
      await write(
        "bin/forge",
        `#!/bin/sh\n${record("forge")}case "$1" in\n` +
          `  --version) echo 'forge Version: 1.0.0' ;;\n` +
          `  config) echo '{"out":"out","cache_path":"cache","cache":true}' ;;\n` +
          `  *) exit 97 ;;\nesac\n`,
        0o755
      )
      process.env["PATH"] = [binDir, Path.dirname(process.execPath), savedPath ?? ""].join(Path.delimiter)
      const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
      const index = PackageIndex.make(loaded)
      // Anvil forks are services (`run` kind), so they plan under their own
      // verb; each plan is one invocation with its own probe cache.
      for (const verb of ["build", "run"] as const) {
        const plan = await PackageExec.plan({ index, patterns: ["//..."], cacheDirectory: ".flows", verb })
        const expected = targets.map((entry) => `//:${entry.split(":")[0]}`).filter((label) =>
          label.startsWith("//:anvil") === (verb === "run")
        )
        for (const label of expected) {
          const node = plan.nodes.get(label)
          expect(node, label).toBeDefined()
          expect(node?.refusal, label).toBeUndefined()
        }
      }
      const observed = (await Fs.readFile(trace, "utf8")).trim().split("\n").map((line) =>
        JSON.parse(line) as Observation
      )
      const calls = (tool: string): ReadonlyArray<string> =>
        observed.filter((entry) => entry.tool === tool).map((entry) => entry.args.join(" ")).sort()
      expect(calls("docker")).toEqual(["--version", "buildx ls", "info --format {{.ServerVersion}}"])
      expect(calls("anvil")).toEqual(["--version"])
      // One identity probe for forge; `forge config` once per (cwd, config,
      // profile): the two default-profile builds share it, the `ci` profile
      // asks its own.
      expect(calls("forge")).toEqual([
        "--version",
        "config --json --config-path foundry.toml",
        "config --json --config-path foundry.toml"
      ])
      expect(
        observed.filter((entry) => entry.tool === "forge" && entry.args[0] === "config").map((entry) => entry.profile)
          .sort()
      ).toEqual(["ci", null].sort())
    } finally {
      if (savedPath === undefined) delete process.env["PATH"]
      else process.env["PATH"] = savedPath
      await Fs.rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
