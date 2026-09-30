import { expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import * as BunHost from "../src/BunHost.ts"

it.effect("round-trips artifacts with explicit best-effort durability through BunHost", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const store = ArtifactStore.makeFileSystem(fs, yield* Path.Path, { directory, durability: "best-effort" })
    const bytes = new TextEncoder().encode("bun digest")
    const digest = yield* store.put(bytes)
    expect(Array.from(yield* store.get(digest))).toEqual(Array.from(bytes))
    expect(yield* store.has(digest)).toBe(true)
    expect(yield* store.put(bytes)).toBe(digest)
    expect(Array.from(yield* store.get(digest))).toEqual(Array.from(bytes))
  }).pipe(Effect.scoped, Effect.provide(BunHost.layer)))

it.effect("preserves required durability by default through BunHost", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const store = ArtifactStore.makeFileSystem(fs, yield* Path.Path, { directory })
    const bytes = new TextEncoder().encode("bun required digest")
    if (process.platform === "win32") {
      const refusal = yield* Effect.flip(store.put(bytes))
      expect(refusal).toBeInstanceOf(ArtifactStore.ArtifactStoreError)
      expect(refusal.code).toBe("unavailable")
      expect(refusal.cause).toBeInstanceOf(PlatformError.PlatformError)
      expect((refusal.cause as PlatformError.PlatformError).reason).toMatchObject({
        module: "FileSystem",
        method: "sync",
        syscall: "fsync",
        cause: { code: "EPERM" }
      })
    } else {
      const digest = yield* store.put(bytes)
      expect(Array.from(yield* store.get(digest))).toEqual(Array.from(bytes))
    }
  }).pipe(Effect.scoped, Effect.provide(BunHost.layer)))

it("exports containment and liveness surfaces", () => {
  expect(BunHost.ProcessReaper.layer).toBeTypeOf("function")
  expect(BunHost.HostLiveness.isAlive).toBeTypeOf("function")
})
