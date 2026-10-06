import { NodeServices } from "@effect/platform-node"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import type * as Cell from "@smthrs/harness/Cell"
import type * as Path from "@smthrs/kernel/Path"
import * as Read from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Context, Deferred, Effect, Fiber, FileSystem, Option, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

const original = "alpha\nbeta\n"
const originalDigest = "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee"
const outside = "outside\n"
const outsideDigest = "92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43"
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const bytes = (value: string) => new TextEncoder().encode(value)
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
type Request = Parameters<CodingFileSystem.MutationProvider["compareWrite"]>[0]

const directory = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-batch-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, "a.txt"), original)
  await writeFile(join(root, "b.txt"), original)
  return root
}
const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const host = (root: string, provider: CodingFileSystem.MutationProvider) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
    const policy = coding[Read.Preconditions]!
    const tools = <A, E, R>(effect: Effect.Effect<A, E, R>, session = "run-a") =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, coding),
        Effect.provideService(Read.ReadSession, session)
      )
    return { fs, coding, policy, tools }
  })
const acknowledge = (request: Request) =>
  request.changes.map((change) => ({
    path: change.path,
    digest: change.content === null ? "absent" : hash(change.content)
  }))

test("standard dispatcher sends a complete move/add/delete batch and retains own-write bases", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const requests: Request[] = []
    // Adapter contract fixture only: real filesystem bytes, a recording provider.
    // This is deliberately not evidence for guest exclusion or authenticated HTTP.
    const { coding } = yield* host(root, {
      compareWrite: (request) =>
        Effect.gen(function*() {
          requests.push(request)
          assert.equal(request.root, root)
          assert.equal(request.session, "run-a")
          for (const change of request.changes) {
            const current = yield* fs.readFile(join(root, change.path)).pipe(
              Effect.map(hash),
              Effect.catch(() => Effect.succeed("absent"))
            )
            assert.equal(change.base_digest, current)
          }
          for (const change of request.changes) {
            const path = join(root, change.path)
            if (change.content === null) yield* fs.remove(path)
            else yield* fs.writeFile(path, change.content)
          }
          return acknowledge(request)
        }).pipe(Effect.orDie)
    })
    const services = Context.add(
      yield* Effect.context<FileSystem.FileSystem | Path.Path>(),
      FileSystem.FileSystem,
      coding
    )
    const bindings = yield* StandardFlows.filesystem(services).bindings()
    const call = (flowName: string, input: unknown, session = "run-a") =>
      bindings.find((b) => b.descriptor.name === flowName)!.run({
        flowName,
        input,
        capabilities: [],
        effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(),
        identity: { session, frame: 0, cell: "fixture", ordinal: 0, declaration: "fixture", layers: [] }
      } as unknown as Cell.Call)
    const a = join(root, "a.txt")
    const b = join(root, "b.txt")
    assert.equal((yield* call("read", { path: a, limit: 1 })).outcome, "success")
    assert.equal((yield* call("write", { path: a, content: outside })).outcome, "success")
    assert.equal(requests[0]!.changes[0]!.base_digest, originalDigest)
    assert.equal((yield* call("write", { path: a, content: original })).outcome, "success")
    assert.equal(requests[1]!.changes[0]!.base_digest, outsideDigest)
    assert.equal((yield* call("edit", { path: a, oldString: "beta", newString: "gamma" })).outcome, "success")
    assert.equal(yield* fs.readFileString(a), "alpha\ngamma\n")
    assert.equal((yield* call("read", { path: b })).outcome, "success")
    const moved = join(root, "moved.txt")
    const added = join(root, "added.txt")
    const patch = yield* call("apply_patch", {
      input:
        `*** Begin Patch\n*** Update File: ${a}\n*** Move to: ${moved}\n@@\n-gamma\n+delta\n*** Add File: ${added}\n+new\n*** Delete File: ${b}\n*** End Patch`
    })
    assert.equal(patch.outcome, "success", JSON.stringify(patch))
    assert.equal(requests.length, 4)
    assert.deepEqual(requests[3]!.changes.map((change) => [change.path, change.content === null]), [
      ["moved.txt", false],
      ["a.txt", true],
      ["added.txt", false],
      ["b.txt", true]
    ])
    assert.equal(yield* fs.exists(a), false)
    assert.equal(yield* fs.exists(b), false)
    assert.equal(yield* fs.readFileString(moved), "alpha\ndelta\n")
    assert.equal(yield* fs.readFileString(added), "new\n")
    assert.equal((yield* call("write", { path: a, content: "" })).outcome, "success")
    assert.equal(requests[4]!.changes[0]!.base_digest, "absent")
    assert.equal((yield* call("write", { path: a, content: original })).outcome, "success")
    assert.equal(requests[5]!.changes[0]!.base_digest, emptyDigest)
    const foreign = yield* call("write", { path: a, content: outside }, "run-b")
    assert.equal(foreign.outcome, "failure")
    assert.match(JSON.stringify(foreign), /base_digest=unread/)
    assert.equal(requests.length, 6)
    assert.equal((yield* Effect.result(coding.writeFileString(a, "bypass")))._tag, "Failure")
  }))
})

