import { NodeServices } from "@effect/platform-node"
import * as Write from "@smthrs/std/Write"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
test("packaged helper guards ignored files and unbounded mutation forms", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper)
  const directory = await mkdtemp(join(tmpdir(), "coding-file-policy-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), "*.ignore\n")
  await writeFile(join(root, "ordinary.txt"), "ordinary\n")
  await writeFile(join(root, "blocked.ignore"), "blocked\n")
  execFileSync("jj", ["-R", root, "status"], { stdio: "pipe" })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make(
        { repositoryPath: root, helperPath: helper },
        fs,
        spawner,
        yield* fs.realPath(root)
      )
      const denied = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.result,
          Effect.map((result) => {
            assert.equal(result._tag, "Failure")
          })
        )
      yield* denied(coding.writeFileString(join(root, "blocked.ignore"), "changed\n"))
      yield* denied(coding.rename(join(root, "ordinary.txt"), join(root, "destination.ignore")))
      yield* denied(coding.remove(root, { recursive: true }))
      yield* coding.writeFileString(join(root, "ordinary.txt"), "changed\n")
    }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(await readFile(join(root, "blocked.ignore"), "utf8"), "blocked\n")
  assert.equal(await readFile(join(root, "ordinary.txt"), "utf8"), "changed\n")
})

test("public write releases only its own native coding lock", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper)
  const directory = await mkdtemp(join(tmpdir(), "coding-write-lock-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const canonicalRoot = await realpath(root)
  const target = join(root, "file.txt")
  const canonicalTarget = join(canonicalRoot, "file.txt")
  await writeFile(target, "original\n")
  const userDirectory = join(root, "user-directory")
  await mkdir(userDirectory)
  await writeFile(join(userDirectory, "keep.txt"), "keep\n")

  // FileMutation's stable on-disk lock name must be computed from the canonical target.
  let hash = 5381
  const lockKey = canonicalTarget.normalize("NFC").toUpperCase()
  for (let index = 0; index < lockKey.length; index++) {
    hash = (hash * 33) ^ lockKey.charCodeAt(index)
  }
  const lock = join(canonicalRoot, `.smithers-${(hash >>> 0).toString(16)}.lock`)
  await mkdir(lock)
  await writeFile(join(lock, "owner"), "another writer\n")

  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const coding = CodingFileSystem.make(
        { repositoryPath: root, helperPath: helper },
        fs,
        spawner,
        canonicalRoot
      )
      const write = (content: string) =>
        Write.run({ path: target, content }).pipe(Effect.provideService(FileSystem.FileSystem, coding))

      const held = yield* Effect.flip(write("blocked\n"))
      assert.equal(held.code, "no_match")
      assert.equal(yield* fs.readFileString(join(lock, "owner")), "another writer\n")
      assert.equal(yield* fs.readFileString(target), "original\n")
      yield* fs.remove(lock, { recursive: true })

      const first = yield* write("first\n")
      assert.deepEqual(first, { path: target, bytesWritten: 6, created: false })
      assert.equal(yield* fs.readFileString(target), "first\n")
      assert.equal(
        (yield* Effect.promise(() => readdir(canonicalRoot))).filter((name) => name.endsWith(".lock")).length,
        0
      )

      const second = yield* write("second\n")
      assert.deepEqual(second, { path: target, bytesWritten: 7, created: false })
      assert.equal(yield* fs.readFileString(target), "second\n")
      assert.equal(
        (yield* Effect.promise(() => readdir(canonicalRoot))).filter((name) => name.endsWith(".lock")).length,
        0
      )

      const refused = yield* Effect.result(coding.remove(userDirectory, { recursive: true }))
      assert.equal(refused._tag, "Failure")
      assert.equal(yield* fs.readFileString(join(userDirectory, "keep.txt")), "keep\n")

      yield* coding.makeDirectory(lock, { mode: 0o700 })
      yield* fs.writeFileString(join(lock, "unexpected"), "retain\n")
      assert.equal((yield* Effect.result(coding.remove(lock, { recursive: true })))._tag, "Failure")
      assert.equal(yield* fs.readFileString(join(lock, "unexpected")), "retain\n")
      yield* fs.remove(join(lock, "unexpected"))
      yield* coding.remove(lock, { recursive: true })
      // Successful cleanup must relinquish ownership of a subsequently recreated lock.
      yield* fs.makeDirectory(lock, { mode: 0o700 })
      assert.equal((yield* Effect.result(coding.remove(lock, { recursive: true })))._tag, "Failure")
      assert.equal(yield* fs.exists(lock), true)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
