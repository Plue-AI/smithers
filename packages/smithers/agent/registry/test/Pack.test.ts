/**
 * A pack is a directory that ships flows, and the registry has to be able to
 * take two of them at once.
 *
 * Everything under the manifest is the real discovery pipeline: the same
 * `Discovery.scan`, the same `FlowDescriptor`, the same first-found merge the
 * single-source registry already performs. What is new is that a descriptor
 * now says which pack it came from, that a local pack shadows an installed one
 * by name rather than by scan order, and that a pack has a content address a
 * lock file can pin.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Flow } from "@smthrs/flow"
import { Node as PlanNode } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Pack from "../src/Pack.ts"
import * as Registry from "../src/Registry.ts"

import { type Node, virtualFileSystem } from "./support/VirtualFileSystem.ts"

const flowFile = (description: string, body: string): Node => ({
  kind: "file",
  contents: `---\ndescription: ${description}\n---\n\n${body}\n`
})

const manifestFile = (value: unknown): Node => ({ kind: "file", contents: JSON.stringify(value, null, 2) })

/**
 * One pack on disk: a manifest at the root and a `flows` directory holding one
 * entry directory per flow.
 */
const packTree = (options: {
  readonly dir: string
  readonly manifest: unknown
  readonly flows: Readonly<Record<string, string>>
}): Array<readonly [string, Node]> => {
  const names = Object.keys(options.flows)
  return [
    [options.dir, { kind: "directory", entries: ["pack.json", "flows"] }] as const,
    [`${options.dir}/pack.json`, manifestFile(options.manifest)] as const,
    [`${options.dir}/flows`, { kind: "directory", entries: names }] as const,
    ...names.flatMap((name) => [
      [`${options.dir}/flows/${name}`, { kind: "directory", entries: ["flow.mdx"] }] as const,
      [
        `${options.dir}/flows/${name}/flow.mdx`,
        flowFile(`Flow ${name} from ${options.dir}.`, options.flows[name]!)
      ] as const
    ])
  ]
}

const localManifest = {
  name: "acme/review",
  version: "1.2.0",
  flows: ["flows"]
}

const installedManifest = {
  name: "vendor/review",
  version: "0.4.1",
  flows: ["flows"]
}

// The in-memory pack trees use POSIX paths; real disk fixtures use NodePath.layer.
const tree = (entries: ReadonlyArray<readonly [string, Node]>): Map<string, Node> => new Map(entries)

const readPack = (nodes: Map<string, Node>, dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Pack.read(virtualFileSystem(nodes), path, dir)
    }).pipe(Effect.provide(NodePath.layerPosix))
  )

const readPackError = (nodes: Map<string, Node>, dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Effect.flip(Pack.read(virtualFileSystem(nodes), path, dir))
    }).pipe(Effect.provide(NodePath.layerPosix))
  )

const packSources = (pack: Pack.Installed) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Pack.sources(pack, path)
    }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layerPosix)
    )
  )

const packSourcesError = (pack: Pack.Installed, paths = NodePath.layerPosix) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Effect.flip(Pack.sources(pack, path))
    }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(paths)
    )
  )

const withRegistry = <A, E>(
  nodes: Map<string, Node>,
  packs: ReadonlyArray<Pack.Installed>,
  runtimeVersion: string,
  effect: (registry: Registry.Registry) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      const fs = virtualFileSystem(nodes)
      return yield* Effect.provide(
        Effect.flatMap(Registry.Registry, effect),
        Registry.layerFromPacks(packs, { runtimeVersion }).pipe(
          Layer.provide(Layer.succeed(Discovery.Discovery)(Discovery.make(fs, path))),
          Layer.provide(Layer.succeed(FileSystem.FileSystem)(fs)),
          Layer.provide(Layer.succeed(Path.Path)(path))
        )
      )
    }).pipe(Effect.provide(NodePath.layerPosix))
  )

const both = tree([
  ...packTree({ dir: "/local", manifest: localManifest, flows: { review: "Review it locally.", lint: "Lint it." } }),
  ...packTree({
    dir: "/installed",
    manifest: installedManifest,
    flows: { review: "Review it as the vendor does.", release: "Release it." }
  })
])

