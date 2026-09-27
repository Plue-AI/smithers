/**
 * The optional atomic batch portion of the shared host contract.
 *
 * @since 1.0.0
 */

import { expect } from "@effect/vitest"
import { Effect, type FileSystem, Option, Path, Result } from "effect"
import * as KernelFileSystem from "../FileSystem.ts"

/**
 * Exercises every advertised batch implementation over the host contract's
 * fresh `source.txt` fixture. Isolated volumes may omit this optimization.
 *
 * @since 1.0.0
 * @category testing
 */
export const check = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function*() {
    const atomic = (fs as Partial<KernelFileSystem.AtomicHostFileSystem>)[KernelFileSystem.AtomicFileSystemTypeId]
    if (atomic?.batchLimits === undefined) {
      expect(KernelFileSystem.batch(fs)).toBeUndefined()
      return
    }
    const path = yield* Path.Path
    const boundaryRoot = yield* fs.realPath(root)
    const rootIdentity = atomic.identifyRoot === undefined
      ? yield* Effect.map(fs.stat(root), (info) => `${info.dev}:${Option.getOrThrow(info.ino)}`)
      : yield* atomic.identifyRoot(boundaryRoot)
    const response = yield* atomic.execute({
      operation: "batch",
      boundaryRoot,
      logicalRoot: root,
      rootIdentity,
      requests: [
        { operation: "digest", path: path.join(root, "source.txt"), content: true },
        { operation: "stat", path: path.join(root, "source.txt") },
        { operation: "readDirectory", path: root },
        { operation: "glob", path: path.join(root, "*.txt"), root },
        { operation: "digest", path: path.join(root, "absent") }
      ]
    })
    expect(response.rootIdentity).toBe(rootIdentity)
    expect(response.entries.map((entry) => entry.index)).toEqual([2, 3, 4, 0, 1])
    const entries = [...response.entries].sort((a, b) => a.index - b.index)
    expect(Result.getOrThrow(entries[0]!.result)).toEqual({
      operation: "digest",
      digest: "0e1c618211c39c03726d50ee05e7e520ca6d8a2a3619b17983adc574e3ca34bf",
      sizeBytes: 13,
      bytes: new TextEncoder().encode("host-contract")
    })
    expect(Result.getOrThrow(entries[1]!.result)).toMatchObject({
      operation: "stat",
      info: { type: "File", size: 13n }
    })
    expect(Result.getOrThrow(entries[2]!.result)).toEqual({ operation: "readDirectory", paths: ["source.txt"] })
    expect(Result.getOrThrow(entries[3]!.result)).toEqual({ operation: "glob", paths: [path.join(root, "source.txt")] })
    expect(entries[4]!.result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "NotFound" } } })
  })
