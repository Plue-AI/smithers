/**
 * The filesystem artifact store's durability contract.
 *
 * These properties moved here from `@smthrs/engine-store`'s `StepBoundary`
 * along with the code (issues #117, #131, #132, #138, #144, #145): atomic
 * publication through temp+rename, unique temp paths per writer, healing
 * rewrites of a corrupt address, and the conservative orphan sweep. Two
 * properties are new, both from Bazel's `DiskCacheClient`: the two-hex fanout
 * layout and the fsync of the temp file before the rename. The
 * once-per-lifetime verification memo the code arrived with (issues #143,
 * #155) is gone: the objects directory is workspace-shared, and a remembered
 * proof let a `put` report success over a blob corrupted behind the store's
 * back without healing it, so verification now runs on every put.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { posix } from "node:path"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"
import { hostPath } from "./HostPath.ts"

const artifact = "shared-oversized-artifact-content"
const digest = sha256(bytes(artifact))
const blobPath = `.flows/objects/${digest.slice(0, 2)}/${digest}`

/**
 * An in-memory host filesystem with per-path instrumentation. Final state
 * alone cannot distinguish a dedupe skip from an unconditional rewrite, so the
 * read and write logs are what the memo cells assert on (issue #143).
 */
const memoryFs = (options: {
  readonly seed?: Record<string, string>
  readonly mtimes?: Record<string, number>
  readonly failRenameTo?: string
  readonly failReadOf?: string
  readonly vanishOnReadOf?: string
  readonly notFoundReadOf?: string
  readonly failExists?: boolean
  readonly failDirectoryRead?: boolean
  readonly supportsOpen?: boolean
  readonly failSyncOf?: (path: string) => boolean
} = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.seed ?? {}).map(([path, content]) => [path, bytes(content)])
  )
  const directories = new Set<string>([".", "/"])
  const createDirectories = (path: string): void => {
    if (directories.has(path)) return
    createDirectories(posix.dirname(path))
    directories.add(path)
  }
  for (const path of files.keys()) createDirectories(posix.dirname(path))
  const events: Array<{ op: "write" | "sync" | "rename" | "directory-sync"; path: string; to?: string }> = []
  // File data and directory entries persist independently. A synced child is
  // unreachable after a crash until every entry linking it to the root persists.
  const persistedEntries = new Set<string>([".", "/"])
  const persistedData = new Set<Uint8Array>()
  const reachable = (path: string): boolean =>
    persistedEntries.has(path) && (path === "." || path === "/" || reachable(posix.dirname(path)))
  const durable = (path: string): boolean =>
    reachable(path) && (directories.has(path) || persistedData.has(files.get(path)!))
  const writes: Array<string> = []
  const reads: Array<string> = []
  const syncs: Array<string> = []
  let directoryReads = 0
  const fs = FileSystem.makeNoop({
    exists: ((path: string) =>
      options.failExists === true
        ? Effect.fail(new Error("EIO: exists"))
        : Effect.succeed(files.has(path) || directories.has(path))) as never,
    readFile: ((path: string) =>
      Effect.suspend(() => {
        reads.push(path)
        if (path === options.notFoundReadOf) {
          return Effect.fail(PlatformError.systemError({
            _tag: "NotFound",
            module: "test",
            method: "readFile",
            pathOrDescriptor: path
          }))
        }
        if (path === options.vanishOnReadOf) {
          files.delete(path)
          return Effect.fail(new Error(`ENOENT: ${path}`))
        }
        return files.has(path) && path !== options.failReadOf
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      })) as never,
    makeDirectory: ((path: string) =>
      Effect.sync(() => {
        createDirectories(path)
      })) as never,
    readLink: () =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "test",
        method: "readLink",
        cause: { code: "EINVAL" }
      })),
    readDirectory: ((directory: string) =>
      Effect.suspend(() => {
        if (directory === ".flows/objects") {
          directoryReads++
        }
        if (options.failDirectoryRead === true) {
          return Effect.fail(new Error("ENOENT: no objects directory"))
        }
        const prefix = `${directory}/`
        return Effect.succeed([
          ...new Set(
            [...files.keys(), ...directories].filter((path) => path.startsWith(prefix))
              .map((path) => path.slice(prefix.length).split("/")[0]!)
          )
        ])
      })) as never,
    stat: ((path: string) =>
      Effect.suspend(() => {
        const directory = directories.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`))
        return directory || files.has(path)
          ? Effect.succeed({
            type: directory ? "Directory" : "File",
            dev: 1,
            ino: Option.some(1),
            mtime: Option.fromUndefinedOr(options.mtimes?.[path]).pipe(Option.map((ms) => new Date(ms)))
          })
          : Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "stat" }))
      })) as never,
    open: ((path: string, openOptions?: { flag?: string }) =>
      Effect.suspend(() => {
        if (options.supportsOpen === false) {
          return Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "open" }))
        }
        if (openOptions?.flag === "wx") {
          if (files.has(path)) {
            return Effect.fail(PlatformError.systemError({ _tag: "AlreadyExists", module: "test", method: "open" }))
          }
          if (!directories.has(posix.dirname(path))) {
            return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "open" }))
          }
          files.set(path, new Uint8Array())
        } else if (!files.has(path) && !directories.has(path)) {
          return Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "open" }))
        }
        return Effect.succeed({
          stat: fs.stat(path),
          writeAll: (content: Uint8Array) => fs.writeFile(path, content),
          sync: Effect.suspend(() => {
            if (options.failSyncOf?.(path) === true) {
              return Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "test",
                method: "sync",
                pathOrDescriptor: path,
                cause: { code: "EIO" }
              }))
            }
            events.push({ op: directories.has(path) ? "directory-sync" : "sync", path })
            if (directories.has(path)) {
              for (const entry of [...files.keys(), ...directories]) {
                if (posix.dirname(entry) === path) persistedEntries.add(entry)
              }
            } else {
              persistedData.add(files.get(path)!)
            }
            syncs.push(path)
            return Effect.void
          })
        })
      })) as never,
    writeFile: ((path: string, content: Uint8Array) =>
      Effect.sync(() => {
        writes.push(path)
        events.push({ op: "write", path })
        files.set(path, content)
      })) as never,
    writeFileString: (path, content) => fs.writeFile(path, bytes(content)),
    readFileString: (path) => Effect.map(fs.readFile(path), (content) => new TextDecoder().decode(content)),
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        if (to === options.failRenameTo) return Effect.fail(new Error(`EIO: ${to}`))
        const content = files.get(from)
        if (content === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
        events.push({ op: "rename", path: from, to })
        files.set(to, content)
        files.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, directories, writes, reads, syncs, events, durable, directoryReads: () => directoryReads, fs }
}

const store = (host: ReturnType<typeof memoryFs>, options?: ArtifactStore.FileSystemOptions) =>
  ArtifactStore.makeFileSystem(host.fs, hostPath, { durability: "best-effort", coordination: "process", ...options })

const tempsOf = (host: ReturnType<typeof memoryFs>) => [...host.files.keys()].filter((path) => path.includes(".tmp-"))

describe("content addressing and layout", () => {
  it.effect("publishes under a two-hex fanout directory, not one flat directory", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const published = yield* withCrypto(store(host).put(bytes(artifact)))
      expect(published).toBe(digest)
      expect(host.files.has(blobPath)).toBe(true)
      // The parent directory is created recursively before the temp write.
      expect(host.directories.has(`.flows/objects/${digest.slice(0, 2)}`)).toBe(true)
      // And the flat address the store used to publish at is gone for good.
      expect(host.files.has(`.flows/objects/${digest}`)).toBe(false)
    }))

  it.effect("honours a caller-supplied directory", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      yield* withCrypto(store(host, { directory: ".objects" }).put(bytes(artifact)))
      expect(host.files.has(`.objects/${digest.slice(0, 2)}/${digest}`)).toBe(true)
    }))

  it.effect("round-trips the bytes it stored", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))
})

describe("atomic publication (issues #117, #131, #138)", () => {
  it.effect("writes through a temp path and renames into place", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes).toHaveLength(1)
      expect(host.writes[0]!.includes(".tmp-")).toBe(true)
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("publishes its start-of-effect snapshot when the caller mutates during filesystem I/O", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const gated = FileSystem.makeNoop({
        ...host.fs,
        open: (path, options) =>
          host.fs.open(path, options).pipe(Effect.map((file) => ({
            ...file,
            writeAll: (content) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(file.writeAll(content))
              )
          })))
      })
      const input = bytes(artifact)
      const running = yield* withCrypto(
        ArtifactStore.makeFileSystem(gated, hostPath, {
          durability: "best-effort",
          coordination: "process"
        }).put(input)
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      input.fill(0)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(digest)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("gives two store instances distinct temp paths for one digest", () =>
    Effect.gen(function*() {
      // The cross-process shape: each instance's temp counter starts fresh,
      // exactly as two processes' counters both start at 0. Before the random
      // per-instance token, both wrote `<blob>.tmp-0`, one truncating open
      // clobbered the other's completed temp file, and the first rename
      // published torn bytes at the canonical content address (issue #131). The
      // latch pins that interleaving: neither writer may rename until both have
      // written their temp file.
      const host = memoryFs()
      const parked: Array<string> = []
      let release: (() => void) | undefined
      const bothWritten = new Promise<void>((resolve) => {
        release = resolve
      })
      const latched = FileSystem.makeNoop({
        ...host.fs,
        open: (path, options) =>
          host.fs.open(path, options).pipe(Effect.map((file) => ({
            ...file,
            writeAll: (content) =>
              Effect.promise(async () => {
                parked.push(path)
                host.files.set(path, content)
                host.writes.push(path)
                if (parked.length >= 2) release!()
                await bothWritten
              })
          })))
      })
      // Distinct filesystem service identities model separate processes: the
      // in-process digest lock cannot coordinate them, so their unique temp
      // paths remain the crash-safety boundary this test exercises.
      const firstProcess = FileSystem.makeNoop({ ...latched })
      const secondProcess = FileSystem.makeNoop({ ...latched })
      const exit = yield* withCrypto(
        Effect.all(
          [
            ArtifactStore.makeFileSystem(firstProcess, hostPath, {
              durability: "best-effort",
              coordination: "process"
            }).put(bytes(artifact)),
            ArtifactStore.makeFileSystem(secondProcess, hostPath, {
              durability: "best-effort",
              coordination: "process"
            }).put(bytes(artifact))
          ],
          { concurrency: 2 }
        ).pipe(Effect.exit)
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(new Set(parked).size).toBe(2)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("removes the temp file when the publishing rename fails", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failRenameTo: blobPath })
      const exit = yield* withCrypto(store(host).put(bytes(artifact)).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("fsyncs the temp file before renaming it, where the host has writable handles", () =>
    Effect.gen(function*() {
      // Bazel's `DiskCacheClient.saveFile`: "fsync temp before we rename it to
      // avoid data loss in the case of machine crashes (the OS may reorder the
      // writes and the rename)".
      const host = memoryFs({ supportsOpen: true })
      yield* withCrypto(store(host, { durability: "required" }).put(bytes(artifact)))
      const temp = host.writes[0]!
      expect(temp).toContain(".tmp-")
      expect(host.events).toEqual([
        { op: "write", path: temp },
        { op: "sync", path: temp },
        { op: "rename", path: temp, to: blobPath },
        ...[posix.dirname(blobPath), ".flows/objects", ".flows", "."].map((path) => ({ op: "directory-sync", path }))
      ])
      expect(host.durable(blobPath)).toBe(true)
    }))

  it.effect("fsyncs every ancestor of a Windows drive directory through the host Path", () =>
    Effect.gen(function*() {
      const directory = "D:\\store\\objects"
      const host = memoryFs({ supportsOpen: true })
      host.directories.add("D:\\store")
      host.directories.add("D:\\")
      yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
          Effect.provide(
            ArtifactStore.layerFileSystem({ directory, durability: "required" }).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)),
              Layer.provide(NodePath.layerWin32)
            )
          )
        )
      )
      expect(host.events.filter((event) => event.op === "directory-sync").map((event) => event.path)).toEqual([
        `${directory}/${digest.slice(0, 2)}`,
        directory,
        "D:\\store",
        "D:\\"
      ])
    }))

  it.effect("refuses publication on a host with no exclusive writable file handles", () =>
    Effect.gen(function*() {
      // Best-effort durability may skip sync, but cannot skip exclusive creation.
      const host = memoryFs({ supportsOpen: false })
      const exit = yield* withCrypto(store(host).put(bytes(artifact)).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.syncs).toEqual([])
      expect(host.files.has(blobPath)).toBe(false)
    }))

  it.effect("fake open rejects a missing path with a typed filesystem error", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const exit = yield* Effect.scoped(host.fs.open("missing", { flag: "r+" })).pipe(Effect.exit)
      expect(errorOf(exit)).toBeInstanceOf(PlatformError.PlatformError)
      expect(errorOf(exit)).toMatchObject({ reason: { _tag: "NotFound" } })
    }))

  it.effect("fake sync refusal is a typed PlatformError", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failSyncOf: () => true })
      const exit = yield* Effect.scoped(Effect.flatMap(host.fs.open(blobPath), (file) => file.sync)).pipe(Effect.exit)
      expect(errorOf(exit)).toBeInstanceOf(PlatformError.PlatformError)
      expect(errorOf(exit)).toMatchObject({ reason: { _tag: "Unknown", method: "sync" } })
    }))

  for (const barrier of ["temp", "fanout", "objects", "ancestor", "root"] as const) {
    for (const durability of ["required", "best-effort"] as const) {
      it.effect(`${durability} handles a typed ${barrier} sync refusal`, () =>
        Effect.gen(function*() {
          let refused = false
          const host = memoryFs({
            failSyncOf: (path) => {
              const match = barrier === "temp" ?
                path.includes(".tmp-") :
                path === (barrier === "fanout" ?
                  posix.dirname(blobPath) :
                  barrier === "objects"
                  ? ".flows/objects"
                  : barrier === "ancestor"
                  ? ".flows"
                  : ".")
              if (match) refused = true
              return match
            }
          })
          const exit = yield* withCrypto(store(host, { durability }).put(bytes(artifact))).pipe(Effect.exit)
          expect(refused).toBe(true)
          if (durability === "required") {
            expect(errorOf(exit)).toMatchObject({ _tag: "@smthrs/artifacts/ArtifactStoreError", code: "unavailable" })
            expect(tempsOf(host)).toEqual([])
          } else {
            expect(exit).toEqual(Exit.succeed(digest))
            expect(text(host.files.get(blobPath))).toBe(artifact)
          }
        }))
    }
  }

  for (const directory of [".flows/objects", "nested/cache/objects", "/nested/cache/objects"]) {
    for (const coordination of ["process", "required"] as const) {
      it.effect(`persists every directory entry in ${directory} with ${coordination} coordination`, () =>
        Effect.gen(function*() {
          const host = memoryFs()
          yield* withCrypto(store(host, { directory, coordination, durability: "required" }).put(bytes(artifact)))
          expect(host.durable(`${directory}/${digest.slice(0, 2)}/${digest}`)).toBe(true)
          if (coordination === "required") expect(host.durable(`${directory}/.locks`)).toBe(true)
        }))
    }
  }

  for (const barrier of [posix.dirname(blobPath), ".flows/objects", ".flows", "."]) {
    it.effect(`deduplicated retry repairs publication interrupted at ${barrier}`, () =>
      Effect.gen(function*() {
        let refuse = true
        const host = memoryFs({ failSyncOf: (path) => refuse && path === barrier })
        const failed = yield* withCrypto(store(host, { durability: "required" }).put(bytes(artifact))).pipe(Effect.exit)
        expect(errorOf(failed)).toMatchObject({ _tag: "@smthrs/artifacts/ArtifactStoreError", code: "unavailable" })
        expect(host.files.has(blobPath)).toBe(true)
        expect(host.durable(blobPath)).toBe(false)
        refuse = false
        host.events.length = 0
        // A fresh store cannot know which mkdir succeeded before the interruption.
        yield* withCrypto(store(host, { durability: "required" }).put(bytes(artifact)))
        expect(host.writes).toHaveLength(1)
        expect(host.events).toEqual([
          { op: "sync", path: blobPath },
          ...[posix.dirname(blobPath), ".flows/objects", ".flows", "."].map((path) => ({ op: "directory-sync", path }))
        ])
        expect(host.durable(blobPath)).toBe(true)
      }))
  }
})

describe("verification and healing (issues #132, #144, #145)", () => {
  it.effect("leaves a healthy existing blob unwritten", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact } })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("heals a corrupt existing blob at the canonical address", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("rewrites an existing blob the host cannot read back", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    }))

  it.effect("digest-verifies an existing blob on every put, never trusting a stale proof", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact } })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.reads.filter((path) => path === blobPath)).toHaveLength(2)
      expect(host.writes).toEqual([])
    }))

  it.effect("re-verifies even its own publication on the next put of the digest", () =>
    Effect.gen(function*() {
      // The objects directory is workspace-shared: this store's own atomic
      // rename proves nothing about what the blob holds by the time the next
      // put arrives, so the proof is re-measured rather than remembered.
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.reads.filter((path) => path === blobPath)).toHaveLength(1)
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    }))

  it.effect("heals a blob corrupted behind its back, even having verified the digest before", () =>
    Effect.gen(function*() {
      // The regression that killed the verification memo: with a remembered
      // proof, the third put reported success while the address kept serving
      // corrupt bytes, and no put would ever repair it.
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.set(blobPath, bytes("CORRUPTED"))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("heals on the put after a read found corruption", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.set(blobPath, bytes("torn-partial-bytes"))
      const refused = yield* withCrypto(artifacts.get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(refused)).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("rewrites on every put while the blob stays unreadable", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failReadOf: blobPath })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(Exit.isFailure(yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    }))

  it.effect("republishes when the blob vanishes behind its back", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.delete(blobPath)
      expect(Exit.isFailure(yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    }))
})

describe("the orphan sweep (issue #138)", () => {
  const stale = `.flows/objects/aa/old.tmp-dead-0`
  const fresh = `.flows/objects/aa/live.tmp-live-0`
  const staleLock = `.flows/objects/.locks/${"a".repeat(64)}.lock`
  const staleTombstone = `.flows/objects/.locks/${"b".repeat(64)}.lock.stale-dead-owner`
  const freshLock = `.flows/objects/.locks/${"c".repeat(64)}.lock`

  it.effect("reclaims lock files a hard-killed holder left behind, and keeps live ones", () =>
    Effect.gen(function*() {
      // A lock file is otherwise reclaimed only when another acquirer contends
      // for the same digest, and a digest nobody publishes again never gets
      // one. Without this the `.locks` directory grows without bound, which is
      // the exact failure the temp sweep exists to prevent.
      yield* TestClock.adjust("2 hours")
      const now = yield* Clock.currentTimeMillis
      const dead = now - 2 * 60 * 60 * 1000
      const host = memoryFs({
        seed: { [staleLock]: "dead-owner", [staleTombstone]: "dead-owner", [freshLock]: "live-owner" },
        mtimes: { [staleLock]: dead, [staleTombstone]: dead, [freshLock]: now }
      })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.files.has(staleLock)).toBe(false)
      expect(host.files.has(staleTombstone)).toBe(false)
      expect(host.files.has(freshLock)).toBe(true)
    }))

  it.effect("sweeps stale orphans on first put, keeps fresh temps, and sweeps once", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 hours")
      const now = yield* Clock.currentTimeMillis
      const host = memoryFs({
        seed: { [stale]: "torn", [fresh]: "in-flight" },
        mtimes: { [stale]: now - 2 * 60 * 60 * 1000, [fresh]: now }
      })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.files.has(stale)).toBe(false)
      expect(host.files.has(fresh)).toBe(true)
      yield* withCrypto(artifacts.put(bytes("a second artifact body")))
      expect(host.directoryReads()).toBe(1)
    }))

  it.effect("keeps a temp file whose age cannot be measured", () =>
    Effect.gen(function*() {
      // `stat` failing says nothing about the writer's liveness, so the
      // conservative sweep never deletes what it cannot age.
      const host = memoryFs({ seed: { [`.flows/objects/aa/unknown.tmp-mystery-0`]: "unknown-age" } })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.files.has(`.flows/objects/aa/unknown.tmp-mystery-0`)).toBe(true)
    }))

  it.effect("survives a directory it cannot list", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failDirectoryRead: true })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))
})

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown } | undefined)?.error
}

describe("reads, probes, and refusals", () => {
  it.effect("round-trips a zero-byte artifact", () =>
    Effect.gen(function*() {
      // A step that spills an empty output is an ordinary publication: the
      // empty digest is a real address, and nothing along the write, read, or
      // verify path may treat "no bytes" as "no artifact".
      const host = memoryFs()
      const artifacts = store(host)
      const empty = yield* withCrypto(artifacts.put(new Uint8Array(0)))
      expect(empty).toBe(sha256(new Uint8Array(0)))
      expect(yield* withCrypto(artifacts.has(empty))).toBe(true)
      expect((yield* withCrypto(artifacts.get(empty))).byteLength).toBe(0)
    }))

  it.effect("reports a typed miss for an address it does not hold", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
    }))

  it.effect("reports typed corruption when the bytes no longer hash to the address", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      const error = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(error._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(error.recordedDigest).toBe(digest)
      expect(error.measuredDigest).toBe(sha256(bytes("torn-partial-bytes")))
    }))

  it.effect("surfaces a host refusal as an ordinary store failure, not corruption", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
    }))

  it.effect("classifies a blob removed between lookup and read as a typed miss", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, vanishOnReadOf: blobPath })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect(errorOf(exit)).toMatchObject({
        _tag: "@smthrs/artifacts/ArtifactMissing",
        code: "artifact_missing",
        digest
      })
    }))

  it.effect("maps a host-native NotFound read directly to a typed miss", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, notFoundReadOf: blobPath })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect(errorOf(exit)).toMatchObject({
        _tag: "@smthrs/artifacts/ArtifactMissing",
        digest
      })
    }))

  it.effect("retains both read and existence-probe failures as unavailable", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath, failExists: true })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect(errorOf(exit), JSON.stringify(exit)).toMatchObject({ code: "unavailable" })
    }))

  it.effect.each<[string, string]>([
    ["an empty string", ""],
    ["a short non-digest", "not-a-sha256-digest"],
    ["an uppercase digest", digest.toUpperCase()],
    ["a whitespace-padded digest", ` ${digest}`],
    ["a control-character digest", `${digest.slice(0, 63)}\n`],
    ["a unicode digest", `${digest.slice(0, 63)}é`],
    ["a query-shaped digest", `${digest}?token=secret`],
    ["a fragment-shaped digest", `${digest}#fragment`],
    ["a percent-encoded digest", `${digest.slice(0, 62)}%2f`],
    ["a path separator", "ab/cd"],
    ["a windows separator", "ab\\cd"],
    ["the current directory", "."],
    ["the parent directory", ".."]
  ])("refuses %s as a content address", ([_label, candidate]) =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      const exits: Array<Exit.Exit<unknown, unknown>> = [
        yield* withCrypto(artifacts.get(candidate).pipe(Effect.exit)),
        yield* withCrypto(artifacts.has(candidate).pipe(Effect.exit))
      ]
      for (const exit of exits) {
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
      }
    }))

  it.effect("answers `has` from the canonical address", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      expect(yield* withCrypto(artifacts.has(digest))).toBe(false)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("bounds concurrent batch probes and preserves first-request order", () =>
    Effect.gen(function*() {
      const requested = Array.from({ length: 40 }, (_, i) => (39 - i).toString(16).padStart(64, "0"))
      const calls: Array<string> = []
      const completed: Array<string> = []
      let active = 0
      let peak = 0
      let elapsed = 0
      const fs = FileSystem.makeNoop({
        exists: (path) =>
          Effect.gen(function*() {
            const digest = path.slice(path.lastIndexOf("/") + 1)
            calls.push(digest)
            peak = Math.max(peak, ++active)
            yield* Effect.sleep(digest === requested[0] ? "10 millis" : "1 milli")
            active--
            completed.push(digest)
            return digest === requested[3]
          })
      })
      const artifacts = ArtifactStore.makeFileSystem(fs, hostPath)
      const running = yield* Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        const missing = yield* artifacts.findMissing([...requested, requested[0]!, requested[3]!])
        elapsed = (yield* Clock.currentTimeMillis) - start
        return missing
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(running)).toEqual(requested.filter((digest) => digest !== requested[3]))
      expect(calls).toEqual(requested)
      expect(elapsed).toBeLessThanOrEqual(10)
      expect(completed[0]).not.toBe(requested[0])
      expect(peak).toBe(16)
      expect(active).toBe(0)
    }))

  it.effect("validates the entire batch before probing the filesystem", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const fs = FileSystem.makeNoop({
        exists: (path) =>
          Effect.sync(() => {
            calls.push(path)
            return false
          })
      })
      const exit = yield* ArtifactStore.makeFileSystem(fs, hostPath).findMissing([digest, "invalid"]).pipe(Effect.exit)
      expect(errorOf(exit)).toMatchObject({ code: "invalid_digest" })
      expect(calls).toEqual([])
    }))

  it.effect("keeps batch probe failures as typed store failures", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failExists: true })
      const exit = yield* store(host).findMissing([digest, sha256(bytes("absent"))]).pipe(Effect.exit)
      expect(errorOf(exit)).toMatchObject({ code: "unavailable" })
    }))

  it.effect("returns a deduplicated subset of the probed digests", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const absent = sha256(bytes("never stored"))
      const missing = yield* withCrypto(artifacts.findMissing([digest, absent, absent, digest]))
      expect(missing).toEqual([absent])
    }))
})

