import { assert, describe, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
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
 * - `successor`: round zero hands off at once, the successor parks, and the
 *   second parent attaches to the successor round only;
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
    const successorRound = { ...successor.round, previousExecutionId: "shared-child" }
    yield* driver.register(Shared, () =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        if (ending === "successor" || released) {
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
        if (released) return "approved"
        instance.waiting = { reason: "approval" }
        return yield* Flow.suspend(instance)
      }))
    yield* driver.register(Parent, () =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        calls[instance.executionId] = (calls[instance.executionId] ?? 0) + 1
        const joinSuccessor = () =>
          driver.execute(Next, {
            executionId: successor.executionId,
            payload: {},
            discard: false,
            parent: instance,
            round: successorRound
          })
        // In the successor case the second parent attaches to the successor
        // round only, so its sole edge is keyed on a later round.
        let result = ending === "successor" && instance.executionId === "parent-b"
          ? yield* joinSuccessor()
          : yield* driver.execute(Shared, {
            executionId: "shared-child",
            payload: {},
            discard: false,
            parent: instance
          })
        if (result._tag === "Handoff") result = yield* joinSuccessor()
        if (result._tag !== "Complete") return yield* Flow.suspend(instance)
        return returned[instance.executionId] = Exit.isSuccess(result.exit) ? String(result.exit.value) : "child failed"
      }))
    for (const id of ["parent-a", "parent-b"]) {
      yield* driver.execute(Parent, { executionId: id, payload: {}, discard: false })
      yield* drained
    }
    const settling = ending === "successor" ? successor.executionId : "shared-child"
    const ids = [settling, "parent-a", "parent-b"]
    const statuses = Effect.forEach(ids, (id) => realStore.get(id).pipe(Effect.map((row) => row.status)))
    assert.deepStrictEqual(yield* statuses, ["suspended", "suspended", "suspended"])
    assert.deepStrictEqual(
      (yield* state.runParents(settling)).map((edge) => edge.parentId),
      ["parent-a", "parent-b"]
    )

    released = true
    corrupt = true
    yield* driver.resume(ending === "successor" ? Next : Shared, settling)
    yield* drained

    return {
      statuses: yield* statuses,
      returned,
      childState: (yield* realStore.get(settling)).stateJson,
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
      name: "settles a parent attached only to the shared child's successor round",
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
})