test("preparation pins snapshots and bases despite later reads; a stale batch never advances either file", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    let submitted: Request | undefined
    const { fs, policy, tools } = yield* host(root, {
      compareWrite: (request) => {
        submitted = request
        return Effect.fail(
          new StdError({ code: "stale_read", path: "b.txt", current_digest: outsideDigest, message: "stale" })
        )
      }
    })
    const a = join(root, "a.txt")
    const b = join(root, "b.txt")
    yield* tools(Read.run({ path: a }))
    yield* tools(Read.run({ path: b }))
    const paths = [a, b]
    const prepared = yield* policy.prepare!(paths, "run-a")
    paths[0] = join(root, "injected.txt")
    const first = yield* prepared.read(a)
    first.fill(0)
    assert.equal(new TextDecoder().decode(yield* prepared.read(a)), original)
    yield* fs.writeFileString(b, outside)
    yield* tools(Read.run({ path: b }))
    assert.equal(new TextDecoder().decode(yield* prepared.read(b)), original)
    const refused = yield* Effect.flip(
      prepared.commit([{ path: a, content: bytes(outside) }, { path: b, content: null }])
    )
    assert.equal(refused.code, "stale_read")
    assert.equal(refused.path, b)
    assert.equal(refused.base_digest, originalDigest)
    assert.equal(refused.current_digest, outsideDigest)
    assert.deepEqual(submitted!.changes.map((change) => change.base_digest), [originalDigest, originalDigest])
    assert.equal(yield* fs.readFileString(a), original)
    assert.equal(yield* fs.readFileString(b), outside)
    // A's old read and B's explicit newer read both survive the failed batch.
    yield* policy.validate([a, b], "run-a")
    assert.equal(
      (yield* Effect.flip(prepared.commit([{ path: a, content: null }, { path: b, content: null }]))).code,
      "invalid_input"
    )
  }))
})

test("commit copies payload bytes and never overwrites a read that races its receipt", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const { fs, policy, tools } = yield* host(root, {
      compareWrite: (request) =>
        Effect.gen(function*() {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(finish)
          assert.equal(new TextDecoder().decode(request.changes[0]!.content!), outside)
          return [{ path: "a.txt", digest: outsideDigest }]
        })
    })
    const a = join(root, "a.txt")
    yield* tools(Read.run({ path: a }))
    const prepared = yield* policy.prepare!([a], "run-a")
    const content = bytes(outside)
    const fiber = yield* Effect.forkChild(prepared.commit([{ path: a, content }]))
    yield* Deferred.await(entered)
    content.fill(0)
    // A newer read can have the same digest as the captured one. Entry identity,
    // not digest equality, must keep that read from being replaced by settlement.
    yield* tools(Read.run({ path: a }))
    yield* fs.writeFileString(a, outside)
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(fiber)
    const refused = yield* Effect.flip(policy.validate([a], "run-a"))
    assert.equal(refused.base_digest, originalDigest)
    assert.equal(refused.current_digest, outsideDigest)
  }))
})

test("cancellation leaves the read ledger unchanged and prevents replay of the prepared batch", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const { fs, policy, tools } = yield* host(root, {
      compareWrite: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    })
    const a = join(root, "a.txt")
    yield* tools(Read.run({ path: a }))
    const prepared = yield* policy.prepare!([a], "run-a")
    const fiber = yield* Effect.forkChild(prepared.commit([{ path: a, content: bytes(outside) }]))
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    yield* fs.writeFileString(a, outside)
    const refused = yield* Effect.flip(policy.validate([a], "run-a"))
    assert.equal(refused.base_digest, originalDigest)
    assert.equal(refused.current_digest, outsideDigest)
    assert.equal((yield* Effect.flip(prepared.commit([{ path: a, content: bytes(outside) }]))).code, "invalid_input")
  }))
})