describe("layers", () => {
  it.effect("layerFileSystem builds the store from the FileSystem tag", () =>
    Effect.gen(function*() {
      const host = memoryFs({ supportsOpen: true })
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
          Effect.provide(
            ArtifactStore.layerFileSystem({ coordination: "process" }).pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)),
              Layer.provide(NodePath.layer)
            )
          )
        )
      )
      expect(published).toBe(digest)
      expect(host.files.has(blobPath)).toBe(true)
    }))
})

describe("Node filesystem publication security", () => {
  it.live("creates private payloads and directories under umask 022, with explicit sharing options", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-modes-" })
      yield* Effect.acquireRelease(
        Effect.sync(() => process.umask(0o022)),
        (previous) => Effect.sync(() => process.umask(previous))
      )
      for (const sharing of [false, true]) {
        const directory = `${root}/${sharing ? "shared" : "private"}/objects`
        const artifacts = ArtifactStore.makeFileSystem(fs, hostPath, {
          directory,
          ...(sharing ? { fileMode: 0o640, directoryMode: 0o750 } : {})
        })
        yield* artifacts.put(bytes(artifact))
        const empty = yield* artifacts.put(new Uint8Array())
        expect((yield* artifacts.get(empty)).byteLength).toBe(0)
        const fan = `${directory}/${digest.slice(0, 2)}`
        for (const path of [directory, fan]) {
          expect((yield* fs.stat(path)).mode & 0o777).toBe(sharing ? 0o750 : 0o700)
        }
        expect((yield* fs.stat(`${directory}/.locks`)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(`${fan}/${digest}`)).mode & 0o777).toBe(sharing ? 0o640 : 0o600)
      }
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  it.live("retries a preplanted scratch symlink without touching its target or removing the collision", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-collision-" })
      const victim = `${root}/victim`
      yield* fs.writeFileString(victim, "unrelated data")
      const attempts: Array<string> = []
      const hostile = {
        ...fs,
        open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
          Effect.gen(function*() {
            if (options?.flag === "wx") {
              attempts.push(path)
              expect(options.mode).toBe(0o600)
              if (attempts.length === 1) yield* fs.symlink(victim, path)
            }
            return yield* fs.open(path, options)
          })
      }
      const directory = `${root}/objects`
      yield* ArtifactStore.makeFileSystem(hostile, hostPath, { directory }).put(bytes(artifact))
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).not.toBe(attempts[1])
      expect(yield* fs.readLink(attempts[0]!)).toBe(victim)
      expect(yield* fs.readFileString(victim)).toBe("unrelated data")
      expect(yield* fs.readFileString(`${directory}/${digest.slice(0, 2)}/${digest}`)).toBe(artifact)
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  it.live("bounds collision retries without deleting another writer's files", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-collisions-" })
      const paths: Array<string> = []
      const hostile = {
        ...fs,
        open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
          Effect.gen(function*() {
            if (options?.flag === "wx") {
              paths.push(path)
              yield* fs.writeFileString(path, "other writer", { flag: "wx" })
            }
            return yield* fs.open(path, options)
          })
      }
      const exit = yield* ArtifactStore.makeFileSystem(hostile, hostPath, { directory: `${root}/objects` }).put(
        bytes(artifact)
      )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      expect(reason?._tag === "Fail" && reason.error.message).toBe(
        "artifact scratch creation exhausted collision retries"
      )
      expect(paths).toHaveLength(16)
      for (const path of paths) expect(yield* fs.readFileString(path)).toBe("other writer")
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  for (const entry of ["root", "fanout", "locks", "blob"] as const) {
    it.live(`refuses a pre-existing ${entry} symlink before publication`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-link-" })
        const directory = `${root}/objects`
        const outside = `${root}/outside`
        yield* fs.makeDirectory(outside)
        yield* fs.makeDirectory(`${directory}/${digest.slice(0, 2)}`, { recursive: true })
        const path = entry === "root" ? directory : entry === "locks" ?
          `${directory}/.locks`
          : entry === "fanout"
          ? `${directory}/${digest.slice(0, 2)}`
          : `${directory}/${digest.slice(0, 2)}/${digest}`
        yield* fs.remove(path, { recursive: true, force: true })
        const target = entry === "blob" ? `${outside}/victim` : outside
        if (entry === "blob") yield* fs.writeFileString(target, artifact)
        yield* fs.symlink(target, path)
        const exit = yield* ArtifactStore.makeFileSystem(fs, hostPath, { directory: `${directory}/` }).put(
          bytes(artifact)
        ).pipe(
          Effect.exit
        )
        expect(errorOf(exit), JSON.stringify(exit)).toMatchObject({ code: "unavailable" })
        expect(yield* fs.readDirectory(outside)).toEqual(entry === "blob" ? ["victim"] : [])
        if (entry === "blob") expect(yield* fs.readFileString(target)).toBe(artifact)
      })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
  }

  for (const entry of ["root", "fanout"] as const) {
    it.live(`refuses ${entry} replacement after writing and before rename`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-replacement-" })
        const directory = `${root}/objects`
        const outside = `${root}/outside`
        yield* fs.makeDirectory(outside)
        const hostile = {
          ...fs,
          open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
            fs.open(path, options).pipe(
              Effect.map((file) =>
                options?.flag !== "wx" ? file : {
                  ...file,
                  stat: file.stat,
                  writeAll: (data: Uint8Array) => file.writeAll(data),
                  sync: file.sync.pipe(Effect.andThen(Effect.gen(function*() {
                    const replaced = entry === "root" ? directory : `${directory}/${digest.slice(0, 2)}`
                    yield* fs.rename(replaced, `${replaced}-saved`)
                    yield* fs.symlink(outside, replaced)
                  })))
                }
              )
            )
        }
        const exit = yield* ArtifactStore.makeFileSystem(hostile, hostPath, { directory, coordination: "process" }).put(
          bytes(artifact)
        ).pipe(Effect.exit)
        expect(errorOf(exit), JSON.stringify(exit)).toMatchObject({ code: "unavailable" })
        expect(yield* fs.readDirectory(outside)).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
  }

  it.live("keeps the opened handle when a scratch name is replaced during the write", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-handle-" })
      const victim = `${root}/victim`
      yield* fs.writeFileString(victim, "unrelated data")
      const hostile = {
        ...fs,
        open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
          fs.open(path, options).pipe(
            Effect.map((file) =>
              options?.flag !== "wx" ? file : {
                ...file,
                stat: file.stat,
                sync: file.sync,
                writeAll: (data: Uint8Array) =>
                  fs.remove(path).pipe(
                    Effect.andThen(fs.symlink(victim, path)),
                    Effect.andThen(file.writeAll(data))
                  )
              }
            )
          )
      }
      const exit = yield* ArtifactStore.makeFileSystem(hostile, hostPath, { directory: `${root}/objects` }).put(
        bytes(artifact)
      )
        .pipe(Effect.exit)
      expect(errorOf(exit), JSON.stringify(exit)).toMatchObject({ code: "unavailable" })
      expect(yield* fs.readFileString(victim)).toBe("unrelated data")
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))

  it.live("skips orphan cleanup through symlinked fanouts and scratch entries", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-orphans-" })
      const directory = `${root}/objects`
      const outside = `${root}/outside`
      yield* fs.makeDirectory(outside)
      yield* fs.makeDirectory(`${directory}/bb`, { recursive: true })
      yield* fs.writeFileString(`${outside}/old.tmp-dead`, "keep")
      yield* fs.utimes(`${outside}/old.tmp-dead`, new Date(0), new Date(0))
      yield* fs.symlink(outside, `${directory}/aa`)
      yield* fs.symlink(`${outside}/old.tmp-dead`, `${directory}/bb/link.tmp-dead`)
      yield* ArtifactStore.makeFileSystem(fs, hostPath, { directory }).put(bytes(artifact))
      expect(yield* fs.readFileString(`${outside}/old.tmp-dead`)).toBe("keep")
      expect(yield* fs.readLink(`${directory}/bb/link.tmp-dead`)).toBe(`${outside}/old.tmp-dead`)
    })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
})

