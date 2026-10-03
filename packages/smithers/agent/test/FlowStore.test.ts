/**
 * Where a saved flow's files land.
 *
 * These cases fix the store's contract: a write reports the paths it wrote in
 * the caller's own terms, a listing names the flows the store already holds,
 * and an id that is not a routable flow directory name is refused before any
 * path is built from it.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError } from "effect"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as FlowStore from "../src/FlowStore.ts"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const roots = new Set<string>()
const root = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "flows-store-"))
  roots.add(directory)
  return directory
}
afterEach(() => {
  for (const directory of roots) rmSync(directory, { recursive: true, force: true })
  roots.clear()
})

const files = (id: string): Record<string, string> => ({
  [`flows/${id}/flow.ts`]: `export default ({ name: "${id}" })`,
  [`flows/${id}/flow.e2e.ts`]: `it("runs ${id}", () => {})`,
  [`flows/${id}/fixtures/${id}.json`]: `{ "calls": [] }`
})

const onDisk = <A, E>(
  directory: string,
  use: (store: FlowStore.Service) => Effect.Effect<A, E>
): Promise<Exit.Exit<A, E>> =>
  Effect.flatMap(FlowStore.FlowStore, use).pipe(
    Effect.provide(FlowStore.layerFileSystem(directory).pipe(Layer.provide(platform))),
    Effect.runPromiseExit
  )

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(effect)

/** The refusal an exit carries, or a failing assertion when it succeeded. */
const refused = <A, E>(exit: Exit.Exit<A, E>): FlowStore.FlowStoreError => {
  if (Exit.isSuccess(exit)) {
    expect.unreachable("expected the store to refuse")
  }
  return Cause.squash(exit.cause) as FlowStore.FlowStoreError
}

