/** Faults and ownership races at pending cancellation discovery, over matrix-selected production stores. */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Fiber, Latch, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("PendingCancellationSweepEdges/Absent", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const state = JSON.stringify({ version: 1, flowName: flow._tag, payload: {}, capabilityCeilings: [[]] })
const owner: Ownership.OwnerId = { hostId: "pending-cancel-edges", pid: 1, nonce: "cleanup" }
// These cases may only cancel; invoking any engine/handler operation is a defect.
const engine = Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
const make = (options: Partial<RunDriver.Dependencies> = {}) =>
  RunDriver.make({
    owner,
    journalSource: "pending-cancel-edges",
    isAlive: () => Effect.succeed(true),
    engine,
    ...options
  })
const tick = Effect.gen(function*() {
  yield* TestClock.adjust(Ownership.heartbeatInterval)
  for (let turn = 0; turn < 1_000; turn++) yield* Effect.yieldNow
})
const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(TestStores.database)
)
type Services = Layer.Success<typeof stores> | Crypto.Crypto | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(effect.pipe(Effect.scoped, Effect.provide(stores)))
const request = (runs: RunStore.Service, id: string) =>
  runs.create(id, state).pipe(Effect.andThen(runs.requestCancel(id, 0)))

describe("pending cancellation sweep races", () => {
  it.effect("skips deleted, already-cancelled and corrupt rows without blocking valid later requests", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const sql = yield* SqlClient
        const original = yield* DurableEngineState.DurableEngineState
        const services = yield* Effect.context<Services>()
        for (const id of ["a-deleted", "b-settled", "c-corrupt", "d-recreated", "e-valid"]) yield* request(runs, id)
        let changed = false
        const discovery: DurableEngineState.Service = {
          ...original,
          pendingCancellationRuns: (limit, after, through) =>
            original.pendingCancellationRuns(limit, after, through).pipe(
              Effect.tap(() =>
                Effect.gen(function*() {
                  if (changed) return
                  changed = true
                  yield* sql`DELETE FROM flows_runs WHERE run_id = 'a-deleted'`
                  // A replacement identity has no cancellation request; stale
                  // discovery must neither claim nor execute it.
                  yield* sql`DELETE FROM flows_runs WHERE run_id = 'd-recreated'`
                  yield* runs.create("d-recreated", state)
                  // Another actual driver closes this row after discovery selected it.
                  yield* Effect.scoped(
                    make({ owner: { ...owner, nonce: "rival" } }).pipe(
                      Effect.flatMap((rival) => rival.resume(flow, "b-settled", { poll: true }))
                    )
                  ).pipe(Effect.provide(services))
                  yield* TestDatabase.checks(sql, false)
                  yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = -1 WHERE run_id = 'c-corrupt'`
                })
              ),
              Effect.orDie
            )
        }
        yield* make().pipe(Effect.provideService(DurableEngineState.DurableEngineState, discovery))
        yield* tick
        yield* TestDatabase.until(runs.get("e-valid").pipe(Effect.map((row) => row.status === "cancelled")))
        expect((yield* Effect.exit(runs.get("a-deleted")))._tag).toBe("Failure")
        expect((yield* runs.get("b-settled")).status).toBe("cancelled")
        expect(yield* runs.get("d-recreated")).toMatchObject({
          status: "pending",
          owner: null,
          claim: null,
          cancelRequestedAtMs: null
        })
        expect(yield* runs.get("e-valid")).toMatchObject({ status: "cancelled", owner: null, claim: null })
        expect((yield* Effect.exit(runs.get("c-corrupt")))._tag).toBe("Failure")
        yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = 0 WHERE run_id = 'c-corrupt'`
        yield* TestDatabase.checks(sql, true)
      })
    ))

  it.effect("retries a transient point-read failure at the same cursor and preserves prior progress", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const original = yield* DurableEngineState.DurableEngineState
        const afters: Array<string | undefined> = []
        const discovery: DurableEngineState.Service = {
          ...original,
          pendingCancellationRuns: (limit, after, through) =>
            Effect.sync(() => {
              afters.push(after?.runId)
            }).pipe(
              Effect.andThen(original.pendingCancellationRuns(limit, after, through))
            )
        }
        for (const id of ["a-progress", "b-outage", "c-later"]) yield* request(runs, id)
        let fail = true
        let outageObserved = false
        // Inject one adapter outage at its public read boundary, with real stores
        // on both sides, to deterministically qualify cursor retry ordering.
        const transient = new RunStore.RunStoreError({
          code: "persistence_failed",
          method: "get",
          message: "one read outage",
          cause: undefined
        })
        const wrapped: RunStore.Service = {
          ...runs,
          get: (id) =>
            id === "b-outage" && fail
              ? Effect.sync(() => {
                outageObserved = true
              }).pipe(Effect.andThen(Effect.fail(transient)))
              : runs.get(id)
        }
        yield* make().pipe(
          Effect.provideService(RunStore.RunStore, wrapped),
          Effect.provideService(DurableEngineState.DurableEngineState, discovery)
        )
        yield* tick
        yield* TestDatabase.until(
          runs.get("a-progress").pipe(
            Effect.map((row) => outageObserved && row.status === "cancelled")
          )
        )
        expect((yield* runs.get("a-progress")).status).toBe("cancelled")
        expect((yield* runs.get("b-outage")).status).toBe("pending")
        expect((yield* runs.get("c-later")).status).toBe("pending")
        fail = false
        yield* tick
        yield* TestDatabase.until(runs.get("c-later").pipe(Effect.map((row) => row.status === "cancelled")))
        expect(afters.slice(0, 2)).toEqual([undefined, "a-progress"])
        for (const id of ["a-progress", "b-outage", "c-later"]) {
          expect(yield* runs.get(id)).toMatchObject({ status: "cancelled", owner: null, claim: null })
        }
      })
    ))

  it.effect("ends a full captured-tail page and leaves activation-refused cancellation ownerless", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const journal = yield* Journal.Journal
        const original = yield* DurableEngineState.DurableEngineState
        const pages: Array<ReadonlyArray<string>> = []
        const discovery: DurableEngineState.Service = {
          ...original,
          pendingCancellationRuns: (limit, after, through) =>
            original.pendingCancellationRuns(limit, after, through)
              .pipe(Effect.tap((rows) =>
                Effect.sync(() => {
                  pages.push(rows.map((row) => row.runId))
                })
              ))
        }
        for (let index = 0; index < 64; index++) yield* request(runs, `requested-${String(index).padStart(2, "0")}`)
        yield* make({ canActivate: (row) => Effect.succeed(row.runId !== "requested-63") }).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, discovery)
        )
        yield* tick
        yield* TestDatabase.until(runs.get("requested-62").pipe(Effect.map((row) => row.status === "cancelled")))
        yield* TestDatabase.until(Effect.gen(function*() {
          yield* journal.flush
          const events = yield* journal.entries({ runId: "requested-63" as never, limit: 100 })
          return events.entries.some((entry) =>
            entry.eventType === "flows.engine.run-decision" &&
            (entry.payload as { decision: string }).decision === "activation-lost"
          )
        }))
        expect(pages[0]).toHaveLength(64)
        expect((yield* runs.get("requested-62")).status).toBe("cancelled")
        expect(yield* runs.get("requested-63")).toMatchObject({
          status: "pending",
          owner: null,
          claim: null,
          cancelRequestedAtMs: 0
        })
        yield* tick
        yield* TestDatabase.until(Effect.sync(() => pages.length >= 2))
        expect(pages[1]).toEqual(["requested-63"])
        yield* journal.flush
        const events = yield* journal.entries({ runId: "requested-63" as never, limit: 100 })
        expect(events.entries.some((entry) =>
          entry.eventType === "flows.engine.run-decision" &&
          (entry.payload as { decision: string }).decision === "activation-lost"
        )).toBe(true)
      })
    ))

  it.effect("does not dispatch a second drive while a cancellation already awaits admission", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const entered = yield* Latch.make(false)
        const release = yield* Latch.make(false)
        let admissions = 0
        yield* request(runs, "active-pending")
        const driver = yield* make({
          canExecute: () =>
            Effect.gen(function*() {
              admissions++
              yield* Latch.open(entered)
              yield* Latch.await(release)
              return true
            })
        })
        const first = yield* driver.resume(flow, "active-pending", { poll: true }).pipe(Effect.forkScoped)
        yield* Latch.await(entered)
        yield* tick
        expect(admissions).toBe(1)
        expect(yield* runs.get("active-pending")).toMatchObject({ status: "pending", owner: null, claim: null })
        yield* Latch.open(release)
        yield* Fiber.join(first)
        expect(yield* runs.get("active-pending")).toMatchObject({ status: "cancelled", owner: null, claim: null })
      })
    ))

  it.effect("rechecks active dispatch when a concurrent wake arrives during sweep admission", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const entered = yield* Latch.make(false)
        const release = yield* Latch.make(false)
        let driver: RunDriver.Service
        const scope = yield* Effect.scope
        let completion: Effect.Effect<unknown, unknown> = Effect.void
        let admissions = 0
        yield* request(runs, "raced-pending")
        driver = yield* make({
          canExecute: () =>
            Effect.gen(function*() {
              admissions++
              if (admissions === 1) {
                // A public wake gets dispatched while the sweep's asynchronous
                // admission is outstanding. Keep that drive pending at preflight.
                const first = yield* driver.resume(flow, "raced-pending", { poll: true }).pipe(Effect.forkIn(scope))
                completion = Fiber.join(first)
                yield* Latch.await(entered)
              } else {
                yield* Latch.open(entered)
                yield* Latch.await(release)
              }
              return true
            })
        })
        yield* tick
        yield* Latch.await(entered)
        expect(admissions).toBe(2)
        expect((yield* driver.active).size).toBe(1)
        expect(yield* runs.get("raced-pending")).toMatchObject({ status: "pending", owner: null, claim: null })
        yield* Latch.open(release)
        yield* completion
        expect(yield* runs.get("raced-pending")).toMatchObject({ status: "cancelled", owner: null, claim: null })
      })
    ))
})
