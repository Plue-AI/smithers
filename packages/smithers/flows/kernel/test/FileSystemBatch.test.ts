import { describe, expect, it } from "@effect/vitest"
import * as Permission from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Result } from "effect"
import { PlatformError } from "effect"
import * as ByteSize from "effect/ByteSize"
import { createHash } from "node:crypto"
import * as Batch from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as BatchContract from "../src/test/FileSystemBatchContract.ts"
import * as Workspace from "../src/Workspace.ts"

const info = { type: "Directory", dev: 7, ino: Option.some(9) } as FileSystem.File.Info

type BatchOperation = Extract<Batch.AtomicRequest, { readonly operation: "batch" }>

/**
 * A double for a host that advertises batching. `execute` answers the result
 * type its request names, which no implementation can prove from the inside:
 * the response is framed by the host, so the one assertion lives here rather
 * than at every fixture, and anything but a batch is a defect.
 */
const batchExecutor = (
  run: (request: BatchOperation) => Effect.Effect<Batch.BatchResponse, PlatformError.PlatformError>
): Batch.AtomicFileSystem["execute"] => {
  const execute = (request: Batch.AtomicRequest): Effect.Effect<Batch.BatchResponse, PlatformError.PlatformError> =>
    request.operation === "batch" ? run(request) : Effect.die(`unexpected operation: ${request.operation}`)
  return <R extends Batch.AtomicRequest>(request: R) =>
    execute(request) as unknown as Effect.Effect<Batch.AtomicResult<R>, PlatformError.PlatformError>
}

const fixture = (
  options: {
    readonly missingIdentity?: boolean
    readonly size?: number
    readonly identifyRoot?: Batch.AtomicFileSystem["identifyRoot"]
  } = {}
) => {
  const requests: Array<BatchOperation> = []
  const fs = Batch.withAtomicFileSystem(
    FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      stat: () => Effect.succeed(options.missingIdentity ? { ...info, ino: Option.none() } : info)
    }),
    {
      identifyRoot: options.identifyRoot,
      batchLimits: { size: options.size ?? 128, response: 24 * 1024 * 1024 },
      execute: batchExecutor((request) =>
        Effect.sync(() => {
          requests.push(request)
          return {
            rootIdentity: request.rootIdentity!,
            entries: request.requests.map((member, index) => ({
              index,
              path: member.path,
              result: Result.succeed({ operation: "stat", info })
            }))
          }
        })
      )
    }
  )
  return { fs, requests }
}

const provide = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  fs: FileSystem.FileSystem,
  check: GrantStore.Service["check"] = () => Effect.void
) =>
  effect.pipe(
    Effect.provide(Batch.layer),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provide(Path.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore.GrantStore, { ...GrantStore.makeNoop, check })
  )

