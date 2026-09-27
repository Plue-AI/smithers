/**
 * The sweep surface's contract, and the `put`-side freshening it depends on.
 *
 * The mechanics mirror the two references named in the module: Bazel's
 * disk-cache collector walks the local directory and fences on mtime, and git
 * freshens a loose object's mtime when a write deduplicates against it so
 * `git prune`'s expiry window keeps protecting re-referenced bytes.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
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
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactSweep from "../src/ArtifactSweep.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"
import { hostPath } from "./HostPath.ts"

const artifact = "sweepable-artifact-content"
const digest = sha256(bytes(artifact))
const blobPath = `.flows/objects/${digest.slice(0, 2)}/${digest}`

const other = "second-sweepable-artifact"
const otherDigest = sha256(bytes(other))
const otherPath = `.flows/objects/${otherDigest.slice(0, 2)}/${otherDigest}`

const systemError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method })

/**
 * An in-memory host filesystem tracking per-path mtimes, so the sweep's age
 * fence and the store's freshening are observable without a real clock or
 * disk. Writes and renames stamp the wall clock the way a real filesystem
 * does; `utimes` re-stamps explicitly, which is the freshen.
 */
const memoryFs = (options: {
  readonly seed?: Record<string, string>
  readonly mtimes?: Record<string, number>
  readonly withoutMtimeFor?: string
  readonly utimesUnsupported?: boolean
  readonly utimesVanishes?: boolean
  /** Extra entries the directory listing reports as subdirectories. */
  readonly directories?: ReadonlyArray<string>
  /** Extra listed entries whose stat then fails — vanished between the two. */
  readonly phantoms?: ReadonlyArray<string>
  readonly failRemoveOf?: string
  readonly failExists?: boolean
  /** Existence probes succeed this many times, then start failing. */
  readonly failExistsAfter?: number
} = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.seed ?? {}).map(([path, content]) => [path, bytes(content)])
  )
  const mtimes = new Map<string, number>(Object.entries(options.mtimes ?? {}))
  const writes: Array<string> = []
  const utimesCalls: Array<string> = []
  let existsCalls = 0
  const hooks: { beforeRemove?: ((path: string) => Effect.Effect<void>) | undefined } = {}
  const fs = FileSystem.makeNoop({
    exists: ((path: string) =>
      Effect.suspend(() => {
        existsCalls++
        const budget = options.failExistsAfter
        if (options.failExists === true || (budget !== undefined && existsCalls > budget)) {
          return Effect.fail(new Error(`EIO: ${path}`))
        }
        return Effect.succeed(files.has(path))
      })) as never,
    readFile: ((path: string) =>
      Effect.suspend(() =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      )) as never,
    makeDirectory: (() => Effect.void) as never,
    readLink: () =>
      Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "test",
        method: "readLink",
        cause: { code: "EINVAL" }
      })),
    open: ((path: string, options?: { flag?: string }) =>
      Effect.suspend(() => {
        if (options?.flag === "wx") {
          if (files.has(path)) return Effect.fail(systemError("AlreadyExists", "open"))
          files.set(path, new Uint8Array())
        }
        return Effect.succeed({
          stat: fs.stat(path),
          writeAll: (content: Uint8Array) => fs.writeFile(path, content),
          sync: Effect.void
        })
      })) as never,
    readDirectory: ((directory: string) =>
      Effect.suspend(() => {
        const prefix = `${directory}/`
        return Effect.succeed([
          ...new Set(
            [
              ...files.keys(),
              ...(options.directories ?? []).map((path) => `.flows/objects/${path}`),
              ...(options.phantoms ?? []).map((path) => `.flows/objects/${path}`)
            ].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!)
          )
        ])
      })) as never,
    stat: ((path: string) =>
      Effect.suspend(() => {
        const relative = path.startsWith(".flows/objects/") ? path.slice(".flows/objects/".length) : path
        if (
          path === ".flows/objects" || /^\.flows\/objects\/[0-9a-f]{2}$/.test(path) ||
          options.directories?.includes(relative) === true
        ) {
          return Effect.succeed({
            type: "Directory",
            dev: 1,
            ino: Option.some(1),
            mtime: Option.some(new Date(0)),
            size: BigInt(0)
          })
        }
        return files.has(path)
          ? Effect.succeed({
            type: "File",
            dev: 1,
            ino: Option.some(1),
            mtime: path === options.withoutMtimeFor
              ? Option.none()
              : Option.some(new Date(mtimes.get(path) ?? 0)),
            size: BigInt(files.get(path)!.length)
          })
          : Effect.fail(systemError("NotFound", "stat"))
      })) as never,
    utimes: ((path: string, _atime: Date | number, mtime: Date | number) =>
      Effect.suspend(() => {
        utimesCalls.push(path)
        if (options.utimesVanishes === true) {
          files.delete(path)
          return Effect.fail(new Error(`ENOENT: ${path}`))
        }
        if (options.utimesUnsupported === true || !files.has(path)) {
          return Effect.fail(new Error(`ENOTSUP: utimes ${path}`))
        }
        mtimes.set(path, typeof mtime === "number" ? mtime : mtime.getTime())
        return Effect.void
      })) as never,
    writeFile: ((path: string, content: Uint8Array) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          writes.push(path)
          files.set(path, content)
          mtimes.set(path, now)
        }))) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        const content = files.get(from)
        if (content === undefined) {
          return Effect.fail(new Error(`ENOENT: ${from}`))
        }
        return Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            files.set(to, content)
            mtimes.set(to, now)
            files.delete(from)
          }))
      })) as never,
    remove: ((path: string) =>
      Effect.suspend(() => {
        if (path === options.failRemoveOf) {
          return Effect.fail(new Error(`EIO: ${path}`))
        }
        const hook = hooks.beforeRemove === undefined ? Effect.void : hooks.beforeRemove(path)
        return hook.pipe(Effect.andThen(Effect.suspend(() =>
          files.delete(path)
            ? Effect.void
            : Effect.fail(new Error(`ENOENT: ${path}`))
        )))
      })) as never
  })
  return { files, mtimes, writes, utimesCalls, hooks, fs }
}