const installed = (
  dir: string,
  manifest: Record<string, unknown>,
  origin: Pack.Origin
): Pack.Installed => ({
  manifest: new Pack.Manifest(manifest as never),
  dir,
  origin
})

describe("Pack.read", () => {
  it("decodes a manifest and reports the pack root it was read from", async () => {
    const pack = await readPack(both, "/local")

    expect(pack.manifest.name).toBe("acme/review")
    expect(pack.manifest.version).toBe("1.2.0")
    expect(pack.manifest.flows).toEqual(["flows"])
    expect(pack.dir).toBe("/local")
  })

  it("fails invalid_pack when the manifest is absent", async () => {
    const error = await readPackError(tree([["/empty", { kind: "directory", entries: [] }]]), "/empty")

    expect(error).toMatchObject({ code: "invalid_pack" })
    expect(error.message).toContain("/empty/pack.json")
  })

  it("fails invalid_pack when the manifest is not valid JSON", async () => {
    const nodes = tree([
      ["/broken", { kind: "directory", entries: ["pack.json"] }],
      ["/broken/pack.json", { kind: "file", contents: "{ not json" }]
    ])

    expect(await readPackError(nodes, "/broken")).toMatchObject({ code: "invalid_pack" })
  })

  it("fails invalid_pack when the manifest omits a required field", async () => {
    const nodes = tree([
      ["/partial", { kind: "directory", entries: ["pack.json"] }],
      ["/partial/pack.json", manifestFile({ name: "acme/review" })]
    ])

    expect(await readPackError(nodes, "/partial")).toMatchObject({ code: "invalid_pack" })
  })

  it("fails invalid_pack when the JSON value is not an object", async () => {
    const nodes = tree([
      ["/array", { kind: "directory", entries: ["pack.json"] }],
      ["/array/pack.json", manifestFile([localManifest])]
    ])

    expect(await readPackError(nodes, "/array")).toMatchObject({
      code: "invalid_pack",
      path: "/array/pack.json"
    })
  })

  it("carries the pack-relative refinement on the public Manifest schema", () => {
    expect(
      Schema.decodeUnknownOption(Pack.Manifest)({
        ...localManifest,
        flows: ["../outside"]
      })
    ).toEqual(Option.none())
  })

  it.each(
    [
      ["flows", ".."],
      ["flows", "../../outside"],
      ["flows", "/absolute"],
      ["flows", "."],
      ["flows", "bad\0path"],
      ["skills", ".."],
      ["skills", "../../outside"],
      ["skills", "/absolute"],
      ["skills", "."],
      ["skills", "bad\0path"]
    ] as const
  )("refuses an unsafe %s entry %j", async (field, entry) => {
    const manifest = field === "flows"
      ? { ...localManifest, flows: [entry] }
      : { ...localManifest, skills: [entry] }
    const nodes = tree([
      ["/unsafe", { kind: "directory", entries: ["pack.json"] }],
      ["/unsafe/pack.json", manifestFile(manifest)]
    ])

    const error = await readPackError(nodes, "/unsafe")

    expect(error).toMatchObject({ code: "invalid_pack", path: "/unsafe/pack.json" })
    expect(error.message).toContain("/unsafe/pack.json")
    expect(error.message).toContain(JSON.stringify(entry))
  })

  it.each(["flows", "skills"] as const)("accepts a nested %s entry", async (field) => {
    const manifest = field === "flows"
      ? { ...localManifest, flows: ["a/b"] }
      : { ...localManifest, skills: ["a/b"] }
    const nodes = tree([
      ["/nested", { kind: "directory", entries: ["pack.json"] }],
      ["/nested/pack.json", manifestFile(manifest)]
    ])

    expect((await readPack(nodes, "/nested")).manifest[field]).toEqual(["a/b"])
  })

  it.each(["skill", "require"])(
    "warns about the unknown top-level key %j without refusing the manifest",
    async (key) => {
      const nodes = tree([
        ["/typo", { kind: "directory", entries: ["pack.json"] }],
        [
          "/typo/pack.json",
          manifestFile({
            ...localManifest,
            [key]: key === "skill" ? ["skills"] : { smithers: ">=1.0.0" }
          })
        ]
      ])

      const pack = await readPack(nodes, "/typo")

      expect(pack.manifest.name).toBe(localManifest.name)
      expect(pack.warnings).toEqual([
        expect.objectContaining({
          code: "unknown_pack_key",
          path: "/typo/pack.json",
          message: expect.stringContaining(key)
        })
      ])
    }
  )
})

