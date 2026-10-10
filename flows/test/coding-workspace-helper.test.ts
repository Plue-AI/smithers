import { NodeServices } from "@effect/platform-node"
import * as Read from "@smthrs/std/Read"
import * as Write from "@smthrs/std/Write"
import { Effect, FileSystem, Layer, ManagedRuntime } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { test } from "node:test"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import * as CodingFileSystem from "../coding/filesystem.ts"
import { layerAt } from "../coding/snapshots.ts"

const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY

test("packaged helper restores outside edits while unregistered coding writes refuse", {
  skip: helper === undefined ? "Build the workspace helper and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY" : false,
  timeout: 120_000
}, async (t) => {
  assert.ok(helper && isAbsolute(helper))
  const temporary = await mkdtemp(join(tmpdir(), "coding-workspace-helper-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo")
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, "note.txt"), "before\n")
  execFileSync("jj", ["-R", root, "status"], { cwd: root, stdio: "pipe" })
  const options = { repositoryPath: root, helperPath: helper }
  const runtime = ManagedRuntime.make(
    layerAt(options).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000))
    )
  )
  t.after(() => runtime.dispose())
  const call = <A, E>(run: (jj: Jj.Jj) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Jj.Jj, run), { signal: t.signal })
  const before = await call((jj) => jj.snapshot())
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const guarded = CodingFileSystem.make(options, fs, spawner, yield* fs.realPath(root))
      const path = join(root, "note.txt")
      const raw = yield* Effect.flip(guarded.writeFileString(path, "after\n"))
      assert.equal(raw.reason._tag, "PermissionDenied", "raw writes cannot bypass the digest boundary")
      yield* Read.run({ path }).pipe(
        Effect.provideService(FileSystem.FileSystem, guarded),
        Effect.provideService(Read.ReadSession, "fixture")
      )
      const refusal = yield* Effect.flip(
        Write.run({ path, content: "after\n" }).pipe(
          Effect.provideService(FileSystem.FileSystem, guarded),
          Effect.provideService(Read.ReadSession, "fixture")
        )
      )
      assert.equal(refusal.code, "provider_unavailable")
      assert.equal(yield* fs.readFileString(path), "before\n")
    }).pipe(Effect.provide(NodeServices.layer))
  )
  // An outside fixture edit still exercises real native snapshot/restore.
  // It is not an authenticated coding mutation or a machine qualification.
  await writeFile(join(root, "note.txt"), "after\n")
  const after = await call((jj) => jj.snapshot())
  assert.notEqual(after.commitId, before.commitId)
  assert.equal(after.changeId, before.changeId, "snapshot must preserve the planned change identity")
  assert.equal(
    after.commitId,
    execFileSync("jj", ["-R", root, "log", "-r", "@", "--no-graph", "-T", "commit_id"], { encoding: "utf8" }).trim()
  )
  assert.match(await call((jj) => jj.diff(before.commitId, after.commitId)), /\+after/)
  await call((jj) => jj.restore(before.commitId))
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before\n")
})
