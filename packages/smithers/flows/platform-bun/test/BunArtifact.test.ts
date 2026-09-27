import { expect, it } from "@effect/vitest"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Effect, FileSystem, Path } from "effect"
import * as BunHost from "../src/BunHost.ts"

it.effect("puts an artifact with only BunHost provided", () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const store = ArtifactStore.makeFileSystem(fs, yield* Path.Path, { directory })
    const bytes = new TextEncoder().encode("bun digest")
    const digest = yield* store.put(bytes)
    expect(Array.from(yield* store.get(digest))).toEqual(Array.from(bytes))
  }).pipe(Effect.scoped, Effect.provide(BunHost.layer)))

it("exports containment and liveness surfaces", () => {
  expect(BunHost.ProcessReaper.layer).toBeTypeOf("function")
  expect(BunHost.HostLiveness.isAlive).toBeTypeOf("function")
})