describe("Pack.sources", () => {
  it("rechecks directly constructed installed values for lexical containment", async () => {
    const pack: Pack.Installed = {
      manifest: {
        ...new Pack.Manifest(localManifest),
        flows: ["../../outside"]
      } as Pack.Manifest,
      dir: "/pack",
      origin: "installed"
    }

    const error = await packSourcesError(pack)

    expect(error).toMatchObject({ code: "invalid_pack", path: "/pack/pack.json" })
    expect(error.message).toContain("../../outside")
  })

  it("refuses a resolved source that a path host places outside the resolved root", async () => {
    const basePath = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* Path.Path
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    const escapingPath: Path.Path = {
      ...basePath,
      resolve: (...segments) => segments.length === 1 ? basePath.resolve(...segments) : "/outside"
    }
    const error = await Effect.runPromise(
      Effect.flip(Pack.sources(installed("/pack", localManifest, "installed"), escapingPath)).pipe(
        Effect.provide(NodeFileSystem.layer)
      )
    )

    expect(error).toMatchObject({ code: "invalid_pack", path: "/pack/pack.json" })
    expect(error.message).toContain(JSON.stringify("flows"))
  })

  it("keeps benign nested flow and skill entries inside the pack root", async () => {
    const pack = installed(
      "/pack",
      { ...localManifest, flows: ["a/b"], skills: ["skills/review"] },
      "installed"
    )

    await expect(packSources(pack)).resolves.toEqual([
      { source: "pack:acme/review", root: "/pack/a/b", confinementRoot: "/pack", naming: "path" },
      { source: "pack:acme/review", root: "/pack/skills/review", confinementRoot: "/pack", naming: "path" }
    ])
  })

  it("refuses a source whose real path escapes through a symlink", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "smithers-registry-pack-"))
    const packDir = join(temporary, "pack")
    const outside = join(temporary, "outside")
    mkdirSync(packDir)
    mkdirSync(outside)
    symlinkSync(outside, join(packDir, "flows"), "dir")

    try {
      const error = await packSourcesError(installed(packDir, localManifest, "installed"), NodePath.layer)

      expect(error).toMatchObject({ code: "invalid_pack", path: join(packDir, "pack.json") })
      expect(error.message).toContain("flows")
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

describe("pack discovery confinement", () => {
  it.each(["pack", "project"] as const)(
    "preserves permitted directory and entry-file links for %s sources",
    async (kind) => {
      const temporary = mkdtempSync(join(tmpdir(), "smithers-registry-pack-"))
      const packDir = join(temporary, "pack")
      const alias = join(temporary, "alias")
      const resources = join(kind === "pack" ? packDir : temporary, "resources")
      mkdirSync(join(packDir, "flows", "linked-file"), { recursive: true })
      mkdirSync(resources, { recursive: true })
      writeFileSync(
        join(resources, "flow.mdx"),
        "---\ndescription: Permitted prompt\ncapabilities: []\n---\nINSIDE_BODY\n"
      )
      symlinkSync(packDir, alias, "dir")
      symlinkSync(resources, join(packDir, "flows", "linked-directory"), "dir")
      symlinkSync(join(resources, "flow.mdx"), join(packDir, "flows", "linked-file", "flow.mdx"), "file")
      const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
      try {
        const scan = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const sources = kind === "pack"
              ? yield* Pack.sources(installed(alias, localManifest, "installed"), path)
              : [{ source: "project", root: join(alias, "flows"), naming: "path" as const }]
            return yield* Discovery.make(fs, path).scan(sources[0]!)
          }).pipe(Effect.provide(platform))
        )
        expect(scan.entries.map((entry) => entry.name)).toEqual(["linked-directory", "linked-file"])
        expect(scan.warnings).toEqual([])
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    }
  )

  it("rechecks a source root redirected after Pack.sources", async () => {
    const nodes = tree(packTree({ dir: "/pack", manifest: localManifest, flows: { review: "Body" } }))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const fs = virtualFileSystem(nodes)
        const sources = yield* Pack.sources(installed("/pack", localManifest, "installed"), path).pipe(
          Effect.provideService(FileSystem.FileSystem, fs)
        )
        return yield* Discovery.make({
          ...fs,
          realPath: (location) => Effect.succeed(location === "/pack/flows" ? "/outside" : location),
          readDirectory: () => {
            throw new Error("Outside directory must not be read")
          }
        }, path).scan(sources[0]!)
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({ code: "outside_root", path: "/pack/flows" })])
  })

  it("refuses an entry whose real path fails once the confinement root resolves", async () => {
    const nodes = tree(packTree({ dir: "/pack", manifest: localManifest, flows: { review: "Body" } }))
    const reads: Array<string> = []
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const fs = virtualFileSystem(nodes, { readFile: reads })
        return yield* Discovery.make({
          ...fs,
          realPath: (location) =>
            location.endsWith("flow.mdx")
              ? Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "realPath",
                pathOrDescriptor: location
              }))
              : Effect.succeed(location)
        }, path).scan({ source: "confined", root: "/pack", confinementRoot: "/pack", naming: "path" })
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "outside_root", path: "/pack/flows/review/flow.mdx" })
    ])
    expect(reads).not.toContain("/pack/flows/review/flow.mdx")
  })

  it("refuses a descended directory whose real path fails once the confinement root resolves", async () => {
    const nodes = tree(packTree({ dir: "/pack", manifest: localManifest, flows: { review: "Body" } }))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        const fs = virtualFileSystem(nodes)
        return yield* Discovery.make({
          ...fs,
          realPath: (location) =>
            location === "/pack/flows/review"
              ? Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "realPath",
                pathOrDescriptor: location,
                description: "ELOOP"
              }))
              : Effect.succeed(location)
        }, path).scan({ source: "confined", root: "/pack", confinementRoot: "/pack", naming: "path" })
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({ code: "outside_root", path: "/pack/flows/review" })])
  })

  it("keeps lexical confinement on hosts that cannot resolve the confinement root", async () => {
    const nodes = tree(packTree({ dir: "/pack", manifest: localManifest, flows: { review: "Body" } }))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Discovery.make(virtualFileSystem(nodes), path).scan({
          source: "confined",
          root: "/pack",
          confinementRoot: "/pack",
          naming: "path"
        })
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(result.entries.map((entry) => entry.name)).toEqual(["flows/review"])
  })

  it.each(["NotFound", "Unknown", "PermissionDenied"] as const)(
    "Pack.sources accepts only a not-yet-created source when its realPath fails with %s under a resolved root",
    async (tag) => {
      const nodes = tree(packTree({ dir: "/pack", manifest: localManifest, flows: { review: "Body" } }))
      const outcome = await Effect.runPromise(
        Effect.gen(function*() {
          const path = yield* Path.Path
          const fs = virtualFileSystem(nodes)
          return yield* Pack.sources(installed("/pack", localManifest, "installed"), path).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              realPath: (location) =>
                location === "/pack"
                  ? Effect.succeed(location)
                  : Effect.fail(PlatformError.systemError({
                    _tag: tag,
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: location
                  }))
            }),
            Effect.result
          )
        }).pipe(Effect.provide(NodePath.layerPosix))
      )
      if (tag === "NotFound") {
        expect(outcome).toMatchObject({ _tag: "Success" })
      } else {
        expect(outcome).toMatchObject({ _tag: "Failure", failure: { code: "invalid_pack" } })
      }
    }
  )

  it.each(
    [
      ["directory", "flow.mdx"],
      ["directory", "SKILL.md"],
      ["directory", "flow.ts"],
      ["file", "flow.mdx"],
      ["file", "SKILL.md"],
      ["file", "flow.ts"]
    ] as const
  )("refuses an outside %s symlink to %s before loading or importing", async (kind, entry) => {
    const temporary = mkdtempSync(join(tmpdir(), "smithers-registry-pack-"))
    const packDir = join(temporary, "pack")
    // A shared prefix is not containment.
    const outside = join(temporary, "pack-outside")
    const escape = join(packDir, "flows", "escape")
    const marker = join(temporary, "imported")
    mkdirSync(join(packDir, "flows"), { recursive: true })
    mkdirSync(outside)
    writeFileSync(
      join(outside, entry),
      entry === "flow.ts"
        ? [
          "import { writeFileSync } from \"node:fs\"",
          `writeFileSync(${JSON.stringify(marker)}, "imported")`,
          "const Flow = { make: (value) => value }",
          "export default ({ description: \"Outside module\", capabilities: [] })"
        ].join("\n")
        : "---\ndescription: Outside prompt\n---\nOUTSIDE_PACK_BODY\n"
    )
    if (kind === "directory") {
      symlinkSync(outside, escape, "dir")
    } else {
      mkdirSync(escape)
      symlinkSync(join(outside, entry), join(escape, entry), "file")
    }
    const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
    const registryLayer = Registry.layerFromPacks([
      installed(packDir, localManifest, "installed")
    ], { runtimeVersion: "1.0.0" }).pipe(
      Layer.provide(Discovery.layer.pipe(Layer.provide(platform))),
      Layer.provide(platform)
    )

    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          return {
            entries: yield* registry.list(),
            body: yield* Effect.result(registry.loadBody("escape")),
            catalog: yield* Executable.catalog({
              delegates: [Flow.make("agent", {
                payload: Executable.Invocation,
                success: Schema.String,
                body: (payload) => PlanNode.succeed(payload.prompt)
              })]
            }),
            warnings: yield* registry.warnings()
          }
        }).pipe(Effect.provide(registryLayer), Effect.provide(platform))
      )

      expect.soft(result.entries).toEqual([])
      expect.soft(result.body).toMatchObject({ _tag: "Failure", failure: { code: "not_found" } })
      expect.soft(result.catalog).toEqual({ executables: [], refused: [] })
      expect.soft(existsSync(marker)).toBe(false)
      expect.soft(result.warnings).toEqual([
        expect.objectContaining({ code: "outside_root", path: kind === "directory" ? escape : join(escape, entry) })
      ])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})

