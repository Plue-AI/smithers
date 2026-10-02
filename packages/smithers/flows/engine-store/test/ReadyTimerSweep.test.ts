/** Heartbeat recovery must work independently of registration-time deferred recovery. */
import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("ReadyTimerSweep", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(TestStores.database))
const seed = (id: string, completion: "ready" | "absent" | "consumed", flowName: string = flow._tag) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    const owner = { hostId: "timer-seed", pid: 1, nonce: id }
    const json = JSON.stringify({
      version: 1,
      flowName,
      payload: {},
      capabilityCeilings: [[]],
      result: { _tag: "Suspended", cause: null }
    })
    yield* runs.create(id, json)
    expect(yield* runs.claimAndOwn(id, yield* runs.get(id), owner, 0)).toMatchObject({ _tag: "Activated" })
    expect(yield* state.park(id, { reason: "timer", wakeAt: 0 }, owner)).toMatchObject({ _tag: "Parked" })
    expect(yield* runs.transitionOwned(id, owner, "suspended", json)).toMatchObject({ _tag: "Transitioned" })
    if (completion !== "absent") {
      const address = { flowName, executionId: id, deferredName: `clock-${id}` }
      yield* state.completeDeferred({ ...address, exit: { _tag: "Success", value: null }, completedAtMs: 0 })
      if (completion === "consumed") expect(yield* state.consumeDeferred(address, 0)).toBe(true)
    }
  })

it.effect("recovers two ready timers with one completion query per flow and leaves unready timers parked", () =>
  withCrypto(
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      for (const id of ["a-ready", "b-ready"]) yield* seed(id, "ready")
      yield* seed("c-absent", "absent")
      yield* seed("d-consumed", "consumed")
      const queries: Array<{ readonly at: number; readonly ids: ReadonlyArray<string> }> = []
      const observed: DurableEngineState.Service = {
        ...state,
        completedDeferreds: (flowName) =>
          Effect.gen(function*() {
            const at = yield* Clock.currentTimeMillis
            const rows = yield* state.completedDeferreds(flowName)
            queries.push({ at, ids: rows.map((row) => row.executionId) })
            return rows
          })
      }
      // A direct driver registration has no DeferredPersistence.sweepDue hook.
      // Only the heartbeat sweep can discover these persisted completions.
      const driver = yield* RunDriver.make({
        owner: { hostId: "timer-recovery", pid: 2, nonce: "heartbeat" },
        journalSource: "ready-timer-sweep",
        isAlive: () => Effect.succeed(false),
        // The handler returns its value directly and uses no engine operations.
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
      }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, observed))
      const executions = new Map<string, number>()
      yield* driver.register(flow, (_, executionId) =>
        Effect.sync(() => {
          executions.set(executionId, (executions.get(executionId) ?? 0) + 1)
          return "done"
        }))
      expect(executions.size).toBe(0)
      yield* TestClock.adjust("1 second")
      yield* TestDatabase.until(Effect.gen(function*() {
        return (yield* runs.get("a-ready")).status === "completed" &&
          (yield* runs.get("b-ready")).status === "completed"
      }))
      expect(queries).toHaveLength(1)
      expect([...(queries[0]?.ids ?? [])].sort()).toEqual(["a-ready", "b-ready"])
      for (const id of ["a-ready", "b-ready"]) {
        expect(yield* runs.get(id)).toMatchObject({ status: "completed", owner: null, claim: null })
        expect(Option.getOrThrow(yield* driver.poll(flow, id))).toMatchObject({
          _tag: "Complete",
          exit: { _tag: "Success", value: "done" }
        })
      }
      // Wait for a subsequent real adapter sweep, advancing only the test clock.
      yield* TestDatabase.until(Effect.gen(function*() {
        if (queries.length >= 2) return true
        yield* TestClock.adjust("1 second")
        return false
      }))
      expect(new Set(queries.map((query) => query.at)).size).toBe(queries.length)
      expect(queries.slice(1).every((query) => query.ids.length === 0)).toBe(true)
      expect([...executions.entries()].sort()).toEqual([["a-ready", 1], ["b-ready", 1]])
      for (const id of ["c-absent", "d-consumed"]) {
        expect(yield* runs.get(id)).toMatchObject({ status: "suspended", owner: null, claim: null })
        expect(Option.getOrThrow(yield* state.waiting(id))).toMatchObject({ reason: "timer", wakeAt: 0 })
      }
      yield* journal.flush
      for (const id of ["a-ready", "b-ready"]) {
        const page = yield* journal.entries({ runId: id as never, limit: 100 })
        expect(page.entries.filter((entry) =>
          entry.eventType === "flows.engine.run-decision" &&
          (entry.payload as { decision?: string; status?: string }).decision === "transitioned" &&
          (entry.payload as { status?: string }).status === "completed"
        )).toHaveLength(1)
      }
    }).pipe(Effect.scoped, Effect.provide(stores))
  ))

