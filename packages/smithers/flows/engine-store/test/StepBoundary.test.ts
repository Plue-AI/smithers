import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as ByteSize from "effect/ByteSize"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as StepBoundary from "../src/StepBoundary.ts"

/**
 * The production boundary now needs an `ArtifactStore` as well as a
 * `FileSystem`: blob mechanics moved to `@smthrs/artifacts`.
 */
const hostLayer = (fs: FileSystem.FileSystem) =>
  ArtifactStore.layerFileSystem().pipe(
    Layer.provideMerge(Layer.merge(Layer.succeed(FileSystem.FileSystem)(fs), NodePath.layer))
  )
import { hostPath } from "./HostPath.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const descriptor: FileBoundary = {
  readSet: [{ path: "input.txt", digest: "a" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

describe("StepBoundary.readSetMatches", () => {
  it("accepts any measured digest for duplicate paths and ignores incidental reads", () => {
    const readSnapshot = [
      { path: "input.txt", digest: "a" },
      { path: "extra.txt", digest: "extra" },
      { path: "input.txt", digest: "b" }
    ]
    expect(StepBoundary.readSetMatches({
      descriptor: { ...descriptor, readSet: [readSnapshot[0]!, readSnapshot[2]!, readSnapshot[0]!] },
      readSnapshot
    })).toBe(true)
    for (
      const readSet of [
        [{ path: "input.txt", digest: "missing" }],
        [{ path: "missing.txt", digest: "a" }],
        [{ path: "INPUT.txt", digest: "a" }]
      ]
    ) {
      expect(StepBoundary.readSetMatches({ descriptor: { ...descriptor, readSet }, readSnapshot })).toBe(false)
    }
    expect(StepBoundary.readSetMatches({ descriptor: { ...descriptor, readSet: [] }, readSnapshot })).toBe(true)
    expect(StepBoundary.readSetMatches({ descriptor, readSnapshot: [] })).toBe(false)
    expect(StepBoundary.readSetMatches({
      descriptor: { ...descriptor, readSet: [{ _tag: "Glob", include: ["*.txt"] }] },
      readSnapshot
    })).toBe(false)
  })

  it("validates 5,000 measured files with a linear number of path reads", () => {
    const reads = Array.from({ length: 5_000 }, (_, index) => ({
      path: `packages/p${index}/src/index.ts`,
      digest: "a".repeat(64)
    }))
    let pathReads = 0
    const readSnapshot = reads.map((read) => ({
      get path() {
        pathReads++
        return read.path
      },
      digest: read.digest
    }))
    expect(StepBoundary.readSetMatches({ descriptor: { ...descriptor, readSet: reads }, readSnapshot })).toBe(true)
    // Count work instead of elapsed time on a contended test host.
    expect(pathReads).toBeLessThanOrEqual(3 * reads.length)
  })
})

describe("StepBoundary", () => {
  it.effect("captures outputs and re-materializes them on replay", () =>
    Effect.gen(function*() {
      const replayed: Array<StepBoundary.BoundaryEvidence> = []
      const layer = StepBoundary.layerTest({
        declaredOutputs: { output: "value" },
        onReplay: (evidence) => replayed.push(evidence)
      })
      const program = Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(descriptor)
        const evidence = yield* boundary.settle(prepared)
        yield* boundary.replayOutputs(evidence)
        return evidence
      }).pipe(Effect.provide(layer))
      expect(yield* withCrypto(program)).toMatchObject({ declaredOutputs: { output: "value" } })
      expect(replayed).toHaveLength(1)
    }))

  it.effect("fails closed when the host does not support boundaries", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(boundary.prepare(descriptor))
      }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
      expect(yield* withCrypto(program)).toMatchObject({
        _tag: "@smthrs/engine-store/UnsupportedBoundary",
        code: "unsupported_boundary"
      })
    }))

  it.effect("fails closed during settlement and output replay", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared: StepBoundary.PreparedBoundary = {
          descriptor,
          readSnapshot: StepBoundary.exactReads(descriptor)
        }
        const settle = yield* Effect.flip(boundary.settle(prepared))
        const replay = yield* Effect.flip(boundary.replayOutputs({ declaredOutputs: {}, diffIdentity: "d3" }))
        return [settle, replay]
      }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
      expect(yield* withCrypto(program)).toHaveLength(2)
    }))
})

/**
 * The filesystem-backed production layer (issue #104): until this layer the
 * only implementation was `layerTest`, whose `prepare` defaulted the read
 * snapshot to the declaration — so outside tests the issue-#90 dirty check
 * compared the declaration against itself and passed unconditionally, and a
 * hard-boundary application had no service to provide at all.
 */