test("all bases are captured before asynchronous path inspection and concurrent rereads", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    let pause = false
    const coding = CodingFileSystem.make(
      { repositoryPath: root },
      {
        ...fs,
        realPath: (path) =>
          path === join(root, "a.txt") && pause
            ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(fs.realPath(path))
            )
            : fs.realPath(path)
      },
      spawner,
      root,
      { compareWrite: () => Effect.die("stale preparation must not submit") }
    )
    const policy = coding[Read.Preconditions]!
    const a = join(root, "a.txt")
    const b = join(root, "b.txt")
    yield* policy.record(a, bytes(original), "run-a")
    yield* policy.record(b, bytes(original), "run-a")
    pause = true
    const preparation = yield* Effect.forkChild(Effect.flip(policy.prepare!([a, b], "run-a")))
    yield* Deferred.await(entered)
    yield* fs.writeFileString(b, outside)
    yield* policy.record(b, bytes(outside), "run-a")
    yield* Deferred.succeed(finish, undefined)
    const refused = yield* Fiber.join(preparation)
    assert.equal(refused.code, "stale_read")
    assert.equal(refused.path, b)
    assert.equal(refused.base_digest, originalDigest)
    assert.equal(refused.current_digest, outsideDigest)
  }))
})

test("inclusive path/content limits and binary or empty bytes survive a complete batch", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    let submitted: Request | undefined
    const { policy } = yield* host(root, {
      compareWrite: (request) => {
        submitted = request
        return Effect.succeed(acknowledge(request))
      }
    })
    const paths = Array.from({ length: 256 }, (_, index) => join(root, `new-${index}`))
    const binary = new Uint8Array(1024 * 1024)
    binary.set([0, 255, 128, 10])
    const prepared = yield* policy.prepare!(paths, "run-a")
    yield* prepared.commit(paths.map((path, index) => ({ path, content: index === 0 ? binary : new Uint8Array() })))
    assert.equal(submitted!.changes.length, 256)
    assert.equal(submitted!.changes[0]!.content!.length, 1024 * 1024)
    assert.deepEqual(submitted!.changes[0]!.content!.slice(0, 4), new Uint8Array([0, 255, 128, 10]))
    assert.equal(submitted!.changes[255]!.content!.length, 0)
    assert.ok(submitted!.changes.every((change) => change.base_digest === "absent"))
  }))
})

test("a configured provider cannot open a raw mutation bypass or authorize failed filesystem reads", async (t) => {
  const root = await directory(t)
  await run(Effect.gen(function*() {
    const { fs, coding, policy } = yield* host(root, { compareWrite: () => Effect.die("raw mutations never dispatch") })
    const a = join(root, "a.txt")
    const missing = join(root, "missing")
    const folder = join(root, "folder")
    yield* fs.makeDirectory(folder)
    assert.equal((yield* Effect.flip(policy.prepare!([folder], "run-a"))).code, "permission_denied")
    yield* coding.makeDirectory(folder, { recursive: true })
    for (
      const operation of [
        coding.makeDirectory(folder),
        coding.makeDirectory(a, { recursive: true }),
        coding.makeDirectory(missing, { recursive: true }),
        coding.writeFileString(a, "bypass"),
        coding.writeFile(a, new Uint8Array()),
        coding.remove(a),
        coding.rename(a, missing),
        coding.copy(a, missing),
        coding.copyFile(a, missing),
        coding.truncate(a),
        coding.link(a, missing),
        coding.symlink(a, missing),
        coding.utimes(a, new Date(), new Date()),
        coding.chmod(a, 0o777),
        coding.chown(a, 0, 0),
        coding.makeTempDirectory(),
        Effect.scoped(coding.makeTempDirectoryScoped()),
        coding.makeTempFile(),
        Effect.scoped(coding.makeTempFileScoped()),
        Effect.scoped(coding.open(a, { flag: "r+" })),
        Stream.run(Stream.make(bytes("bypass")), coding.sink(a))
      ]
    ) assert.equal((yield* Effect.result(operation))._tag, "Failure")
    yield* Effect.scoped(coding.open(a))
    yield* Effect.scoped(coding.open(a, { flag: "r" }))
    assert.equal(yield* fs.readFileString(a), original)
    assert.equal(yield* fs.exists(missing), false)
    // An unbound read cannot create an authenticated run ledger.
    yield* policy.record(a, bytes(original), undefined)
    assert.equal((yield* Effect.flip(policy.validate([a], undefined))).base_digest, "unread")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const unbound = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root)[Read.Preconditions]!
    assert.equal((yield* Effect.flip(unbound.prepare!([missing], "run-a"))).code, "provider_unavailable")
  }))
})

