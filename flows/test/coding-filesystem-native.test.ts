import * as StandardFlows from "@smthrs/agent/StandardFlows"
import type * as Cell from "@smthrs/harness/Cell"
import type * as Path from "@smthrs/kernel/Path"
import { NodeServices } from "@effect/platform-node"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Edit from "@smthrs/std/Edit"
import * as Read from "@smthrs/std/Read"
import type { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Context, Effect, FileSystem, Option } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

// Independently fixed SHA-256 fixtures for complete bytes, never a paginated page.
const original = "alpha\nbeta\n"
const originalDigest = "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee"
const replacement = "outside\n"
const replacementDigest = "92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43"

test("coding std tools retain full-file read bases and refuse stale and unavailable writers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-write-preconditions-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, "a.txt")
  const second = join(root, "b.txt")
  await writeFile(target, original)
  await writeFile(second, original)
  await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const canonicalRoot = yield* Effect.promise(() => realpath(root))
    const make = () => CodingFileSystem.make({ repositoryPath: root }, fs, spawner, canonicalRoot)
    const coding = make()
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(FileSystem.FileSystem, coding), Effect.provideService(Read.ReadSession, "run-a"))
    const unread = yield* Effect.flip(run(Write.run({ path: target, content: "mine\n" })))
    assert.equal(unread.code, "stale_read")
    assert.equal(unread.base_digest, "unread")
    assert.equal(unread.current_digest, originalDigest)
    const page = yield* run(Read.run({ path: target, limit: 1 }))
    assert.equal(page.content, "alpha")
    assert.equal(page.truncated, true)
    yield* fs.writeFileString(target, replacement)
    const mutations: ReadonlyArray<Effect.Effect<unknown, StdError, FileSystem.FileSystem | Path.Path>> = [
      Write.run({ path: target, content: "mine\n" }),
      Edit.run({ path: target, oldString: "outside", newString: "mine" }),
      ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-outside\n+mine\n*** End Patch` }),
      ApplyPatch.run({ input: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch` }),
      ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${target}\n*** Move to: ${join(root, "moved.txt")}\n@@\n-outside\n+mine\n*** End Patch` })
    ]
    for (const mutation of mutations) {
      const failure = yield* Effect.flip(run(mutation))
      assert.equal(failure.code, "stale_read")
      assert.equal(failure.path, target)
      assert.equal(failure.base_digest, originalDigest)
      assert.equal(failure.current_digest, replacementDigest)
      assert.equal(yield* fs.readFileString(target), replacement)
    }
    // Internal edit/patch reads must not update the ledger. An explicit re-read does.
    yield* run(Read.run({ path: target }))
    const fresh = yield* Effect.flip(run(Write.run({ path: target, content: "mine\n" })))
    assert.equal(fresh.code, "provider_unavailable")
    const missing = join(root, "new.txt")
    const absent = yield* Effect.flip(run(Write.run({ path: missing, content: "new\n" })))
    assert.equal(absent.code, "provider_unavailable")
    assert.equal(yield* fs.exists(missing), false)
    const otherSession = yield* Effect.flip(Write.run({ path: target, content: "mine\n" }).pipe(
      Effect.provideService(FileSystem.FileSystem, coding), Effect.provideService(Read.ReadSession, "run-b")
    ))
    assert.equal(otherSession.code, "stale_read")
    assert.equal(otherSession.base_digest, "unread")
    const nested = join(root, "missing-parent", "new.txt")
    const nestedWrite = yield* Effect.flip(run(Write.run({ path: nested, content: "new\n" })))
    assert.equal(nestedWrite.code, "provider_unavailable")
    const nestedPatch = yield* Effect.flip(run(ApplyPatch.run({ input:
      `*** Begin Patch\n*** Add File: ${nested}\n+new\n*** End Patch`
    })))
    assert.equal(nestedPatch.code, "provider_unavailable")
    assert.equal(yield* fs.exists(join(root, "missing-parent")), false)
    // Recomposition (including resume) loses the ledger and requires a new read.
    const resumed = yield* Effect.flip(Write.run({ path: target, content: "mine\n" }).pipe(
      Effect.provideService(FileSystem.FileSystem, make())
    ))
    assert.equal(resumed.code, "stale_read")
    assert.equal(resumed.base_digest, "unread")
    yield* run(Read.run({ path: target }))
    yield* run(Read.run({ path: second }))
    yield* fs.writeFileString(second, replacement)
    const later = yield* Effect.flip(run(ApplyPatch.run({ input:
      `*** Begin Patch\n*** Update File: ${target}\n@@\n-outside\n+mine\n*** Update File: ${second}\n@@\n-outside\n+mine\n*** End Patch`
    })))
    assert.equal(later.code, "stale_read")
    assert.equal(later.path, second)
    assert.equal(yield* fs.readFileString(target), replacement)
    assert.equal(yield* fs.readFileString(second), replacement)
    // Every move destination is validated, including an unread existing file.
    yield* run(Read.run({ path: second }))
    const destination = join(root, "destination.txt")
    yield* fs.writeFileString(destination, original)
    const occupied = yield* Effect.flip(run(ApplyPatch.run({ input:
      `*** Begin Patch\n*** Update File: ${second}\n*** Move to: ${destination}\n@@\n-outside\n+mine\n*** End Patch`
    })))
    assert.equal(occupied.code, "stale_read")
    assert.equal(occupied.path, destination)
    assert.equal(occupied.base_digest, "unread")
    assert.equal(yield* fs.readFileString(destination), original)
    yield* fs.remove(destination)
    // Removing a previously read file is stale even when lock path resolution fails.
    yield* fs.remove(second)
    const removed = yield* Effect.flip(run(Edit.run({ path: second, oldString: "outside", newString: "mine" })))
    assert.equal(removed.code, "stale_read")
    assert.equal(removed.current_digest, "absent")
    yield* fs.writeFileString(second, replacement)
    // Failed reads (offset and binary) never authorize a write.
    yield* fs.writeFileString(target, original)
    const failedRead = yield* Effect.flip(Read.run({ path: target, offset: 99 }).pipe(
      Effect.provideService(FileSystem.FileSystem, coding), Effect.provideService(Read.ReadSession, "failed-read")
    ))
    assert.equal(failedRead.code, "offset_out_of_range")
    const afterFailedRead = yield* Effect.flip(Write.run({ path: target, content: "mine\n" }).pipe(
      Effect.provideService(FileSystem.FileSystem, coding), Effect.provideService(Read.ReadSession, "failed-read")
    ))
    assert.equal(afterFailedRead.base_digest, "unread")
    yield* fs.writeFileString(target, replacement)
    // No direct filesystem form bypasses the absent atomic provider.
    for (const mutation of [
      coding.writeFileString(target, "mine\n"), coding.writeFile(target, new Uint8Array()),
      coding.rename(target, missing), coding.remove(target), coding.copyFile(target, missing),
      coding.open(target, { flag: "w" }).pipe(Effect.asVoid), coding.chmod(target, 0o777), coding.truncate(target)
    ]) assert.equal((yield* Effect.result(mutation))._tag, "Failure")
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
  assert.equal(await readFile(target, "utf8"), replacement)
  assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"])
})


test("standard flow dispatcher reports stale bases and separates authenticated sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-dispatch-preconditions-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, "a.txt")
  await writeFile(target, original)
  await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const canonicalRoot = yield* Effect.promise(() => realpath(root))
    const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, canonicalRoot)
    const services = Context.add(yield* Effect.context<FileSystem.FileSystem | Path.Path>(), FileSystem.FileSystem, coding)
    const bindings = yield* StandardFlows.filesystem(services).bindings()
    const call = (flowName: string, input: unknown, session: string) => bindings.find((b) => b.descriptor.name === flowName)!.run({
      flowName, input, capabilities: [],
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity: { session, frame: 0, cell: "fixture", ordinal: 0, declaration: "fixture", layers: [] }
    } as unknown as Cell.Call)
    assert.equal((yield* call("read", { path: target, limit: 1 }, "a")).outcome, "success")
    const other = yield* call("write", { path: target, content: "mine\n" }, "b")
    assert.equal(other.outcome, "failure")
    assert.match(JSON.stringify(other), /stale_read/)
    assert.match(JSON.stringify(other), /base_digest=unread/)
    yield* fs.writeFileString(target, replacement)
    for (const [name, input] of [
      ["write", { path: target, content: "mine\n" }],
      ["edit", { path: target, oldString: "outside", newString: "mine" }],
      ["apply_patch", { input: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch` }]
    ] as const) {
      const refused = yield* call(name, input, "a")
      assert.equal(refused.outcome, "failure")
      assert.match(JSON.stringify(refused), /stale_read/)
      assert.ok(JSON.stringify(refused).includes(originalDigest))
      assert.ok(JSON.stringify(refused).includes(replacementDigest))
      assert.equal(yield* fs.readFileString(target), replacement)
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