const sweepFor = (host: ReturnType<typeof memoryFs>) =>
  ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })

describe("inventory", () => {
  it.effect("bounds concurrent metadata reads while preserving order and conservative skips", () =>
    Effect.gen(function*() {
      const digests = Array.from({ length: 40 }, (_, i) => `aa${(39 - i).toString(16).padStart(62, "0")}`)
      const paths = digests.map((digest) => `.flows/objects/aa/${digest}`)
      const host = memoryFs({
        seed: Object.fromEntries(paths.filter((_, i) => i !== 2 && i !== 4).map((path) => [path, artifact])),
        withoutMtimeFor: paths[1]!,
        phantoms: [`aa/${digests[2]}`],
        directories: [`aa/${digests[4]}`]
      })
      const calls: Array<string> = []
      const completed: Array<string> = []
      let active = 0
      let peak = 0
      let elapsed = 0
      const fs = {
        ...host.fs,
        readDirectory: (path: string) =>
          path === ".flows/objects/aa"
            ? Effect.succeed([...digests, `${digests[0]}.tmp-abc`, "foreign", `bb${"0".repeat(62)}`])
            : host.fs.readDirectory(path),
        stat: (path: string) =>
          paths.includes(path)
            ? Effect.gen(function*() {
              calls.push(path)
              peak = Math.max(peak, ++active)
              yield* Effect.sleep(path === paths[0] ? "10 millis" : "1 milli")
              active--
              completed.push(path)
              if (path === paths[3]) return yield* Effect.fail(systemError("PermissionDenied", "stat"))
              return yield* host.fs.stat(path)
            })
            : host.fs.stat(path)
      }
      const running = yield* Effect.gen(function*() {
        const start = yield* Clock.currentTimeMillis
        const listed = yield* ArtifactSweep.makeFileSystem(fs).inventory
        elapsed = (yield* Clock.currentTimeMillis) - start
        return listed
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(running)).toEqual(
        digests.filter((_, i) => i === 0 || i > 4).map((digest) => ({
          digest,
          modifiedAtMs: 0,
          sizeBytes: bytes(artifact).length
        }))
      )
      expect(new Set(calls)).toEqual(new Set(paths))
      expect(elapsed).toBeLessThanOrEqual(20)
      expect(completed[0]).not.toBe(paths[0])
      expect(peak).toBe(16)
      expect(active).toBe(0)
    }))

  it.effect("lists blobs with their age and size, and nothing else", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          [otherPath]: other,
          // A crashed writer's scratch file, a foreign file, and a blob filed
          // under the wrong fanout are all invisible to the sweep.
          [`${blobPath}.tmp-abc123-0`]: "in-flight",
          ".flows/objects/README": "not a blob",
          [`.flows/objects/zz/${digest}`]: artifact
        },
        mtimes: { [blobPath]: 1_000, [otherPath]: 2_000 }
      })
      const listed = yield* withCrypto(sweepFor(host).inventory)
      expect(listed.map((blob) => [blob.digest, blob.modifiedAtMs, blob.sizeBytes])).toEqual([
        [digest, 1_000, bytes(artifact).length],
        [otherDigest, 2_000, bytes(other).length]
      ])
    }))

  it.effect("reports an empty inventory when the store never published", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      expect(yield* withCrypto(sweepFor(host).inventory)).toEqual([])
    }))

  it.effect("reports an empty inventory when the objects directory cannot be read", () =>
    Effect.gen(function*() {
      const failing = FileSystem.makeNoop({
        readDirectory: (() => Effect.fail(systemError("NotFound", "readDirectory"))) as never
      })
      expect(yield* withCrypto(ArtifactSweep.makeFileSystem(failing).inventory)).toEqual([])
    }))

  it.effect("fails inventory when the objects directory cannot be read for another reason", () =>
    Effect.gen(function*() {
      const failing = FileSystem.makeNoop({
        readDirectory: (() => Effect.fail(systemError("PermissionDenied", "readDirectory"))) as never
      })
      const exit = yield* withCrypto(ArtifactSweep.makeFileSystem(failing).inventory.pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("excludes foreign files that are not lowercase SHA-256 addresses", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          ".flows/objects/ab/abc": "foreign",
          [`.flows/objects/${digest.slice(0, 2)}/${digest.toUpperCase()}`]: "foreign"
        },
        mtimes: { [blobPath]: 1_000 }
      })
      const listed = yield* withCrypto(sweepFor(host).inventory)
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))

  it.effect("excludes a blob whose age the host cannot measure", () =>
    Effect.gen(function*() {
      // No mtime means no age evidence, and the sweep must never judge what it
      // cannot measure — the same conservatism as the orphan-temp sweep.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        withoutMtimeFor: blobPath
      })
      expect(yield* withCrypto(sweepFor(host).inventory)).toEqual([])
    }))

  it.effect("skips nested paths, directories at blob addresses, and vanished entries", () =>
    Effect.gen(function*() {
      const directoryShaped = `ab/ab${"c".repeat(62)}`
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          // A path nested one level too deep is not in the fanout shape.
          [`.flows/objects/${digest.slice(0, 2)}/extra/${digest}`]: artifact
        },
        mtimes: { [blobPath]: 1_000 },
        // A directory that happens to sit at a blob-shaped path, and an entry
        // removed between the listing and its stat.
        directories: [directoryShaped],
        phantoms: [`${otherDigest.slice(0, 2)}/${otherDigest}`]
      })
      const listed = yield* withCrypto(sweepFor(host).inventory)
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))
})

