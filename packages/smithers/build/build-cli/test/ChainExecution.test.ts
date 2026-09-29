import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AnvilExec from "../src/AnvilExec.ts"
import * as DockerExec from "../src/DockerExec.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { dockerAvailable } from "./helpers/DockerProbe.ts"
import { serve } from "./helpers/ServeCli.ts"

const fixture = NodePath.resolve(import.meta.dirname, "fixtures/chain-exec")
const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

/**
 * Runs `body` with every PATH directory holding `binary` removed.
 *
 * A case that asserts a host-binary refusal has to ARRANGE the absence. The
 * Mise case below inherited it from whatever PATH the suite happened to run
 * with, so it asserted a refusal a developer machine with mise installed never
 * produces: on this macOS host the plan resolved
 * `argv[2]: /opt/homebrew/bin/mise,"--version"` and the case failed. Every PATH
 * directory that holds the binary is removed, not just its own entry, so a
 * fixture needing another host tool from the same directory would break; this
 * one declares a mise tool alone.
 */
const withoutOnPath = async <A>(binary: string, body: () => Promise<A>): Promise<A> => {
  const original = process.env["PATH"] ?? ""
  const holdsBinary = (directory: string): boolean =>
    directory !== "" &&
    [binary, `${binary}.exe`, `${binary}.cmd`].some((name) => existsSync(NodePath.join(directory, name)))
  process.env["PATH"] = original.split(NodePath.delimiter).filter((directory) => !holdsBinary(directory))
    .join(NodePath.delimiter)
  try {
    return await body()
  } finally {
    process.env["PATH"] = original
  }
}

/** What a stub `docker` answers the three probes `resolveDocker` makes with. */
interface StubEngine {
  /** What `docker info` prints, and the code it exits with. */
  readonly info?: { readonly output: string; readonly exitCode: number } | undefined
  /** The `docker-container` builder `buildx ls` lists, if it lists one. */
  readonly builder?: string | undefined
}

/**
 * Runs `body` with a stub `docker` first on PATH, and hands it the stub's path.
 *
 * `DockerExec` reaches its argv construction only through `resolveDocker`, so
 * a host without Docker reaches none of it: the spec cases below opened with
 * `if (!docker.ok) return` and therefore asserted nothing at all on
 * `macos-latest`, where no engine exists. The stub answers `--version`,
 * `docker info`, and `buildx ls`, and refuses everything else, so these cases
 * exercise the argv this module builds and never a daemon's behaviour. What a
 * real engine does with that argv is the suite above, which skips when no
 * engine answers.
 */
const withDockerStub = async <A>(engine: StubEngine, body: (dockerPath: string) => Promise<A>): Promise<A> => {
  const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docker-stub-"))
  temporaryDirectories.push(directory)
  const dockerPath = NodePath.join(directory, "docker")
  const builderLine = engine.builder === undefined ? "" : `${engine.builder}   docker-container`
  await Fs.writeFile(
    dockerPath,
    `#!/bin/sh
case "$1" in
  --version) echo 'Docker version 0.0.0-stub, build stub' ;;
  info) echo '${engine.info?.output ?? "0.0.0-stub"}'; exit ${engine.info?.exitCode ?? 0} ;;
  buildx) printf '%s\\n' 'NAME/NODE DRIVER/ENDPOINT STATUS' '${builderLine}' ;;
  *) echo "stub docker was asked for $*" >&2; exit 97 ;;
esac
`,
    { mode: 0o755 }
  )
  const original = process.env["PATH"] ?? ""
  process.env["PATH"] = `${directory}${NodePath.delimiter}${original}`
  try {
    return await body(dockerPath)
  } finally {
    process.env["PATH"] = original
  }
}

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-chain-exec-")))
  temporaryDirectories.push(root)
  await Fs.cp(fixture, root, { recursive: true })
  return root
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") return reject(new Error("no port"))
      server.close(() => resolve(address.port))
    })
    server.on("error", reject)
  })

const waitForPort = async (port: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`port ${port} did not open`)
}

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

/**
 * Whether the host has Foundry, looked up the way the exec boundary does.
 *
 * The fixture declares `forge` in `S.Host({ bins: ... })`, and the cases below
 * build, test, and format real Solidity, so a runner without Foundry turns the
 * tool's absence into red cases that say nothing about this package. The Docker
 * suite already skips for the same reason; this one asserted the toolchain's
 * presence implicitly.
 */