describe("Pack.digest", () => {
  const files = [
    { path: "flows/review/flow.mdx", contents: "Review it." },
    { path: "flows/lint/flow.mdx", contents: "Lint it." }
  ]

  it("is stable across file order", () => {
    const manifest = new Pack.Manifest(localManifest)

    expect(Pack.digest(manifest, files)).toBe(Pack.digest(manifest, [...files].reverse()))
  })

  it("matches the lock-address golden vector", () => {
    const manifest = new Pack.Manifest({
      ...localManifest,
      skills: ["skills"],
      requires: { smithers: ">=1.0" }
    })

    expect(Pack.digest(manifest, [
      { path: "flows/review/flow.mdx", contents: "Review it.\n" },
      { path: "skills/triage/SKILL.md", contents: "Triage it.\n" }
    ])).toBe("edefafe12d85981fe9294aba74263441ded75f9f677e64d2e354ee84aa89a5f1")
  })

  it("is stable across every permutation of three files", () => {
    const manifest = new Pack.Manifest(localManifest)
    const measured = [
      { path: "flows/a/flow.mdx", contents: "A" },
      { path: "flows/b/flow.mdx", contents: "B" },
      { path: "flows/c/flow.mdx", contents: "C" }
    ]
    const permutations = [
      [measured[0]!, measured[1]!, measured[2]!],
      [measured[0]!, measured[2]!, measured[1]!],
      [measured[1]!, measured[0]!, measured[2]!],
      [measured[1]!, measured[2]!, measured[0]!],
      [measured[2]!, measured[0]!, measured[1]!],
      [measured[2]!, measured[1]!, measured[0]!]
    ]

    expect(new Set(permutations.map((items) => Pack.digest(manifest, items))).size).toBe(1)
  })

  it("orders duplicate paths by content digest so input order cannot change the address", () => {
    const manifest = new Pack.Manifest(localManifest)
    const left = { path: "flows/review/flow.mdx", contents: "A" }
    const right = { path: "flows/review/flow.mdx", contents: "B" }

    expect(Pack.digest(manifest, [left, right])).toBe(Pack.digest(manifest, [right, left]))
    expect(Pack.digest(manifest, [left, left])).not.toBe(Pack.digest(manifest, [left]))
  })

  it.each(["/absolute", "../outside", "flows/../outside", "flows//review", "flows\\review"])(
    "refuses the unsafe measured path %j",
    (path) => {
      expect(() => Pack.digest(new Pack.Manifest(localManifest), [{ path, contents: "body" }])).toThrow(
        JSON.stringify(path)
      )
    }
  )

  it("hashes non-ASCII paths and UTF-8 text deterministically", () => {
    const manifest = new Pack.Manifest(localManifest)

    expect(Pack.digest(manifest, [{ path: "flows/café/技能.mdx", contents: "Résumé 😀\n" }])).toBe(
      "7de8830426fe7149524e29db51acaa556f221cfe379eacd87db206d665729772"
    )
  })

  it("changes when a flow body changes", () => {
    const manifest = new Pack.Manifest(localManifest)
    const edited = [files[0]!, { path: "flows/lint/flow.mdx", contents: "Lint it harder." }]

    expect(Pack.digest(manifest, edited)).not.toBe(Pack.digest(manifest, files))
  })

  it("covers the optional manifest halves in the address", () => {
    const bare = new Pack.Manifest(localManifest)
    const full = new Pack.Manifest({
      ...localManifest,
      skills: ["skills"],
      requires: { smithers: ">=1.0.0" }
    })

    expect(Pack.digest(full, files)).not.toBe(Pack.digest(bare, files))
  })

  it("changes when the manifest version changes", () => {
    const manifest = new Pack.Manifest(localManifest)
    const bumped = new Pack.Manifest({ ...localManifest, version: "1.3.0" })

    expect(Pack.digest(bumped, files)).not.toBe(Pack.digest(manifest, files))
  })
})

