import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Path, PlatformError, Result } from "effect"
import { describe, expect, it } from "vitest"
import type { Source } from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"

import { type FileSystemCalls, type Node, virtualFileSystem } from "./support/VirtualFileSystem.ts"

type FileNode = Extract<Node, { readonly kind: "file" }>

// The virtual tree uses POSIX paths independently of the runner OS.
const root = "/vfs"
const expectedEntrySizeLimit = 4 * 1024 * 1024

const tree = (nodes: Readonly<Record<string, Node>>): Map<string, Node> => new Map(Object.entries(nodes))

const scan = (nodes: Map<string, Node>, source: Partial<Source> = {}, calls?: FileSystemCalls) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Discovery.make(virtualFileSystem(nodes, calls), path).scan({
        source: "virtual",
        root,
        naming: "path",
        ...source
      })
    }).pipe(Effect.provide(NodePath.layerPosix))
  )

const scanError = (nodes: Map<string, Node>, source: Partial<Source> = {}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* Effect.flip(
        Discovery.make(virtualFileSystem(nodes), path).scan({
          source: "virtual",
          root,
          naming: "path",
          ...source
        })
      )
    }).pipe(Effect.provide(NodePath.layerPosix))
  )

const skill = (description: string, name?: string): FileNode => ({
  kind: "file",
  contents: [
    "---",
    ...(name === undefined ? [] : [`name: ${name}`]),
    `description: ${description}`,
    "capabilities: []",
    "---",
    `Body for ${description}`,
    ""
  ].join("\n")
})

const flowModule = (body: string): Node => ({
  kind: "file",
  contents: `export default Flow.make({\n${body}\n})\n`
})