const hasForge = PackageTree.findOnPath("forge") !== undefined
if (!hasForge) {
  console.warn("Foundry package execution tests SKIPPED: no `forge` on PATH")
}

describe.skipIf(!hasForge)("Foundry package execution", { concurrent: false }, () => {
  it("builds and tests for real, caches both, and reports fmt drift", async () => {
    const root = await workspace()
    const built = await serve(root, ["//:foundryBuild"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//:foundryBuild  ran")
    expect(await Fs.stat(NodePath.join(root, "out"))).toBeDefined()

    await Fs.rm(NodePath.join(root, "out"), { recursive: true, force: true })
    const restored = await serve(root, ["//:foundryBuild"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//:foundryBuild  hit")
    expect(await Fs.stat(NodePath.join(root, "out"))).toBeDefined()

    const tested = await serve(root, ["//:foundryTest"])
    expect(tested.exitCode, tested.logs).toBe(0)
    expect(tested.logs).toContain("//:foundryTest  ran")
    const testedAgain = await serve(root, ["//:foundryTest"])
    expect(testedAgain.exitCode, testedAgain.logs).toBe(0)
    expect(testedAgain.logs).toContain("//:foundryTest  hit")

    const formatted = await serve(root, ["//:foundryFmt"])
    expect(formatted.exitCode, formatted.logs).toBe(0)
    await Fs.writeFile(
      NodePath.join(root, "src/Counter.sol"),
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Counter{uint x;}\n",
      "utf8"
    )
    const drift = await serve(root, ["//:foundryFmt"])
    expect(drift.exitCode).toBe(1)
    expect(drift.logs).toContain("forge fmt --check")
    expect(drift.logs).toContain("Diff in src/Counter.sol")
  }, 120_000)

  it("resolves an attrs-level Foundry config relative to a nested package", async () => {
    const root = await workspace()
    await Fs.mkdir(NodePath.join(root, "contracts/src"), { recursive: true })
    await Fs.writeFile(
      NodePath.join(root, "contracts/PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const config = S.file("foundry.toml")
const srcs = S.Filegroup({ srcs: S.glob(["src/**", "foundry.toml"]) })
const artifacts = S.Foundry.Build({ config, data: [srcs], outDirs: ["out"], sandbox: { network: true } })
export const Package = S.Package({ targets: { artifacts, srcs } })
`,
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "contracts/foundry.toml"),
      "[profile.default]\nsrc = \"src\"\nout = \"out\"\nsolc = \"0.8.20\"\n",
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "contracts/src/Nested.sol"),
      "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20; contract Nested {}\n",
      "utf8"
    )

    const built = await serve(root, ["//contracts:artifacts"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//contracts:artifacts  ran")
    expect(await Fs.stat(NodePath.join(root, "contracts/out"))).toBeDefined()
  }, 120_000)
})

/**
 * Whether a container engine answers on this host, probed once at module load.
 *
 * `macos-latest` runners ship no Docker, so the cases below that build an OCI
 * archive, supervise a container, and plan a push against the real CLI cannot
 * run there. They asserted the daemon's presence implicitly and turned its
 * absence into three red cases reading `host binary "docker" is not present on
 * PATH`, which says nothing about this package. The probe is `docker info`
 * rather than a PATH lookup because `DockerExec.resolveDocker` refuses a CLI
 * whose daemon is silent too, so a host with the binary and no daemon has to
 * skip for the same reason.
 */
const engineAvailable = dockerAvailable()
if (!engineAvailable) {
  console.warn(
    "Docker package execution tests SKIPPED: no container engine answered `docker info` on this host"
  )
}

describe.skipIf(!engineAvailable)("Docker package execution", { concurrent: false }, () => {
  it("builds an OCI archive through CAS and restores it on a cache hit", async () => {
    const root = await workspace()
    const built = await serve(root, ["//:dockerBuild"])
    expect(built.exitCode, built.logs).toBe(0)
    expect(built.logs).toContain("//:dockerBuild  ran")
    expect(await Fs.stat(NodePath.join(root, "docker-image/image.tar"))).toBeDefined()

    const baked = await serve(root, ["//:dockerBake"])
    expect(baked.exitCode, baked.logs).toBe(0)
    expect(baked.logs).toContain("//:dockerBake  ran")
    expect(await Fs.stat(NodePath.join(root, "docker-image-fixture/image.tar"))).toBeDefined()
    const bakedAgain = await serve(root, ["//:dockerBake"])
    expect(bakedAgain.exitCode, bakedAgain.logs).toBe(0)
    expect(bakedAgain.logs).toContain("//:dockerBake  hit")
    await Fs.rm(NodePath.join(root, "docker-image"), { recursive: true, force: true })
    const restored = await serve(root, ["//:dockerBuild"])
    expect(restored.exitCode, restored.logs).toBe(0)
    expect(restored.logs).toContain("//:dockerBuild  hit")
    expect(await Fs.stat(NodePath.join(root, "docker-image/image.tar"))).toBeDefined()
  }, 120_000)

  it("acquires, exec-probes, initializes, and releases a Docker service", async () => {
    const root = await workspace()
    const docker = await DockerExec.resolveDocker()
    expect(docker.ok).toBe(true)
    if (docker.ok) {
      // Record the actual lifetime-owned names while forwarding every
      // command to the real engine. Recomputing an old deterministic name
      // would let the absence checks pass without observing either service.
      const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docker-record-"))
      temporaryDirectories.push(directory)
      const namesFile = NodePath.join(directory, "names")
      const idsFile = NodePath.join(directory, "ids")
      const cleanupFile = NodePath.join(directory, "cleanup")
      const literal = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      await Fs.writeFile(
        NodePath.join(directory, "docker"),
        `#!/bin/sh
if [ "$1" = create ]; then printf '%s\\n' "$4" >> ${literal(namesFile)}; fi
if [ "$1" = start ]; then printf '%s\\n' "$3" >> ${literal(idsFile)}; fi
if [ "$1" = rm ]; then
  printf 'rm %s\\n' "$3" >> ${literal(cleanupFile)}
  exec ${literal(docker.path)} "$@" 2>> ${literal(cleanupFile)}
fi
exec ${literal(docker.path)} "$@"
`,
        { mode: 0o755 }
      )
      const result = await serve(root, ["//:dockerConsumer"], {
        environment: {
          ...process.env,
          PATH: `${directory}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
        }
      })
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain("service //:dockerService: ready")
      expect(result.logs).toContain("service //:dockerServiceAlias: ready")
      const names = (await Fs.readFile(namesFile, "utf8")).trim().split("\n")
      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
      const ids = (await Fs.readFile(idsFile, "utf8")).trim().split("\n")
      const cleanup = await Fs.readFile(cleanupFile, "utf8")
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/)
      expect(cleanup.split("\n").filter((line) => line.startsWith("rm ")).map((line) => line.slice(3)).sort()).toEqual(
        [...ids].sort()
      )
      for (const name of names) {
        expect(name).toMatch(/^smthrs-[0-9a-f]{32}-[0-9a-f]{32}$/)
        const inspect = await new Promise<number>((resolve, reject) => {
          const child = spawn(docker.path, ["inspect", name], { stdio: "ignore" })
          child.on("error", reject)
          child.on("close", (code) => resolve(code ?? 1))
        })
        expect(inspect, `${name}\n${cleanup}`).not.toBe(0)
      }
    }
  }, 120_000)

  it("refuses an outward push before credentials or effects", async () => {
    const root = await workspace()
    const result = await serve(root, ["//:dockerPush", "--plan"])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("approval required")
    expect(result.output).not.toContain("NotImplemented")
  })
})

describe("Docker container identity", () => {
  it("keeps the name prefix stable within an invocation and distinct across commands and workspaces", () => {
    const first = NodePath.join(Os.tmpdir(), "smthrs-docker-first")
    const second = NodePath.join(Os.tmpdir(), "smthrs-docker-second")
    const name = DockerExec.containerName("//:service", first, "invocation-a")
    expect(name).toMatch(/^smthrs-[0-9a-f]{32}$/)
    expect(DockerExec.containerName("//:service", first, "invocation-b")).not.toBe(name)
    expect(DockerExec.containerName("//:service", NodePath.join(first, "."), "invocation-a")).toBe(name)
    expect(DockerExec.containerName("//:service", second, "invocation-a")).not.toBe(name)
    expect(DockerExec.containerName("//:other", first, "invocation-a")).not.toBe(name)
    expect(DockerExec.containerName("//:service", NodePath.relative(process.cwd(), first), "invocation-a")).toBe(name)
  })
})

describe("Docker service spec", () => {
  /**
   * An unqualified `-p host:container` publishes on 0.0.0.0, putting a
   * developer fixture or a CI container on the LAN and on anything sharing the
   * CI host's network. The rest of the local service machinery is already
   * loopback-only: the HTTP readiness probe targets 127.0.0.1.
   */
  it("publishes declared ports on loopback only", async () => {
    await withDockerStub({}, async () => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerPorts",
        cwd: process.cwd(),
        attrs: { image: "alpine", ports: { "5432": 15_432, "6379": 16_379 } } as never
      })
      if ("error" in spec) throw new Error(spec.error)
      const published = spec.argv.filter((entry, index) => spec.argv[index - 1] === "-p")
      expect(published).toEqual(["127.0.0.1:15432:5432", "127.0.0.1:16379:6379"])
    })
  })

  it("plans stable creation options and delegates container identity to the supervisor", async () => {
    await withDockerStub({}, async (docker) => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerService",
        cwd: process.cwd(),
        attrs: { image: "alpine", command: ["sleep", "60"] } as never
      })
      if ("error" in spec) throw new Error(spec.error)
      const name = DockerExec.containerName("//:dockerService", process.cwd(), "spec-test")
      expect(spec.docker).toBe(name)
      expect(spec.argv[0]).toBe(docker)
      expect(spec.argv.at(-3)).toBe("alpine")
      expect(spec.argv.slice(-2)).toEqual(["sleep", "60"])
      expect(spec.prepare).toBeUndefined()
      expect(spec.cleanup).toBeUndefined()
    })
  })

  it("orders env and volumes, tags the image, and declares container readiness and init commands", async () => {
    await withDockerStub({}, async (docker) => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerService",
        cwd: "/workspace",
        attrs: {
          image: "postgres",
          tag: "16",
          env: { PGUSER: "smithers", PGDATA: "/data" },
          volumes: { "/host/second": "/second", "/host/first": "/first" },
          readiness: { exec: ["pg_isready"], timeout: "60s" },
          init: [["psql", "-c", "select 1"]],
          health: { exec: ["pg_isready"], interval: "5s" },
          stop: { signal: "SIGTERM", grace: "3s" }
        } as never
      })
      if ("error" in spec) throw new Error(spec.error)
      const name = DockerExec.containerName("//:dockerService", "/workspace", "spec-test")
      // Both tables are emitted in key order, not declaration order, so one
      // table written two ways plans one argv.
      expect(spec.docker).toBe(name)
      expect(spec.argv[0]).toBe(docker)
      expect(spec.argv.slice(1)).toEqual([
        "-e",
        "PGDATA=/data",
        "-e",
        "PGUSER=smithers",
        "-v",
        "/host/first:/first",
        "-v",
        "/host/second:/second",
        "postgres:16"
      ])
      expect(spec.readiness).toEqual({ exec: ["pg_isready"], timeout: "60s" })
      expect(spec.init).toEqual([["psql", "-c", "select 1"]])
      expect(spec.health).toEqual({ exec: ["pg_isready"], interval: "5s" })
      expect(spec.stop).toEqual({ signal: "SIGTERM", grace: "3s" })
      expect(spec.cwd).toBe("/workspace")
    })
  })

  it("passes an HTTP readiness probe through without wrapping it in docker exec", async () => {
    await withDockerStub({}, async () => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerHttp",
        cwd: process.cwd(),
        attrs: { image: "nginx", readiness: { http: "http://127.0.0.1:8080/health", timeout: "30s" } } as never
      })
      if ("error" in spec) throw new Error(spec.error)
      expect(spec.readiness).toEqual({ http: "http://127.0.0.1:8080/health", timeout: "30s" })
      expect(spec.init).toEqual([])
    })
  })

  it("carries the resolver's refusal when the CLI is present and its daemon is not", async () => {
    const silent = { image: "alpine" } as never
    await withDockerStub({ info: { output: "Cannot connect to the Docker daemon", exitCode: 1 } }, async () => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerService",
        cwd: process.cwd(),
        attrs: silent
      })
      expect(spec).toEqual({
        error: "docker daemon did not answer \"docker info\": Cannot connect to the Docker daemon"
      })
    })
    // A daemon that says nothing at all still has to name why: the exit code
    // is the only fact left, and an empty refusal would read as no refusal.
    await withDockerStub({ info: { output: "", exitCode: 7 } }, async () => {
      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerService",
        cwd: process.cwd(),
        attrs: silent
      })
      expect(spec).toEqual({ error: "docker daemon did not answer \"docker info\": exit 7" })
    })
  })
})

