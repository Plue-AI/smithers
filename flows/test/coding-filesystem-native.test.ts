/** Std boundary tests with a test-only atomic provider; no machine qualification. */
import { NodeServices } from "@effect/platform-node"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Cell from "@smthrs/harness/Cell"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Edit from "@smthrs/std/Edit"
import * as Read from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Cause, Context, Effect, Exit, FileSystem, Option, Path, Sink, Stream } from "effect"
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

test("lost write receipt and resumed coding host require a fresh read before retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-lost-receipt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "a")
  await writeFile(path, "before")
  let calls = 0
  let loseReceipt = true
  const provider: CodingFileSystem.MutationProvider = {
    commit: (_session, changes) =>
      Effect.tryPromise({
        try: async () => {
          calls++
          assert.equal(changes.length, 1)
          const change = changes[0]!
          assert.equal(change.base_digest, hash(await readFile(path)))
          assert.ok(change.content !== null)
          await writeFile(path, change.content)
          if (loseReceipt) {
            throw new StdError({ code: "provider_unavailable", message: "Connection lost after publication" })
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
      const call = <A, E, R>(effect: Effect.Effect<A, E, R>, host = coding) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, host),
          Effect.provideService(Read.ReadSession, "run")
        )
      yield* call(Read.run({ path }))
      assert.equal((yield* Effect.flip(call(Write.run({ path, content: "published" })))).code, "provider_unavailable")
      assert.equal(yield* fs.readFileString(path), "published")
      const retry = yield* Effect.flip(call(Write.run({ path, content: "blind retry" })))
      assert.equal(retry.code, "stale_read")
      assert.equal(retry.base_digest, "unread")
      assert.equal(retry.current_digest, hash(Buffer.from("published")))
      assert.equal(calls, 1)
      const resumed = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, provider)
      assert.equal((yield* Effect.flip(call(Write.run({ path, content: "resume" }), resumed))).base_digest, "unread")
      assert.equal(calls, 1)
      loseReceipt = false
      yield* call(Read.run({ path }), resumed)
      yield* call(Write.run({ path, content: "recovered" }), resumed)
      yield* call(Edit.run({ path, oldString: "recovered", newString: "own write" }), resumed)
      assert.equal(calls, 3)
      assert.equal(yield* fs.readFileString(path), "own write")
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

// Test-only client transport; kernel cgroup admission still needs the reference host.
test("installed coding std tools use daemon single and batch clients and validate receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coding-daemon-client-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  const world = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7"
  const path = join(root, "a")
  await writeFile(path, "hello")
  const calls: Array<ReadonlyArray<string>> = []
  let mode: "success" | "stale" | "reply" = "success"
  let reply = "", status = 0
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function*() {
      assert.equal(command._tag, "StandardCommand")
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipe")
      assert.equal(command.command, "/opt/smithers/bin/smithers-machined")
      assert.equal(command.options.cwd, "/workspace")
      assert.equal(command.args[0], "client")
      const batch = command.args[1] === "write-files"
      if (batch) assert.equal(command.args.length, 2, "no actor is sent")
      else {
        assert.equal(command.args[1], "write-file")
        assert.equal(command.args[3], "--base")
        assert.equal(command.args.length, 5, "the client derives the run; no actor is sent")
      }
      assert.ok(Stream.isStream(command.options.stdin))
      const content = yield* Stream.mkString(Stream.decodeText(command.options.stdin as Stream.Stream<Uint8Array>))
      calls.push(command.args)
      let output = reply, exit = status
      if (mode === "success" && batch) {
        const changes = JSON.parse(content) as Array<
          { path: string; base_digest: string; content: Array<number> | null }
        >
        const writes = []
        for (const change of changes) {
          assert.deepEqual(Object.keys(change).sort(), ["base_digest", "content", "path"])
          const target = join(root, change.path)
          if (change.content === null) {
            yield* Effect.promise(() => rm(target))
          } else yield* Effect.promise(() => writeFile(target, Uint8Array.from(change.content!)))
          writes.push({
            path: change.path,
            post_digest: change.content === null ? "absent" : hash(Uint8Array.from(change.content))
          })
        }
        output = JSON.stringify({ writes })
        exit = 0
      } else if (mode === "success") {
        assert.ok(content === "hello" || content === "world")
        yield* Effect.promise(() => writeFile(join(root, command.args[2]!), content))
        output = JSON.stringify({ post_digest: content === "hello" ? hello : world })
        exit = 0
      } else if (mode === "stale") {
        yield* Effect.promise(() => writeFile(path, "world"))
        output = JSON.stringify({ error: { code: "stale", current_digest: world } })
        exit = 1
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, "/workspace")
      const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, coding),
          Effect.provideService(Read.ReadSession, "model-ledger-id")
        )
      assert.equal((yield* Effect.flip(call(Write.run({ path, content: "world" })))).code, "stale_read")
      assert.equal(calls.length, 0)
      yield* call(Read.run({ path }))
      yield* call(Write.run({ path, content: "world" }))
      assert.equal(calls[0]![4], hello)
      yield* call(Edit.run({ path, oldString: "world", newString: "hello" }))
      assert.equal(calls[1]![4], world, "successful own write advances the ledger")
      mode = "stale"
      const refused = yield* Effect.flip(call(Write.run({ path, content: "hello" })))
      assert.equal(refused.code, "stale_read")
      assert.equal(refused.base_digest, hello)
      assert.equal(refused.current_digest, world)
      assert.equal(yield* fs.readFileString(path), "world")
      yield* call(Read.run({ path }))
      mode = "reply"
      reply = JSON.stringify({ error: { code: "moved_off" } })
      status = 1
      for (
        const tool of [
          Write.run({ path, content: "hello" }).pipe(Effect.asVoid),
          Edit.run({ path, oldString: "world", newString: "hello" }).pipe(Effect.asVoid),
          ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-world\n+hello\n*** End Patch` })
            .pipe(Effect.asVoid)
        ]
      ) {
        assert.equal((yield* Effect.flip(call(tool))).code, "moved_off")
        assert.equal(calls.at(-1)![4], world, "moved-off refusals never advance the read ledger")
        assert.equal(yield* fs.readFileString(path), "world")
      }
      for (
        const [body, code] of [
          ["not json", 0],
          ["null", 0],
          ["[]", 0],
          ["x".repeat(65537), 0],
          [JSON.stringify({ post_digest: hello }), 1],
          [JSON.stringify({ post_digest: world }), 0],
          [JSON.stringify({ error: { code: "unauthorized" } }), 1],
          [JSON.stringify({ error: { code: "moved_off" } }), 0],
          [JSON.stringify({ error: { code: "stale", current_digest: "invalid" } }), 1],
          [JSON.stringify({ error: { code: "stale", current_digest: world } }), 0]
        ] as const
      ) {
        yield* call(Read.run({ path }))
        reply = body
        status = code
        assert.equal((yield* Effect.flip(call(Write.run({ path, content: "hello" })))).code, "provider_unavailable")
        assert.equal(calls.at(-1)![4], world, "bad receipts never advance the ledger")
        const beforeRetry: number = calls.length
        const retry = yield* Effect.flip(call(Write.run({ path, content: "hello" })))
        assert.equal(retry.code, "stale_read")
        assert.equal(retry.base_digest, "unread", "unknown settlement revokes authority even for unchanged bytes")
        assert.equal(calls.length, beforeRetry, "retry must stop before another daemon call")
        assert.equal(yield* fs.readFileString(path), "world")
      }
      yield* call(Read.run({ path }))
      reply = JSON.stringify({ error: { code: "stale" } })
      status = 1
      assert.equal((yield* Effect.flip(call(Write.run({ path, content: "hello" })))).current_digest, "absent")
      mode = "success"
      const added = join(root, "b")
      yield* call(Write.run({ path: added, content: "hello" }))
      assert.equal(calls.at(-1)![4], "absent")
      yield* call(ApplyPatch.run({
        input: `*** Begin Patch
*** Update File: ${path}
@@
-world
+hello
*** Update File: ${added}
*** Move to: ${join(root, "moved")}
@@
-hello
+world
*** Add File: ${join(root, "empty")}
*** End Patch`
      }))
      assert.equal(calls.at(-1)![1], "write-files")
      assert.equal(yield* fs.readFileString(path), "hello\n")
      assert.equal(yield* fs.exists(added), false)
      assert.equal(yield* fs.readFileString(join(root, "moved")), "world\n")
      yield* call(ApplyPatch.run({
        input: `*** Begin Patch
*** Delete File: ${path}
*** End Patch`
      }))
      assert.equal(yield* fs.exists(path), false)
      // A refused preflight keeps every earlier file and the read ledger intact.
      mode = "reply"
      const moved = join(root, "moved")
      const patch = `*** Begin Patch
*** Update File: ${moved}
@@
-world
+hello
*** Add File: ${added}
+hello
*** End Patch`
      reply = JSON.stringify({ writes: [], failure: { index: 1, preflight: true, code: 4, current_digest: world } })
      status = 1
      const stale = yield* Effect.flip(call(ApplyPatch.run({ input: patch })))
      assert.equal(stale.code, "stale_read")
      assert.equal(stale.path, "b")
      assert.equal(stale.base_digest, "absent")
      assert.equal(yield* fs.readFileString(moved), "world\n")
      assert.equal(yield* fs.exists(added), false)
      // An application failure reports its prefix and revokes old read authority.
      reply = JSON.stringify({ writes: [], failure: { index: 0, preflight: false, code: 12 } })
      const failed = yield* Effect.flip(call(ApplyPatch.run({ input: patch })))
      assert.equal(failed.code, "command_failed")
      assert.match(failed.message, /stopped after 0 files/)
      const unread = yield* Effect.flip(call(Write.run({ path: moved, content: "hello" })))
      assert.equal(unread.base_digest, "unread")
      yield* call(Read.run({ path: moved }))
      for (
        const body of [
          { writes: [], failure: { index: 2, preflight: true, code: 4 } },
          { writes: [{ path: "moved", post_digest: hello }], failure: { index: 0, preflight: true, code: 4 } },
          { writes: [{ path: "wrong", post_digest: hello }] },
          { writes: [{ path: "moved", post_digest: hello, raced: "bad" }] },
          { writes: [] },
          { error: { code: "stale", current_digest: world } },
          { error: { code: "moved_off" } }
        ]
      ) {
        yield* call(Read.run({ path: moved }))
        reply = JSON.stringify(body)
        assert.equal((yield* Effect.flip(call(ApplyPatch.run({ input: patch })))).code, "provider_unavailable")
        const beforeRetry: number = calls.length
        const retry = yield* Effect.flip(call(Write.run({ path: moved, content: "hello" })))
        assert.equal(retry.base_digest, "unread")
        assert.equal(calls.length, beforeRetry)
      }
      // Production schema-decoding coding/edit-atom bindings; test transport.
      mode = "success"
      const pathService = yield* Path.Path
      const bindings = yield* StandardFlows.filesystem(
        Context.make(FileSystem.FileSystem, coding).pipe(Context.add(Path.Path, pathService))
      ).bindings()
      let ordinal = 0
      const dispatch = (name: string, input: Cell.Call["input"]) => {
        const binding = bindings.find((binding) => binding.descriptor.name === name)
        assert.ok(binding)
        return binding.run(
          new Cell.Call({
            flowName: name,
            input,
            capabilities: [],
            effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
            placement: Option.none(),
            identity: new Cell.CallIdentity({
              session: "dispatcher-run",
              frame: 0,
              cell: "fixture",
              ordinal: ordinal++,
              declaration: "fixture",
              layers: []
            })
          })
        )
      }
      assert.equal((yield* dispatch(Read.name, { path: moved })).outcome, "success")
      yield* fs.writeFileString(moved, "hello")
      for (
        const [name, input] of [
          [Write.name, { path: moved, content: "world" }],
          [Edit.name, { path: moved, oldString: "hello", newString: "world" }],
          [ApplyPatch.name, { input: `*** Begin Patch\n*** Update File: ${moved}\n@@\n-hello\n+world\n*** End Patch` }]
        ] as const
      ) {
        const refused = yield* dispatch(name, input)
        assert.equal(refused.outcome, "failure")
        assert.match(refused.message!, /Re-read/)
        assert.equal(yield* fs.readFileString(moved), "hello")
      }
      assert.equal((yield* dispatch(Read.name, { path: moved })).outcome, "success")
      mode = "reply"
      reply = "not json"
      status = 0
      assert.equal((yield* dispatch(Write.name, { path: moved, content: "world" })).outcome, "failure")
      const beforeRetry: number = calls.length
      const retry = yield* dispatch(Write.name, { path: moved, content: "world" })
      assert.equal(retry.outcome, "failure")
      assert.match(retry.message!, /Re-read/)
      assert.equal(calls.length, beforeRetry)
      assert.equal(yield* fs.readFileString(moved), "hello")
      mode = "success"
      assert.equal((yield* dispatch(Read.name, { path: moved })).outcome, "success")
      const accepted = yield* dispatch(ApplyPatch.name, {
        input: `*** Begin Patch\n*** Update File: ${moved}\n*** Move to: ${added}\n@@\n-hello\n+world\n*** End Patch`
      })
      assert.equal(accepted.outcome, "success")
      assert.equal(yield* fs.exists(moved), false)
      assert.equal(yield* fs.readFileString(added), "world\n")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

// Supplementary cause handling: installed acceptance cannot safely inject a
// crash into a broker-owned mutation child from this host.
for (const defect of [false, true]) {
  test(`unknown mutation ${defect ? "defect" : "interruption"} revokes read authority and preserves its cause`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coding-unknown-settlement-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, "a")
    await writeFile(path, "hello")
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, root, {
          commit: () =>
            Effect.sync(() => calls++).pipe(Effect.andThen(
              defect ? Effect.die("lost settlement") : Effect.interrupt
            ))
        })
        const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, coding),
            Effect.provideService(Read.ReadSession, "run")
          )
        yield* call(Read.run({ path }))
        const exit = yield* Effect.exit(call(Write.run({ path, content: "world" })))
        assert.ok(Exit.isFailure(exit))
        assert.equal(Cause.hasInterruptsOnly(exit.cause), !defect)
        if (defect) assert.equal(Cause.squash(exit.cause), "lost settlement")
        const retry = yield* Effect.flip(call(Write.run({ path, content: "world" })))
        assert.equal(retry.code, "stale_read")
        assert.equal(retry.base_digest, "unread")
        assert.equal(calls, 1)
        assert.equal(yield* fs.readFileString(path), "hello")
      }).pipe(Effect.provide(NodeServices.layer))
    )
  })
}