describe("Discovery host failures", () => {
  it("includes a missing native helper fix in its typed read failure", async () => {
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "AtomicFileSystem",
      method: "exists",
      description: "smithers-jj-export is missing; set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path"
    })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Effect.flip(
          Discovery.make(
            FileSystem.makeNoop({
              exists: () => Effect.fail(cause)
            }),
            path
          ).scan({ source: "virtual", root, naming: "path" })
        )
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(error).toMatchObject({ code: "read_failed", cause })
    expect(error.message).toContain("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY")
  })

  it("includes an unusable configured helper in its typed read failure", async () => {
    const description = "smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/absent: ENOENT"
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Effect.flip(
          Discovery.make(
            FileSystem.makeNoop({
              exists: () =>
                Effect.fail(PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "AtomicFileSystem",
                  method: "exists",
                  description
                }))
            }),
            path
          ).scan({ source: "virtual", root, naming: "path" })
        )
      }).pipe(Effect.provide(NodePath.layerPosix))
    )
    expect(error.message).toContain(description)
  })

  it("fails with invalid_root when the source root is not a directory", async () => {
    const error = await scanError(tree({ [root]: { kind: "file", contents: "" } }))

    expect(error).toMatchObject({
      code: "invalid_root",
      path: root,
      message: `invalid_root: Discovery.scan: source root "${root}" is not a directory`
    })
  })

  it("fails with read_failed when the source root cannot be inspected", async () => {
    const error = await scanError(tree({ [root]: { kind: "unstattable" } }))

    expect(error).toMatchObject({
      code: "read_failed",
      path: root,
      message: `read_failed: Discovery.scan: could not inspect source root "${root}"`,
      cause: { _tag: "PlatformError" }
    })
  })

  it("fails with read_failed when the source root cannot be listed", async () => {
    const error = await scanError(tree({ [root]: { kind: "unreadable-directory" } }))

    expect(error).toMatchObject({
      code: "read_failed",
      path: root,
      message: `read_failed: Discovery.scan: could not read source root "${root}"`
    })
  })

  it("returns an empty scan for an empty source root", async () => {
    const result = await scan(tree({ [root]: { kind: "directory", entries: [] } }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("warns and keeps scanning when a nested directory cannot be listed", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["ok", "sealed"] },
      [`${root}/sealed`]: { kind: "unreadable-directory" },
      [`${root}/ok`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/ok/SKILL.md`]: skill("Reads a file.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["ok"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/sealed`,
      message: `Could not read directory "${root}/sealed"`,
      cause: expect.objectContaining({ _tag: "PlatformError" })
    })])
    expect(result.warnings[0]).not.toHaveProperty("name")
  })

  it("warns and keeps scanning when an entry cannot be inspected", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["ghost", "ok"] },
      [`${root}/ghost`]: { kind: "unstattable" },
      [`${root}/ok`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/ok/SKILL.md`]: skill("Reads a file.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["ok"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/ghost`,
      message: `Could not inspect "${root}/ghost"`
    })])
  })

  it("warns when entry metadata cannot be read and drops the entry", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["sealed"] },
      [`${root}/sealed`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/sealed/SKILL.md`]: { kind: "unreadable-file" }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "unreadable",
      path: `${root}/sealed/SKILL.md`,
      message: `Could not read entry metadata from "${root}/sealed/SKILL.md"`
    })])
  })

  it.each(
    [
      ["a symbolic link", "SymbolicLink"],
      ["a fifo", "FIFO"],
      ["a socket", "Socket"],
      ["an unknown node", "Unknown"]
    ] as const
  )("ignores a host-reported %s node without warning", async (_label, type) => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["other"] },
      [`${root}/other`]: { kind: "special", type }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe("Discovery traversal", () => {
  const nested = () =>
    tree({
      [root]: {
        kind: "directory",
        entries: [".git", ".hidden", "node_modules", "channels", "connections", "flows"]
      },
      [`${root}/.git`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/.git/SKILL.md`]: skill("Hidden by dot.", "git"),
      [`${root}/.hidden`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/.hidden/SKILL.md`]: skill("Hidden by dot.", "hidden"),
      [`${root}/node_modules`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/node_modules/SKILL.md`]: skill("Vendored.", "vendored"),
      [`${root}/channels`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/channels/SKILL.md`]: skill("A channel.", "channels"),
      [`${root}/connections`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/connections/SKILL.md`]: skill("A connection.", "connections"),
      [`${root}/flows`]: { kind: "directory", entries: ["SKILL.md", "channels"] },
      [`${root}/flows/SKILL.md`]: skill("A flow.", "flows"),
      [`${root}/flows/channels`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/flows/channels/SKILL.md`]: skill("A nested channel.", "nested-channel")
    })

  it("skips reserved directories at the root of a path-named source", async () => {
    const result = await scan(nested())

    expect(result.entries.map((entry) => entry.name)).toEqual(["flows", "flows/channels"])
  })

  it("scans root-level channels and connections when names come from frontmatter", async () => {
    const result = await scan(nested(), { naming: "frontmatter" })

    expect(result.entries.map((entry) => entry.name)).toEqual([
      "channels",
      "connections",
      "flows",
      "nested-channel"
    ])
  })

  it("warns about a root-level entry in a path-named source and keeps its children", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["SKILL.md", "nested"] },
      [`${root}/SKILL.md`]: skill("At the root."),
      [`${root}/nested`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/nested/SKILL.md`]: skill("Nested.")
    }))

    expect(result.entries.map((entry) => entry.name)).toEqual(["nested"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "root_level_entry",
      path: `${root}/SKILL.md`,
      message: "Path-named sources cannot contain a root-level entry"
    })])
  })

  it("discovers a root-level entry when names come from frontmatter", async () => {
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["SKILL.md"] },
        [`${root}/SKILL.md`]: skill("At the root.", "vfs")
      }),
      { naming: "frontmatter" }
    )

    expect(result.entries.map((entry) => entry.name)).toEqual(["vfs"])
    expect(result.warnings).toEqual([])
  })

  it("warns once when a directory holds several entry files and uses the precedence order", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["multi"] },
      [`${root}/multi`]: { kind: "directory", entries: ["SKILL.md", "flow.mdx", "flow.ts"] },
      [`${root}/multi/SKILL.md`]: skill("From the skill file."),
      [`${root}/multi/flow.mdx`]: skill("From the markdown flow."),
      [`${root}/multi/flow.ts`]: flowModule("  description: \"From the module.\",\n  capabilities: []")
    }))

    expect(result.entries.map((entry) => entry.description)).toEqual(["From the module."])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "multiple_entry_files",
      path: `${root}/multi`,
      message: "Multiple entry files found (flow.ts, flow.mdx, SKILL.md); using flow.ts"
    })])
  })

  it("orders entries and warnings by path even when traversal finds them out of order", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["a", "a-b"] },
      [`${root}/a`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/a/SKILL.md`]: skill("Discovered first.", "a"),
      [`${root}/a-b`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/a-b/SKILL.md`]: skill("Discovered second.", "a-b")
    }))

    expect(result.entries.map((entry) => entry.path)).toEqual([
      `${root}/a-b/SKILL.md`,
      `${root}/a/SKILL.md`
    ])
    expect(result.warnings.map((warning) => warning.path)).toEqual([
      `${root}/a-b/SKILL.md`,
      `${root}/a/SKILL.md`
    ])
  })

  it("sorts warnings that share a path by code and then by message", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["keys"] },
      [`${root}/keys`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/keys/SKILL.md`]: {
        kind: "file",
        contents: [
          "---",
          "description: Declares unknown keys.",
          "capabilities: []",
          "zeta: 1",
          "alpha: 2",
          "middle: 3",
          "---",
          "body"
        ].join("\n")
      }
    }))

    expect(result.warnings.map((warning) => warning.message)).toEqual([
      "Unknown frontmatter key: alpha",
      "Unknown frontmatter key: middle",
      "Unknown frontmatter key: zeta"
    ])
  })

  it("bounds a duplicate directory listing by physical identity", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["dup", "dup", "dup"] },
      [`${root}/dup`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/dup/SKILL.md`]: {
        kind: "file",
        contents: "---\ndescription: Listed twice.\nunknown: 1\n---\nbody"
      }
    }))

    expect(result.entries.map((entry) => entry.path)).toEqual([`${root}/dup/SKILL.md`])
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "symlink_cycle",
      "symlink_cycle",
      "unknown_frontmatter_key",
      "unprojectable_authority"
    ])
  })

  it("stops parsing entry metadata at the 64 KiB parsing ceiling", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["huge"] },
      [`${root}/huge`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/huge/SKILL.md`]: {
        kind: "file",
        contents: [
          "---",
          "description: Declared past the ceiling.",
          `padding: ${"x".repeat(70 * 1024)}`,
          "---",
          "body"
        ].join("\n")
      }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "missing_description",
      path: `${root}/huge/SKILL.md`
    })])
  })

  it.each([-1, 0, 1])("checks the reported size at the input ceiling %i", async (offset) => {
    const location = `${root}/bounded/SKILL.md`
    const calls: FileSystemCalls = { readFile: [] }
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["bounded"] },
        [`${root}/bounded`]: { kind: "directory", entries: ["SKILL.md"] },
        [location]: { ...skill("Within the input ceiling."), reportedSize: expectedEntrySizeLimit + offset }
      }),
      {},
      calls
    )

    if (offset <= 0) {
      expect(result.entries.map((entry) => entry.name)).toEqual(["bounded"])
      expect(result.warnings).toEqual([])
      expect(calls.readFile).toEqual([location])
    } else {
      expect(result.entries).toEqual([])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "entry_too_large",
        path: location,
        message: expect.stringContaining(String(expectedEntrySizeLimit + offset))
      })])
      expect(calls.readFile).toEqual([])
    }
  })

  it.each([-1, 0, 1])("checks actual UTF-8 bytes at the input ceiling %i with under-reported stat", async (offset) => {
    const location = `${root}/bounded/SKILL.md`
    const prefix = skill("The host under-reported this entry.").contents
    const size = expectedEntrySizeLimit + offset
    const padding = size - new TextEncoder().encode(prefix).length
    const contents = prefix + "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2)
    expect(new TextEncoder().encode(contents).length).toBe(size)
    expect(contents.length).toBeLessThan(expectedEntrySizeLimit)
    const calls: FileSystemCalls = { readFile: [] }
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["bounded"] },
        [`${root}/bounded`]: { kind: "directory", entries: ["SKILL.md"] },
        [location]: { kind: "file", contents, reportedSize: 0 }
      }),
      {},
      calls
    )

    expect(calls.readFile).toEqual([location])
    if (offset <= 0) {
      expect(result.entries.map((entry) => entry.name)).toEqual(["bounded"])
      expect(result.warnings).toEqual([])
    } else {
      expect(result.entries).toEqual([])
      expect(result.warnings).toEqual([expect.objectContaining({
        code: "entry_too_large",
        path: location,
        message: expect.stringContaining(String(size))
      })])
    }
  })

  it.each([31, 32, 33])("checks the traversal ceiling at %i segments", async (depth) => {
    const segments = Array.from({ length: depth }, (_, index) => `d${index}`)
    const nodes = tree({})
    let directory = root
    for (const segment of segments) {
      nodes.set(directory, { kind: "directory", entries: [segment] })
      directory += `/${segment}`
    }
    nodes.set(directory, { kind: "directory", entries: ["SKILL.md"] })
    nodes.set(`${directory}/SKILL.md`, skill("At the traversal ceiling."))
    const calls: FileSystemCalls = { readFile: [] }
    const result = await scan(nodes, {}, calls)

    if (depth <= 32) {
      expect(result.entries.map((entry) => entry.name)).toEqual([segments.join("/")])
      expect(result.warnings).toEqual([])
      expect(calls.readFile).toEqual([`${directory}/SKILL.md`])
    } else {
      expect(result.entries).toEqual([])
      expect(result.warnings).toEqual([expect.objectContaining({ code: "max_depth_exceeded", path: directory })])
      expect(calls.readFile).toEqual([])
    }
  })
})

describe("Discovery module entries", () => {
  it("projects a module without declared schemas and warns about its ignored name", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["tools"] },
      [`${root}/tools`]: { kind: "directory", entries: ["report"] },
      [`${root}/tools/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/tools/report/flow.ts`]: flowModule(
        "  name: \"ignored\",\n  description: \"Reports a result.\",\n  capabilities"
      )
    }))
    const entry = result.entries[0]

    expect(entry?.name).toBe("tools/report")
    expect(entry?.input).toMatchObject({ _tag: "None" })
    expect(entry?.output).toMatchObject({ _tag: "None" })
    expect(entry?.capabilities).toEqual(["*"])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "name_field_ignored",
        name: "tools/report",
        message: "Ignoring Flow.make name because this source uses path-derived names"
      }),
      expect.objectContaining({
        code: "unsupported_module_metadata",
        name: "tools/report",
        message: "Capabilities must be a string-literal array for discovery; using the conservative wildcard"
      })
    ])
  })

  it.each([
    ["tools/report", []],
    ["report", ["name_field_ignored"]]
  ])("accepts the declared name %s in silence only when it is the path name", async (declared, codes) => {
    // `Flow.make` requires a name, so declaring the path name is what every
    // module in a path-named source does. Warning about that would put a line
    // beside every flow a scan finds and say nothing.
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["tools"] },
      [`${root}/tools`]: { kind: "directory", entries: ["report"] },
      [`${root}/tools/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/tools/report/flow.ts`]: flowModule(
        `  name: "${declared}",\n  description: "Reports a result.",\n  capabilities: []`
      )
    }))

    expect(result.entries[0]?.name).toBe("tools/report")
    expect(result.warnings.map((item) => item.code)).toEqual(codes)
  })

  it("warns about a declared name it cannot read, because it cannot be shown to agree", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["tools"] },
      [`${root}/tools`]: { kind: "directory", entries: ["report"] },
      [`${root}/tools/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/tools/report/flow.ts`]: flowModule(
        "  name: prefix + \"report\",\n  description: \"Reports a result.\",\n  capabilities: []"
      )
    }))

    expect(result.entries[0]?.name).toBe("tools/report")
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "name_field_ignored",
      name: "tools/report",
      message: "Ignoring Flow.make name because this source uses path-derived names"
    })])
  })

  it("drops a module flow that declares no description", async () => {
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["report"] },
      [`${root}/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/report/flow.ts`]: flowModule("  capabilities: []")
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "missing_description",
      name: "report",
      message: "Module flows require a literal description in the default Flow.make value"
    })])
  })

  it("drops a module whose default export is built by Flow.agent", async () => {
    // `Flow.make` is the one constructor discovery reads. `Flow.agent` is read
    // as no declaration at all, which is what every unrecognised default
    // export gets: the umbrella warning, then the refusal for the description
    // that cannot be there.
    const result = await scan(tree({
      [root]: { kind: "directory", entries: ["report"] },
      [`${root}/report`]: { kind: "directory", entries: ["flow.ts"] },
      [`${root}/report/flow.ts`]: {
        kind: "file",
        contents: "export default Flow.agent({\n  description: \"Reports a result.\",\n  capabilities: []\n})\n"
      }
    }))

    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "missing_description",
        name: "report",
        message: "Module flows require a literal description in the default Flow.make value"
      }),
      expect.objectContaining({
        code: "unsupported_module_metadata",
        name: "report",
        message: "Could not statically read the default Flow.make declaration"
      })
    ])
  })

  it("names a module flow after its directory when names come from frontmatter", async () => {
    const result = await scan(
      tree({
        [root]: { kind: "directory", entries: ["report"] },
        [`${root}/report`]: { kind: "directory", entries: ["flow.ts"] },
        [`${root}/report/flow.ts`]: flowModule(
          "  name: \"declared\",\n  description: \"Reports a result.\",\n  input: Schema.String,\n  capabilities: []"
        )
      }),
      { naming: "frontmatter" }
    )
    const entry = result.entries[0]

    expect(entry?.name).toBe("report")
    expect(entry?.input).toMatchObject({ _tag: "Module", field: "input" })
    expect(entry?.output).toMatchObject({ _tag: "None" })
    expect(result.warnings).toEqual([])
  })
})

describe("Registry over a virtual host", () => {
  const registryLayer = (nodes: Map<string, Node>, sources: ReadonlyArray<Source>) => {
    const platform = Layer.merge(Layer.succeed(FileSystem.FileSystem)(virtualFileSystem(nodes)), NodePath.layerPosix)
    return Registry.layer({ sources }).pipe(
      Layer.provide(Layer.merge(Discovery.layer.pipe(Layer.provide(platform)), platform))
    )
  }

  it("refuses same-path body drift until the registry refreshes its content address", async () => {
    const nodes = tree({
      [root]: { kind: "directory", entries: ["review"] },
      [`${root}/review`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/review/SKILL.md`]: {
        kind: "file",
        contents: "---\ndescription: Reviews a change.\ncapabilities: []\n---\nOriginal body."
      }
    })
    const layer = registryLayer(nodes, [{ source: "virtual", root, naming: "path" }])

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const declaredBefore = yield* registry.get("review")
        const before = yield* registry.loadBody("review")
        yield* Effect.sync(() => {
          nodes.set(`${root}/review/SKILL.md`, {
            kind: "file",
            contents: "---\ndescription: Reviews a change.\ncapabilities: []\n---\nRewritten body."
          })
        })
        const stale = yield* Effect.flip(registry.loadBody("review"))
        yield* registry.refresh()
        const declaredAfter = yield* registry.get("review")
        const after = yield* registry.loadBody("review")
        return { after, before, declaredAfter, declaredBefore, stale }
      }).pipe(Effect.provide(layer))
    )

    expect(result.before).toMatchObject({ _tag: "Prompt", text: "Original body." })
    expect(result.stale).toMatchObject({ code: "body_unavailable", method: "loadBody" })
    expect(result.stale.path).toBe(`${root}/review/SKILL.md`)
    expect(result.after).toMatchObject({ _tag: "Prompt", text: "Rewritten body." })
    expect(result.declaredBefore.body.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.declaredAfter.body.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.declaredAfter.body.contentDigest).not.toBe(result.declaredBefore.body.contentDigest)
  })

  it("keeps one entry when the host lists one physical directory twice", async () => {
    const nodes = tree({
      [root]: { kind: "directory", entries: ["review", "review"] },
      [`${root}/review`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/review/SKILL.md`]: skill("Reviews a change.")
    })

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        return { entries: yield* registry.list(), warnings: yield* registry.warnings() }
      }).pipe(Effect.provide(registryLayer(nodes, [{ source: "virtual", root, naming: "path" }])))
    )

    expect(result.entries.map((entry) => entry.name)).toEqual(["review"])
    expect(result.warnings).toEqual([expect.objectContaining({
      code: "symlink_cycle",
      path: `${root}/review`,
      message:
        `Directory "${root}/review" resolves to already visited directory "${root}/review"; skipping recursive traversal`
    })])
  })
})

describe("Discovery concurrency", () => {
  /**
   * Records how many `stat` calls the traversal keeps in flight, and holds each
   * one open for a host round trip. Without the delay every stat settles inside
   * the calling microtask and a concurrent pass is indistinguishable from a
   * sequential one.
   */
  const countingStats = (nodes: Map<string, Node>, record: { inFlight: number; peak: number }) => {
    const base = virtualFileSystem(nodes)
    return FileSystem.makeNoop({
      exists: base.exists,
      readDirectory: base.readDirectory,
      readFile: base.readFile,
      readFileString: base.readFileString,
      stat: (path: string) =>
        Effect.gen(function*() {
          record.inFlight += 1
          record.peak = Math.max(record.peak, record.inFlight)
          const settled = yield* Effect.result(Effect.delay(base.stat(path), "10 millis"))
          record.inFlight -= 1
          if (Result.isFailure(settled)) return yield* Effect.fail(settled.failure)
          return settled.success
        })
    })
  }

  const shuffled = (listing: ReadonlyArray<string>) =>
    tree({
      [root]: { kind: "directory", entries: listing },
      [`${root}/review`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/review/SKILL.md`]: skill("Reviews a change."),
      [`${root}/apply`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/apply/SKILL.md`]: skill("Applies a change."),
      [`${root}/bisect`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/bisect/SKILL.md`]: skill("Bisects a regression."),
      [`${root}/deploy`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/deploy/SKILL.md`]: skill("Deploys a build."),
      [`${root}/triage`]: { kind: "directory", entries: ["SKILL.md"] },
      [`${root}/triage/SKILL.md`]: skill("Triages an issue."),
      [`${root}/opaque`]: { kind: "unstattable" },
      [`${root}/sealed`]: { kind: "unstattable" }
    })

  const listing = ["triage", "opaque", "apply", "deploy", "sealed", "bisect", "review"] as const

  const scanWith = (nodes: Map<string, Node>, fs: FileSystem.FileSystem) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Discovery.make(fs, path).scan({ source: "virtual", root, naming: "path" })
      }).pipe(Effect.provide(NodePath.layerPosix))
    )

  it("keeps several directory stats in flight at once", async () => {
    const record = { inFlight: 0, peak: 0 }
    const nodes = shuffled(listing)
    const result = await scanWith(nodes, countingStats(nodes, record))

    // A sequential traversal awaits each stat before issuing the next, so its
    // peak is exactly one.
    expect(record.peak).toBeGreaterThan(1)
    expect(record.inFlight).toBe(0)
    expect(result.entries.map((entry) => entry.name)).toEqual(["apply", "bisect", "deploy", "review", "triage"])
  })

  it("reports the same entries and warnings however the host orders a directory", async () => {
    const reversed = [...listing].reverse()
    const plain = await scanWith(shuffled(listing), virtualFileSystem(shuffled(listing)))
    const record = { inFlight: 0, peak: 0 }
    const nodes = shuffled(reversed)
    const concurrent = await scanWith(nodes, countingStats(nodes, record))

    expect(concurrent.entries).toEqual(plain.entries)
    expect(concurrent.warnings).toEqual(plain.warnings)
    expect(concurrent.warnings.map((item) => item.path)).toEqual([`${root}/opaque`, `${root}/sealed`])
  })
})