for (
  const [name, response] of [
    ["missing", []],
    ["wrong digest", [{ path: "a.txt", digest: originalDigest }]],
    ["unexpected path", [{ path: "elsewhere.txt", digest: outsideDigest }]],
    ["duplicate", [{ path: "a.txt", digest: outsideDigest }, { path: "a.txt", digest: outsideDigest }]],
    ["malformed digest", [{ path: "a.txt", digest: "oops" }]]
  ] as const
) {
  test(`unverified ${name} receipt cannot advance the ledger`, async (t) => {
    const root = await directory(t)
    await run(Effect.gen(function*() {
      const { fs, tools } = yield* host(root, { compareWrite: () => Effect.succeed(response) })
      const a = join(root, "a.txt")
      yield* tools(Read.run({ path: a }))
      assert.equal((yield* Effect.flip(tools(Write.run({ path: a, content: outside })))).code, "provider_unavailable")
      yield* fs.writeFileString(a, outside)
      const refused = yield* Effect.flip(tools(Write.run({ path: a, content: original })))
      assert.equal(refused.base_digest, originalDigest)
      assert.equal(refused.current_digest, outsideDigest)
    }))
  })
}

test("malformed batches, alias paths, missing sessions and unprepared reads never reach the provider", async (t) => {
  const root = await directory(t)
  await symlink(join(root, "a.txt"), join(root, "alias.txt"))
  await symlink(join(root, "loop.txt"), join(root, "loop.txt"))
  await run(Effect.gen(function*() {
    let calls = 0
    const { policy, tools } = yield* host(root, {
      compareWrite: (request) => {
        calls++
        return Effect.succeed(acknowledge(request))
      }
    })
    const a = join(root, "a.txt")
    const b = join(root, "b.txt")
    yield* tools(Read.run({ path: a }))
    yield* tools(Read.run({ path: b }))
    for (
      const paths of [
        [],
        [a, a],
        [a, join(root, "./a.txt")],
        [a, `${a}/child`],
        [join(root, "\ud800")],
        [join(root, "bad\0name")],
        [join(root, "x".repeat(4097))],
        Array.from({ length: 257 }, (_, index) => join(root, `new-${index}`))
      ]
    ) {
      assert.equal((yield* Effect.flip(policy.prepare!(paths, "run-a"))).code, "invalid_input")
    }
    for (const path of [join(root, "alias.txt"), join(root, "loop.txt"), root, join(root, "..", "outside.txt")]) {
      assert.equal((yield* Effect.flip(policy.prepare!([path], "run-a"))).code, "permission_denied")
    }
    for (const session of [undefined, ""]) {
      assert.equal((yield* Effect.flip(policy.prepare!([join(root, "new.txt")], session))).code, "provider_unavailable")
    }
    const prepared = yield* policy.prepare!([a, join(root, "new.txt")], "run-a")
    assert.equal((yield* Effect.flip(prepared.read(b))).code, "invalid_input")
    assert.equal((yield* Effect.flip(prepared.read(join(root, "new.txt")))).code, "not_found")
    for (
      const changes of [
        [{ path: a, content: null }],
        [{ path: a, content: null }, { path: a, content: null }],
        [{ path: a, content: null }, { path: join(root, "injected.txt"), content: null }],
        [{ path: a, content: new Uint8Array(1024 * 1024 + 1) }, { path: b, content: null }]
      ]
    ) {
      const batch = yield* policy.prepare!([a, b], "run-a")
      assert.equal((yield* Effect.flip(batch.commit(changes))).code, "invalid_input")
    }
    assert.equal(calls, 0)
  }))
})

for (
  const error of [
    new StdError({ code: "stale_read", path: "wrong.txt", current_digest: outsideDigest, message: "stale" }),
    new StdError({ code: "stale_read", path: "a.txt", current_digest: "broken", message: "stale" }),
    new StdError({ code: "stale_read", path: "a.txt", message: "missing digest" }),
    new StdError({ code: "permission_denied", message: "Run revoked" }),
    new StdError({ code: "provider_unavailable", message: "Unavailable" })
  ]
) {
  test(`provider failure ${error.code}/${error.path ?? ""}/${error.current_digest ?? error.message} preserves bases`, async (t) => {
    const root = await directory(t)
    await run(Effect.gen(function*() {
      const { policy, tools } = yield* host(root, { compareWrite: () => Effect.fail(error) })
      const a = join(root, "a.txt")
      yield* tools(Read.run({ path: a }))
      const failure = yield* Effect.flip(tools(Write.run({ path: a, content: outside })))
      assert.equal(failure.code, error.code === "stale_read" ? "provider_unavailable" : error.code)
      yield* policy.validate([a], "run-a")
    }))
  })
}
