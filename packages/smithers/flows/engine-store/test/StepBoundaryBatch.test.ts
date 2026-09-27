import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Effect, FileSystem, Layer, PlatformError, Result } from "effect"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as FileEnumeration from "../src/internal/FileEnumeration.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { hostPath } from "./HostPath.ts"

const roots: Array<string> = []
const temporary = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-boundary-batch-")))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const guarded = (root: string, options: AtomicFileSystem.Options = {}) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layerWith(options)),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
// Independent canonical oracle for this fixture's finite JSON values.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      ).join(",")
    }}`
  }
  return JSON.stringify(value)
}
const key = (value: unknown) => `key1_${sha(canonical(value))}`

describe("batched boundary identities", () => {
  it.each(["wrong operation", "missing content", "changed output"])(
    "refuses a host's %s during settlement",
    async (fault) => {
      let calls = 0
      const bytes = Uint8Array.of(1)
      const fs = Object.assign(FileSystem.makeNoop({}), {
        [KernelFileSystem.FileSystemBatchTypeId]: {
          maxSize: 128,
          maxResponseBytes: 24000,
          execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) =>
            Effect.sync(() => {
              calls++
              return {
                rootIdentity: "7:9",
                entries: requests.map((request, index) => ({
                  index,
                  path: request.path,
                  result: Result.succeed(
                    fault === "wrong operation"
                      ? { operation: "readDirectory", paths: [] }
                      : {
                        operation: "digest",
                        sizeBytes: 1,
                        digest: fault === "changed output" && calls > 1 ? sha("new") : sha(bytes),
                        ...(fault === "missing content" ? {} : { bytes })
                      }
                  )
                }))
              }
            })
        }
      })
      const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory())
      await Effect.runPromise(
        Effect.gen(function*() {
          const prepared = yield* boundary.prepare({ readSet: [], writeSet: ["a"], boundaryMode: "hard" })
          expect(yield* Effect.flip(boundary.settle(prepared))).toMatchObject({
            code: "unsupported_boundary",
            cause: expect.any(Error)
          })
        }).pipe(Effect.provide(NodeCrypto.layer))
      )
    }
  )

  it("preserves the exact per-path cause from a failed digest", async () => {
    const cause = PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "digest" })
    const fs = Object.assign(FileSystem.makeNoop({}), {
      [KernelFileSystem.FileSystemBatchTypeId]: {
        maxSize: 128,
        maxResponseBytes: 24000,
        execute: () =>
          Effect.succeed({
            rootIdentity: "7:9",
            entries: [{ index: 0, path: "a", result: Result.fail(cause) }]
          })
      }
    })
    const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory())
    const error = await Effect.runPromise(
      Effect.flip(boundary.prepare({ readSet: [{ path: "a", digest: "old" }], writeSet: [], boundaryMode: "hard" }))
        .pipe(Effect.provide(NodeCrypto.layer))
    )
    expect(error.cause).toBe(cause)
  })
  it("matches the ordinary guarded read path and independent hashes for trees, globs, absences, removals and Unicode", async () => {
    const root = await temporary()
    const input = new Map<string, Uint8Array>([
      ["src/a.txt", Buffer.from("small")],
      ["src/.雪.txt", Buffer.from("unicode 雪")],
      ["src/nested/😀.txt", Buffer.alloc(1024 * 1024 + 1, 173)],
      ["removed", Buffer.from("remove")]
    ])
    const output = new Map<string, Uint8Array>([
      ["out/a.bin", Buffer.from([0, 128, 255])],
      ["out/nested/雪.bin", Buffer.alloc(2 * 1024 * 1024 + 1, 231)],
      ["out/.hidden", Buffer.from("hidden")],
      ["top.txt", Buffer.from("top")]
    ])
    for (const [path, bytes] of input) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), bytes)
    }
    const descriptor: FileBoundary = {
      readSet: [{ _tag: "Glob", include: ["src/**/*.txt"] }, { path: "absent", digest: "old" }, {
        path: "removed",
        digest: sha("remove")
      }],
      writeSet: [{ _tag: "TreeArtifact", path: "out" }, { _tag: "Glob", include: ["top*.txt"] }, "never"],
      removes: ["removed", "absent-removal"],
      boundaryMode: "expected"
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const old = StepBoundary.makeFileSystem(
          { ...fs, [KernelFileSystem.FileSystemBatchTypeId]: undefined } as FileSystem.FileSystem,
          hostPath,
          ArtifactStore.makeMemory(),
          { maxInlineBytes: 64 }
        )
        const batched = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory(), { maxInlineBytes: 64 })
        const prepared = yield* batched.prepare(descriptor)
        expect(prepared).toEqual(yield* old.prepare(descriptor))
        const expectedReads = [...input].map(([path, bytes]) => ({ path, digest: sha(bytes) })).concat({
          path: "absent",
          digest: "absent"
        }).sort((a, b) => a.path < b.path ? -1 : 1)
        expect(prepared.readSnapshot).toEqual(expectedReads)
        expect(key(prepared.readSnapshot)).toBe(key(expectedReads))
        yield* Effect.promise(async () => {
          for (const [path, bytes] of output) {
            await mkdir(join(root, path, ".."), { recursive: true })
            await writeFile(join(root, path), bytes)
          }
          await rm(join(root, "removed"))
        })
        const evidence = yield* batched.settle(prepared)
        expect(evidence).toEqual(yield* old.settle(prepared))
        const outputs = [...output].map(([path, bytes]) => ({
          path,
          digest: sha(bytes),
          sizeBytes: bytes.length,
          ...(bytes.length <= 64 ? { content: Buffer.from(bytes).toString("base64") } : {})
        })).concat(["absent-removal", "never", "removed"].map((path) => ({ path, digest: null } as never))).sort((
          a,
          b
        ) => a.path < b.path ? -1 : 1)
        const trees = [{
          path: "out",
          identity: key({
            kind: "tree-artifact",
            files: [...output].filter(([path]) => path.startsWith("out/")).sort(([a], [b]) => a < b ? -1 : 1).map((
              [path, bytes]
            ) => [path.slice(4), sha(bytes)])
          })
        }]
        expect(evidence.declaredOutputs).toEqual({ outputs, trees })
        expect(evidence.diffIdentity).toBe(
          key({ kind: "diff-identity", outputs: outputs.map(({ path, digest }) => [path, digest]), trees })
        )
        expect(evidence.deviation).toMatchObject({ _tag: "MissingDeclaredOutput", paths: ["never"] })
        expect(yield* FileEnumeration.filesUnder(fs, "out")).toEqual(
          [...output.keys()].filter((path) => path.startsWith("out/")).sort()
        )
      }).pipe(Effect.provide(guarded(root)), Effect.provide(NodeCrypto.layer))
    )
  })

  it("splits output content at the byte budget while keeping manifests identical", async () => {
    const root = await temporary()
    const paths = ["a", "b", "c"]
    for (const path of paths) await writeFile(join(root, path), Buffer.alloc(12_000, path.charCodeAt(0)))
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory())
        const descriptor: FileBoundary = { readSet: [], writeSet: paths, boundaryMode: "hard" }
        const evidence = yield* boundary.settle(yield* boundary.prepare(descriptor))
        expect(
          (evidence.declaredOutputs as { outputs: Array<{ path: string; digest: string }> }).outputs.map((
            { path, digest }
          ) => [path, digest])
        )
          .toEqual(paths.map((path) => [path, sha(Buffer.alloc(12_000, path.charCodeAt(0)))]))
      }).pipe(Effect.provide(guarded(root, { limits: { response: 24_000 } })), Effect.provide(NodeCrypto.layer))
    )
  })

  it("refuses a replacement root between prepare and settle", async () => {
    const container = await temporary()
    const root = join(container, "root")
    await mkdir(root)
    await writeFile(join(root, "a"), "old")
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory())
        const prepared = yield* boundary.prepare({
          readSet: [{ path: "a", digest: sha("old") }],
          writeSet: [],
          boundaryMode: "hard"
        })
        yield* Effect.promise(async () => {
          await rename(root, join(container, "moved"))
          await mkdir(root)
          await writeFile(join(root, "a"), "old")
        })
        const failure = yield* Effect.flip(boundary.settle(prepared))
        expect(failure).toMatchObject({ code: "unsupported_boundary", cause: { reason: { _tag: "Busy" } } })
      }).pipe(Effect.provide(guarded(root)), Effect.provide(NodeCrypto.layer))
    )
  })
})
