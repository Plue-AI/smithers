import { describe, expect, it } from "vitest"
import * as Anvil from "../src/Anvil.ts"
import * as Docker from "../src/Docker.ts"
import * as Foundry from "../src/Foundry.ts"
import * as Input from "../src/Input.ts"
import * as Mise from "../src/Mise.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { plannedCalls } from "./plan.ts"

describe("Mise and Foundry toolchain declarations", () => {
  const config = Input.file("//mise.toml")
  const mise = Mise.Mise({ config })

  it("constructs inert workspace entries and pinned tool references", () => {
    expect(mise).toEqual({ _tag: "Mise", config })
    expect(Mise.Mise.bin("mockery")).toEqual({ _tag: "MiseBin", name: "mockery" })
    expect(Foundry.Toolchain({ config: Input.file("//foundry.toml"), versions: mise })).toMatchObject({
      _tag: "FoundryToolchain",
      versions: mise
    })
  })

  it("supports a toolchains-only workspace and keeps Node declarations optional as one set", () => {
    const workspace = WorkspaceDeclaration.Workspace("chain", {
      repository: "git+https://example.invalid/chain.git",
      cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
      toolchains: [mise]
    })
    expect(workspace.toolchains).toEqual([mise])
    expect(workspace.runtime).toBeUndefined()
    expect(() =>
      WorkspaceDeclaration.Workspace("bad", {
        repository: "git+https://example.invalid/bad.git",
        cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
        runtime: { _tag: "NodeRuntimeDeclaration", version: "22" } as never
      })
    ).toThrow(/declared together/)
  })

  it("rejects unknown declaration fields", () => {
    expect(() => Mise.Mise({ config, extra: true } as never)).toThrow(/unknown option/)
    expect(() => Foundry.Toolchain({ config, version: "1" } as never)).toThrow(/unknown option/)
  })

  it.each(
    [
      [() => Mise.Mise(null as never), "Mise options must be an object"],
      [() => Mise.Mise({ config: "mise.toml" } as never), "Mise config must be an S.file declaration"],
      [() => Foundry.Toolchain(null as never), "Foundry.Toolchain options must be an object"],
      [
        () => Foundry.Toolchain({ config: "foundry.toml" } as never),
        "Foundry.Toolchain config must be an S.file declaration"
      ],
      [
        () => Foundry.Toolchain({ config, versions: { _tag: "Other" } } as never),
        "Foundry.Toolchain versions must be an S.Mise declaration"
      ]
    ] as const
  )("rejects malformed toolchain input with TypeError: %s", (construct, message) => {
    expect(construct).toThrowError(new TypeError(message))
  })
})

describe("Foundry targets", () => {
  const srcs = Input.glob("src/**")

  it("constructs cacheable build and test rules with their declared edges and outputs", () => {
    const build = Foundry.Build({ data: [srcs], skip: ["test/**"], outDirs: ["out"] })
    const test = Foundry.Test({ data: [srcs], profile: "ci" })
    expect(Target.metadata(build)).toMatchObject({ target: "Foundry.Build", cacheable: true })
    expect(Target.metadata(build).outputs).toEqual({ cwd: ".", paths: ["out"] })
    expect(Target.metadata(build).inputs).toContainEqual(srcs)
    expect(Target.metadata(test)).toMatchObject({ target: "Foundry.Test", cacheable: true })
  })

  it("constructs forge fmt as a check/write rule and validates nested attrs strictly", () => {
    const fmt = Foundry.Fmt({ data: [srcs], changes: ["src/**"] })
    expect(Target.metadata(fmt)).toMatchObject({ target: "Foundry.Fmt", kinds: ["lint", "run"] })
    expect(() => Foundry.Build({ outDirs: ["out"], profile: "ci", typo: true } as never)).toThrow(
      /declaration.*invalid/s
    )
  })
})