describe("StepBoundary.layer (filesystem-backed)", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /**
   * How a real host reports absence: a typed `NotFound`, not a bare `Error`.
   * The boundary reads that refusal instead of probing with `exists` first,
   * so the fixture has to answer the way the host it stands in for does.
   */
  const absent = (method: string, path: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: `ENOENT: ${path}`
    })

  /** A deterministic in-memory host filesystem over the kernel seam. */
  const memoryFs = (seed: Record<string, string>) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(seed).map(([path, content]) => [path, encoder.encode(content)])
    )
    const directories = new Set<string>()
    const addParentDirectories = (path: string) => {
      const segments = path.split("/")
      for (let index = 1; index < segments.length; index++) {
        directories.add(segments.slice(0, index).join("/"))
      }
    }
    for (const path of files.keys()) addParentDirectories(path)
    const failedReads = new Set<string>()
    // A path that a concurrent process deletes the instant the enumeration
    // has classified it: listed and stat'd as a file, gone by the time the
    // boundary reads it.
    const vanishAfterStat = new Set<string>()
    const mtimes = new Map<string, number>()
    const madeDirectories: Array<string> = []
    const probes: Array<string> = []
    const reads: Array<string> = []
    const removals: Array<string> = []
    const writes: Array<string> = []
    const present = (path: string) =>
      files.has(path) ||
      directories.has(path) ||
      [...files.keys(), ...directories].some((candidate) => candidate.startsWith(`${path}/`))
    const fs = FileSystem.makeNoop({
      exists: ((path: string) =>
        Effect.sync(() => {
          probes.push(path)
          return present(path)
        })) as never,
      readFile: ((path: string) =>
        Effect.suspend(() => {
          reads.push(path)
          if (failedReads.delete(path)) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readFile",
                pathOrDescriptor: path,
                description: `EIO: ${path}`
              })
            )
          }
          const bytes = files.get(path)
          return bytes === undefined ? Effect.fail(absent("readFile", path)) : Effect.succeed(bytes)
        })) as never,
      writeFile: ((path: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          writes.push(path)
          addParentDirectories(path)
          files.set(path, bytes)
        })) as never,
      remove: ((path: string, options?: { readonly force?: boolean; readonly recursive?: boolean }) =>
        Effect.suspend(() => {
          // Node-faithful: removing a path that is not there is an error
          // unless the caller asked for `force`, which is how a caller says
          // "absent is the outcome I wanted" without probing first.
          if (!present(path)) {
            return options?.force === true ? Effect.void : Effect.fail(absent("remove", path))
          }
          const descendantFiles = [...files.keys()].filter((candidate) =>
            candidate.startsWith(`${path}/`)
          )
          const descendantDirectories = [...directories].filter((candidate) => candidate.startsWith(`${path}/`))
          if (
            files.has(path) === false &&
            options?.recursive !== true &&
            (descendantFiles.length > 0 || descendantDirectories.length > 0)
          ) return Effect.fail(new Error(`ENOTEMPTY: ${path}`))
          return Effect.sync(() => {
            removals.push(path)
            files.delete(path)
            directories.delete(path)
            if (options?.recursive !== true) return
            for (const candidate of files.keys()) {
              if (candidate.startsWith(`${path}/`)) files.delete(candidate)
            }
            for (const candidate of directories) {
              if (candidate.startsWith(`${path}/`)) directories.delete(candidate)
            }
          })
        })) as never,
      makeDirectory: ((path: string, options?: { readonly recursive?: boolean }) =>
        Effect.sync(() => {
          madeDirectories.push(path)
          if (options?.recursive !== true) {
            directories.add(path)
            return
          }
          const segments = path.split("/")
          for (let index = 1; index <= segments.length; index++) {
            directories.add(segments.slice(0, index).join("/"))
          }
        })) as never,
      // Node-faithful: a recursive listing names intermediate directories
      // too, and `stat` answers `Directory` for them — the walk skips or
      // collects them exactly as it does over a real host. Directories with
      // no files exist only in the `directories` set, so listings draw from
      // both; a missing or non-directory path answers ENOENT as a host does.
      readDirectory: ((directory: string, options?: { readonly recursive?: boolean }) =>
        Effect.suspend(() => {
          const root = directory === "."
          if (!root && (!present(directory) || files.has(directory))) {
            return Effect.fail(absent("readDirectory", directory))
          }
          const prefix = root ? "" : `${directory}/`
          const entries = new Set<string>()
          for (const candidate of [...directories, ...files.keys()]) {
            if (prefix !== "" && !candidate.startsWith(prefix)) continue
            const relative = prefix === "" ? candidate : candidate.slice(prefix.length)
            entries.add(options?.recursive === true ? relative : relative.split("/")[0]!)
          }
          return Effect.succeed([...entries].sort())
        })) as never,
      stat: ((path: string) =>
        files.has(path)
          ? Effect.sync(() => {
            const info = {
              type: "File",
              size: ByteSize.bytes(files.get(path)!.length),
              mtime: Option.some(new Date(mtimes.get(path) ?? Date.now())),
              dev: 1,
              ino: Option.some(1)
            }
            if (vanishAfterStat.delete(path)) files.delete(path)
            return info
          })
          : present(path)
          ? Effect.succeed({ type: "Directory" })
          : Effect.fail(absent("stat", path))) as never
    })
    return {
      directories,
      failedReads,
      files,
      fs,
      madeDirectories,
      mtimes,
      probes,
      reads,
      removals,
      vanishAfterStat,
      writes,
      // Attested isolated: replay confines its writes and refuses a path-based host.
      layer: StepBoundary.layer.pipe(Layer.provide(hostLayer(KernelFileSystem.withIsolatedFileSystem(fs))))
    }
  }

  const declared = (content: string): FileBoundary => ({
    readSet: [{ path: "input.txt", digest: sha256(content) }],
    writeSet: ["output.txt"],
    boundaryMode: "hard"
  })

  it.effect("measures and captures each path in one host call", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        "input.txt": "source",
        "tree/a.txt": "a",
        "tree/nested/b.txt": "b"
      })
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [{ path: "input.txt", digest: sha256("source") }, { path: "gone.txt", digest: "absent" }],
            writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
            boundaryMode: "hard"
          })
          host.reads.length = 0
          host.probes.length = 0
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )

      // Every host call is one CPython fork under the confined production
      // host (`@smthrs/platform-node/AtomicFileSystem`, ~130 ms each), so a
      // path measured twice — an `exists` probe and then the read that
      // reports absence anyway — doubled the cost of every boundary.
      expect(host.probes).toEqual([])
      // A tree member is measured once. Its digest reaches the tree identity
      // from the capture that already read it, not from a second read.
      expect(host.reads).toEqual([
        "gone.txt",
        "input.txt",
        "tree/a.txt",
        "tree/nested/b.txt"
      ])
    }))

  it.effect("records a tree member that vanished after enumeration as absent", () =>
    Effect.gen(function*() {
      const present = memoryFs({ "tree/a.txt": "a", "tree/b.txt": "b" })
      const raced = memoryFs({ "tree/a.txt": "a", "tree/b.txt": "b" })
      // The enumeration classified `tree/b.txt` as a file; a concurrent
      // process deleted it before the capture read it.
      raced.vanishAfterStat.add("tree/b.txt")
      const tree: FileBoundary = {
        readSet: [],
        writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
        boundaryMode: "hard"
      }
      const settle = (host: ReturnType<typeof memoryFs>) =>
        withCrypto(
          Effect.gen(function*() {
            const boundary = yield* StepBoundary.StepBoundary
            return yield* boundary.settle(yield* boundary.prepare(tree))
          }).pipe(Effect.provide(host.layer))
        )

      const complete = yield* settle(present)
      const partial = yield* settle(raced)
      const identity = (evidence: StepBoundary.BoundaryEvidence) =>
        (evidence.declaredOutputs as { readonly trees: ReadonlyArray<{ readonly identity: string }> }).trees[0]!
          .identity

      // The vanished member is evidence, not a defect: only a declared exact
      // output may be missing. It is recorded absent, and the tree hashes
      // differently from the one whose members were all there.
      expect(
        (partial.declaredOutputs as { readonly outputs: ReadonlyArray<{ path: string; digest: string | null }> })
          .outputs
      ).toContainEqual({ path: "tree/b.txt", digest: null })
      expect(identity(partial)).not.toBe(identity(complete))
    }))

  it.effect("measures the declared read set for real instead of echoing the declaration", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "post-edit content" })
      const prepared = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.prepare(declared("pre-edit content"))
        }).pipe(Effect.provide(host.layer))
      )
      // The stale declaration must be refused: the measured digest differs.
      expect(StepBoundary.readSetMatches(prepared)).toBe(false)
      expect(prepared.readSnapshot[0]!.digest).toBe(sha256("post-edit content"))
    }))

  it.effect("re-hashes an unchanged old file across repeated measurements", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "memo.txt": "stable" })
      host.mtimes.set("memo.txt", 0)
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())
      const snapshots = yield* withCrypto(
        Effect.gen(function*() {
          yield* TestClock.setTime(3_000)
          const descriptor: FileBoundary = {
            readSet: [{ path: "memo.txt", digest: sha256("stable") }],
            writeSet: [],
            boundaryMode: "hard"
          }
          return [yield* boundary.prepare(descriptor), yield* boundary.prepare(descriptor)]
        }).pipe(Effect.provide(TestClock.layer()))
      )

      expect(host.reads).toEqual(["memo.txt", "memo.txt"])
      expect(snapshots.map((snapshot) => snapshot.readSnapshot[0]?.digest)).toEqual([
        sha256("stable"),
        sha256("stable")
      ])
    }))

  it.effect("hashes the exact bytes capture records", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "memo.txt": "stable" })
      host.mtimes.set("memo.txt", 0)
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          yield* TestClock.setTime(3_000)
          const prepared = yield* boundary.prepare({
            readSet: [{ path: "memo.txt", digest: sha256("stable") }],
            writeSet: ["memo.txt"],
            boundaryMode: "hard"
          })
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(TestClock.layer()))
      )

      // Prepare and capture each hash the bytes they actually observe.
      expect(host.reads).toEqual(["memo.txt", "memo.txt"])
      expect(evidence.declaredOutputs).toMatchObject({
        outputs: [{ path: "memo.txt", digest: sha256("stable") }]
      })
    }))

  it.effect("re-hashes when stat identity changes and returns the new digest", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "memo.txt": "old" })
      host.mtimes.set("memo.txt", 0)
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())
      const digests = yield* withCrypto(
        Effect.gen(function*() {
          yield* TestClock.setTime(3_000)
          const descriptor: FileBoundary = {
            readSet: [{ path: "memo.txt", digest: sha256("old") }],
            writeSet: [],
            boundaryMode: "hard"
          }
          const before = yield* boundary.prepare(descriptor)
          host.files.set("memo.txt", encoder.encode("new-size"))
          const after = yield* boundary.prepare(descriptor)
          return [before.readSnapshot[0]!.digest, after.readSnapshot[0]!.digest]
        }).pipe(Effect.provide(TestClock.layer()))
      )

      expect(host.reads).toEqual(["memo.txt", "memo.txt"])
      expect(digests).toEqual([sha256("old"), sha256("new-size")])
    }))

  it.effect("re-hashes an old same-size rewrite even when its stat identity is unchanged", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "memo.txt": "before" })
      host.mtimes.set("memo.txt", 0)
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())
      const digest = yield* withCrypto(
        Effect.gen(function*() {
          yield* TestClock.setTime(10_000)
          const descriptor: FileBoundary = {
            readSet: [{ path: "memo.txt", digest: sha256("before") }],
            writeSet: [],
            boundaryMode: "hard"
          }
          yield* boundary.prepare(descriptor)
          // Same path, size, old mtime, device, and inode. A stat-identity
          // memo would return the stale digest forever; only reading the
          // bytes again can observe this rewrite.
          host.files.set("memo.txt", encoder.encode("after!"))
          return (yield* boundary.prepare(descriptor)).readSnapshot[0]!.digest
        }).pipe(Effect.provide(TestClock.layer()))
      )

      expect(host.reads).toEqual(["memo.txt", "memo.txt"])
      expect(digest).toBe(sha256("after!"))
    }))

  it.effect("snapshots a mutable declaration before its first asynchronous host read", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const bytes = encoder.encode("stable")
      const fs = FileSystem.makeNoop({
        exists: (() => Effect.succeed(true)) as never,
        readFile: (() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(bytes)
          )) as never
      })
      const mutable: FileBoundary = {
        readSet: [{ path: "input.txt", digest: sha256("stable") }],
        writeSet: [{ _tag: "Glob", include: ["dist/**/*.js"], exclude: ["dist/tmp/**"] }],
        removes: ["stale.txt"],
        boundaryMode: "hard"
      }
      const running = yield* withCrypto(
        StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeNoop()).prepare(mutable).pipe(
          Effect.forkChild({ startImmediately: true })
        )
      )
      yield* Deferred.await(entered)
      ;(mutable.readSet as Array<unknown>).push({ path: "late.txt", digest: "late" })
      ;(mutable.writeSet[0] as unknown as { include: Array<string>; exclude?: Array<string> }).include.push("late/**")
      ;(mutable.writeSet[0] as unknown as { exclude?: Array<string> }).exclude?.push("dist/other/**")
      ;(mutable.removes as Array<string>).push("late-remove.txt")
      ;(mutable as { boundaryMode: "hard" | "expected" }).boundaryMode = "expected"
      yield* Deferred.succeed(release, undefined)
      const prepared = yield* Fiber.join(running)

      expect(prepared.descriptor).toEqual({
        readSet: [{ path: "input.txt", digest: sha256("stable") }],
        writeSet: [{ _tag: "Glob", include: ["dist/**/*.js"], exclude: ["dist/tmp/**"] }],
        removes: ["stale.txt"],
        boundaryMode: "hard"
      })
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(Object.isFrozen(prepared.descriptor)).toBe(true)
      expect(Object.isFrozen(prepared.descriptor.readSet)).toBe(true)
      expect(Object.isFrozen(prepared.descriptor.writeSet[0])).toBe(true)
    }))

  it.effect("hashes and stores the exact post-step bytes after an old same-size rewrite", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "memo.txt": "before" })
      host.mtimes.set("memo.txt", 0)
      const artifacts = ArtifactStore.makeMemory()
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, artifacts, { maxInlineBytes: 0 })
      const observed = yield* withCrypto(Effect.gen(function*() {
        const prepared = yield* boundary.prepare({
          readSet: [{ path: "memo.txt", digest: sha256("before") }],
          writeSet: ["memo.txt"],
          boundaryMode: "hard"
        })
        host.files.set("memo.txt", encoder.encode("after!"))
        const evidence = yield* boundary.settle(prepared)
        const outputs = evidence.declaredOutputs as {
          readonly outputs: ReadonlyArray<{ readonly digest: string | null }>
        }
        const digest = outputs.outputs[0]!.digest!
        return { digest, stored: decoder.decode(yield* artifacts.get(digest)) }
      }))

      expect(observed).toEqual({ digest: sha256("after!"), stored: "after!" })
    }))

  it.effect("refuses an artifact store that claims a different address", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "output.txt": "built" })
      const artifacts = ArtifactStore.makeNoop({
        put: () => Effect.succeed(sha256("different") as ArtifactStore.Digest)
      })
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, artifacts, { maxInlineBytes: 0 })
      const failure = yield* withCrypto(Effect.flip(Effect.gen(function*() {
        const prepared = yield* boundary.prepare({ readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" })
        return yield* boundary.settle(prepared)
      })))

      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/BoundaryCorruption",
        code: "boundary_corruption",
        path: "output.txt",
        recordedDigest: sha256("different"),
        measuredDigest: sha256("built")
      })
    }))

  it.effect("uses one locale-independent UTF-16 order for measured reads and outputs", () =>
    Effect.gen(function*() {
      const expected = ["e\u0301", "é", "日本", "😀", "\uE000"]
      const host = memoryFs(Object.fromEntries(expected.map((path) => [path, path])))
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())
      const evidence = yield* withCrypto(Effect.gen(function*() {
        const prepared = yield* boundary.prepare({
          readSet: [...expected].reverse().map((path) => ({ path, digest: sha256(path) })),
          writeSet: [...expected].reverse(),
          boundaryMode: "hard"
        })
        expect(prepared.readSnapshot.map((entry) => entry.path)).toEqual(expected)
        return yield* boundary.settle(prepared)
      }))
      const outputs = evidence.declaredOutputs as { readonly outputs: ReadonlyArray<{ readonly path: string }> }
      expect(outputs.outputs.map((entry) => entry.path)).toEqual(expected)
    }))

  it.effect("falls back to read-and-hash without memoizing when stat is unavailable", () =>
    Effect.gen(function*() {
      const reads: Array<string> = []
      const fs = FileSystem.makeNoop({
        exists: (() => Effect.succeed(true)) as never,
        stat: (() => Effect.fail(new Error("ENOTSUP: stat"))) as never,
        readFile: (() =>
          Effect.sync(() => {
            reads.push("fallback.txt")
            return encoder.encode("fallback")
          })) as never
      })
      const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeNoop())
      const descriptor: FileBoundary = {
        readSet: [{ path: "fallback.txt", digest: sha256("fallback") }],
        writeSet: [],
        boundaryMode: "hard"
      }

      const snapshots = yield* withCrypto(Effect.all([
        boundary.prepare(descriptor),
        boundary.prepare(descriptor)
      ]))
      expect(reads).toEqual(["fallback.txt", "fallback.txt"])
      expect(snapshots.every(StepBoundary.readSetMatches)).toBe(true)
    }))

  it.effect("does not trust stat identities whose optional mtime is unavailable", () =>
    Effect.gen(function*() {
      const reads: Array<string> = []
      const fs = FileSystem.makeNoop({
        exists: (() => Effect.succeed(true)) as never,
        stat: (() =>
          Effect.succeed({
            type: "File",
            size: ByteSize.bytes(8),
            mtime: Option.none(),
            dev: 1,
            ino: Option.none()
          })) as never,
        readFile: (() =>
          Effect.sync(() => {
            reads.push("timeless.txt")
            return encoder.encode("timeless")
          })) as never
      })
      const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeNoop())
      const descriptor: FileBoundary = {
        readSet: [{ path: "timeless.txt", digest: sha256("timeless") }],
        writeSet: [],
        boundaryMode: "hard"
      }

      yield* withCrypto(Effect.gen(function*() {
        yield* boundary.prepare(descriptor)
        yield* boundary.prepare(descriptor)
      }))
      expect(reads).toEqual(["timeless.txt", "timeless.txt"])
    }))

  it.effect("accepts a declaration that still matches the measured files", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "stable content" })
      const prepared = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.prepare(declared("stable content"))
        }).pipe(Effect.provide(host.layer))
      )
      expect(StepBoundary.readSetMatches(prepared)).toBe(true)
    }))

  it.effect("expands read globs deterministically but refuses an unkeyed direct cache hit", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        "src/a.ts": "a",
        "src/nested/b.ts": "b",
        "src/skip.js": "skip"
      })
      const prepared = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.prepare({
            readSet: [{ _tag: "Glob", include: ["src/**/*.ts"] }],
            writeSet: [],
            boundaryMode: "hard"
          })
        }).pipe(Effect.provide(host.layer))
      )
      expect(prepared.readSnapshot.map((entry) => entry.path)).toEqual(["src/a.ts", "src/nested/b.ts"])
      // PlanScheduler replaces source globs with this exact measured snapshot
      // before keying. A direct action retains the pattern, so it cannot prove
      // that the snapshot was folded into its key and must miss conservatively.
      expect(StepBoundary.readSetMatches(prepared)).toBe(false)
    }))

  it.effect("reports a vanished declared read as a mismatch", () =>
    Effect.gen(function*() {
      const host = memoryFs({})
      const prepared = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.prepare(declared("was here"))
        }).pipe(Effect.provide(host.layer))
      )
      expect(StepBoundary.readSetMatches(prepared)).toBe(false)
    }))

  it.effect("fails a hard boundary whose declared read was mutated outside the write set", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare(declared("original"))
          // The body mutates a declared read that is not a declared write.
          host.files.set("input.txt", encoder.encode("scribbled"))
          return yield* Effect.flip(boundary.settle(prepared))
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/UndeclaredWrite",
        code: "undeclared_write",
        paths: ["input.txt"]
      })
    }))

  it.effect("records the mutation as a deviation under an expected boundary", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
          host.files.set("input.txt", encoder.encode("scribbled"))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(evidence.deviation).toMatchObject({ _tag: "ExpectedSetDeviation", paths: ["input.txt"] })
    }))

  it.effect("hard-fails a declared output the body never produced", () =>
    Effect.gen(function*() {
      // Bazel's `checkOutputs`. Recording the absence as `digest: null` would
      // cache the claim "this file should not exist", and every later
      // `replayOutputs` would act on it by DELETING the path on a workspace that
      // never ran the step — a crash mid-body would poison the cache with an
      // eraser.
      const host = memoryFs({ "input.txt": "original" })
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare(declared("original"))
          // The body never wrote `output.txt`.
          return yield* Effect.flip(boundary.settle(prepared))
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/MissingDeclaredOutput",
        code: "missing_declared_output",
        paths: ["output.txt"]
      })
    }))

  it.effect("records the absence as a deviation under an expected boundary", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(evidence.deviation).toMatchObject({ _tag: "MissingDeclaredOutput", paths: ["output.txt"] })
    }))

  it.effect("legalizes a declared removal, and replay still deletes it", () =>
    Effect.gen(function*() {
      const producer = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            ...declared("original"),
            writeSet: ["output.txt"],
            removes: ["stale.txt"]
          })
          producer.files.set("output.txt", encoder.encode("built"))
          producer.files.delete("stale.txt")
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(producer.layer))
      )
      // Declared, therefore evidence rather than a defect — and it keeps the
      // `digest: null` capture that makes replay delete the path.
      expect(evidence.deviation).toBeUndefined()

      const consumer = memoryFs({ "stale.txt": "still here" })
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(consumer.layer))
      )
      expect(consumer.files.has("stale.txt")).toBe(false)
      expect(decoder.decode(consumer.files.get("output.txt"))).toBe("built")
    }))

  it.effect("hard-fails a declared removal the body left in place", () =>
    Effect.gen(function*() {
      // The dual of the missing-output rule: `removes` promises the post-state.
      // A path that survived — here, quietly rewritten — must not settle as
      // evidence, or the mutation is cached under a declaration that disclaimed
      // it and replay materializes it everywhere.
      const host = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            ...declared("original"),
            writeSet: ["output.txt"],
            removes: ["stale.txt"]
          })
          host.files.set("output.txt", encoder.encode("built"))
          host.files.set("stale.txt", encoder.encode("mutated, not deleted"))
          return yield* Effect.flip(boundary.settle(prepared))
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/SurvivingDeclaredRemoval",
        code: "surviving_declared_removal",
        paths: ["stale.txt"]
      })
    }))

  it.effect("records a surviving removal as a deviation under an expected boundary", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            ...declared("original"),
            boundaryMode: "expected",
            writeSet: ["output.txt"],
            removes: ["stale.txt"]
          })
          host.files.set("output.txt", encoder.encode("built"))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(evidence.deviation).toMatchObject({ _tag: "SurvivingDeclaredRemoval", paths: ["stale.txt"] })
    }))

  it.effect("refuses to replay evidence naming a path outside the workspace", () =>
    Effect.gen(function*() {
      // Evidence can arrive from a foreign producer through cache sync, and
      // replay DELETES what it names: confinement is the difference between a
      // refusal and a wipe.
      const host = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(boundary.replayOutputs({
            declaredOutputs: { outputs: [{ path: "../escape.txt", digest: null }] },
            diffIdentity: "tampered"
          }))
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({ code: "unsupported_boundary" })
      const absolute = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(boundary.replayOutputs({
            declaredOutputs: { outputs: [], trees: [{ path: "/", identity: "x" }] },
            diffIdentity: "tampered"
          }))
        }).pipe(Effect.provide(host.layer))
      )
      expect(absolute).toMatchObject({ code: "unsupported_boundary" })
    }))

  it.effect("expands root-level patterns and walks a shared include prefix once", () =>
    Effect.gen(function*() {
      // A root-level pattern walks the workspace root itself; two includes with
      // one static prefix walk that subtree once and still match through every
      // include.
      const host = memoryFs({ "a.out": "x", "docs/a.md": "m", "docs/b.txt": "t", "src/skip.js": "s" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "Glob", include: ["*.out", "docs/*.md", "docs/*.txt"] }],
            boundaryMode: "hard"
          })
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      const captured = (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs
      expect(captured.map((output) => output.path)).toEqual(["a.out", "docs/a.md", "docs/b.txt"])
    }))

  it.effect("expands globs and trees over dotfiles, and replay restores them", () =>
    Effect.gen(function*() {
      // Node's own glob skips dotfiles; the declared-pattern matcher does not.
      // A tree capture that missed `.gitignore` would DELETE it on every
      // cache-hit replay, because replay clears the tree first.
      const host = memoryFs({ "dist/.hidden": "dot", "dist/app.js": "code" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
            boundaryMode: "hard"
          })
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      const captured = (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs
      expect(captured.map((output) => output.path).sort()).toEqual(["dist/.hidden", "dist/app.js"])

      const consumer = memoryFs({ "dist/stale.js": "old" })
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(evidence)
        }).pipe(Effect.provide(consumer.layer))
      )
      expect(consumer.files.has("dist/stale.js")).toBe(false)
      expect(decoder.decode(consumer.files.get("dist/.hidden"))).toBe("dot")
      expect(decoder.decode(consumer.files.get("dist/app.js"))).toBe("code")
    }))

  it.effect("does not count a declared removal as an undeclared write", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "input.txt": "original", "output.txt": "built" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [{ path: "input.txt", digest: sha256("original") }],
            writeSet: ["output.txt"],
            removes: ["input.txt"],
            boundaryMode: "hard"
          })
          host.files.delete("input.txt")
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(evidence.deviation).toBeUndefined()
    }))

  it.effect("treats mutations covered by tree and glob outputs as declared", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "tree/a.txt": "before", "generated/a.js": "before" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [
              { path: "tree/a.txt", digest: sha256("before") },
              { path: "generated/a.js", digest: sha256("before") }
            ],
            writeSet: [
              { _tag: "TreeArtifact", path: "tree" },
              { _tag: "Glob", include: ["generated/**/*.js"] }
            ],
            boundaryMode: "hard"
          })
          host.files.set("tree/a.txt", encoder.encode("after"))
          host.files.set("generated/a.js", encoder.encode("after"))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(evidence.deviation).toBeUndefined()
    }))

  it.effect("expands write globs deterministically, applies exclusions, and allows zero matches", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        "dist/a.js": "a",
        "dist/nested/b.js": "b",
        "dist/skip/c.js": "skip",
        "dist/readme.txt": "text"
      })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            readSet: [],
            writeSet: [{
              _tag: "Glob",
              include: ["dist/**/*.js"],
              exclude: ["dist/skip/**"]
            }],
            boundaryMode: "hard"
          })
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(host.layer))
      )
      expect(
        (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs.map((entry) => entry.path)
      )
        .toEqual(["dist/a.js", "dist/nested/b.js"])

      const empty = memoryFs({})
      expect(
        yield* (withCrypto(
          Effect.gen(function*() {
            const boundary = yield* StepBoundary.StepBoundary
            return yield* boundary.settle(
              yield* boundary.prepare({
                readSet: [],
                writeSet: [{ _tag: "Glob", include: ["none/**"] }],
                boundaryMode: "hard"
              })
            )
          }).pipe(Effect.provide(empty.layer))
        ))
      ).toBeDefined()
      expect(
        yield* (withCrypto(
          Effect.gen(function*() {
            const boundary = yield* StepBoundary.StepBoundary
            return yield* boundary.settle(
              yield* boundary.prepare({
                readSet: [],
                writeSet: [{ _tag: "TreeArtifact", path: "none" }],
                boundaryMode: "hard"
              })
            )
          }).pipe(Effect.provide(empty.layer))
        ))
      ).toBeDefined()
    }))

  it.effect("settles and replays a combined tree and glob write set over the real filesystem layer", () =>
    Effect.gen(function*() {
      const producer = memoryFs({
        "tree/a.txt": "tree output",
        "generated/nested/a.js": "glob output",
        "outside.txt": "unowned"
      })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.settle(
            yield* boundary.prepare({
              readSet: [],
              writeSet: [{ _tag: "TreeArtifact", path: "tree" }, { _tag: "Glob", include: ["generated/**/*.js"] }],
              boundaryMode: "hard"
            })
          )
        }).pipe(Effect.provide(producer.layer))
      )
      const consumer = memoryFs({})
      yield* withCrypto(
        Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence))
          .pipe(Effect.provide(consumer.layer))
      )
      expect([...consumer.files.keys()].sort()).toEqual(["generated/nested/a.js", "tree/a.txt"])
      expect(decoder.decode(consumer.files.get("tree/a.txt"))).toBe("tree output")
      expect(decoder.decode(consumer.files.get("generated/nested/a.js"))).toBe("glob output")
      expect(evidence.deviation).toBeUndefined()
    }))

  it.effect("makes a warm replay write-free without recreating parent directories", () =>
    Effect.gen(function*() {
      const producer = memoryFs({ "dist/a.txt": "a", "dist/b.txt": "b" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.settle(
            yield* boundary.prepare({
              readSet: [],
              writeSet: ["dist/a.txt", "dist/b.txt"],
              boundaryMode: "hard"
            })
          )
        }).pipe(Effect.provide(producer.layer))
      )
      const consumer = memoryFs({})
      const replay = () =>
        withCrypto(
          Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
            Effect.provide(consumer.layer)
          )
        )

      yield* replay()
      expect(consumer.writes).toEqual(["dist/a.txt", "dist/b.txt"])
      consumer.writes.length = 0
      consumer.madeDirectories.length = 0

      yield* replay()
      expect(consumer.writes).toEqual([])
      expect(consumer.madeDirectories).toEqual([])
      expect(decoder.decode(consumer.files.get("dist/a.txt"))).toBe("a")
      expect(decoder.decode(consumer.files.get("dist/b.txt"))).toBe("b")
    }))

  it.effect("rewrites only a tampered output", () =>
    Effect.gen(function*() {
      const producer = memoryFs({ "dist/a.txt": "a", "dist/b.txt": "b" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.settle(
            yield* boundary.prepare({
              readSet: [],
              writeSet: ["dist/a.txt", "dist/b.txt"],
              boundaryMode: "hard"
            })
          )
        }).pipe(Effect.provide(producer.layer))
      )
      const consumer = memoryFs({ "dist/a.txt": "tampered", "dist/b.txt": "b" })

      yield* withCrypto(
        Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
          Effect.provide(consumer.layer)
        )
      )

      expect(consumer.writes).toEqual(["dist/a.txt"])
      expect(decoder.decode(consumer.files.get("dist/a.txt"))).toBe("a")
      expect(decoder.decode(consumer.files.get("dist/b.txt"))).toBe("b")
    }))

  it.effect("verifies the destination before decoding inline content or reading an artifact", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "inline.txt": "inline", "referenced.txt": "referenced" })
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())

      yield* withCrypto(
        boundary.replayOutputs({
          declaredOutputs: {
            outputs: [
              { path: "inline.txt", digest: sha256("inline"), content: "%%%not-base64%%%" },
              { path: "referenced.txt", digest: sha256("referenced") }
            ]
          },
          diffIdentity: "warm-short-circuit"
        })
      )

      // The first row would be corrupt if decoded and the second store refuses
      // every read. Matching destination digests make both unnecessary.
      expect(host.writes).toEqual([])
    }))

  it.effect("falls through to ordinary materialization when the destination probe fails", () =>
    Effect.gen(function*() {
      const host = memoryFs({ "output.txt": "stale" })
      host.failedReads.add("output.txt")
      const boundary = StepBoundary.makeFileSystem(host.fs, hostPath, ArtifactStore.makeNoop())

      yield* withCrypto(
        boundary.replayOutputs({
          declaredOutputs: {
            outputs: [{
              path: "output.txt",
              digest: sha256("recorded"),
              content: Encoding.encodeBase64(encoder.encode("recorded"))
            }]
          },
          diffIdentity: "probe-refused"
        })
      )

      expect(host.writes).toEqual(["output.txt"])
      expect(decoder.decode(host.files.get("output.txt"))).toBe("recorded")
    }))

  it.effect("diffs a tree artifact, including dotfiles, and removes only stale empty directories", () =>
    Effect.gen(function*() {
      const producer = memoryFs({
        "tree/.kept": "dotfile",
        "tree/a.txt": "a",
        "tree/nested/b.txt": "b"
      })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.settle(
            yield* boundary.prepare({
              readSet: [],
              writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
              boundaryMode: "hard"
            })
          )
        }).pipe(Effect.provide(producer.layer))
      )
      const outputs = evidence.declaredOutputs as {
        readonly outputs: ReadonlyArray<{ readonly path: string }>
        readonly trees: ReadonlyArray<{ readonly path: string; readonly identity: string }>
      }
      expect(outputs.outputs.map((entry) => entry.path)).toEqual([
        "tree/.kept",
        "tree/a.txt",
        "tree/nested/b.txt"
      ])
      expect(outputs.trees[0]).toMatchObject({ path: "tree" })
      expect(outputs.trees[0]!.identity).toMatch(/^key1_/)

      const consumer = memoryFs({
        "tree/.kept": "dotfile",
        "tree/a.txt": "a",
        "tree/nested/b.txt": "tampered",
        "tree/spare/.secret": "spare",
        "tree/stale/.secret": "stale"
      })
      yield* withCrypto(
        Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
          Effect.provide(consumer.layer)
        )
      )
      expect([...consumer.files.keys()].sort()).toEqual([
        "tree/.kept",
        "tree/a.txt",
        "tree/nested/b.txt"
      ])
      expect(consumer.writes).toEqual(["tree/nested/b.txt"])
      expect(consumer.removals).toEqual([
        "tree/spare/.secret",
        "tree/stale/.secret",
        "tree/spare",
        "tree/stale"
      ])
      expect(consumer.directories.has("tree/spare")).toBe(false)
      expect(consumer.directories.has("tree/stale")).toBe(false)
      expect(decoder.decode(consumer.files.get("tree/nested/b.txt"))).toBe("b")
    }))

  it.effect("fully materializes a recorded tree when its root is missing", () =>
    Effect.gen(function*() {
      const producer = memoryFs({ "tree/a.txt": "a", "tree/nested/b.txt": "b" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* boundary.settle(
            yield* boundary.prepare({
              readSet: [],
              writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
              boundaryMode: "hard"
            })
          )
        }).pipe(Effect.provide(producer.layer))
      )
      const consumer = memoryFs({ "tree/old.txt": "old" })
      yield* withCrypto(consumer.fs.remove("tree", { recursive: true, force: true }))
      consumer.removals.length = 0

      yield* withCrypto(
        Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
          Effect.provide(consumer.layer)
        )
      )

      expect(consumer.writes).toEqual(["tree/a.txt", "tree/nested/b.txt"])
      expect([...consumer.files.keys()].sort()).toEqual(["tree/a.txt", "tree/nested/b.txt"])
      expect(consumer.directories.has("tree")).toBe(true)
      expect(consumer.directories.has("tree/nested")).toBe(true)
    }))

  it.effect("captures write-set outputs and re-materializes them on a fresh workspace", () =>
    Effect.gen(function*() {
      const producer = memoryFs({ "input.txt": "original" })
      const evidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare(declared("original"))
          producer.files.set("output.txt", encoder.encode("produced artifact"))
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(producer.layer))
      )
      // `diffIdentity` is a `Key` now, not a bare Sha256 hex: it goes through
      // the repo's one hashing chokepoint, so it carries the `key1_` version
      // marker its derivation is named by.
      expect(evidence.diffIdentity).toMatch(/^key1_[0-9a-f]{64}$/)

      // A different workspace that never ran the step, plus stale garbage at a
      // path the evidence records as absent.
      const replayer = memoryFs({ "stale.txt": "left over" })
      const staleEvidence = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          const prepared = yield* boundary.prepare({
            // A declared read that is also a declared write is exempt from the
            // undeclared-mutation check: mutating it is the declared contract.
            readSet: [{ path: "output.txt", digest: sha256("pre-state") }],
            writeSet: ["output.txt"],
            // The digest-null capture that makes replay delete a path is now
            // reachable only through a DECLARED removal: an undeclared absence
            // is a `MissingDeclaredOutput` defect, because caching it would hand
            // every later replay an eraser.
            removes: ["stale.txt", "gone.txt"],
            boundaryMode: "hard"
          })
          replayer.files.set("output.txt", encoder.encode("produced artifact"))
          replayer.files.delete("stale.txt")
          return yield* boundary.settle(prepared)
        }).pipe(Effect.provide(replayer.layer))
      )
      // "gone.txt" was recorded absent and is already absent on the target:
      // replay leaves it absent without attempting a remove.
      const target = memoryFs({ "stale.txt": "left over" })
      yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          yield* boundary.replayOutputs(staleEvidence)
        }).pipe(Effect.provide(target.layer))
      )
      expect(decoder.decode(target.files.get("output.txt"))).toBe("produced artifact")
      // A recorded-absent output deletes the stale file on replay.
      expect(target.files.has("stale.txt")).toBe(false)
      expect(target.files.has("gone.txt")).toBe(false)
    }))

  it.effect("classifies undecodable inline content as corruption, not a host failure (issue #159)", () =>
    Effect.gen(function*() {
      // A tampered inline row that is no longer valid base64 is cache-origin
      // corruption exactly like a digest mismatch: it must raise
      // `BoundaryCorruption` so the caller routes it to the Inconsistency
      // receiver instead of retrying it as a transient host refusal.
      const host = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(
            boundary.replayOutputs({
              declaredOutputs: {
                outputs: [{
                  path: "output.txt",
                  digest: "aa".repeat(32),
                  sizeBytes: 3,
                  content: "%%%not-base64%%%"
                }]
              },
              diffIdentity: "corrupt-inline"
            })
          )
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/BoundaryCorruption",
        code: "boundary_corruption",
        path: "output.txt",
        recordedDigest: "aa".repeat(32),
        measuredDigest: "invalid_base64"
      })
      expect(host.files.has("output.txt")).toBe(false)
    }))

  it.effect("refuses to replay evidence recorded without materializable outputs", () =>
    Effect.gen(function*() {
      const host = memoryFs({})
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(
            boundary.replayOutputs({ declaredOutputs: { paths: ["output.txt"] }, diffIdentity: "foreign" })
          )
        }).pipe(Effect.provide(host.layer))
      )
      expect(failure).toMatchObject({ code: "unsupported_boundary" })
    }))
})

