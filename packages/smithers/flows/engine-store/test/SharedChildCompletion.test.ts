import { assert, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Schema } from "effect"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// Issue #2500: a diamond's second parent is recorded only as a durable edge,
// so settling the shared child must wake every edge, not just the creator.
const Child = Flow.make("Diamond/child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Parent = Flow.make("Diamond/parent", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

it.live("settles both durable parents when their shared attached child completes", () =>
  withCrypto(
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const receipts: Array<[string, string]> = []
      const calls: Record<string, number> = {}
      let approved = false
      const driver = yield* RunDriver.make({
        owner: { hostId: "diamond", pid: process.pid, nonce: "shared-child" },
        journalSource: "shared-child-completion",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
        requestResume: (id, reason) =>
          Effect.sync(() => {
            receipts.push([id, reason])
          })
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
          if (!approved) {
            instance.waiting = { reason: "approval" }
            return yield* Flow.suspend(instance)
          }
          return "approved"
        }))
      yield* driver.register(Parent, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          calls[instance.executionId] = (calls[instance.executionId] ?? 0) + 1
          const result = yield* driver.execute(Child, {
            executionId: "shared-child",
            payload: {},
            discard: false,
            parent: instance
          })
          if (result._tag !== "Complete") return yield* Flow.suspend(instance)
          return Exit.isSuccess(result.exit) ? String(result.exit.value) : yield* Effect.die(result.exit)
        }))
      for (const id of ["parent-a", "parent-b"]) {
        yield* driver.execute(Parent, { executionId: id, payload: {}, discard: false })
        yield* drained
      }
      const ids = ["shared-child", "parent-a", "parent-b"]
      const statuses = Effect.forEach(ids, (id) => store.get(id).pipe(Effect.map((row) => row.status)))
      assert.deepStrictEqual(yield* statuses, ["suspended", "suspended", "suspended"])
      assert.deepStrictEqual(
        (yield* state.runParents("shared-child")).map((edge) => edge.parentId),
        ["parent-a", "parent-b"]
      )

      approved = true
      yield* driver.resume(Child, "shared-child")
      yield* drained

      assert.deepStrictEqual(yield* statuses, ["completed", "completed", "completed"])
      assert.deepStrictEqual(calls, { "parent-a": 2, "parent-b": 2 })
      assert.deepStrictEqual([...receipts].sort(), [["parent-a", "parent"], ["parent-b", "parent"]])
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")))
  ))