describe("guarded filesystem batches", () => {
  it.effect("pins and rechecks an exact identity when the numeric inode cannot represent it", () =>
    Effect.gen(function*() {
      const exact = "7:9007199254740993"
      const observed: Array<string> = []
      const host = fixture({
        missingIdentity: true,
        identifyRoot: (path) =>
          Effect.sync(() => {
            observed.push(path)
            return exact
          })
      })
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (let i = 0; i < 2; i++) {
            const answer = yield* Batch.batch(fs)!.execute([{ operation: "stat", path: "a" }])
            expect(answer.rootIdentity).toBe(exact)
          }
        }),
        host.fs
      )
      expect(observed).toEqual(Array(5).fill("/workspace"))
      expect(host.requests.map((request) => request.rootIdentity)).toEqual([exact, exact])
    }))

  it.effect("refuses composition when the exact identity cannot be observed", () =>
    Effect.gen(function*() {
      const failure = PlatformError.systemError({ _tag: "NotFound", module: "test", method: "stat" })
      const host = fixture({ identifyRoot: () => Effect.fail(failure) })
      expect(yield* Effect.flip(provide(Effect.void, host.fs))).toBe(failure)
      expect(host.requests).toEqual([])
    }))

  it.effect("rechecks granted resources and preserves canonical-resolution failures per path", () =>
    Effect.gen(function*() {
      for (const phase of ["before", "after"]) {
        const host = fixture()
        let swapped = false
        const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "realPath" })
        yield* provide(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            Object.assign(host.fs, {
              realPath: (path: string) =>
                phase === "before"
                  ? Effect.fail(denied)
                  : Effect.succeed(swapped && path.endsWith("/a") ? "/outside/a" : path)
            })
            const response = yield* Batch.batch(fs)!.execute([{ operation: "digest", path: "a" }])
            expect(response.entries[0]!.result).toMatchObject({
              _tag: "Failure",
              failure: { reason: { _tag: "PermissionDenied" } }
            })
            if (phase === "before") expect(Result.getFailure(response.entries[0]!.result)).toEqual(Option.some(denied))
            expect(host.requests).toEqual([])
          }),
          host.fs,
          () =>
            Effect.sync(() => {
              swapped = true
            })
        )
      }
    }))

  it.effect("detects root loss while grants are suspended even when no path remains admitted", () =>
    Effect.gen(function*() {
      const host = fixture()
      const missing = PlatformError.systemError({ _tag: "NotFound", module: "test", method: "stat" })
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const failure = yield* Effect.flip(Batch.batch(fs)!.execute([{ operation: "stat", path: "a" }]))
          expect(failure).toMatchObject({ reason: { _tag: "Busy", cause: missing } })
          expect(host.requests).toEqual([])
        }),
        host.fs,
        () =>
          Effect.sync(() => {
            Object.assign(host.fs, { stat: () => Effect.fail(missing) })
          })
      )
    }))
  it.effect("refuses root loss or replacement before it can become per-path absence", () =>
    Effect.gen(function*() {
      for (const fault of ["missing", "replaced", "unidentified"] as const) {
        const host = fixture()
        const missing = PlatformError.systemError({ _tag: "NotFound", module: "test", method: "stat" })
        yield* provide(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            Object.assign(host.fs, {
              stat: () =>
                fault === "missing"
                  ? Effect.fail(missing)
                  : Effect.succeed({ ...info, ino: fault === "replaced" ? Option.some(10) : Option.none() })
            })
            const refused = yield* Effect.flip(Batch.batch(fs)!.execute([{ operation: "digest", path: "a" }]))
            expect(refused).toMatchObject({ reason: { _tag: "Busy" } })
            if (fault === "missing") expect((refused.reason as { cause: unknown }).cause).toBe(missing)
            if (fault === "replaced") {
              expect((refused.reason as { cause: unknown }).cause).toMatchObject({
                _tag: "@smthrs/kernel/FileSystemFault",
                code: "workspace_identity_changed"
              })
            }
            expect(host.requests).toEqual([])
          }),
          host.fs
        )
      }
    }))
  it.effect("normalizes each path and glob, grants each member, and retains denied results and original indexes", () =>
    Effect.gen(function*() {
      const host = fixture()
      const checks: Array<string> = []
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const result = yield* Batch.batch(fs)!.execute([
            { operation: "stat", path: "z" },
            { operation: "stat", path: "denied" },
            { operation: "glob", path: "*.txt", root: "nested", options: { exclude: ["hidden.txt"] } },
            { operation: "stat", path: "z" },
            { operation: "readDirectory", path: "." }
          ])
          expect(checks).toEqual([
            "/workspace/z",
            "/workspace/denied",
            "/workspace/nested/*.txt",
            "/workspace/z",
            "/workspace"
          ])
          expect(result.entries.map(({ index, path }) => [index, path])).toEqual([
            [4, "/workspace"],
            [1, "/workspace/denied"],
            [2, "/workspace/nested/*.txt"],
            [0, "/workspace/z"],
            [3, "/workspace/z"]
          ])
          expect(result.entries[1]!.result).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "PermissionDenied" } }
          })
          expect(host.requests).toHaveLength(1)
          expect(host.requests[0]).toMatchObject({
            boundaryRoot: "/workspace",
            logicalRoot: "/workspace",
            rootIdentity: "7:9",
            requests: [
              { operation: "stat", path: "/workspace/z" },
              {
                operation: "glob",
                path: "/workspace/nested/*.txt",
                root: "/workspace/nested",
                options: { exclude: ["hidden.txt"] }
              },
              { operation: "stat", path: "/workspace/z" },
              { operation: "readDirectory", path: "/workspace" }
            ]
          })
        }),
        host.fs,
        (capability) => {
          checks.push(capability.resource)
          return capability.resource.endsWith("denied")
            ? Effect.fail(Permission.permissionDenied(capability, "no"))
            : Effect.void
        }
      )
    }))

  it.effect("does not invoke a helper when every path exhausts the grant quota", () =>
    Effect.gen(function*() {
      const host = fixture()
      let calls = 0
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const response = yield* Batch.batch(fs)!.execute([{ operation: "stat", path: "a" }, {
            operation: "stat",
            path: "b"
          }])
          expect(response.entries.every((entry) => Result.isFailure(entry.result))).toBe(true)
          expect(calls).toBe(2)
          expect(host.requests).toEqual([])
        }),
        host.fs,
        (capability) => {
          calls++
          return Effect.fail(Permission.permissionDenied(capability, "quota exhausted"))
        }
      )
    }))

  it.effect("snapshots mutable member data before a suspended grant", () =>
    Effect.gen(function*() {
      const host = fixture()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const requests = [{ operation: "glob" as const, path: "*.txt", root: "nested", options: { exclude: ["a"] } }]
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const worker = yield* Batch.batch(fs)!.execute(requests).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          requests[0]!.path = "secret"
          requests[0]!.options.exclude.push("b")
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(worker)
          expect(host.requests[0]!.requests).toEqual([{
            operation: "glob",
            path: "/workspace/nested/*.txt",
            root: "/workspace/nested",
            options: { exclude: ["a"] }
          }])
        }),
        host.fs,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      )
    }))

  it.effect("fails closed for a host that cannot bind an inode", () =>
    Effect.gen(function*() {
      const host = fixture({ missingIdentity: true })
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          expect(yield* Effect.flip(Batch.batch(fs)!.execute([{ operation: "stat", path: "a" }]))).toMatchObject({
            reason: { _tag: "PermissionDenied" }
          })
          expect(host.requests).toEqual([])
        }),
        host.fs
      )
    }))

  it.effect("enforces the advertised bound before any grant or helper work", () =>
    Effect.gen(function*() {
      const host = fixture({ size: 2 })
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          for (const count of [0, 3]) {
            expect(
              yield* Effect.flip(
                Batch.batch(fs)!.execute(
                  Array.from({ length: count }, () => ({ operation: "stat" as const, path: "a" }))
                )
              )
            ).toMatchObject({ reason: { _tag: "BadArgument" } })
          }
          for (const count of [1, 2]) {
            expect(
              (yield* Batch.batch(fs)!.execute(
                Array.from({ length: count }, () => ({ operation: "stat" as const, path: "a" }))
              )).entries
            ).toHaveLength(count)
          }
          expect(host.requests).toHaveLength(2)
        }),
        host.fs
      )
    }))

  it("leaves batching optional for isolated or ordinary hosts", () => {
    const fs = FileSystem.makeNoop({})
    expect(Batch.batch(fs)).toBeUndefined()
    expect(Batch.batch(Batch.withIsolatedFileSystem(fs))).toBeUndefined()
  })

  it.effect("does not advertise batching after guarding a host without batch limits", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path), stat: () => Effect.succeed(info) })
      for (const host of [fs, Batch.withIsolatedFileSystem({ ...fs })]) {
        yield* provide(
          Effect.gen(function*() {
            expect(Batch.batch(yield* FileSystem.FileSystem)).toBeUndefined()
          }),
          host
        )
      }
    }))

  it.effect("runs the shared contract against optional hosts and checks the full advertised protocol", () =>
    Effect.gen(function*() {
      const fs = FileSystem.makeNoop({ realPath: (path) => Effect.succeed(path), stat: () => Effect.succeed(info) })
      yield* BatchContract.check(fs, "/workspace").pipe(Effect.provide(Path.layer))
      Batch.withAtomicFileSystem(fs, { execute: () => Effect.die("no batch") })
      yield* BatchContract.check(fs, "/workspace").pipe(Effect.provide(Path.layer))
      Batch.withAtomicFileSystem(fs, {
        batchLimits: { size: 128, response: 1024 },
        execute: batchExecutor((request) => {
          expect(request).toMatchObject({
            operation: "batch",
            rootIdentity: "7:9",
            boundaryRoot: "/workspace",
            logicalRoot: "/workspace"
          })
          expect(request.requests.map((member) => member.operation)).toEqual([
            "digest",
            "stat",
            "readDirectory",
            "glob",
            "digest"
          ])
          const results: Array<Batch.BatchEntry> = [
            {
              index: 0,
              path: "/workspace/source.txt",
              result: Result.succeed({
                operation: "digest",
                digest: createHash("sha256").update("host-contract").digest("hex"),
                sizeBytes: 13,
                bytes: new TextEncoder().encode("host-contract")
              })
            },
            {
              index: 1,
              path: "/workspace/source.txt",
              result: Result.succeed({ operation: "stat", info: { ...info, type: "File", size: ByteSize.bytes(13) } })
            },
            {
              index: 2,
              path: "/workspace",
              result: Result.succeed({ operation: "readDirectory", paths: ["source.txt"] })
            },
            {
              index: 3,
              path: "/workspace/*.txt",
              result: Result.succeed({ operation: "glob", paths: ["/workspace/source.txt"] })
            },
            {
              index: 4,
              path: "/workspace/absent",
              result: Result.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "digest" }))
            }
          ]
          results.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index)
          return Effect.succeed({ rootIdentity: "7:9", entries: results })
        })
      })
      yield* BatchContract.check(fs, "/workspace").pipe(Effect.provide(Path.layer))
      const original = (fs as Batch.AtomicHostFileSystem)[Batch.AtomicFileSystemTypeId]
      Batch.withAtomicFileSystem(fs, { ...original, identifyRoot: () => Effect.succeed("7:9") })
      yield* BatchContract.check(fs, "/workspace").pipe(Effect.provide(Path.layer))
    }))
})
