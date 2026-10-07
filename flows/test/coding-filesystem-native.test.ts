/** Std boundary tests with a test-only atomic provider; no machine qualification. */
import { NodeServices } from "@effect/platform-node"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Edit from "@smthrs/std/Edit"
import * as Read from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
test("coding std ledger rejects stale and unread writes, advances only its run, and resets on resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-read-ledger-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "a"), "alpha\nbeta\n")
  let calls = 0
  const provider: CodingFileSystem.MutationProvider = {
    commit: (_session, changes) =>
      Effect.tryPromise({
        try: async () => {
          calls++
          // The fake owns the entire comparison boundary, just as the real
          // provider must. No writes occur until every affected base matches.
          for (const change of changes) {
            const current = await readFile(join(root, change.path)).then(hash, () => "absent")
            if (current !== change.base_digest) {
              throw new StdError({
                code: "stale_read",
                path: join(root, change.path),
                base_digest: change.base_digest,
                current_digest: current,
                message: "Re-read"
              })
            }
          }
          for (const change of changes) {
            if (change.content === null) await rm(join(root, change.path), { force: true })
            else await writeFile(join(root, change.path), change.content)
          }
        },
        catch: (error) =>
          error instanceof StdError ? error : new StdError({ code: "provider_unavailable", message: String(error) })
      })
  }
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
      const call = <A, E, R>(effect: Effect.Effect<A, E, R>, run = "a") =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, coding),
          Effect.provideService(Read.ReadSession, run)
        )
      const path = join(root, "a")
      const denied = yield* Effect.flip(call(Write.run({ path, content: "blind" })))
      assert.equal(denied.code, "stale_read")
      assert.equal(denied.base_digest, "unread")
      assert.equal(calls, 0)
      const page = yield* call(Read.run({ path, limit: 1 }))
      assert.equal(page.content, "alpha")
      yield* call(Write.run({ path, content: "own" }))
      yield* call(Edit.run({ path, oldString: "own", newString: "next" }))
      assert.equal(yield* fs.readFileString(path), "next")
      assert.equal((yield* Effect.flip(call(Write.run({ path, content: "other" }), "b"))).base_digest, "unread")
      const resumed = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
      assert.equal(
        (yield* Effect.flip(
          Write.run({ path, content: "resume" }).pipe(
            Effect.provideService(FileSystem.FileSystem, resumed),
            Effect.provideService(Read.ReadSession, "a")
          )
        )).base_digest,
        "unread"
      )
      yield* fs.writeFileString(path, "outside")
      for (
        const mutation of [
          Write.run({ path, content: "bad" }).pipe(Effect.asVoid),
          Edit.run({ path, oldString: "next", newString: "bad" }).pipe(Effect.asVoid),
          ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-next\n+bad\n*** End Patch` }).pipe(
            Effect.asVoid
          )
        ]
      ) {
        const failure = yield* Effect.flip(call(mutation))
        assert.equal(failure.code, "stale_read")
        assert.equal(failure.path, path)
        assert.equal(failure.current_digest, hash(Buffer.from("outside")))
      }
      assert.equal(yield* fs.readFileString(path), "outside")
      yield* call(Read.run({ path }))
      yield* call(Write.run({ path, content: "reread" }))
      const absent = join(root, "new")
      yield* call(Write.run({ path: absent, content: "created" }))
      yield* call(Write.run({ path: absent, content: "advanced" }))
      assert.equal(yield* fs.readFileString(absent), "advanced")
      assert.equal((yield* Effect.result(coding.writeFileString(path, "raw")))._tag, "Failure")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("unavailable provider refuses all std mutations before creating protocol files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-no-writer-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root)
      const path = join(root, "new", "a")
      const failure = yield* Effect.flip(
        Write.run({ path, content: "bad" }).pipe(
          Effect.provideService(FileSystem.FileSystem, coding),
          Effect.provideService(Read.ReadSession, "run")
        )
      )
      assert.equal(failure.code, "provider_unavailable")
      assert.deepEqual(yield* fs.readDirectory(root), [])
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("whole patch later-stale and exchange refusals leave earlier bytes and ledger unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-patch-ledger-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ["a", "b"]) await writeFile(join(root, name), "original\n")
  let exchangeRace = false
  let calls = 0
  const provider: CodingFileSystem.MutationProvider = {
    commit: (_session, changes) =>
      Effect.tryPromise({
        try: async () => {
          calls++
          if (exchangeRace) await writeFile(join(root, "b"), "outside\n")
          for (const change of changes) {
            const current = await readFile(join(root, change.path)).then(hash, () => "absent")
            if (current !== change.base_digest) {
              throw new StdError({
                code: "stale_read",
                path: join(root, change.path),
                base_digest: change.base_digest,
                current_digest: current,
                message: "Re-read"
              })
            }
          }
          for (const change of changes) {
            if (change.content === null) await rm(join(root, change.path))
            else await writeFile(join(root, change.path), change.content)
          }
        },
        catch: (error) => error as StdError
      })
  }
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
      const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, coding),
          Effect.provideService(Read.ReadSession, "run")
        )
      for (const name of ["a", "b"]) yield* call(Read.run({ path: join(root, name) }))
      const input = `*** Begin Patch\n*** Update File: ${join(root, "a")}\n@@\n-original\n+updated\n*** Update File: ${
        join(root, "b")
      }\n@@\n-original\n+updated\n*** End Patch`
      yield* fs.writeFileString(join(root, "b"), "outside\n")
      assert.equal((yield* Effect.flip(call(ApplyPatch.run({ input })))).code, "stale_read")
      assert.equal(calls, 0)
      assert.equal(yield* fs.readFileString(join(root, "a")), "original\n")
      yield* fs.writeFileString(join(root, "b"), "original\n")
      exchangeRace = true
      assert.equal((yield* Effect.flip(call(ApplyPatch.run({ input })))).code, "stale_read")
      assert.equal(calls, 1)
      assert.equal(yield* fs.readFileString(join(root, "a")), "original\n")
      assert.equal(yield* fs.readFileString(join(root, "b")), "outside\n")
      exchangeRace = false
      yield* call(Write.run({ path: join(root, "a"), content: "original base retained" }))
      assert.equal(
        (yield* Effect.flip(call(Write.run({ path: join(root, "b"), content: "bad" })))).base_digest,
        hash(Buffer.from("original\n"))
      )
      yield* call(Read.run({ path: join(root, "a") }))
      yield* call(Read.run({ path: join(root, "b") }))
      {
        yield* fs.writeFileString(join(root, "occupied"), "keep")
        const refused = yield* Effect.flip(
          call(
            ApplyPatch.run({
              input: `*** Begin Patch\n*** Update File: ${join(root, "a")}\n*** Move to: ${
                join(root, "occupied")
              }\n@@\n-original base retained\n+moved\n*** End Patch`
            })
          )
        )
        assert.equal(refused.code, "stale_read")
        assert.equal(refused.base_digest, "unread")
        assert.equal(yield* fs.readFileString(join(root, "occupied")), "keep")
      }
      yield* call(
        ApplyPatch.run({
          input: `*** Begin Patch\n*** Add File: ${join(root, "added")}\n+added\n*** Update File: ${
            join(root, "a")
          }\n*** Move to: ${join(root, "moved")}\n@@\n-original base retained\n+moved\n*** Delete File: ${
            join(root, "b")
          }\n*** End Patch`
        })
      )
      assert.equal(yield* fs.exists(join(root, "a")), false)
      assert.equal(yield* fs.exists(join(root, "b")), false)
      assert.equal(yield* fs.readFileString(join(root, "added")), "added\n")
      assert.equal(yield* fs.readFileString(join(root, "moved")), "moved\n")
      yield* call(Write.run({ path: join(root, "moved"), content: "own move" }))
      yield* call(Write.run({ path: join(root, "b"), content: "own deletion" }))
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
