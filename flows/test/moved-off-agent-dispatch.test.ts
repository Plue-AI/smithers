/** Reference-guest evidence: production coding/edit-atom tool bindings and
 * installed daemon transport. The runner must launch this as a registered agent
 * session after moving T2 off its item. No injected mutation provider is used. */
import { NodeServices } from "@effect/platform-node"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Cell from "@smthrs/harness/Cell"
import * as Read from "@smthrs/std/Read"
import * as Write from "@smthrs/std/Write"
import * as Edit from "@smthrs/std/Edit"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import { Context, Effect, FileSystem, Option, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import * as CodingFileSystem from "../coding/filesystem.ts"

const guest = process.env.SMITHERS_COL05_GUEST === "1"
const unbound = process.env.SMITHERS_COL05_UNBOUND === "1"
// A main-built supervisor forks this registered agent with Node IPC. It arms
// qualification-freeze-start and qualification-coding-queued in daemon-private
// state (killpoints debug build only), invokes the served person Return command,
// and acknowledges return-held only after freeze-start.hit exists. On queued it
// waits for coding-queued.hit, removes freeze-start.hit, waits for the real Return
// receipt, removes coding-queued.hit, then sends returned. Before each case it
// moves the fixture off the item again. No provider or transport is substituted.
const coordinate = (phase: "hold-return" | "finish-return", tool: string) => new Promise<void>((resolve, reject) => {
  assert.ok(process.send, "queued Return qualification requires the reference-guest IPC supervisor")
  const expected = phase === "hold-return" ? "return-held" : "returned"
  const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}: ${tool}`)), 30_000)
  const receive = (message: unknown) => {
    if (typeof message !== "object" || message === null) return
    const reply = message as { phase?: string; tool?: string; error?: string }
    if (reply.tool !== tool) return
    if (reply.error) finish(new Error(reply.error))
    else if (reply.phase === expected) finish()
  }
  const finish = (error?: Error) => {
    clearTimeout(timeout)
    process.off("message", receive)
    if (error) reject(error)
    else resolve()
  }
  process.on("message", receive)
  process.send!({ phase, tool }, error => { if (error) finish(error) })
})

const assertBindingsRefuse = async (expectedMessage: string, queuedReturn = false) => {
  assert.equal(process.getuid?.(), 19999)
  const path = "/workspace/t-col05-dispatch.txt"
  // Committed literal fixture, installed by the canary before the move.
  assert.deepEqual(await readFile(path), Buffer.from("hello\n"))
  await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const coding = CodingFileSystem.make({ repositoryPath: "/workspace" }, fs, spawner, "/workspace")
    const paths = yield* Path.Path
    const bindings = yield* StandardFlows.filesystem(
      Context.make(FileSystem.FileSystem, coding).pipe(Context.add(Path.Path, paths))
    ).bindings()
    let ordinal = 0
    const dispatch = (name: string, input: Cell.Call["input"]) => {
      const binding = bindings.find(binding => binding.descriptor.name === name)
      assert.ok(binding)
      return binding.run(new Cell.Call({
        flowName: name, input, capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(),
        identity: new Cell.CallIdentity({ session: "col05-dispatch", frame: 0,
          cell: "col05", ordinal: ordinal++, declaration: "col05", layers: [] })
      }))
    }
    assert.equal((yield* dispatch(Read.name, { path })).outcome, "success")
    for (const [name, input] of [
      [Write.name, { path, content: "overwritten\n" }],
      [Edit.name, { path, oldString: "hello", newString: "overwritten" }],
      [ApplyPatch.name, { input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-hello\n+overwritten\n*** End Patch` }]
    ] as const) {
      if (queuedReturn) yield* Effect.promise(() => coordinate("hold-return", name))
      const refusal = queuedReturn
        ? (yield* Effect.all([
            dispatch(name, input),
            Effect.promise(() => coordinate("finish-return", name))
          ], { concurrency: "unbounded" }))[0]
        : yield* dispatch(name, input)
      assert.equal(refusal.outcome, "failure", name)
      assert.equal(refusal.message, `Flow ${name} failed: ${expectedMessage}`, name)
      assert.equal(yield* fs.readFileString(path), "hello\n", name)
    }
  }).pipe(Effect.provide(NodeServices.layer)))
}

test("TestMovedOffAgentDispatch", {
  skip: guest && !unbound ? false : "requires installed guest and broker-registered agent session",
  timeout: 120_000
}, async (t) => {
  t.after(() => { if (process.connected) process.disconnect?.() })
  await assertBindingsRefuse("Branch moved off the item")
  const path = "/workspace/t-col05-dispatch.txt"
  // The wire refusal is literal moved_off, independently of std's public text.
  const result = await new Promise<{ error: { code: string } }>((resolve, reject) => {
    const child = execFile("/opt/smithers/bin/smithers-machined", ["client", "write-file", "t-col05-dispatch.txt",
      "--base", "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"],
      { cwd: "/workspace", timeout: 10_000 }, (error, stdout) => {
        if (!error) return reject(new Error("write unexpectedly succeeded"))
        try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
      })
    child.stdin!.end("overwritten\n")
  })
  assert.equal(result.error.code, "moved_off")
  assert.deepEqual(await readFile(path), Buffer.from("hello\n"))
  // Each mutation is admitted and queued behind a held production Return.
  // Even though Return restores hello and clears moved_off, its stale admission
  // must still refuse rather than overwrite the restored working copy.
  await assertBindingsRefuse("Branch moved off the item", true)
  assert.deepEqual(await readFile(path), Buffer.from("hello\n"))
})

// Run the same main-built test as agent uid outside a registered run cgroup;
// then repeat with the daemon stopped. Neither case may fall back to host I/O.
test("TestMovedOffAgentDispatchUnavailableAuthority", {
  skip: guest && unbound ? false : "requires installed guest with missing or unbound daemon authority",
  timeout: 120_000
}, async () => {
  await assertBindingsRefuse("Authenticated file mutation provider unavailable")
})