describe("fenced removal", () => {
  it.effect("removes a blob and reports the deletion", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const sweep = sweepFor(host)
      expect(yield* withCrypto(sweep.remove(digest))).toBe(true)
      expect(host.files.has(blobPath)).toBe(false)
      // Removing what is already gone is a completed deletion, not a failure —
      // a crashed sweep re-runs over its own progress.
      expect(yield* withCrypto(sweep.remove(digest))).toBe(false)
    }))

  it.effect("refuses the fence when the blob was freshened past the bound", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 5_000 } })
      const sweep = sweepFor(host)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 4_000 }))).toBe(false)
      expect(host.files.has(blobPath)).toBe(true)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 5_000 }))).toBe(true)
      expect(host.files.has(blobPath)).toBe(false)
    }))

  it.effect("serializes a concurrent put with fenced deletion so the digest remains readable", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      host.hooks.beforeRemove = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const sweep = sweepFor(host)
      const store = ArtifactStore.makeFileSystem(host.fs, hostPath, {
        durability: "best-effort",
        coordination: "process"
      })

      const removing = yield* sweep.remove(digest, { ifUnmodifiedSinceMs: 1_000 }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      const publishing = yield* withCrypto(store.put(bytes(artifact))).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(publishing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(removing)).toBe(true)
      expect(yield* Fiber.join(publishing)).toBe(digest)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("refuses the fence when the blob's age cannot be measured", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, withoutMtimeFor: blobPath })
      const sweep = sweepFor(host)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: Number.MAX_SAFE_INTEGER }))).toBe(false)
      expect(host.files.has(blobPath)).toBe(true)
    }))

  it.effect("refuses the fence when the blob is already gone", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const sweep = sweepFor(host)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: Number.MAX_SAFE_INTEGER }))).toBe(false)
    }))

  it.effect("rejects an address that is not usable as a path segment", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const exit = yield* withCrypto(
        sweepFor(host).remove("../escape").pipe(Effect.exit)
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("fails when the host refuses to delete bytes that still exist", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        failRemoveOf: blobPath
      })
      const exit = yield* withCrypto(sweepFor(host).remove(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.files.has(blobPath)).toBe(true)
    }))

  it.effect("fails when a deletion refusal cannot be verified by an existence probe", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        failRemoveOf: blobPath,
        failExists: true
      })
      const exit = yield* withCrypto(sweepFor(host).remove(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("layers", () => {
  it.effect("provides the filesystem sweep through the service tag", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const listed = yield* withCrypto(
        Effect.gen(function*() {
          const sweep = yield* ArtifactSweep.ArtifactSweep
          return yield* sweep.inventory
        }).pipe(
          Effect.provide(
            ArtifactSweep.layerFileSystem().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)))
          )
        )
      )
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))

  it.effect("fails every no-op operation while honouring overrides", () =>
    Effect.gen(function*() {
      const overridden = ArtifactSweep.makeNoop({ inventory: Effect.succeed([]) })
      expect(yield* withCrypto(overridden.inventory)).toEqual([])
      const noop = yield* withCrypto(
        Effect.gen(function*() {
          const sweep = yield* ArtifactSweep.ArtifactSweep
          const listed = yield* sweep.inventory.pipe(Effect.exit)
          const removed = yield* sweep.remove(digest).pipe(Effect.exit)
          return [Exit.isFailure(listed), Exit.isFailure(removed)]
        }).pipe(Effect.provide(ArtifactSweep.layerNoop()))
      )
      expect(noop).toEqual([true, true])
    }))
})