describe("Docker build, bake, and push plans", () => {
  it("plans buildx against the resolved builder with platforms and ordered build args", async () => {
    await withDockerStub({ builder: "stub-builder" }, async (docker) => {
      const built = await DockerExec.plan({
        rule: "Docker.Build",
        packagePath: "apps/img",
        attrs: {
          dockerfile: { path: "Dockerfile" },
          context: ".",
          platforms: ["linux/amd64", "linux/arm64"],
          buildArgs: { RELEASE: true, ALPHA: "one", BUILD: 7 }
        } as never
      })
      expect(built.refusal).toBeUndefined()
      expect(built.outDirs).toEqual(["apps/img/docker-image"])
      expect(built.argv).toEqual([
        docker,
        "buildx",
        "build",
        "--builder",
        "stub-builder",
        "--file",
        "apps/img/Dockerfile",
        "--platform",
        "linux/amd64,linux/arm64",
        "--build-arg",
        "ALPHA=one",
        "--build-arg",
        "BUILD=7",
        "--build-arg",
        "RELEASE=true",
        "--output",
        "type=oci,dest=apps/img/docker-image/image.tar",
        "apps/img"
      ])

      const baked = await DockerExec.plan({
        rule: "Docker.Bake",
        packagePath: "apps/img",
        attrs: { config: { path: "docker-bake.hcl" }, target: "web/app" } as never
      })
      // The target names the output directory, so the one character a path
      // cannot carry is replaced rather than dropped.
      expect(baked.outDirs).toEqual(["apps/img/docker-image-web-app"])
      expect(baked.argv).toEqual([
        docker,
        "buildx",
        "bake",
        "--builder",
        "stub-builder",
        "--file",
        "apps/img/docker-bake.hcl",
        "--set",
        "web/app.output=type=oci,dest=apps/img/docker-image-web-app/image.tar",
        "web/app"
      ])
    })
  })

  it("omits the builder flag when buildx lists none, and creates the archive's parent", async () => {
    await withDockerStub({}, async (docker) => {
      const built = await DockerExec.plan({
        rule: "Docker.Build",
        packagePath: "",
        attrs: { dockerfile: { path: "Dockerfile" }, context: ".", platforms: [] } as never
      })
      expect(built.argv).toEqual([
        docker,
        "buildx",
        "build",
        "--file",
        "Dockerfile",
        "--output",
        "type=oci,dest=docker-image/image.tar",
        "."
      ])

      const baked = await DockerExec.plan({
        rule: "Docker.Bake",
        packagePath: "",
        attrs: { config: { path: "docker-bake.hcl" }, target: "fixture" } as never
      })
      expect(baked.argv).toEqual([
        docker,
        "buildx",
        "bake",
        "--file",
        "docker-bake.hcl",
        "--set",
        "fixture.output=type=oci,dest=docker-image-fixture/image.tar",
        "fixture"
      ])

      // `--output type=oci,dest=...` writes a file, so docker needs the
      // directory to exist before it runs.
      const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-docker-out-"))
      temporaryDirectories.push(root)
      await DockerExec.prepareOutputs(root, [...built.outDirs, ...baked.outDirs])
      expect(existsSync(NodePath.join(root, "docker-image"))).toBe(true)
      expect(existsSync(NodePath.join(root, "docker-image-fixture"))).toBe(true)
    })
  })

  it("defers a stamped build arg to execution and refuses one that never resolves", async () => {
    await withDockerStub({}, async () => {
      const stamped = await DockerExec.plan({
        rule: "Docker.Build",
        packagePath: "",
        attrs: {
          dockerfile: { path: "Dockerfile" },
          context: ".",
          buildArgs: { VERSION: { _tag: "Stamp", name: "git-sha" } }
        } as never
      })
      const argument = stamped.argv?.[stamped.argv.indexOf("--build-arg") + 1] ?? ""
      expect(argument.startsWith("VERSION={smthrs:stamp:")).toBe(true)
      const encoded = argument.slice("VERSION={smthrs:stamp:".length, -1)
      expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({
        name: "docker-tag",
        value: { _tag: "Stamp", name: "git-sha" }
      })

      const refused = await DockerExec.plan({
        rule: "Docker.Build",
        packagePath: "",
        attrs: {
          dockerfile: { path: "Dockerfile" },
          context: ".",
          buildArgs: { OPAQUE: { registry: "example.invalid" } }
        } as never
      })
      expect(refused.argv).toBeUndefined()
      expect(refused.refusal).toBe("Docker.Build buildArgs.OPAQUE must resolve to a string before execution")
    })
  })

  it("plans one Docker push command per tag and refuses a tag that never resolves", async () => {
    await withDockerStub({}, async (docker) => {
      const planned = await DockerExec.plan({
        rule: "Docker.Push",
        packagePath: "apps/img",
        attrs: { registry: "registry.example.invalid", name: "fixture", tags: ["latest", 7] } as never
      })
      expect(planned.outDirs).toEqual([])
      expect(planned.commands).toEqual([
        [docker, "push", "registry.example.invalid/fixture:latest"],
        [docker, "push", "registry.example.invalid/fixture:7"]
      ])
      const refused = await DockerExec.plan({
        rule: "Docker.Push",
        packagePath: "apps/img",
        attrs: { registry: "registry.example.invalid", name: "fixture", tags: [{ unresolved: true }] } as never
      })
      expect(refused.argv).toBeUndefined()
      expect(refused.refusal).toBe("Docker.Push tags must resolve to strings before execution")

      const empty = await DockerExec.plan({
        rule: "Docker.Push",
        packagePath: "apps/img",
        attrs: { registry: "registry.example.invalid", name: "fixture", tags: [] } as never
      })
      expect(empty.commands).toBeUndefined()
      expect(empty.refusal).toBe("Docker.Push requires at least one tag")
    })
  })

  it.skipIf(PackageTree.findOnPath("docker") === undefined)(
    "passes each planned push through Docker argument parsing",
    async () => {
      const docker = PackageTree.findOnPath("docker")!
      const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-2577-"))
      temporaryDirectories.push(directory)
      await withDockerStub({}, async () => {
        const planned = await DockerExec.plan({
          rule: "Docker.Push",
          packagePath: "apps/img",
          attrs: { registry: "127.0.0.1:1", name: "fixture", tags: ["one", "two"] } as never
        })
        expect(planned.commands).toHaveLength(2)
        for (const command of planned.commands ?? []) {
          const result = spawnSync(docker, command.slice(1), {
            encoding: "utf8",
            env: { ...process.env, DOCKER_HOST: `unix://${NodePath.join(directory, "missing.sock")}` }
          })
          expect(result.status).toBe(1)
          expect(`${result.stdout}${result.stderr}`).toContain("missing.sock")
        }
      })
    }
  )

  /**
   * The refusal `macos-latest` produces. Every entry point has to name the
   * absent binary rather than plan an argv around `undefined`, and the message
   * is the one the skipped suite above reported three times when it asserted a
   * daemon it never arranged.
   */
  it("names the absent binary in every entry point when docker is not on PATH", async () => {
    await withoutOnPath("docker", async () => {
      const absent = "host binary \"docker\" is not present on PATH"
      const tool = await DockerExec.resolveDocker()
      expect(tool).toEqual({ ok: false, refusal: absent, identity: { tag: "Docker", absent: true } })

      const built = await DockerExec.plan({
        rule: "Docker.Build",
        packagePath: "apps/img",
        attrs: { dockerfile: { path: "Dockerfile" }, context: "." } as never
      })
      expect(built.argv).toBeUndefined()
      expect(built.outDirs).toEqual([])
      expect(built.refusal).toBe(absent)

      const spec = await DockerExec.serviceSpec({
        invocationId: "spec-test",
        label: "//:dockerService",
        cwd: process.cwd(),
        attrs: { image: "alpine" } as never
      })
      expect(spec).toEqual({ error: absent })
    })
  })
})

