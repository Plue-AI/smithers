import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, PlatformError, Result } from "effect"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import * as FileEnumeration from "../src/internal/FileEnumeration.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { hostPath } from "./HostPath.ts"

describe("filesystem batch fallback", () => {
  it("groups metadata across sibling directories instead of starting one batch per leaf", async () => {
    let calls = 0
    const names = Array.from({ length: 150 }, (_, index) => `d${String(index).padStart(3, "0")}`)
    const fs = Object.assign(FileSystem.makeNoop({}), {
      [KernelFileSystem.FileSystemBatchTypeId]: {
        maxSize: 128,
        maxResponseBytes: 24000,
        execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) => {
          calls++
          return Effect.succeed({
            rootIdentity: "7:9",
            entries: requests.map((request, index) => ({
              index,
              path: request.path,
              result: Result.succeed(
                request.operation === "readDirectory"
                  ? { operation: "readDirectory", paths: request.path === "." ? names : ["a"] }
                  : { operation: "stat", info: { type: request.path.includes("/") ? "File" : "Directory" } }
              )
            }))
          })
        }
      }
    })
    expect(await Effect.runPromise(FileEnumeration.filesUnder(fs, ""))).toEqual(names.map((path) => `${path}/a`))
    expect(calls).toBe(7)
  })
  it("bounds concurrent metadata and digest work at four and passes no array index as filesystem options", async () => {
    let active = 0
    let peak = 0
    const paths = Array.from({ length: 13 }, (_, index) => String(index))
    const bounded = <A>(value: A) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active++
          peak = Math.max(peak, active)
        }),
        () =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 2))
            return value
          }),
        () =>
          Effect.sync(() => {
            active--
          })
      )
    const fs = FileSystem.makeNoop({
      readDirectory: (path, options) => {
        expect(options).toBeUndefined()
        return Effect.succeed(path === "." ? ["dir", ...paths] : ["child"])
      },
      stat: (path) => bounded({ type: path === "dir" ? "Directory" : "File" } as FileSystem.File.Info),
      readFile: () => bounded(Uint8Array.of(42))
    })
    expect(await Effect.runPromise(FileEnumeration.filesUnder(fs, ""))).toEqual([...paths, "dir/child"].sort())
    expect(peak).toBe(4)
    expect(active).toBe(0)
    peak = 0
    const boundary = StepBoundary.makeFileSystem(fs, hostPath, ArtifactStore.makeMemory())
    const prepared = await Effect.runPromise(
      boundary.prepare({ readSet: paths.map((path) => ({ path, digest: "old" })), writeSet: [], boundaryMode: "hard" })
        .pipe(Effect.provide(NodeCrypto.layer))
    )
    expect(prepared.readSnapshot).toEqual(
      [...paths].sort().map((path) => ({ path, digest: createHash("sha256").update(Uint8Array.of(42)).digest("hex") }))
    )
    expect(peak).toBe(4)
    expect(active).toBe(0)
  })

  it.each([2, 3, 4])("charges the entry budget before the next metadata batch at %i entries", async (count) => {
    let stats = 0
    const fs = Object.assign(FileSystem.makeNoop({}), {
      [KernelFileSystem.FileSystemBatchTypeId]: {
        maxSize: 2,
        maxResponseBytes: 24000,
        execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) =>
          Effect.succeed({
            rootIdentity: "7:9",
            entries: requests.map((request, index) => ({
              index,
              path: request.path,
              result: Result.succeed(
                request.operation === "readDirectory"
                  ? {
                    operation: "readDirectory",
                    paths: Array.from({ length: count }, (_, i) => String(i))
                  }
                  : (stats++, { operation: "stat", info: { type: "File" } })
              )
            }))
          })
      }
    })
    const result = await Effect.runPromise(Effect.result(FileEnumeration.filesUnder(fs, "", { maxEntries: 3 })))
    if (count <= 3) {
      expect(Result.getOrThrow(result)).toHaveLength(count)
      expect(stats).toBe(count)
    } else {
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "entry_limit_exceeded", limit: 3 } })
      expect(stats).toBe(2)
    }
  })

  it("treats only a missing walk root as empty and preserves a discovered-subtree failure", async () => {
    const refused = PlatformError.systemError({ _tag: "NotFound", module: "test", method: "readDirectory" })
    const fs = Object.assign(FileSystem.makeNoop({}), {
      [KernelFileSystem.FileSystemBatchTypeId]: {
        maxSize: 128,
        maxResponseBytes: 24000,
        execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) =>
          Effect.succeed({
            rootIdentity: "7:9",
            entries: requests.map((request, index) => ({
              index,
              path: request.path,
              result:
                request.path === "absent" || request.path === "root/child" && request.operation === "readDirectory"
                  ? Result.fail(refused)
                  : Result.succeed(
                    request.operation === "readDirectory"
                      ? { operation: "readDirectory", paths: ["child"] }
                      : { operation: "stat", info: { type: "Directory" } }
                  )
            }))
          })
      }
    })
    expect(await Effect.runPromise(FileEnumeration.filesUnder(fs, "absent"))).toEqual([])
    expect(await Effect.runPromise(Effect.flip(FileEnumeration.filesUnder(fs, "root")))).toBe(refused)
  })
})