describe("put freshens a deduplicated blob (git's loose-object freshening)", () => {
  it.effect("re-stamps the mtime instead of rewriting, so the grace fence protects it", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const store = ArtifactStore.makeFileSystem(host.fs, hostPath, {
        durability: "best-effort",
        coordination: "process"
      })
      yield* TestClock.adjust("2 seconds")
      const before = yield* Clock.currentTimeMillis
      yield* withCrypto(store.put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(host.utimesCalls).toEqual([blobPath])
      expect(host.mtimes.get(blobPath)!).toBeGreaterThanOrEqual(before)
      // The liveness half: a sweep that computed its bound before the freshen
      // now fails its fence, exactly like a laggard's fenced cache evict.
      const sweep = sweepFor(host)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 1_000 }))).toBe(false)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("keeps the dedupe skip on a host without utimes while the blob exists", () =>
    Effect.gen(function*() {
      // The browser filesystem fails `utimes` rather than pretending. Such a
      // host forgoes freshening — and accepts git's freshen-versus-prune race —
      // but must not pay a rewrite on every deduplicated put.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesUnsupported: true
      })
      yield* withCrypto(
        ArtifactStore.makeFileSystem(host.fs, hostPath, { durability: "best-effort", coordination: "process" }).put(
          bytes(artifact)
        )
      )
      expect(host.writes).toEqual([])
      expect(host.mtimes.get(blobPath)).toBe(1_000)
    }))

  it.effect("keeps the dedupe skip when the freshen and the existence probe both fail", () =>
    Effect.gen(function*() {
      // Neither call proves the blob is gone, so the verified proof stands —
      // rewriting on a flaky probe would trade every dedupe on such a host for
      // a spurious republication.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesUnsupported: true,
        failExistsAfter: 1
      })
      yield* withCrypto(
        ArtifactStore.makeFileSystem(host.fs, hostPath, { durability: "best-effort", coordination: "process" }).put(
          bytes(artifact)
        )
      )
      expect(host.writes).toEqual([])
      expect(host.mtimes.get(blobPath)).toBe(1_000)
    }))

  it.effect("republishes when the blob vanished between verification and freshen", () =>
    Effect.gen(function*() {
      // The sweep won the race: the blob existed at the dedupe check and was
      // gone by the freshen. Trusting the stale proof would return a digest
      // nothing can read; the failed freshen drops it and the atomic rewrite
      // heals the address.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesVanishes: true
      })
      const published = yield* withCrypto(
        ArtifactStore.makeFileSystem(host.fs, hostPath, { durability: "best-effort", coordination: "process" }).put(
          bytes(artifact)
        )
      )
      expect(published).toBe(digest)
      expect(host.writes).toHaveLength(1)
      expect(host.writes[0]!.includes(".tmp-")).toBe(true)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))
})