describe("Pack.compatible", () => {
  it("accepts a runtime inside the declared range and refuses one below it", () => {
    expect(Pack.compatible(">=1.0.0", "1.2.3")).toBe(true)
    expect(Pack.compatible(">=1.0.0", "0.9.0")).toBe(false)
    expect(Pack.compatible("^1.2.0", "1.9.0")).toBe(true)
    expect(Pack.compatible("^1.2.0", "2.0.0")).toBe(false)
    expect(Pack.compatible("~1.2.0", "1.2.9")).toBe(true)
    expect(Pack.compatible("~1.2.0", "1.3.0")).toBe(false)
    expect(Pack.compatible("1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("1.2.3", "1.2.4")).toBe(false)
    expect(Pack.compatible(">=1.0.0 <2.0.0", "1.5.0")).toBe(true)
    expect(Pack.compatible(">=1.0.0 <2.0.0", "2.1.0")).toBe(false)
    expect(Pack.compatible("<=1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("<=1.2.3", "1.2.4")).toBe(false)
    expect(Pack.compatible(">1.2.3", "1.2.4")).toBe(true)
    expect(Pack.compatible(">1.2.3", "1.2.3")).toBe(false)
    expect(Pack.compatible("<1.2.3", "1.2.2")).toBe(true)
    expect(Pack.compatible("<1.2.3", "1.2.3")).toBe(false)
    expect(Pack.compatible("=1.2.3", "1.2.3")).toBe(true)
    expect(Pack.compatible("^1.2.0", "1.1.0")).toBe(false)
    expect(Pack.compatible("~1.2.3", "1.2.2")).toBe(false)
    expect(Pack.compatible("~1.2.0", "2.2.0")).toBe(false)
    expect(Pack.compatible("^0.9.0", "1.0.0")).toBe(false)
    expect(Pack.compatible("*", "3.0.0")).toBe(true)
    expect(Pack.compatible("1.2.3", "1.3.3")).toBe(false)
    expect(Pack.compatible("1.2.3", "2.2.3")).toBe(false)
  })

  it("reads a caret on a zero-major line as npm does: the minor is the pin", () => {
    // `^0.2.3` is `>=0.2.3 <0.3.0`. A pre-1.0 line has no compatibility
    // promise across minors, so a caret that only pinned the major would let a
    // pack written for 0.2 load against the rewritten 0.9.
    expect(Pack.compatible("^0.2.3", "0.2.9")).toBe(true)
    expect(Pack.compatible("^0.2.3", "0.9.0")).toBe(false)
    expect(Pack.compatible("^0.2.3", "0.3.0")).toBe(false)
    expect(Pack.compatible("^0.2.3", "0.2.2")).toBe(false)
    // `^0.0.3` is `>=0.0.3 <0.0.4`: on a zero-minor line every patch is a
    // breaking release.
    expect(Pack.compatible("^0.0.3", "0.0.3")).toBe(true)
    expect(Pack.compatible("^0.0.3", "0.0.4")).toBe(false)
  })

  it("refuses an empty range", () => {
    expect(Pack.compatible("   ", "1.0.0")).toBe(false)
  })

  it("refuses a range or a version it cannot parse rather than guessing", () => {
    expect(Pack.compatible("not-a-range", "1.0.0")).toBe(false)
    expect(Pack.compatible(">=1.0.0", "not-a-version")).toBe(false)
  })

  it("compares prerelease-tagged runtimes on their release numbers", () => {
    expect(Pack.compatible(">=1.0.0", "1.0.0-rc.3")).toBe(true)
  })
})

describe("Pack.checkCompatible", () => {
  const requiring = (range: string, dir = "/pack"): Pack.Installed =>
    installed(dir, { ...localManifest, requires: { smithers: range } }, "installed")

  const check = (pack: Pack.Installed, runtimeVersion: string) =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Pack.checkCompatible(pack, path, runtimeVersion)
    }).pipe(Effect.provide(NodePath.layerPosix))

  it.each([">= 1.0.0", ">=1.0", "^1", "1.0.0 - 2.0.0"])(
    "accepts the readable npm range %j",
    async (range) => {
      await expect(Effect.runPromise(check(requiring(range), "1.0.0-rc.0"))).resolves.toBeUndefined()
      expect(Pack.compatible(range, "1.0.0-rc.0")).toBe(true)
    }
  )

  it.each(["||", ""])("distinguishes the unreadable range %j", async (range) => {
    const error = await Effect.runPromise(Effect.flip(check(requiring(range), "1.0.0-rc.0")))

    expect(error).toMatchObject({ code: "unreadable_pack_range", path: "/pack/pack.json" })
    expect(error.message).toContain(JSON.stringify(range))
    expect(error.message).toContain("could not be parsed")
  })

  it("reserves incompatible_pack for a readable range the runtime does not satisfy", async () => {
    const error = await Effect.runPromise(
      Effect.flip(check(requiring(">=2.0.0"), "1.0.0-rc.0"))
    )

    expect(error).toMatchObject({ code: "incompatible_pack", path: "/pack/pack.json" })
  })

  it("names the manifest the way Pack.read does, through the same Path service", async () => {
    const dir = "/packs/./vendor"
    const [error, read] = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return [
          yield* Effect.flip(Pack.checkCompatible(requiring(">=2.0.0", dir), path, "1.0.0-rc.0")),
          path.join(dir, "pack.json")
        ] as const
      }).pipe(Effect.provide(NodePath.layerPosix))
    )

    expect(read).toBe("/packs/vendor/pack.json")
    expect(error.path).toBe(read)
  })
})

