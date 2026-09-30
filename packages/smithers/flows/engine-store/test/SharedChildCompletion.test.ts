import { assert, describe, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// Issue #2500: a diamond's second parent is recorded only as a durable edge,
// so settling the shared child must wake every edge, not just the creator.
const Child = Flow.make("Diamond/child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Bounded = Flow.make("Diamond/bounded", {
  payload: {},
  success: Schema.String,
  maxRounds: 1,
  body: opaqueHandlerBody
})
const Next = Flow.make("Diamond/next", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const NumberNext = Flow.make("Diamond/number-next", { payload: {}, success: Schema.Number, body: opaqueHandlerBody })
const Parent = Flow.make("Diamond/parent", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

type TestServices = Layer.Success<ReturnType<typeof TestStores.layerAt>> | Scope.Scope | Crypto.Crypto

/** A real file-backed SQLite store, removed after the body. */
const onDisk = <A, E>(body: Effect.Effect<A, E, TestServices>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-shared-child-"))),
    (directory) =>
      withCrypto(body.pipe(Effect.scoped, Effect.provide(TestStores.layerAt(join(directory, "engine.db"))))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

/**
 * How the shared child ends once released:
 * - `completed`: its only round returns a value;
 * - `successor`: round zero hands off, then its successor parks until approved;
 * - `exhausted`: it asks for a handoff past `maxRounds: 1`;
 * - `invalid`: it asks for a handoff from a malformed persisted round.
 */
type Ending = "completed" | "successor" | "exhausted" | "invalid"

const diamond = (ending: Ending) =>
  onDisk(Effect.gen(function*() {
    const realStore = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    const receipts: Array<[string, string]> = []
    const calls: Record<string, number> = {}
    const returned: Record<string, string> = {}
    let released = false
    let successorApproved = false
    let corrupt = false
    // The only way to reach `InvalidRound` is a malformed persisted round, so
    // the store serves one for the child once both parents have admitted it.
    const store = ending !== "invalid" ? realStore : RunStore.makeNoop({
      ...realStore,
      get: (runId) =>
        realStore.get(runId).pipe(
          Effect.map((row) =>
            corrupt && runId === "shared-child" ? { ...row, lineageId: runId, roundOrdinal: -1 } : row
          )
        )
    })
    const driver = yield* RunDriver.make({
      owner: { hostId: "diamond", pid: process.pid, nonce: ending },
      journalSource: "shared-child-completion",
      isAlive: () => Effect.succeed(false),
      engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
      requestResume: (id, reason) =>
        Effect.sync(() => {
          receipts.push([id, reason])
        })
    }).pipe(Effect.provideService(RunStore.RunStore, store))
    const drained = Effect.gen(function*() {
      for (let turn = 0; turn < 2000; turn++) {
        if ((yield* driver.active).size === 0) return
        yield* Effect.sleep("2 millis")
      }
      return yield* Effect.die("coordinator did not drain")
    })
    const Shared = ending === "exhausted" ? Bounded : Child
    const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("shared-child"), {
      flowName: Shared._tag,
      maxRounds: undefined
    })
    yield* driver.register(Shared, () =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        if (released) {
          // `drive` read the malformed row before this round ran; parents
          // re-admitting the settled child must see the real one.
          corrupt = false
          if (ending !== "completed") {
            instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
            return "handed off"
          }
          return "approved"
        }
        instance.waiting = { reason: "approval" }
        return yield* Flow.suspend(instance)
      }))
    yield* driver.register(Next, () =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        if (successorApproved) return "approved"
        instance.waiting = { reason: "approval" }
        return yield* Flow.suspend(instance)
      }))
    yield* driver.register(Parent, () =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        calls[instance.executionId] = (calls[instance.executionId] ?? 0) + 1
        const result = yield* driver.execute(Shared, {
          executionId: "shared-child",
          payload: {},
          discard: false,
          parent: instance
        })
        if (result._tag !== "Complete") return yield* Flow.suspend(instance)
        return returned[instance.executionId] = Exit.isSuccess(result.exit) ? String(result.exit.value) : "child failed"
      }))
    for (const id of ["parent-a", "parent-b"]) {
      yield* driver.execute(Parent, { executionId: id, payload: {}, discard: false })
      yield* drained
    }
    const settling = "shared-child"
    const ids = [settling, "parent-a", "parent-b"]
    const statuses = Effect.forEach(ids, (id) => realStore.get(id).pipe(Effect.map((row) => row.status)))
    assert.deepStrictEqual(yield* statuses, ["suspended", "suspended", "suspended"])
    assert.deepStrictEqual(
      (yield* state.runParents(settling)).map((edge) => edge.parentId),
      ["parent-a", "parent-b"]
    )

    released = true
    corrupt = true
    yield* driver.resume(Shared, settling)
    yield* drained

    if (ending === "successor") {
      assert.strictEqual((yield* realStore.get("shared-child")).status, "completed")
      assert.deepStrictEqual(
        yield* Effect.forEach(
          [successor.executionId, "parent-a", "parent-b"],
          (id) => realStore.get(id).pipe(Effect.map((row) => row.status))
        ),
        ["suspended", "suspended", "suspended"]
      )
      assert.deepStrictEqual(
        (yield* state.runParents("shared-child")).map((edge) => edge.parentId),
        ["parent-a", "parent-b"]
      )
      successorApproved = true
      yield* driver.resume(Next, successor.executionId)
      yield* drained
    }

    return {
      statuses: ending === "successor"
        ? yield* Effect.forEach(
          [successor.executionId, "parent-a", "parent-b"],
          (id) => realStore.get(id).pipe(Effect.map((row) => row.status))
        )
        : yield* statuses,
      returned,
      childState: (yield* realStore.get(ending === "successor" ? successor.executionId : settling)).stateJson,
      calls,
      receipts: [...receipts].sort()
    }
  }))