describe("Anvil and Docker targets", () => {
  it("preserves an Anvil RPC fallback without reading the environment", () => {
    const url = Secret.Secret("CHAIN_RPC_URL", { fallback: "https://rpc.example.invalid" })
    const fork = Anvil.Fork({ forkUrl: url, forkBlockNumber: 1, port: 8545 })
    expect(url).toEqual({ _tag: "Secret", env: "CHAIN_RPC_URL", fallback: "https://rpc.example.invalid" })
    expect(Target.metadata(fork)).toMatchObject({ target: "Anvil.Fork", cacheable: false })
  })

  it("constructs Docker service, build, bake, and uncached push shapes", () => {
    const service = Docker.Serve({
      image: "postgres:17",
      ports: { 5432: 5432 },
      readiness: { exec: ["pg_isready"], timeout: "30s" },
      init: [["psql", "-c", "select 1"]]
    })
    const build = Docker.Build({ dockerfile: Input.file("//Dockerfile"), context: "//" })
    const bake = Docker.Bake({ config: Input.file("//docker-bake.hcl"), target: "api" })
    const push = Docker.Push({
      image: build,
      registry: "registry.example.invalid",
      name: "api",
      tags: ["latest"],
      approval: "required"
    })
    expect(() =>
      Docker.Push({
        image: build,
        registry: "registry.example.invalid",
        name: "api",
        tags: [],
        approval: "required"
      })
    ).toThrow(/tags/)
    expect(Target.metadata(service).target).toBe("Docker.Serve")
    expect(Target.metadata(build)).toMatchObject({ target: "Docker.Build", cacheable: true })
    // The declared output name carries a digest of the exact declaration, so a
    // package with two image builds never gives both the same path.
    expect(Target.metadata(build).outputs?.paths).toEqual([expect.stringMatching(/^docker-image-[0-9a-f]{12}$/)])
    expect(Target.metadata(bake).outputs?.paths).toEqual([
      expect.stringMatching(/^docker-image-api-[0-9a-f]{12}$/)
    ])
    const second = Docker.Build({ dockerfile: Input.file("//other/Dockerfile"), context: "//" })
    expect(Target.metadata(second).outputs?.paths).not.toEqual(Target.metadata(build).outputs?.paths)
    // Two bake targets whose slug is lossy-equal keep two output paths.
    expect(Docker.imageOutputPath("a-b", ["Docker.Bake", "x", "a/b"]))
      .not.toBe(Docker.imageOutputPath("a-b", ["Docker.Bake", "x", "a?b"]))
    // The label is parts, not a joined string, so no path can forge the
    // boundary between two of them.
    expect(Docker.imageOutputPath("api", ["Docker.Build", "a", "b/c"]))
      .not.toBe(Docker.imageOutputPath("api", ["Docker.Build", "a/b", "c"]))
    expect(Target.metadata(push)).toMatchObject({ target: "Docker.Push", cacheable: false })
    expect(plannedCalls(bake)[0]).toEqual({
      action: "smithers-build/not-implemented",
      payload: { target: "Docker.Bake" }
    })
    expect(plannedCalls(build)[0]).toEqual({
      action: "smithers-build/not-implemented",
      payload: { target: "Docker.Build" }
    })
    expect(plannedCalls(push)[0]).toEqual({
      action: "smithers-build/not-implemented",
      payload: { target: "Docker.Push" }
    })
  })

  it("gives two image builds two output paths when only the platforms or the build args differ", () => {
    const base = { dockerfile: Input.file("//Dockerfile"), context: "//" } as const
    const pathOf = (attrs: Parameters<typeof Docker.Build>[0]): string =>
      Target.metadata(Docker.Build(attrs)).outputs?.paths[0] ?? ""
    const plain = pathOf(base)
    const arm = pathOf({ ...base, platforms: ["linux/arm64"] })
    const amd = pathOf({ ...base, platforms: ["linux/amd64"] })
    const release = pathOf({ ...base, buildArgs: { profile: "release" } })
    const debug = pathOf({ ...base, buildArgs: { profile: "debug" } })
    expect(new Set([plain, arm, amd, release, debug]).size).toBe(5)
  })

  it("names one output for a build-arg table written in two key orders", () => {
    const base = { dockerfile: Input.file("//Dockerfile"), context: "//" } as const
    const pathOf = (attrs: Parameters<typeof Docker.Build>[0]): string =>
      Target.metadata(Docker.Build(attrs)).outputs?.paths[0] ?? ""
    expect(pathOf({ ...base, buildArgs: { a: "1", b: "2" } }))
      .toBe(pathOf({ ...base, buildArgs: { b: "2", a: "1" } }))
  })

  it("rejects unknown and malformed service attrs", () => {
    expect(() => Docker.Service({ image: "postgres", readiness: { exec: [], timeout: "1s" } } as never)).toThrow(
      /declaration.*invalid/s
    )
    expect(() => Docker.Build({ dockerfile: Input.file("Dockerfile"), context: ".", push: true } as never)).toThrow(
      /declaration.*invalid/s
    )
  })
})