describe("FlowStore.makeMemory", () => {
  it("keeps every file it is given and reports the paths it wrote", async () => {
    const written = new Map<string, string>()
    const store = FlowStore.makeMemory(written)

    const result = await run(store.write("weekly-digest", files("weekly-digest")))

    expect(result).toStrictEqual(Exit.succeed({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    }))
    expect(written.get("flows/weekly-digest/flow.ts")).toBe(`export default ({ name: "weekly-digest" })`)
  })

  it("lists one entry per saved flow, with the files it holds", async () => {
    const store = FlowStore.makeMemory()
    await run(store.write("triage", files("triage")))
    await run(store.write("digest", files("digest")))

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      {
        id: "digest",
        files: ["flows/digest/fixtures/digest.json", "flows/digest/flow.e2e.ts", "flows/digest/flow.ts"]
      },
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it("keeps one entry for a flow the model saves twice", async () => {
    const store = FlowStore.makeMemory()
    await run(store.write("triage", files("triage")))
    await run(store.write("triage", { "flows/triage/flow.ts": "the second draft" }))

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it("lists only what is laid out as a saved flow", async () => {
    // The map is the host's, so it may hold anything. Only `flows/<id>/<file>`
    // is a saved flow.
    const store = FlowStore.makeMemory(
      new Map([
        ["README.md", ""],
        ["flows/triage", ""],
        ["notes/triage/flow.ts", ""],
        ["flows/Triage/flow.ts", ""],
        ["flows/triage/flow.ts", "kept"]
      ])
    )

    expect(await run(store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/flow.ts"] }
    ]))
  })

  it("refuses an id no router could route", async () => {
    const written = new Map<string, string>()
    const store = FlowStore.makeMemory(written)

    expect(refused(await run(store.write("../escape", { "flows/../escape/flow.ts": "" }))).code).toBe("invalid_id")
    expect(written.size).toBe(0)
  })

  it.each([
    "flows/other/flow.ts",
    "README.md",
    "flows/triage",
    "flows/triage/",
    "flows/triage/../other/flow.ts",
    "flows/triage/./flow.ts",
    "flows/triage//flow.ts"
  ])("refuses the key %s outside flows/<id>/ before storing anything", async (key) => {
    const written = new Map<string, string>()
    const store = FlowStore.makeMemory(written)

    const result = await run(store.write("triage", { "flows/triage/flow.ts": "kept", [key]: "outside" }))

    expect(refused(result).code).toBe("invalid_path")
    expect(written.size).toBe(0)
  })
})

describe("FlowStore.layerFileSystem", () => {
  it("publishes on a host that refuses makeTempDirectory, as the kernel filesystem does", async () => {
    const directory = root()
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const refused = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeTempDirectory",
        description: "host does not provide descriptor-relative, no-follow filesystem isolation"
      })
      const kernelLike = FileSystem.FileSystem.of({
        ...fs,
        makeTempDirectory: () => Effect.fail(refused),
        makeTempDirectoryScoped: () => Effect.fail(refused)
      })
      return yield* FlowStore.makeFileSystem(kernelLike, path, directory).write("triage", files("triage"))
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(Exit.isSuccess(result)).toBe(true)
    for (const [relative, source] of Object.entries(files("triage"))) {
      expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it.each([1, 2])("preserves the previous file set when staged write %i runs out of space", async (failAt) => {
    const directory = root()
    const original = files("triage")
    await onDisk(directory, (store) => store.write("triage", original))
    const writes: Array<string> = []
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failing = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (target, source, options) =>
          Effect.suspend(() => {
            writes.push(target)
            return writes.length === failAt
              ? Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "writeFileString",
                description: "ENOSPC"
              }))
              : fs.writeFileString(target, source, options)
          })
      })
      return yield* FlowStore.makeFileSystem(failing, path, directory).write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      })
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(refused(result).code).toBe("write_failed")
    for (const [relative, source] of Object.entries(original)) {
      expect(existsSync(join(directory, relative))).toBe(true)
      expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(writes).toHaveLength(failAt)
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it.each([true, false])("rolls back a later rename failure (previous files: %s)", async (existing) => {
    const directory = root()
    const original = files("triage")
    if (existing) await onDisk(directory, (store) => store.write("triage", original))
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failing = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          to.endsWith("flow.e2e.ts")
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename"
            }))
            : fs.rename(from, to)
      })
      return yield* FlowStore.makeFileSystem(failing, path, directory).write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      })
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(refused(result).code).toBe("write_failed")
    for (const [relative, source] of Object.entries(original)) {
      expect(existsSync(join(directory, relative))).toBe(existing)
      if (existing) expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("keeps backups if the filesystem also refuses rollback", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failing = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          from.endsWith(".old") || to.endsWith("flow.e2e.ts")
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename"
            }))
            : fs.rename(from, to)
      })
      return yield* FlowStore.makeFileSystem(failing, path, directory).write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      })
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    const generation = readdirSync(directory).find((name) => name.startsWith(".flow-store-"))!
    expect(generation).toBeDefined()
    expect(refused(result).message).toContain(join(directory, generation))
    expect(readFileSync(join(directory, generation, "0.old"), "utf8")).toBe(files("triage")["flows/triage/flow.ts"])
    expect(readFileSync(join(directory, "flows/triage/flow.e2e.ts"), "utf8")).toBe(
      files("triage")["flows/triage/flow.e2e.ts"]
    )
  })

  it("leaves previous files intact when retaining a backup runs out of space", async () => {
    const directory = root()
    const original = files("triage")
    await onDisk(directory, (store) => store.write("triage", original))
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failing = FileSystem.FileSystem.of({
        ...fs,
        copyFile: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "copyFile",
            description: "ENOSPC"
          }))
      })
      return yield* FlowStore.makeFileSystem(failing, path, directory).write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      })
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(refused(result).code).toBe("write_failed")
    for (const [relative, source] of Object.entries(original)) {
      expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("cleans staging on interruption without changing existing files", async () => {
    const directory = root()
    const original = files("triage")
    await onDisk(directory, (store) => store.write("triage", original))
    await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const entered = yield* Deferred.make<void>()
      let writes = 0
      const interrupted = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (target, source, options) =>
          Effect.suspend(() =>
            ++writes === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : fs.writeFileString(target, source, options)
          )
      })
      const store = FlowStore.makeFileSystem(interrupted, path, directory)
      const saving = yield* store.write("triage", original).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(saving)
    }).pipe(Effect.provide(platform), Effect.runPromise)

    for (const [relative, source] of Object.entries(original)) {
      expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("finishes publishing the entire set before honoring interruption", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))
    await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const delayed = FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) =>
          fs.rename(from, to).pipe(Effect.andThen(
            to.endsWith("flow.ts")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
          ))
      })
      const store = FlowStore.makeFileSystem(delayed, path, directory)
      const saving = yield* store.write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const interrupting = yield* Fiber.interrupt(saving).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupting)
    }).pipe(Effect.provide(platform), Effect.runPromise)

    expect(readFileSync(join(directory, "flows/triage/flow.ts"), "utf8")).toBe("new flow")
    expect(readFileSync(join(directory, "flows/triage/flow.e2e.ts"), "utf8")).toBe("new test")
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it.each([false, true])("serializes concurrent saves of the same flow (separate stores: %s)", async (separate) => {
    const directory = root()
    const writes: Array<string> = []
    await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const secondRequested = yield* Deferred.make<void>()
      const recording = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (target, source, options) =>
          Effect.gen(function*() {
            if (source === "first") yield* Deferred.await(secondRequested)
            writes.push(source)
            yield* fs.writeFileString(target, source, options)
          })
      })
      const store = FlowStore.makeFileSystem(recording, path, directory)
      const first = yield* store.write("triage", {
        "flows/triage/flow.ts": "first",
        "flows/triage/flow.e2e.ts": "first"
      }).pipe(Effect.forkChild({ startImmediately: true }))
      const other = separate ? FlowStore.makeFileSystem(recording, path, directory) : store
      const second = yield* Deferred.succeed(secondRequested, undefined).pipe(
        Effect.andThen(
          other.write("triage", { "flows/triage/flow.ts": "second", "flows/triage/flow.e2e.ts": "second" })
        ),
        Effect.forkChild
      )
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }).pipe(Effect.provide(platform), Effect.runPromise)

    expect(writes).toStrictEqual(["first", "first", "second", "second"])
    expect(readFileSync(join(directory, "flows/triage/flow.ts"), "utf8")).toBe("second")
    expect(readFileSync(join(directory, "flows/triage/flow.e2e.ts"), "utf8")).toBe("second")
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("preserves earlier files when a later destination is a directory", async () => {
    const directory = root()
    mkdirSync(join(directory, "flows/triage/flow.e2e.ts"), { recursive: true })
    writeFileSync(join(directory, "flows/triage/flow.ts"), "old flow")

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
    expect(readFileSync(join(directory, "flows/triage/flow.ts"), "utf8")).toBe("old flow")
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it.each([
    ["win32", String.raw`C:\workspace\flows-root`, String.raw`..\outside.ts`],
    ["win32", String.raw`C:\workspace\flows-root`, String.raw`nested\..\..\outside.ts`],
    ["posix", "/workspace/flows-root", "../outside.ts"]
  ])("rejects %s traversal %s %s before creating directories", async (platformName, directory, relative) => {
    const mutations: Array<string> = []
    const fs = FileSystem.makeNoop({
      makeDirectory: (target) =>
        Effect.sync(() => {
          mutations.push(target)
        }),
      writeFileString: (target) =>
        Effect.sync(() => {
          mutations.push(target)
        }),
      remove: (target) =>
        Effect.sync(() => {
          mutations.push(target)
        })
    })
    const result = await Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* FlowStore.makeFileSystem(fs, path, directory).write("safe", {
        "flows/safe/flow.ts": "safe",
        [relative]: "outside"
      })
    }).pipe(
      Effect.provide(platformName === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
      Effect.runPromiseExit
    )

    expect(refused(result).code).toBe("invalid_path")
    expect(mutations).toStrictEqual([])
  })

  it.each([
    ["flows/triage/flow.ts", "flows/triage/./flow.ts"],
    ["flows/triage", "flows/triage/flow.ts"],
    ["flows/triage/flow.ts", "flows/triage"]
  ])("rejects overlapping targets %s and %s before any mkdir", async (first, second) => {
    const mutations: Array<string> = []
    const fs = FileSystem.makeNoop({
      makeDirectory: (target) =>
        Effect.sync(() => {
          mutations.push(target)
        })
    })
    const result = await Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* FlowStore.makeFileSystem(fs, path, "/workspace").write("triage", {
        [first]: "first",
        [second]: "second"
      })
    }).pipe(Effect.provide(NodePath.layerPosix), Effect.runPromiseExit)

    expect(refused(result).code).toBe("invalid_path")
    expect(mutations).toStrictEqual([])
  })

  it("checks each backslash-delimited Windows component for symbolic links", async () => {
    const mutations: Array<string> = []
    const noop = FileSystem.makeNoop({})
    const fs = FileSystem.FileSystem.of({
      ...noop,
      readLink: (target) =>
        target === String.raw`C:\workspace\flows\triage`
          ? Effect.succeed(String.raw`C:\outside`)
          : noop.readLink(target),
      makeDirectory: (target) =>
        Effect.sync(() => {
          mutations.push(target)
        })
    })
    const result = await Effect.gen(function*() {
      const path = yield* Path.Path
      return yield* FlowStore.makeFileSystem(fs, path, String.raw`C:\workspace`).write("triage", {
        [String.raw`flows\triage\flow.ts`]: "new flow"
      })
    }).pipe(Effect.provide(NodePath.layerWin32), Effect.runPromiseExit)

    expect(refused(result).code).toBe("invalid_path")
    expect(mutations).toStrictEqual([])
  })

  it("refuses a directory link planted while creating a parent", async () => {
    const directory = root()
    const outside = root()
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const planted = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (target, options) =>
          Effect.gen(function*() {
            if (target === join(directory, "flows")) symlinkSync(outside, target)
            yield* fs.makeDirectory(target, options)
          })
      })
      return yield* FlowStore.makeFileSystem(planted, path, directory).write("triage", files("triage"))
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(refused(result).code).toBe("write_failed")
    expect(readdirSync(outside)).toStrictEqual([])
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("does not treat a failed stat as a missing previous file", async () => {
    const directory = root()
    const original = files("triage")
    await onDisk(directory, (store) => store.write("triage", original))
    const result = await Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failing = FileSystem.FileSystem.of({
        ...fs,
        stat: (target) =>
          target.endsWith("flow.e2e.ts")
            ? Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "stat"
            }))
            : fs.stat(target)
      })
      return yield* FlowStore.makeFileSystem(failing, path, directory).write("triage", {
        "flows/triage/flow.ts": "new flow",
        "flows/triage/flow.e2e.ts": "new test"
      })
    }).pipe(Effect.provide(platform), Effect.runPromiseExit)

    expect(refused(result).code).toBe("write_failed")
    for (const [relative, source] of Object.entries(original)) {
      expect(readFileSync(join(directory, relative), "utf8")).toBe(source)
    }
    expect(readdirSync(directory)).toStrictEqual(["flows"])
  })

  it("writes the flow, its test, and its fixture under the root", async () => {
    const directory = root()

    const result = await onDisk(directory, (store) => store.write("weekly-digest", files("weekly-digest")))

    expect(result).toStrictEqual(Exit.succeed({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    }))
    expect(readFileSync(join(directory, "flows/weekly-digest/flow.ts"), "utf8")).toBe(
      `export default ({ name: "weekly-digest" })`
    )
    expect(readFileSync(join(directory, "flows/weekly-digest/fixtures/weekly-digest.json"), "utf8")).toBe(
      `{ "calls": [] }`
    )
  })

  it("lists the flows the root already holds", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })

  it.each([
    ["win32", String.raw`C:\workspace`],
    ["posix", "/workspace"]
  ])("lists nested files with portable separators on %s", async (platformName, directory) => {
    const file = join(root(), "fixture.ts")
    writeFileSync(file, "fixture")
    const result = await Effect.gen(function*() {
      const host = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const info = yield* host.stat(file)
      const held = [`fixtures${path.sep}triage.json`, "flow.ts"]
      const fs = FileSystem.makeNoop({
        readDirectory: (target) => {
          if (target === path.join(directory, "flows")) return Effect.succeed(["triage"])
          expect(target).toBe(path.join(directory, "flows", "triage"))
          return Effect.succeed(held)
        },
        stat: (target) => {
          expect(held.map((relative) => path.join(directory, "flows", "triage", relative))).toContain(target)
          return Effect.succeed(info)
        }
      })
      return yield* FlowStore.makeFileSystem(fs, path, directory).list()
    }).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(platformName === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
      Effect.runPromise
    )

    expect(result).toEqual([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.ts"] }
    ])
  })

  it("reports nothing for a root that holds no flows yet", async () => {
    expect(await onDisk(root(), (store) => store.list())).toStrictEqual(Exit.succeed([]))
  })

  it("refuses an id that would write outside the flows directory", async () => {
    const directory = root()

    const result = await onDisk(directory, (store) => store.write("../escape", { "flows/../escape/flow.ts": "" }))

    expect(refused(result).code).toBe("invalid_id")
    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([]))
  })

  it("refuses a file path that climbs out of the root, before anything is written", async () => {
    const directory = root()

    const climbing = await onDisk(
      directory,
      (store) => store.write("triage", { "flows/triage/flow.ts": "kept", "../escape.ts": "" })
    )
    const absolute = await onDisk(directory, (store) => store.write("triage", { "/etc/escape.ts": "" }))

    expect(refused(climbing).code).toBe("invalid_path")
    expect(refused(absolute).code).toBe("invalid_path")
    expect(existsSync(join(directory, "flows/triage/flow.ts"))).toBe(false)
  })

  it("refuses to write through a file the checkout linked outside the root", async () => {
    const directory = root()
    const outside = root()
    const victim = join(outside, "victim.ts")
    writeFileSync(victim, "original")
    // The path is the one a saved flow takes; the entry it names is a link the
    // agent never wrote, which a plain write would follow out of the root.
    mkdirSync(join(directory, "flows/triage"), { recursive: true })
    symlinkSync(victim, join(directory, "flows/triage/flow.ts"))

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("invalid_path")
    expect(readFileSync(victim, "utf8")).toBe("original")
    expect(existsSync(join(directory, "flows/triage/flow.e2e.ts"))).toBe(false)
  })

  it("refuses to write through a directory the checkout linked outside the root", async () => {
    const directory = root()
    const outside = root()
    writeFileSync(join(outside, "flow.ts"), "original")
    mkdirSync(join(directory, "flows"), { recursive: true })
    symlinkSync(outside, join(directory, "flows/triage"))

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("invalid_path")
    expect(readFileSync(join(outside, "flow.ts"), "utf8")).toBe("original")
    expect(existsSync(join(outside, "flow.e2e.ts"))).toBe(false)
  })

  it("replaces the files a flow already saved", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))

    const result = await onDisk(
      directory,
      (store) => store.write("triage", { ...files("triage"), "flows/triage/flow.ts": "saved again" })
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(readFileSync(join(directory, "flows/triage/flow.ts"), "utf8")).toBe("saved again")
  })

  it("reports a directory it could not create rather than claiming the write", async () => {
    const directory = root()
    // A root that is a file: every directory the write needs is under it.
    const file = join(directory, "not-a-directory")
    writeFileSync(file, "")

    const result = await onDisk(file, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
  })

  it("reports a directory the flows tree could not make room for", async () => {
    const directory = root()
    // A file where the flows directory has to be: the component can be neither
    // created nor descended into.
    writeFileSync(join(directory, "flows"), "")

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
  })

  it("reports a file it could not write rather than claiming the write", async () => {
    const directory = root()
    // The path the flow file has to take is already a directory.
    mkdirSync(join(directory, "flows/triage/flow.ts"), { recursive: true })

    const result = await onDisk(directory, (store) => store.write("triage", files("triage")))

    expect(refused(result).code).toBe("write_failed")
  })

  it("skips what is in the flows directory but is not a saved flow", async () => {
    const directory = root()
    await onDisk(directory, (store) => store.write("triage", files("triage")))
    // A name no router could route, a routable name that is a file rather than
    // a flow directory, and a dangling link inside a flow: none of them is a
    // saved flow this store holds.
    writeFileSync(join(directory, "flows/README.md"), "")
    writeFileSync(join(directory, "flows/notes"), "")
    symlinkSync(join(directory, "flows/triage/missing.ts"), join(directory, "flows/triage/link.ts"))

    expect(await onDisk(directory, (store) => store.list())).toStrictEqual(Exit.succeed([
      { id: "triage", files: ["flows/triage/fixtures/triage.json", "flows/triage/flow.e2e.ts", "flows/triage/flow.ts"] }
    ]))
  })
})