describe("a shared attached child", () => {
  const cases: ReadonlyArray<{
    readonly ending: Ending
    readonly name: string
    readonly child: RunStore.RunStatus
    readonly value: string
    readonly reason?: string
  }> = [
    {
      ending: "completed",
      name: "settles both durable parents when their shared attached child completes",
      child: "completed",
      value: "approved"
    },
    {
      ending: "successor",
      name: "settles both parents attached to the original child after its successor resumes",
      child: "completed",
      value: "approved"
    },
    {
      ending: "exhausted",
      name: "settles both durable parents when their shared child exhausts its round budget",
      child: "failed",
      value: "child failed",
      reason: "MaxRoundsExceeded"
    },
    {
      ending: "invalid",
      name: "settles both durable parents when their shared child fails on a malformed round",
      child: "failed",
      value: "child failed",
      reason: "InvalidRound"
    }
  ]
  for (const { child, ending, name, reason, value } of cases) {
    it.live(name, () =>
      Effect.gen(function*() {
        const observed = yield* diamond(ending)
        assert.deepStrictEqual(observed.statuses, [child, "completed", "completed"])
        if (reason !== undefined) assert.include(observed.childState, reason)
        assert.deepStrictEqual(observed.returned, { "parent-a": value, "parent-b": value })
        assert.deepStrictEqual(observed.calls, { "parent-a": 2, "parent-b": 2 })
        assert.deepStrictEqual(observed.receipts, [["parent-a", "parent"], ["parent-b", "parent"]])
      }))
  }

  it.live("wakes parents attached to different rounds of one shared child lineage (#2500)", () =>
    onDisk(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const calls: Record<string, number> = {}
      const returned: Record<string, string> = {}
      const receipts: Array<[string, string]> = []
      let released = false
      let approved = false
      const driver = yield* RunDriver.make({
        owner: { hostId: "diamond", pid: process.pid, nonce: "split-rounds" },
        journalSource: "shared-child-completion",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        requestResume: (id, reason) =>
          Effect.sync(() => {
            receipts.push([id, reason])
          })
      })
      const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("shared-child"), {
        flowName: Child._tag,
        maxRounds: undefined
      })
      const drained = Effect.gen(function*() {
        for (let turn = 0; turn < 2000; turn++) {
          if ((yield* driver.active).size === 0) return
          yield* Effect.sleep("2 millis")
        }
        return yield* Effect.die("coordinator did not drain")
      })
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          if (released) {
            instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
            return "handed off"
          }
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      yield* driver.register(Next, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          if (approved) return "approved"
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          calls[instance.executionId] = (calls[instance.executionId] ?? 0) + 1
          const result = instance.executionId === "parent-a"
            ? yield* driver.execute(Child, {
              executionId: "shared-child",
              payload: {},
              discard: false,
              parent: instance
            })
            : yield* driver.execute(Next, {
              executionId: successor.executionId,
              payload: {},
              discard: false,
              parent: instance,
              round: successor.round
            })
          if (result._tag !== "Complete") return yield* Flow.suspend(instance)
          return returned[instance.executionId] = Exit.isSuccess(result.exit)
            ? String(result.exit.value)
            : "child failed"
        }))

      yield* driver.execute(Parent, { executionId: "parent-a", payload: {}, discard: false })
      yield* drained
      assert.strictEqual((yield* store.get("shared-child")).status, "suspended")
      released = true
      yield* driver.resume(Child, "shared-child")
      yield* drained
      assert.strictEqual((yield* store.get(successor.executionId)).status, "suspended")
      yield* driver.execute(Parent, { executionId: "parent-b", payload: {}, discard: false })
      yield* drained
      assert.deepStrictEqual((yield* state.runParents("shared-child")).map((edge) => edge.parentId), ["parent-a"])
      assert.deepStrictEqual((yield* state.runParents(successor.executionId)).map((edge) => edge.parentId), [
        "parent-b"
      ])
      approved = true
      yield* driver.resume(Next, successor.executionId)
      yield* drained
      assert.deepStrictEqual(
        yield* Effect.forEach(["parent-a", "parent-b"], (id) => store.get(id).pipe(Effect.map((row) => row.status))),
        ["completed", "completed"]
      )
      assert.deepStrictEqual(returned, { "parent-a": "approved", "parent-b": "approved" })
      assert.deepStrictEqual(calls, { "parent-a": 2, "parent-b": 2 })
      assert.deepStrictEqual(receipts.sort(), [["parent-a", "parent"], ["parent-b", "parent"]])
    })))

  for (const ending of ["number", "cancelled", "unregistered"] as const) {
    it.live(`reads the terminal successor of a nested direct child: ${ending}`, () =>
      onDisk(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const successorFlow = ending === "cancelled" ? Next : NumberNext
        const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("lineage-child"), {
          flowName: Child._tag,
          maxRounds: undefined
        })
        const driver = yield* RunDriver.make({
          owner: { hostId: "diamond", pid: process.pid, nonce: `lineage-${ending}` },
          journalSource: "shared-child-completion",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
          requestResume: () => Effect.void
        })
        const tags: Array<string> = []
        const values: Array<unknown> = []
        const defects: Array<string> = []
        let interrupted = false
        yield* driver.register(Child, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: successorFlow._tag, payload: {} })
            return "handed off"
          }))
        const successorScope = yield* Scope.make()
        yield* driver.register(successorFlow, () =>
          Effect.gen(function*() {
            if (ending !== "cancelled") return 42
            const instance = yield* FlowRuntime.FlowInstance
            instance.waiting = { reason: "approval" }
            return yield* Flow.suspend(instance)
          })).pipe(Effect.provideService(Scope.Scope, successorScope))
        yield* driver.register(Parent, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            const observed = yield* Effect.exit(driver.execute(Child, {
              executionId: "lineage-child",
              payload: {},
              discard: false,
              parent: instance
            }))
            if (Exit.isFailure(observed)) {
              defects.push(String(Cause.squash(observed.cause)))
              return "defect"
            }
            const result = observed.value
            tags.push(result._tag)
            if (result._tag === "Suspended") return yield* Flow.suspend(instance)
            if (result._tag === "Complete") {
              interrupted = Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause)
              if (Exit.isSuccess(result.exit)) values.push(result.exit.value)
            }
            return "observed"
          }))

        yield* executeAndDrain(driver, Child, { executionId: "lineage-child", payload: {}, discard: true })
        for (let turn = 0; turn < 2000; turn++) {
          if (
            (yield* store.get(successor.executionId)).status === (ending === "cancelled" ? "suspended" : "completed")
          ) break
          yield* Effect.sleep("2 millis")
        }
        assert.strictEqual(
          (yield* store.get(successor.executionId)).status,
          ending === "cancelled" ? "suspended" : "completed"
        )
        if (ending === "unregistered") yield* Scope.close(successorScope, Exit.void)

        if (ending === "cancelled") {
          yield* driver.interrupt(Next, successor.executionId)
          for (let turn = 0; turn < 2000; turn++) {
            if ((yield* store.get(successor.executionId)).status === "cancelled") break
            yield* Effect.sleep("2 millis")
          }
          assert.strictEqual((yield* store.get(successor.executionId)).status, "cancelled")
        }
        yield* driver.execute(Parent, { executionId: "lineage-parent", payload: {}, discard: false })
        if (ending === "cancelled") {
          assert.strictEqual((yield* store.get("lineage-parent")).status, "completed")
          assert.deepStrictEqual(tags, ["Complete"])
          assert.strictEqual(interrupted, true)
        } else if (ending === "unregistered") {
          assert.deepStrictEqual(tags, [])
          assert.strictEqual(defects.length, 1)
          assert.include(defects[0], `Flow ${NumberNext._tag} is not registered`)
          assert.strictEqual((yield* store.get("lineage-parent")).status, "completed")
        } else {
          assert.deepStrictEqual(tags, ["Complete"])
          assert.deepStrictEqual(values, [42])
          assert.strictEqual((yield* store.get("lineage-parent")).status, "completed")
        }
      })))
  }

  it.live("reads the final nested result without decoding an obsolete middle round", () =>
    onDisk(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      const driver = yield* RunDriver.make({
        owner: { hostId: "diamond", pid: process.pid, nonce: "obsolete-middle" },
        journalSource: "shared-child-completion",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        requestResume: () => Effect.void
      })
      const middle = yield* FlowEngine.Round.next(FlowEngine.Round.initial("three-round-child"), {
        flowName: Child._tag,
        maxRounds: undefined
      })
      const final = yield* FlowEngine.Round.next(middle.round, {
        flowName: Next._tag,
        maxRounds: undefined
      })
      const observed: Array<unknown> = []
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
          return "first handoff"
        }))
      yield* driver.register(Next, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: NumberNext._tag, payload: {} })
          return "second handoff"
        }))
      yield* driver.register(NumberNext, () => Effect.succeed(42))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          const result = yield* Effect.exit(driver.execute(Child, {
            executionId: "three-round-child",
            payload: {},
            discard: false,
            parent: instance
          }))
          observed.push(result)
          instance.waiting = { reason: "result-recorded" }
          return yield* Flow.suspend(instance)
        }))

      yield* executeAndDrain(driver, Child, { executionId: "three-round-child", payload: {}, discard: true })
      for (let turn = 0; turn < 2000; turn++) {
        if ((yield* store.get(final.executionId)).status === "completed") break
        yield* Effect.sleep("2 millis")
      }
      assert.deepStrictEqual(
        yield* Effect.forEach(
          ["three-round-child", middle.executionId, final.executionId],
          (id) => store.get(id).pipe(Effect.map((row) => row.status))
        ),
        ["completed", "completed", "completed"]
      )

      const original = (yield* store.get(middle.executionId)).owner?.pid ?? null
      yield* TestDatabase.checks(sql, false)
      yield* sql`UPDATE flows_runs SET owner_pid = -1 WHERE run_id = ${middle.executionId}`
      yield* TestDatabase.checks(sql, true)
      const malformed = yield* Effect.flip(store.get(middle.executionId))
      assert.strictEqual(malformed.code, "decode_failed")
      yield* driver.execute(Parent, { executionId: "three-round-parent", payload: {}, discard: false })
      yield* sql`UPDATE flows_runs SET owner_pid = ${original} WHERE run_id = ${middle.executionId}`

      assert.strictEqual((yield* store.get("three-round-parent")).status, "suspended")
      assert.strictEqual(observed.length, 1)
      const call = observed[0] as Exit.Exit<Flow.Result<unknown, unknown>, unknown>
      assert.strictEqual(Exit.isSuccess(call), true)
      if (!Exit.isSuccess(call)) return
      const result = call.value
      assert.strictEqual(result._tag, "Complete")
      if (result._tag === "Complete") {
        assert.strictEqual(Exit.isSuccess(result.exit), true)
        if (Exit.isSuccess(result.exit)) assert.strictEqual(result.exit.value, 42)
      }
    })))

  it.live("reads a successor cancellation after its nested parent parked", () =>
    onDisk(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const driver = yield* RunDriver.make({
        owner: { hostId: "diamond", pid: process.pid, nonce: "cancel-after-parent-park" },
        journalSource: "shared-child-completion",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        requestResume: () => Effect.void
      })
      const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("parked-child"), {
        flowName: Child._tag,
        maxRounds: undefined
      })
      const observations: Array<{ readonly tag: string; readonly interrupted: boolean }> = []
      const drained = Effect.gen(function*() {
        for (let turn = 0; turn < 2000; turn++) {
          if ((yield* driver.active).size === 0) return
          yield* Effect.sleep("2 millis")
        }
        return yield* Effect.die("coordinator did not drain")
      })
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
          return "handed off"
        }))
      yield* driver.register(Next, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          const result = yield* driver.execute(Child, {
            executionId: "parked-child",
            payload: {},
            discard: false,
            parent: instance
          })
          observations.push({
            tag: result._tag,
            interrupted: result._tag === "Complete" &&
              Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause)
          })
          if (result._tag !== "Complete") return yield* Flow.suspend(instance)
          return "observed"
        }))

      yield* executeAndDrain(driver, Child, { executionId: "parked-child", payload: {}, discard: true })
      yield* drained
      assert.strictEqual((yield* store.get(successor.executionId)).status, "suspended")
      yield* driver.execute(Parent, { executionId: "parked-parent", payload: {}, discard: false })
      yield* drained
      assert.strictEqual((yield* store.get("parked-parent")).status, "suspended")
      assert.deepStrictEqual(observations, [{ tag: "Suspended", interrupted: false }])

      yield* driver.interrupt(Next, successor.executionId)
      for (let turn = 0; turn < 2000; turn++) {
        if ((yield* store.get(successor.executionId)).status === "cancelled") break
        yield* Effect.sleep("2 millis")
      }
      yield* drained
      assert.strictEqual((yield* store.get(successor.executionId)).status, "cancelled")
      // The committed cancellation wakes the parked parent itself (#2758), and
      // the woken round reads the successor's terminal row (#2752).
      for (let turn = 0; turn < 5000; turn++) {
        if ((yield* store.get("parked-parent")).status === "completed") break
        yield* Effect.sleep("5 millis")
      }
      yield* drained
      assert.strictEqual((yield* store.get("parked-parent")).status, "completed")
      assert.deepStrictEqual(observations, [
        { tag: "Suspended", interrupted: false },
        { tag: "Complete", interrupted: true }
      ])
    })))

  it.live("returns a raw handoff to a parent that supplies the trampoline round, even after the successor completes", () =>
    onDisk(Effect.gen(function*() {
      const realStore = yield* RunStore.RunStore
      const driver = yield* RunDriver.make({
        owner: { hostId: "diamond", pid: process.pid, nonce: "no-follow" },
        journalSource: "shared-child-completion",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        requestResume: () => Effect.void
      })
      const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("raw-child"), {
        flowName: Child._tag,
        maxRounds: undefined
      })
      let approved = false
      const observed: Record<string, string> = {}
      yield* driver.register(Child, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
          return "handed off"
        }))
      yield* driver.register(Next, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          if (approved) return "approved"
          instance.waiting = { reason: "approval" }
          return yield* Flow.suspend(instance)
        }))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          const result = yield* driver.execute(Child, {
            executionId: "raw-child",
            payload: {},
            discard: false,
            parent: instance,
            round: FlowEngine.Round.initial("raw-child")
          })
          observed[instance.executionId] = result._tag === "Handoff" ? result.flow : result._tag
          if (instance.executionId === "raw-parent-before" && !approved) return yield* Flow.suspend(instance)
          return "observed"
        }))

      yield* driver.execute(Parent, { executionId: "raw-parent-before", payload: {}, discard: false })
      assert.strictEqual(observed["raw-parent-before"], Next._tag)

      for (let turn = 0; turn < 2000; turn++) {
        if ((yield* driver.active).size === 0) break
        yield* Effect.sleep("2 millis")
      }
      assert.strictEqual((yield* realStore.get(successor.executionId)).status, "suspended")
      approved = true
      yield* driver.resume(Next, successor.executionId)
      assert.strictEqual((yield* realStore.get(successor.executionId)).status, "completed")
      yield* driver.execute(Parent, { executionId: "raw-parent-after", payload: {}, discard: false })
      assert.strictEqual(observed["raw-parent-after"], Next._tag)
    })))
})
