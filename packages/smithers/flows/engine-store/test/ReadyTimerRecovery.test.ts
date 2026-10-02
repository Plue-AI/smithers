import { expect, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("ReadyTimerRecovery", { payload: {}, success: Schema.String, body: () => Node.succeed("done") })
// These flows have no filesystem effects; Jj is an unused required host port.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.die("unused"),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)
const stores = Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), jj)
const tick = Effect.gen(function*() {
  yield* TestClock.adjust("1 second")
  for (let i = 0; i < 1000; i++) yield* Effect.yieldNow
})
const seed = (id: string, reason: string, wakeAt: number, completed: boolean, consumed = false) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    const owner = { hostId: "former", pid: 10000, nonce: id }
    const json = JSON.stringify({
      version: 1,
      flowName: flow._tag,
      payload: {},
      capabilityCeilings: [[]],
      result: { _tag: "Suspended", cause: null }
    })
    yield* runs.create(id, json)
    expect((yield* runs.claimAndOwn(id, yield* runs.get(id), owner, yield* Clock.currentTimeMillis))._tag).toBe(
      "Activated"
    )
    yield* state.park(id, { reason, wakeAt }, owner)
    expect((yield* runs.transitionOwned(id, owner, "suspended", json))._tag).toBe("Transitioned")
    if (completed) {
      const address = { flowName: flow._tag, executionId: id, deferredName: `clock-${id}` }
      yield* state.completeDeferred({ ...address, exit: { _tag: "Success", value: null }, completedAtMs: 0 })
      if (consumed) yield* state.consumeDeferred(address, 0)
    }
  })

it.effect("#3408 revisits a ready timer after admission refuses its first wake, without resume or duplicate execution", () =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      yield* seed("ready", "timer", 0, true)
      let allowed = false, calls = 0
      const engine = yield* EngineStore.make({
        owner: { hostId: "replacement" },
        journalSource: "ready-timer",
        canExecute: () => Effect.succeed(allowed)
      })
      yield* engine.register(flow, () =>
        Effect.sync(() => {
          calls++
          return "done"
        }))
      yield* tick
      expect(calls).toBe(0)
      expect((yield* (yield* RunStore.RunStore).get("ready")).status).toBe("suspended")
      allowed = true
      yield* tick
      expect(calls).toBe(1)
      expect((yield* (yield* RunStore.RunStore).get("ready")).status).toBe("completed")
      expect(Option.getOrThrow(yield* engine.poll(flow, "ready"))._tag).toBe("Complete")
      yield* tick
      expect(calls).toBe(1)
    })).pipe(Effect.provide(stores))
  ))

it.effect("#3408 excludes future/uncompleted/consumed timers and ordinary event/released waits", () =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      let calls = 0
      const engine = yield* EngineStore.make({
        owner: { hostId: "replacement" },
        journalSource: "ready-timer-controls",
        canExecute: (row) => Effect.succeed(row.runId !== "released")
      })
      yield* engine.register(flow, () =>
        Effect.sync(() => {
          calls++
          return "done"
        }))
      yield* seed("future", "timer", 60_000, true)
      yield* seed("uncompleted", "timer", 0, false)
      yield* seed("consumed", "timer", 0, true, true)
      yield* seed("event", "event", 0, true)
      yield* seed("released", "released", 0, true)
      yield* tick
      expect(calls).toBe(0)
      const runs = yield* RunStore.RunStore
      for (const id of ["future", "uncompleted", "consumed", "event", "released"]) {
        expect((yield* runs.get(id)).status).toBe("suspended")
      }
    })).pipe(Effect.provide(stores))
  ))
