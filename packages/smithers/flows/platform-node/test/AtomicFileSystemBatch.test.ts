import * as NodePath from "@effect/platform-node/NodePath"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { checkFileSystemBatch } from "@smthrs/kernel/test/contract"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, FileSystem, Layer, Result } from "effect"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const spawns = vi.hoisted(() => ({ count: 0 }))
vi.mock("node:child_process", async (original) => {
  const module = await original<typeof import("node:child_process")>()
  return {
    ...module,
    spawn: (...args: Parameters<typeof module.spawn>) => {
      spawns.count += 1
      return module.spawn(...args)
    }
  }
})

const directories: Array<string> = []
const temporary = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-batch-")))
  directories.push(root)
  return root
}
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true })
})
const guarded = (root: string, options: AtomicFileSystem.Options = {}) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layerWith(options)),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
const batch = (
  root: string,
  requests: ReadonlyArray<KernelFileSystem.BatchRequest>,
  options: AtomicFileSystem.Options = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* KernelFileSystem.batch(fs)!.execute(requests)
    }).pipe(Effect.provide(guarded(root, options)))
  )

describe("confined read batches", () => {
  /**
   * Authorization resolves every member through the helper, never by host
   * pathname (#2882): one batched `resolve` before the grants, one after them,
   * then the measured batch itself.
   */
  const helpersPerBatch = 3
  it("passes the shared host batch contract against the real confined helper", async () => {
    const root = await temporary()
    await writeFile(join(root, "source.txt"), "host-contract")
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* checkFileSystemBatch(yield* FileSystem.FileSystem, root)
      }).pipe(Effect.provide(AtomicFileSystem.layer), Effect.provide(NodePath.layer))
    )
  })
  it.each([15, 150, 257])("starts three helpers per 128-member batch over %i paths", async (count) => {
    const root = await temporary()
    const paths = Array.from({ length: count }, (_, index) => String(index).padStart(5, "0"))
    for (let offset = 0; offset < paths.length; offset += 16) {
      await Promise.all(paths.slice(offset, offset + 16).map((path) => writeFile(join(root, path), path)))
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const extension = KernelFileSystem.batch(fs)!
        const before = AtomicFileSystem.helperSpawns()
        let measured = 0
        for (let offset = 0; offset < paths.length; offset += 128) {
          const group = paths.slice(offset, offset + 128)
          const response = yield* extension.execute(group.map((path) => ({ operation: "digest", path })))
          for (const entry of response.entries) {
            expect(Result.getOrThrow(entry.result)).toMatchObject({
              digest: createHash("sha256").update(group[entry.index]!).digest("hex")
            })
            measured++
          }
        }
        expect(measured).toBe(count)
        expect(AtomicFileSystem.helperSpawns() - before).toBe(helpersPerBatch * Math.ceil(count / 128))
      }).pipe(Effect.provide(guarded(root)))
    )
  })

  it("orders astral and BMP filenames by UTF-16 code units", async () => {
    const root = await temporary()
    const names = ["\uE000", "\u{10000}"]
    for (const path of names) await writeFile(join(root, path), path)
    const response = await batch(root, names.map((path) => ({ operation: "digest", path })))
    expect(response.entries.map((entry) => entry.index)).toEqual([1, 0])
  })
  it("returns deterministic indexed stat, directory, glob, digest and missing results in one batch", async () => {
    const root = await temporary()
    await mkdir(join(root, "nested"))
    const bytes = Buffer.from([0, 255, 127, 1])
    await writeFile(join(root, "nested", "雪.txt"), bytes)
    await writeFile(join(root, "a.txt"), "a")
    const before = spawns.count
    const answer = await batch(root, [
      { operation: "digest", path: "nested/雪.txt", content: true },
      { operation: "stat", path: "a.txt" },
      { operation: "readDirectory", path: ".", options: { recursive: true } },
      { operation: "glob", path: "**/*.txt", root },
      { operation: "digest", path: "absent" },
      { operation: "digest", path: "a.txt" }
    ])
    expect(spawns.count - before).toBe(helpersPerBatch)
    expect(answer.entries.map((entry) => entry.path)).toEqual(answer.entries.map((entry) => entry.path).sort())
    const results = [...answer.entries].sort((a, b) => a.index - b.index).map((entry) => entry.result)
    expect(Result.getOrThrow(results[0]!)).toEqual({
      operation: "digest",
      digest: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: 4,
      bytes: Uint8Array.from(bytes)
    })
    expect(Result.getOrThrow(results[1]!)).toMatchObject({ operation: "stat", info: { type: "File", size: 1n } })
    expect(Result.getOrThrow(results[2]!)).toEqual({
      operation: "readDirectory",
      paths: ["a.txt", "nested", "nested/雪.txt"]
    })
    expect(Result.getOrThrow(results[3]!)).toEqual({
      operation: "glob",
      paths: [join(root, "a.txt"), join(root, "nested/雪.txt")]
    })
    expect(results[4]).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "NotFound" } } })
    expect(Result.getOrThrow(results[5]!)).toEqual({
      operation: "digest",
      digest: createHash("sha256").update("a").digest("hex"),
      sizeBytes: 1
    })
    expect(answer.rootIdentity).toMatch(/^\d+:\d+$/)
  })

  it.each([127, 128, 129])("enforces the 128-operation ceiling at %i", async (count) => {
    const root = await temporary()
    await writeFile(join(root, "value"), "value")
    const before = spawns.count
    const result = batch(root, Array.from({ length: count }, () => ({ operation: "digest" as const, path: "value" })))
    if (count <= 128) {
      expect((await result).entries).toHaveLength(count)
      expect(spawns.count - before).toBe(helpersPerBatch)
    } else {
      await expect(result).rejects.toMatchObject({ reason: { _tag: "BadArgument" } })
      expect(spawns.count - before).toBe(0)
    }
  })
})
