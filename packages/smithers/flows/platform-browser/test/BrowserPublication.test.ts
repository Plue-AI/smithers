import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Effect, FileSystem, Path } from "effect"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BrowserFileSystem from "../src/BrowserFileSystem/index.ts"
import * as BrowserHost from "../src/BrowserHost.ts"

it.effect("refuses filesystem publication without trusted handles and uses memory on BrowserHost", () =>
  Effect.gen(function*() {
    const root = yield* Effect.promise(() => fs.mkdtemp(join(tmpdir(), "browser-artifact-")))
    try {
      const bytes = new TextEncoder().encode("browser publication")
      yield* Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const store = ArtifactStore.makeFileSystem(fileSystem, yield* Path.Path, {
          directory: root,
          durability: "best-effort",
          coordination: "process"
        })
        const refusal = yield* Effect.flip(store.put(bytes))
        expect(refusal.code).toBe("unavailable")
        expect(refusal.message).toContain("readLink")
        const memory = ArtifactStore.makeMemory()
        const digest = yield* memory.put(bytes)
        expect(yield* memory.get(digest)).toEqual(bytes)
        expect(yield* memory.put(bytes)).toBe(digest)
      }).pipe(
        Effect.provide(BrowserHost.layer({
          fs,
          bash: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
          jj: { wasm: new Uint8Array(), fs: {} as never }
        })),
        Effect.provide(NodeCrypto.layer)
      )
    } finally {
      yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
    }
  }))

it.effect("an unavailable rename of an existing file is not missing", () =>
  Effect.gen(function*() {
    const adapter = BrowserFileSystem.make({ ...fs, rename: undefined })
    expect(yield* adapter.exists(import.meta.filename)).toBe(true)
    const error = yield* Effect.flip(adapter.rename(import.meta.filename, "/unused"))
    expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "rename" })
    expect(error.message).toContain("rename")
  }))

it.effect("refuses isolation for a workspace smaller than its mount", () =>
  Effect.gen(function*() {
    const error = yield* Effect.flip(
      Effect.provide(FileSystem.FileSystem, BrowserFileSystem.layer(fs, { workspaceRoot: "/repo" }))
    )
    expect(error.reason).toMatchObject({ _tag: "PermissionDenied", method: "layer" })
  }))