describe("Registry.layerFromPacks", () => {
  it("reads a manifest warning back through registry.warnings()", async () => {
    const nodes = tree([
      ...packTree({
        dir: "/typo",
        manifest: { ...localManifest, require: { smithers: ">=9.0.0" } },
        flows: { review: "Review it locally." }
      })
    ])
    const read = await readPack(nodes, "/typo")

    const warnings = await withRegistry(
      nodes,
      [{ ...read, origin: "local" }],
      "1.0.0",
      (registry) => registry.warnings()
    )

    expect(warnings).toContainEqual(expect.objectContaining({
      code: "unknown_pack_key",
      path: "/typo/pack.json",
      message: expect.stringContaining("require")
    }))
  })

  it("names the pack and version in every descriptor's provenance", async () => {
    const entries = await withRegistry(
      both,
      [installed("/installed", installedManifest, "installed")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["release", "review"])
    for (const entry of entries) {
      expect(entry.provenance.pack).toEqual({
        name: "vendor/review",
        version: "0.4.1",
        origin: "installed"
      })
    }
  })

  it("shadows an installed flow with the local one and warns naming both packs", async () => {
    const result = await withRegistry(
      both,
      [
        installed("/installed", installedManifest, "installed"),
        installed("/local", localManifest, "local")
      ],
      "1.0.0",
      (registry) =>
        Effect.all({
          review: registry.get("review"),
          names: Effect.map(registry.list(), (entries) => entries.map((entry) => entry.name).sort()),
          warnings: registry.warnings()
        })
    )

    expect(result.names).toEqual(["lint", "release", "review"])
    expect(result.review.provenance.pack?.name).toBe("acme/review")
    const shadowed = result.warnings.filter((warning) => warning.code === "shadowed")
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.name).toBe("review")
    expect(shadowed[0]!.message).toContain("acme/review@1.2.0")
    expect(shadowed[0]!.message).toContain("vendor/review@0.4.1")
  })

  it("keeps the first local pack when two local packs declare one name", async () => {
    const result = await withRegistry(
      both,
      [
        installed("/local", localManifest, "local"),
        installed("/installed", { ...installedManifest, name: "vendor/other" }, "local")
      ],
      "1.0.0",
      (registry) =>
        Effect.all({
          review: registry.get("review"),
          warnings: registry.warnings()
        })
    )

    expect(result.review.provenance.pack?.name).toBe("acme/review")
    expect(result.warnings.filter((warning) => warning.code === "shadowed")).toHaveLength(1)
  })

  it("fails incompatible_pack when the runtime is outside requires.smithers", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.promise(() =>
          withRegistry(
            both,
            [installed("/local", { ...localManifest, requires: { smithers: ">=2.0.0" } }, "local")],
            "1.0.0",
            (registry) => registry.list()
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("incompatible_pack")
  })

  it("admits a pack whose requires.smithers the runtime satisfies", async () => {
    const entries = await withRegistry(
      both,
      [installed("/local", { ...localManifest, requires: { smithers: ">=1.0.0" } }, "local")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["lint", "review"])
  })

  it("scans a pack's declared skills directories alongside its flows", async () => {
    const nodes = tree([
      ["/skilled", { kind: "directory", entries: ["pack.json", "flows", "skills"] }],
      ["/skilled/pack.json", manifestFile({ ...localManifest, skills: ["skills"] })],
      ["/skilled/flows", { kind: "directory", entries: ["review"] }],
      ["/skilled/flows/review", { kind: "directory", entries: ["flow.mdx"] }],
      ["/skilled/flows/review/flow.mdx", flowFile("Review it.", "Review it.")],
      ["/skilled/skills", { kind: "directory", entries: ["triage"] }],
      ["/skilled/skills/triage", { kind: "directory", entries: ["SKILL.md"] }],
      ["/skilled/skills/triage/SKILL.md", flowFile("Triage it.", "Triage it.")]
    ])

    const entries = await withRegistry(
      nodes,
      [installed("/skilled", { ...localManifest, skills: ["skills"] }, "local")],
      "1.0.0",
      (registry) => registry.list()
    )

    expect(entries.map((entry) => entry.name).sort()).toEqual(["review", "triage"])
  })

  it("loads a flow body through the pack's own root", async () => {
    const body = await withRegistry(
      both,
      [installed("/local", localManifest, "local")],
      "1.0.0",
      (registry) => registry.loadBody("lint")
    )

    expect(JSON.stringify(body)).toContain("Lint it.")
  })
})