describe("filesystem capability refusals", () => {
  it.effect("reports unsupported symlink inspection as unavailable", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const fs = {
        ...host.fs,
        readLink: () =>
          Effect.fail(PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "test",
            method: "readLink"
          }))
      }
      const exit = yield* withCrypto(ArtifactStore.makeFileSystem(fs, hostPath).put(bytes(artifact))).pipe(Effect.exit)
      expect(errorOf(exit)).toMatchObject({ code: "unavailable" })
      expect(host.writes).toEqual([])
    }))

  it.effect("best-effort durability still publishes if syncing the retained handle fails", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failSyncOf: () => true })
      expect(yield* withCrypto(store(host).put(bytes(artifact)))).toBe(digest)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("skips unreadable orphan directories and foreign nested entries", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { ".flows/objects/aa/old.tmp-dead": "keep", ".flows/objects/README": "foreign" } })
      for (const entries of [undefined, ["../victim.tmp-dead", "..\\victim.tmp-dead"]]) {
        const fs = {
          ...host.fs,
          readDirectory: (path: string) =>
            path.endsWith("/aa")
              ? entries === undefined
                ? Effect.fail(
                  PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "readDirectory" })
                )
                : Effect.succeed(entries)
              : host.fs.readDirectory(path)
        }
        const body = entries === undefined ? artifact : "second"
        yield* withCrypto(ArtifactStore.makeFileSystem(fs, hostPath, { coordination: "process" }).put(bytes(body)))
      }
      expect(text(host.files.get(".flows/objects/aa/old.tmp-dead"))).toBe("keep")
    }))

  for (const replacement of ["directory", "missing", "file"] as const) {
    it.live(`refuses a fanout replaced with ${replacement} after scratch sync`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-identity-" })
        const directory = `${root}/objects`
        const parent = `${directory}/${digest.slice(0, 2)}`
        const hostile = {
          ...fs,
          open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
            fs.open(path, options).pipe(
              Effect.map((file) =>
                options?.flag !== "wx" ? file : {
                  ...file,
                  stat: file.stat,
                  writeAll: (data: Uint8Array) => file.writeAll(data),
                  sync: file.sync.pipe(Effect.andThen(Effect.gen(function*() {
                    yield* fs.rename(parent, `${parent}-saved`)
                    if (replacement === "directory") yield* fs.makeDirectory(parent)
                    if (replacement === "file") yield* fs.writeFileString(parent, "foreign")
                  })))
                }
              )
            )
        }
        const exit = yield* ArtifactStore.makeFileSystem(hostile, hostPath, { directory, coordination: "process" }).put(
          bytes(artifact)
        ).pipe(Effect.exit)
        expect(errorOf(exit)).toMatchObject({ code: "unavailable" })
        if (replacement === "directory") expect(yield* fs.readDirectory(parent)).toEqual([])
        if (replacement === "file") expect(yield* fs.readFileString(parent)).toBe("foreign")
      })).pipe(Effect.provide(NodeFileSystem.layer), withCrypto))
  }
})

it.effect("fails closed when directory metadata cannot be inspected", () =>
  Effect.gen(function*() {
    const host = memoryFs()
    const fs = {
      ...host.fs,
      stat: () =>
        Effect.fail(PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "test",
          method: "stat"
        }))
    }
    const exit = yield* withCrypto(ArtifactStore.makeFileSystem(fs, hostPath).put(bytes(artifact))).pipe(Effect.exit)
    expect(errorOf(exit)).toMatchObject({ code: "unavailable" })
    expect(host.writes).toEqual([])
  }))
