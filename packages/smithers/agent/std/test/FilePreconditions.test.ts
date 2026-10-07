/** Unit contract for the optional host policy, over real disk operations.
 * The callback is deliberately controlled here to test preflight ordering;
 * production coding policy/dispatcher behavior is tested in flows/test.
 * This is not a real-machine or authenticated-daemon acceptance receipt.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Read from "../src/Read.ts"
import { StdError } from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

const original = "alpha\nbeta\n"
const stale = (path: string) =>
  new StdError({
    code: "stale_read",
    path,
    message: "Re-read",
    base_digest: "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee",
    current_digest: "92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43"
  })

it("passes complete successful read bytes and the run identity to the host policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "std-read-policy-"))
  try {
    const target = join(root, "a.txt")
    await writeFile(target, original)
    const calls: Array<{ path: string; bytes: string; session: string | undefined }> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const guarded: Read.VersionedFileSystem = {
          ...fs,
          [Read.Preconditions]: {
            record: (path, bytes, session) =>
              Effect.sync(() => {
                calls.push({ path, bytes: new TextDecoder().decode(bytes), session })
              }),
            validate: () => Effect.void
          }
        }
        const page = yield* Read.run({ path: target, limit: 1 }).pipe(
          Effect.provideService(FileSystem.FileSystem, guarded),
          Effect.provideService(Read.ReadSession, "run-a")
        )
        expect(page.content).toBe("alpha")
        expect(calls).toEqual([{ path: target, bytes: original, session: "run-a" }])
        const failed = yield* Effect.flip(
          Read.run({ path: target, offset: 99 }).pipe(
            Effect.provideService(FileSystem.FileSystem, guarded)
          )
        )
        expect(failed.code).toBe("offset_out_of_range")
        expect(calls).toHaveLength(1)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses write and add before creating parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "std-write-policy-"))
  try {
    const target = join(root, "missing", "a.txt")
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const guarded: Read.VersionedFileSystem = {
          ...fs,
          [Read.Preconditions]: {
            record: () => Effect.void,
            validate: (paths, session) => {
              expect(paths).toEqual([target])
              expect(session).toBe("run-a")
              return Effect.fail(new StdError({ code: "provider_unavailable", message: "Unavailable" }))
            }
          }
        }
        for (
          const action of [
            Write.run({ path: target, content: "mine\n" }).pipe(Effect.asVoid),
            ApplyPatch.run({ input: `*** Begin Patch\n*** Add File: ${target}\n+mine\n*** End Patch` }).pipe(
              Effect.asVoid
            )
          ]
        ) {
          const failure = yield* Effect.flip(action.pipe(
            Effect.provideService(FileSystem.FileSystem, guarded),
            Effect.provideService(Read.ReadSession, "run-a")
          ))
          expect(failure.code).toBe("provider_unavailable")
          expect(yield* fs.readDirectory(root)).toEqual([])
        }
      }).pipe(Effect.provide(NodeServices.layer))
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses a stale preparation before any filesystem mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "std-edit-policy-"))
  try {
    const target = join(root, "a.txt")
    await writeFile(target, original)
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let checks = 0
        const guarded: Read.VersionedFileSystem = {
          ...fs,
          [Read.Preconditions]: {
            record: () => Effect.void,
            validate: () =>
              Effect.gen(function*() {
                checks++
                const locks = (yield* fs.readDirectory(root).pipe(Effect.orDie)).filter((name) =>
                  name.endsWith(".lock")
                )
                expect(locks).toHaveLength(0)
              }),
            prepare: () => Effect.fail(stale(target))
          }
        }
        const failure = yield* Effect.flip(
          Edit.run({ path: target, oldString: "alpha", newString: "mine" }).pipe(
            Effect.provideService(FileSystem.FileSystem, guarded)
          )
        )
        expect(failure.code).toBe("stale_read")
        expect(checks).toBe(1)
      }).pipe(Effect.provide(NodeServices.layer))
    )
    expect(await readFile(target, "utf8")).toBe(original)
    expect(await readdir(root)).toEqual(["a.txt"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