/**
 * Whether the host has Anvil. `AnvilExec.serviceSpec` reaches its argv only
 * through `resolveAnvil`, so both cases below that assert on a spec need the
 * real binary; the Mise case arranges its own absence and needs none.
 */
const hasAnvil = PackageTree.findOnPath("anvil") !== undefined
if (!hasAnvil) {
  console.warn("Anvil boundary tests SKIPPED: no `anvil` on PATH")
}

describe("host refusals and Anvil secret boundaries", () => {
  it("plans a typed Mise refusal from the declared config when mise is absent", async () => {
    const root = await workspace()
    await Fs.writeFile(NodePath.join(root, "mise.toml"), "[tools]\nmockery = \"2.53.6\"\n", "utf8")
    await Fs.writeFile(
      NodePath.join(root, "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const mise = S.Mise({ config: S.file("//mise.toml") })
export const Workspace = S.Workspace("mise-fixture", {
  repository: "git+https://example.invalid/mise.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [mise]
})
`,
      "utf8"
    )
    await Fs.writeFile(
      NodePath.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const tool = S.Shell.Test({ bin: S.Mise.bin("mockery"), args: ["--version"] })
export const Package = S.Package({ targets: { tool } })
`,
      "utf8"
    )
    const result = await withoutOnPath(
      "mise",
      () => serve(root, ["//:tool", "--plan"], { environment: { ...process.env, PATH: "" } })
    )
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("host binary")
    expect(result.output).toContain("mise")
    expect(result.output).toContain("not present on PATH")
    expect(result.output).toContain("2.53.6")
  })

  it.skipIf(!hasAnvil)("keeps the RPC URL out of Anvil argv and resolves it only at egress", async () => {
    const port = await freePort()
    const secretUrl = "https://secret.example.invalid/rpc-token"
    process.env["CHAIN_TEST_RPC"] = secretUrl
    const result = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: process.cwd(),
      attrs: {
        forkUrl: { _tag: "Secret", env: "CHAIN_TEST_RPC" },
        forkBlockNumber: "latest",
        port
      }
    })
    delete process.env["CHAIN_TEST_RPC"]
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(JSON.stringify(result.argv)).not.toContain(secretUrl)
      expect(result.argv).toContain("{secret-url:CHAIN_TEST_RPC}")
      expect(result.secretUrls).toEqual([
        { index: 6, secret: { _tag: "Secret", env: "CHAIN_TEST_RPC" } }
      ])
    }
  })

  it.skipIf(!hasAnvil)("forks a local Anvil, readiness-gates a CLI consumer, and releases it", async () => {
    const tool = await AnvilExec.resolveAnvil()
    expect(tool.ok).toBe(true)
    if (!tool.ok) return
    const basePort = await freePort()
    const forkPort = await freePort()
    const base = spawn(tool.path, ["--silent", "--host", "127.0.0.1", "--port", String(basePort)], {
      stdio: "ignore"
    })
    try {
      await waitForPort(basePort)
      const root = await workspace()
      await Fs.writeFile(
        NodePath.join(root, "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"
const fork = S.Anvil.Fork({
  forkUrl: S.Secret("CHAIN_LOCAL_FORK_URL", { fallback: "http://127.0.0.1:${basePort}" }),
  forkBlockNumber: "latest",
  port: ${forkPort}
})
const consumer = S.Shell.Test({
  shell: ${
          JSON.stringify(
            `curl -fsS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:${forkPort} | grep -q '"result"'`
          )
        },
  services: [fork],
  sandbox: { network: true }
})
export const Package = S.Package({ targets: { consumer, fork } })
`,
        "utf8"
      )
      const result = await serve(root, ["//:consumer"])
      expect(result.exitCode, result.logs).toBe(0)
      expect(result.logs).toContain("service //:fork: ready")
      expect(await portOpen(forkPort)).toBe(false)
      const plan = await serve(root, ["//:consumer", "--plan"])
      expect(plan.output).toContain("cacheable: false")
    } finally {
      base.kill("SIGTERM")
    }
  }, 120_000)
})