describe("Node filesystem sweep security", () => {
  for (const entry of ["root", "fanout", "blob"] as const) {
    it.live(`refuses deletion through a ${entry} symlink`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-sweep-link-" })
        const directory = `${root}/objects`
        const outside = `${root}/outside`
        yield* fs.makeDirectory(`${outside}/${digest.slice(0, 2)}`, { recursive: true })
        yield* fs.makeDirectory(`${directory}/${digest.slice(0, 2)}`, { recursive: true })
        for (const path of [`${outside}/${digest}`, `${outside}/${digest.slice(0, 2)}/${digest}`]) {
          yield* fs.writeFileString(path, artifact)
        }
        const path = entry === "root" ? directory : entry === "fanout" ?
          `${directory}/${digest.slice(0, 2)}`
          : `${directory}/${digest.slice(0, 2)}/${digest}`
        yield* fs.remove(path, { recursive: true, force: true })
        yield* fs.symlink(entry === "blob" ? `${outside}/${digest}` : outside, path)
        const sweep = ArtifactSweep.makeFileSystem(fs, { directory: `${directory}/` })
        expect(Exit.isFailure(yield* sweep.remove(digest).pipe(Effect.exit))).toBe(true)
        for (const path of [`${outside}/${digest}`, `${outside}/${digest.slice(0, 2)}/${digest}`]) {
          expect(yield* fs.readFileString(path)).toBe(artifact)
        }
        if (entry !== "root") expect(yield* sweep.inventory).toEqual([])
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }

  for (const entry of ["root", "fanout"] as const) {
    it.live(`refuses ${entry} replacement after measuring the deletion fence`, () =>
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "artifacts-g1-sweep-replace-" })
        const directory = `${root}/objects`
        const outside = `${root}/outside`
        const path = `${directory}/${digest.slice(0, 2)}/${digest}`
        yield* fs.makeDirectory(`${directory}/${digest.slice(0, 2)}`, { recursive: true })
        yield* fs.makeDirectory(`${outside}/${digest.slice(0, 2)}`, { recursive: true })
        for (const blob of [path, `${outside}/${digest}`, `${outside}/${digest.slice(0, 2)}/${digest}`]) {
          yield* fs.writeFileString(blob, artifact)
        }
        let stats = 0
        const hostile = {
          ...fs,
          stat: (candidate: string) =>
            Effect.gen(function*() {
              const info = yield* fs.stat(candidate)
              // The first blob stat inspects its type; the second measures the fence.
              if (candidate === path && ++stats === 2) {
                const replaced = entry === "root" ? directory : `${directory}/${digest.slice(0, 2)}`
                yield* fs.rename(replaced, `${replaced}-saved`)
                yield* fs.symlink(outside, replaced)
              }
              return info
            })
        }
        const exit = yield* ArtifactSweep.makeFileSystem(hostile, { directory, coordination: "process" })
          .remove(digest, { ifUnmodifiedSinceMs: Number.MAX_SAFE_INTEGER }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(stats).toBe(2)
        expect(yield* fs.readFileString(`${outside}/${digest}`)).toBe(artifact)
        expect(yield* fs.readFileString(`${outside}/${digest.slice(0, 2)}/${digest}`)).toBe(artifact)
      })).pipe(Effect.provide(NodeFileSystem.layer)))
  }
})