describe("FlowStore layers", () => {
  it("provides the in-memory store", async () => {
    const written = new Map<string, string>()

    const result = await run(
      Effect.flatMap(FlowStore.FlowStore, (store) => store.write("triage", files("triage"))).pipe(
        Effect.provide(FlowStore.layerMemory(written))
      )
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(written.size).toBe(3)
  })

  it("provides the store that saves nothing", async () => {
    const result = await run(
      Effect.flatMap(FlowStore.FlowStore, (store) => store.list()).pipe(
        Effect.provide(FlowStore.layerNoop())
      )
    )

    expect(refused(result).code).toBe("unsupported")
  })
})

describe("FlowStore.makeNoop", () => {
  it("refuses every call with a message that says no flow was saved", async () => {
    const store = FlowStore.makeNoop()

    const result = refused(await run(store.write("triage", files("triage"))))

    expect(result.code).toBe("unsupported")
    expect(result.message).toContain("no flow was saved")
    expect(refused(await run(store.list())).code).toBe("unsupported")
  })

  it("takes one operation at a time", async () => {
    const store = FlowStore.makeNoop({ list: () => Effect.succeed([{ id: "triage", files: [] }]) })

    expect(await run(store.list())).toStrictEqual(Exit.succeed([{ id: "triage", files: [] }]))
    expect(refused(await run(store.write("triage", files("triage")))).code).toBe("unsupported")
  })
})

describe("FlowStore.validateId", () => {
  it("accepts the ids a flow directory can be named", async () => {
    for (const id of ["a", "triage", "weekly-digest", "pr2md", "a-1-b"]) {
      expect(Exit.isSuccess(await run(FlowStore.validateId(id)))).toBe(true)
    }
  })

  it("refuses everything else with the rule the model has to follow", async () => {
    for (const id of ["", "Triage", "1triage", "-triage", "flows/triage", "../escape", "triage_two"]) {
      expect(refused(await run(FlowStore.validateId(id))).code).toBe("invalid_id")
    }
    expect(refused(await run(FlowStore.validateId("Triage"))).message).toContain("lowercase letters")
  })
})
