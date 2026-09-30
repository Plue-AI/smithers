/**
 * Docker planning through a scripted `docker` executable on PATH: an absent
 * CLI, a silent daemon and every malformed declaration become typed refusals
 * before anything spawns, and the resolved argv carries each option once.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

/**
 * A `docker` stand-in: `info` exits with `infoExit` after printing
 * `infoOutput`, `buildx ls` prints `builders`, and every call is logged.
 */
const host = async (options: {
  readonly infoExit?: number
  readonly infoOutput?: string
  readonly builders?: string
} = {}) => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-docker-exec-")))
  roots.push(root)
  const bin = NodePath.join(root, "bin")
  const log = NodePath.join(root, "calls.log")
  await Fs.mkdir(bin)
  await Fs.writeFile(NodePath.join(root, "builders"), options.builders ?? "")
  await Fs.writeFile(
    NodePath.join(bin, "docker"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(log)}`,
      "case \"$1\" in",
      "  --version) echo 'Docker version 27.0.0' ;;",
      `  info) printf '%s' ${JSON.stringify(options.infoOutput ?? "27.0.0")}; exit ${options.infoExit ?? 0} ;;`,
      `  buildx) cat ${JSON.stringify(NodePath.join(root, "builders"))} ;;`,
      "esac",
      ""
    ].join("\n"),
    { mode: 0o755 }
  )
  const environment = { PATH: `${bin}:/usr/bin:/bin`, HOME: root }
  return {
    root,
    path: NodePath.join(bin, "docker"),
    environment,
    calls: async () => (await Fs.readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")
  }
}

const buildAttrs = (fields: Record<string, unknown> = {}) =>
  ({ dockerfile: { path: "Dockerfile" }, context: ".", ...fields }) as never

const pushAttrs = (tags: ReadonlyArray<unknown>) => ({ registry: "registry.test", name: "app", tags }) as never

const serveAttrs = (fields: Record<string, unknown> = {}) =>
  ({ image: "redis", readiness: { exec: ["true"], timeout: "5s" }, ...fields }) as never

describe.skipIf(process.platform === "win32")("Docker resolution failures", () => {
  it("refuses every plan and service when docker is not on PATH", async () => {
    const empty = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-docker-none-"))
    roots.push(empty)
    const environment = { PATH: empty }
    const refusal = "host binary \"docker\" is not present on PATH"
    expect(await DockerExec.resolveDocker(environment)).toEqual({
      ok: false,
      refusal,
      identity: { tag: "Docker", absent: true }
    })
    for (const rule of ["Docker.Build", "Docker.Bake", "Docker.Push"] as const) {
      expect(
        await DockerExec.plan({ rule, packagePath: "app", attrs: buildAttrs(), environment })
      ).toEqual({ outDirs: [], toolchain: { tag: "Docker", absent: true }, refusal })
    }
    expect(
      await DockerExec.serviceSpec({ invocationId: "i", label: "//:db", cwd: empty, attrs: serveAttrs(), environment })
    ).toEqual({ error: refusal })
  })

  it.each([
    [
      "its output",
      { infoExit: 1, infoOutput: "  Cannot connect to the Docker daemon  " },
      "Cannot connect to the Docker daemon"
    ],
    ["its exit code when silent", { infoExit: 125, infoOutput: "" }, "exit 125"]
  ])("refuses a daemon that does not answer with %s and skips the builder probe", async (_name, options, detail) => {
    const docker = await host(options)
    const tool = await DockerExec.resolveDocker(docker.environment)
    expect(tool).toMatchObject({
      ok: false,
      refusal: `docker daemon did not answer "docker info": ${detail}`,
      identity: { tag: "Docker", path: docker.path, builder: null, daemon: { exitCode: options.infoExit } }
    })
    expect(await docker.calls()).toEqual(["--version", "info --format {{.ServerVersion}}"])
    const planned = await DockerExec.plan({
      rule: "Docker.Build",
      packagePath: "",
      attrs: buildAttrs(),
      environment: docker.environment
    })
    expect(planned.refusal).toBe(`docker daemon did not answer "docker info": ${detail}`)
    expect(planned.argv).toBeUndefined()
  })

  it("selects the current docker-container builder and shares probes across one invocation", async () => {
    const docker = await host({
      builders: "NAME/NODE DRIVER/ENDPOINT\ndefault docker\nsmithers* docker-container\n"
    })
    const probes = HostProbes.make()
    const first = await DockerExec.resolveDocker(docker.environment, probes)
    const second = await DockerExec.resolveDocker(docker.environment, probes)
    expect(first).toMatchObject({ ok: true, path: docker.path, builder: "smithers" })
    expect(second).toEqual(first)
    expect(await docker.calls()).toEqual(["--version", "info --format {{.ServerVersion}}", "buildx ls"])
  })
})

describe.skipIf(process.platform === "win32")("Docker plans", () => {
  it.each([
    ["no tags", [], "Docker.Push requires at least one tag"],
    ["a non-scalar tag", ["ok", { nested: true }], "Docker.Push tags must resolve to strings before execution"],
    ["an empty tag", [""], "Docker.Push requires a non-empty value for every tag"],
    ["a leading separator", ["-bad"], expect.stringMatching(/^Docker.Push tags must contain 1 to 128/)],
    ["an overlong tag", ["a".repeat(129)], expect.stringMatching(/^Docker.Push tags must contain 1 to 128/)]
  ])("refuses a push with %s before any command", async (_name, tags, refusal) => {
    const docker = await host()
    const planned = await DockerExec.plan({
      rule: "Docker.Push",
      packagePath: "app",
      attrs: pushAttrs(tags),
      environment: docker.environment
    })
    expect(planned).toMatchObject({ outDirs: [], refusal })
    expect(planned.commands).toBeUndefined()
  })

  it("plans one push per scalar tag and defers a stamp tag to execution", async () => {
    const docker = await host()
    const planned = await DockerExec.plan({
      rule: "Docker.Push",
      packagePath: "app",
      attrs: pushAttrs(["v1", 2, true, { _tag: "Stamp", name: "version" }]),
      environment: docker.environment
    })
    const stamp = `{smthrs:stamp:${
      Buffer.from(JSON.stringify({ name: "docker-tag", value: { _tag: "Stamp", name: "version" } })).toString(
        "base64url"
      )
    }}`
    expect(planned.refusal).toBeUndefined()
    expect(planned.commands).toEqual([
      [docker.path, "push", "registry.test/app:v1"],
      [docker.path, "push", "registry.test/app:2"],
      [docker.path, "push", "registry.test/app:true"],
      [docker.path, "push", `registry.test/app:${stamp}`]
    ])
    expect(planned.argv).toEqual(planned.commands![0])
  })

  it("refuses a build argument that is not a scalar and still names the output directory", async () => {
    const docker = await host()
    const planned = await DockerExec.plan({
      rule: "Docker.Build",
      packagePath: "app",
      attrs: buildAttrs({ buildArgs: { A: "1", B: ["list"] } }),
      environment: docker.environment
    })
    expect(planned).toMatchObject({
      outDirs: ["app/docker-image"],
      refusal: "Docker.Build buildArgs.B must resolve to a string before execution"
    })
  })

  it("renders a build with builder, platforms, sorted build arguments and the package context", async () => {
    const docker = await host({ builders: "ci docker-container\n" })
    const planned = await DockerExec.plan({
      rule: "Docker.Build",
      packagePath: "app",
      attrs: buildAttrs({
        dockerfile: { path: "docker/Dockerfile" },
        context: "src",
        platforms: ["linux/amd64", "linux/arm64"],
        buildArgs: { Z: false, A: 3, S: { _tag: "Stamp", name: "commit" } }
      }),
      environment: docker.environment
    })
    expect(planned.refusal).toBeUndefined()
    expect(planned.argv).toEqual([
      docker.path,
      "buildx",
      "build",
      "--builder",
      "ci",
      "--file",
      "app/docker/Dockerfile",
      "--platform",
      "linux/amd64,linux/arm64",
      "--build-arg",
      "A=3",
      "--build-arg",
      expect.stringMatching(/^S=\{smthrs:stamp:[A-Za-z0-9_-]+\}$/),
      "--build-arg",
      "Z=false",
      "--output",
      "type=oci,dest=app/docker-image/image.tar",
      "app/src"
    ])
  })

  it("builds the workspace root context as '.' without a builder or platforms", async () => {
    const docker = await host()
    const planned = await DockerExec.plan({
      rule: "Docker.Build",
      packagePath: "",
      attrs: buildAttrs({ platforms: [] }),
      environment: docker.environment
    })
    expect(planned.argv).toEqual([
      docker.path,
      "buildx",
      "build",
      "--file",
      "Dockerfile",
      "--output",
      "type=oci,dest=docker-image/image.tar",
      "."
    ])
  })

  it("renders a bake into a sanitized per-target output directory", async () => {
    const docker = await host({ builders: "ci docker-container\n" })
    const attrs = { config: { path: "docker-bake.hcl" }, target: "web/app:latest" } as never
    const planned = await DockerExec.plan({
      rule: "Docker.Bake",
      packagePath: "app",
      attrs,
      environment: docker.environment
    })
    expect(planned).toEqual({
      argv: [
        docker.path,
        "buildx",
        "bake",
        "--builder",
        "ci",
        "--file",
        "app/docker-bake.hcl",
        "--set",
        "web/app:latest.output=type=oci,dest=app/docker-image-web-app-latest/image.tar",
        "web/app:latest"
      ],
      outDirs: ["app/docker-image-web-app-latest"],
      toolchain: expect.objectContaining({ tag: "Docker", builder: "ci" })
    })
    const plain = await host()
    expect(
      (await DockerExec.plan({ rule: "Docker.Bake", packagePath: "", attrs, environment: plain.environment })).argv
    ).toEqual([
      plain.path,
      "buildx",
      "bake",
      "--file",
      "docker-bake.hcl",
      "--set",
      "web/app:latest.output=type=oci,dest=docker-image-web-app-latest/image.tar",
      "web/app:latest"
    ])
    await DockerExec.prepareOutputs(docker.root, planned.outDirs)
    expect((await Fs.stat(NodePath.join(docker.root, "app/docker-image-web-app-latest"))).isDirectory()).toBe(true)
  })
})

describe.skipIf(process.platform === "win32")("Docker service specs", () => {
  it("binds ports to loopback and orders ports, environment and volumes deterministically", async () => {
    const docker = await host()
    const spec = await DockerExec.serviceSpec({
      invocationId: "run-1",
      label: "//:db",
      cwd: docker.root,
      attrs: serveAttrs({
        tag: "7",
        ports: { "6380": 16380, "6379": 16379 },
        env: { Z: "z", A: "a" },
        volumes: { data: "/data", cache: "/cache" },
        command: ["redis-server", "--save", ""],
        init: [["redis-cli", "ping"]],
        stop: { signal: "SIGTERM", grace: "1s" }
      }),
      environment: docker.environment
    })
    expect(spec).toEqual({
      key: "//:db",
      cwd: docker.root,
      docker: DockerExec.containerName("//:db", docker.root, "run-1"),
      argv: [
        docker.path,
        "-p",
        "127.0.0.1:16379:6379",
        "-p",
        "127.0.0.1:16380:6380",
        "-e",
        "A=a",
        "-e",
        "Z=z",
        "-v",
        "cache:/cache",
        "-v",
        "data:/data",
        "redis:7",
        "redis-server",
        "--save",
        ""
      ],
      readiness: { exec: ["true"], timeout: "5s" },
      health: undefined,
      stop: { signal: "SIGTERM", grace: "1s" },
      init: [["redis-cli", "ping"]]
    })
  })

  it("keeps a bare image and names containers per directory, label and invocation", async () => {
    const docker = await host()
    const spec = await DockerExec.serviceSpec({
      invocationId: "run-1",
      label: "//:db",
      cwd: docker.root,
      attrs: serveAttrs(),
      environment: docker.environment
    })
    expect(spec).toMatchObject({ argv: [docker.path, "redis"], init: [] })
    const name = DockerExec.containerName("//:db", docker.root, "run-1")
    expect(name).toMatch(/^smthrs-[0-9a-f]{32}$/)
    expect(DockerExec.containerName("//:db", docker.root, "run-2")).not.toBe(name)
    expect(DockerExec.containerName("//:other", docker.root, "run-1")).not.toBe(name)
    expect(DockerExec.containerName("//:db", NodePath.join(docker.root, "x", ".."), "run-1")).toBe(name)
  })
})