it.effect("skips deleted, settled and unregistered timer cursors while recovering later eligible rows", () =>
  withCrypto(
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      const sql = yield* SqlClient
      const absentFlow = "ReadyTimerSweep/Unregistered"
      yield* seed("a-deleted", "absent")
      yield* seed("b-settled", "ready")
      yield* seed("c-unregistered", "ready", absentFlow)
      for (const id of ["d-eligible", "e-eligible"]) yield* seed(id, "ready")
      let selected: ReadonlyArray<string> = []
      let settled: RunStore.RunRow | undefined
      const completionQueries: Array<string> = []
      const observed: DurableEngineState.Service = {
        ...state,
        completedDeferreds: (flowName) =>
          state.completedDeferreds(flowName).pipe(Effect.tap(() =>
            Effect.sync(() => {
              completionQueries.push(flowName)
            })
          )),
        waitingRuns: (filter) =>
          state.waitingRuns(filter).pipe(
            Effect.tap((rows) =>
              Effect.gen(function*() {
                if (filter?.reason !== "timer" || selected.length !== 0) return
                selected = rows.map((row) => row.runId)
                // The actual query has returned its cursors. Another actor deletes a
                // row and fences a terminal transition before their point reads.
                yield* sql`DELETE FROM flows_runs WHERE run_id = 'a-deleted'`
                const before = yield* runs.get("b-settled")
                const rival = { hostId: "timer-rival", pid: 3, nonce: "settled" }
                expect(yield* runs.claimAndOwn("b-settled", before, rival, yield* Clock.currentTimeMillis))
                  .toMatchObject({ _tag: "Activated" })
                expect(yield* runs.transitionOwned("b-settled", rival, "completed"))
                  .toMatchObject({ _tag: "Transitioned" })
                settled = yield* runs.get("b-settled")
              })
            ),
            Effect.orDie
          )
      }
      const driver = yield* RunDriver.make({
        owner: { hostId: "timer-recovery", pid: 2, nonce: "stale-cursors" },
        journalSource: "ready-timer-stale-cursors",
        isAlive: () => Effect.succeed(false),
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
      }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, observed))
      const executed: Array<string> = []
      yield* driver.register(flow, (_, executionId) =>
        Effect.sync(() => {
          executed.push(executionId)
          return "done"
        }))
      yield* TestClock.adjust("1 second")
      yield* TestDatabase.until(Effect.gen(function*() {
        return (yield* runs.get("d-eligible")).status === "completed" &&
          (yield* runs.get("e-eligible")).status === "completed"
      }))
      expect([...selected].sort()).toEqual(["a-deleted", "b-settled", "c-unregistered", "d-eligible", "e-eligible"])
      expect([...executed].sort()).toEqual(["d-eligible", "e-eligible"])
      expect(completionQueries).toEqual([flow._tag])
      const missing = yield* runs.get("a-deleted").pipe(Effect.match({
        onFailure: (error) => error.code,
        onSuccess: () => "unexpected-row"
      }))
      expect(missing).toBe("not_found_row")
      expect(yield* runs.get("b-settled")).toEqual(settled)
      expect(yield* runs.get("c-unregistered")).toMatchObject({ status: "suspended", owner: null, claim: null })
      expect(Option.getOrThrow(yield* state.waiting("c-unregistered"))).toMatchObject({ reason: "timer", wakeAt: 0 })
      expect((yield* state.completedDeferreds(absentFlow)).map((address) => address.executionId)).toEqual([
        "c-unregistered"
      ])
      yield* journal.flush
      for (const id of ["a-deleted", "b-settled", "c-unregistered"]) {
        expect((yield* journal.entries({ runId: id as never, limit: 100 })).entries).toEqual([])
      }
      for (const id of ["d-eligible", "e-eligible"]) {
        expect(yield* runs.get(id)).toMatchObject({ status: "completed", owner: null, claim: null })
        const page = yield* journal.entries({ runId: id as never, limit: 100 })
        expect(page.entries.filter((entry) =>
          entry.eventType === "flows.engine.run-decision" &&
          (entry.payload as { decision?: string; status?: string }).decision === "transitioned" &&
          (entry.payload as { status?: string }).status === "completed"
        )).toHaveLength(1)
      }
    }).pipe(Effect.scoped, Effect.provide(stores))
  ))