describe("StepBoundary.layer host failures", () => {
  it.effect("maps a filesystem failure to UnsupportedBoundary", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({
        // Not a `NotFound`: an absent path is measured as `absent`, so the
        // host refusal this maps has to be a refusal the boundary cannot
        // read as an answer.
        readFile: ((path: string) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "Unknown",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: path,
              description: "the host cannot measure"
            })
          )) as never
      })
      const failure = yield* withCrypto(
        Effect.gen(function*() {
          const boundary = yield* StepBoundary.StepBoundary
          return yield* Effect.flip(
            boundary.prepare({
              readSet: [{ path: "input.txt", digest: "d" }],
              writeSet: [],
              boundaryMode: "hard"
            })
          )
        }).pipe(
          Effect.provide(StepBoundary.layer.pipe(Layer.provide(hostLayer(fs))))
        )
      )
      expect(failure).toMatchObject({ code: "unsupported_boundary" })
    }))
})

describe("StepBoundary stays importable from a browser bundle (issue #114)", () => {
  it("has no module-scope node: imports", async () => {
    // The module exports the contract schemas, the service tag, and
    // `layerTest` — all of which a browser composition must import — so a
    // module-scope node: dependency would drag Node builtins into every
    // bundle. Base64 goes through the platform-neutral `effect/Encoding`.
    const fs = await import("node:fs/promises")
    const url = await import("node:url")
    const source = await fs.readFile(
      url.fileURLToPath(new URL("../src/StepBoundary.ts", import.meta.url)),
      "utf8"
    )
    expect(source).not.toMatch(/from "node:/)
  })
})