it.effect("skips fanouts that become unreadable during inventory", () =>
  Effect.gen(function*() {
    const host = memoryFs({ seed: { [blobPath]: artifact } })
    const fs = {
      ...host.fs,
      readDirectory: (path: string) =>
        path === ".flows/objects"
          ? host.fs.readDirectory(path)
          : Effect.fail(systemError("PermissionDenied", "readDirectory"))
    }
    expect(yield* ArtifactSweep.makeFileSystem(fs).inventory).toEqual([])
  }))

describe("stale lock reclamation", () => {
  it.live("never lets a second stale reclaimer displace a sweep between its age fence and delete", () =>
    Effect.gen(function*() {
      // Two processes measure the same crashed lock as stale. The sweep
      // reclaims it first and passes its age fence; the writer's stale verdict
      // is now about a lock generation that no longer exists. Renaming the path
      // anyway would move the sweep's fresh lock, let the writer freshen the
      // blob as published, and leave the sweep to delete it on pre-publication
      // age evidence.
      const payload = bytes("artifact that was republished")
      const address = sha256(payload)
      const directory = "objects"
      const blob = `${directory}/${address.slice(0, 2)}/${address}`
      const lock = `${directory}/.locks/${address}.lock`
      const old = Date.now() - 120_000
      const files = new Map<string, { bytes: Uint8Array; mtime: number }>([
        [blob, { bytes: payload, mtime: old }],
        [lock, { bytes: bytes("crashed"), mtime: old }]
      ])
      const missing = (method: string, tag: PlatformError.SystemErrorTag = "NotFound") => systemError(tag, method)
      const writerSawStale = yield* Deferred.make<void>()
      const resumeWriter = yield* Deferred.make<void>()
      const sweepPassedFence = yield* Deferred.make<void>()
      const resumeSweep = yield* Deferred.make<void>()
      let writerPaused = false
      let sweepBlobStats = 0
      const host = (role: "writer" | "sweep"): FileSystem.FileSystem => {
        const self: FileSystem.FileSystem = FileSystem.makeNoop({
          makeDirectory: (() => Effect.void) as never,
          readLink: ((path: string) => Effect.fail(missing(`readLink ${path}`))) as never,
          exists: ((path: string) => Effect.sync(() => files.has(path))) as never,
          readFile: ((path: string) =>
            Effect.suspend(() =>
              files.has(path) ? Effect.succeed(files.get(path)!.bytes.slice()) : Effect.fail(missing("readFile"))
            )) as never,
          readFileString: ((path: string) =>
            Effect.suspend(() =>
              files.has(path) ? Effect.succeed(text(files.get(path)!.bytes)) : Effect.fail(missing("readFileString"))
            )) as never,
          writeFileString: ((path: string, value: string, options?: { flag?: string }) =>
            Effect.suspend(() => {
              if (options?.flag === "wx" && files.has(path)) {
                return Effect.fail(missing("writeFileString", "AlreadyExists"))
              }
              files.set(path, { bytes: bytes(value), mtime: Date.now() })
              return Effect.void
            })) as never,
          writeFile: ((path: string, content: Uint8Array) =>
            Effect.sync(() => {
              files.set(path, { bytes: content, mtime: Date.now() })
            })) as never,
          open: ((path: string, options?: { flag?: string }) =>
            Effect.suspend(() => {
              if (options?.flag === "wx") {
                if (files.has(path)) {
                  return Effect.fail(missing("open", "AlreadyExists"))
                }
                files.set(path, { bytes: new Uint8Array(), mtime: Date.now() })
              }
              return Effect.succeed({
                stat: self.stat(path),
                writeAll: (content: Uint8Array) =>
                  self.writeFile(path, content),
                sync: Effect.void
              })
            })) as never,
          stat: ((path: string) =>
            Effect.suspend(() => {
              const file = files.get(path)
              const info = {
                type: file === undefined ? "Directory" : "File",
                dev: 1,
                ino: Option.some(1),
                mtime: Option.some(new Date(file?.mtime ?? 0)),
                size: BigInt(file?.bytes.length ?? 0)
              } as FileSystem.File.Info
              if (file === undefined && (path.endsWith(".lock") || path.includes(".reclaim-") || path === blob)) {
                return Effect.fail(missing("stat"))
              }
              if (role === "writer" && path === lock && !writerPaused) {
                writerPaused = true
                return Deferred.succeed(writerSawStale, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeWriter)),
                  Effect.as(info)
                )
              }
              // The second stat of the blob is the sweep's age fence.
              if (role === "sweep" && path === blob && ++sweepBlobStats === 2) {
                return Deferred.succeed(sweepPassedFence, undefined).pipe(
                  Effect.andThen(Deferred.await(resumeSweep)),
                  Effect.as(info)
                )
              }
              return Effect.succeed(info)
            })) as never,
          rename: ((from: string, to: string) =>
            Effect.suspend(() => {
              const file = files.get(from)
              if (file === undefined) {
                return Effect.fail(missing("rename"))
              }
              files.set(to, file)
              files.delete(from)
              return Effect.void
            })) as never,
          remove: ((path: string) =>
            Effect.suspend(() =>
              files.delete(path) ? Effect.void : Effect.fail(missing("remove"))
            )) as never,
          utimes: ((path: string, _atime: Date | number, mtime: Date | number) =>
            Effect.suspend(() => {
              const file = files.get(path)
              if (file === undefined) return Effect.fail(missing("utimes"))
              file.mtime = mtime instanceof Date ? mtime.getTime() : mtime * 1000
              return Effect.void
            })) as never
        })
        return self
      }
      const writer = ArtifactStore.makeFileSystem(host("writer"), hostPath, { directory, durability: "best-effort" })
      const sweep = ArtifactSweep.makeFileSystem(host("sweep"), { directory })

      const writing = yield* writer.put(payload).pipe(withCrypto, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(writerSawStale)
      const deleting = yield* sweep.remove(address, { ifUnmodifiedSinceMs: old }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(sweepPassedFence)
      yield* Deferred.succeed(resumeWriter, undefined)
      // The writer must now wait on the sweep's lock instead of taking it.
      yield* Effect.sleep("200 millis")
      expect(writing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(resumeSweep, undefined)
      expect(yield* Fiber.join(deleting)).toBe(true)
      expect(yield* Fiber.join(writing)).toBe(address)
      expect(files.has(blob)).toBe(true)
      expect([...files.keys()].filter((path) => path.includes(".reclaim-") || path.includes(".stale-"))).toEqual([])
    }))
})
