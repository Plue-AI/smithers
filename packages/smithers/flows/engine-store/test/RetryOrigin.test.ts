import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Issue #45: the schedule-to-close (`expirationMs`) budget is measured from
 * the durably recorded first attempt, so it survives park/resume and process
 * death instead of restarting on every process.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const OriginFlow = Flow.make("RetryOrigin/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "retry-origin-snapshot" as never, changeId: "retry-origin-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | TestClock.TestClock
  | Crypto.Crypto

const provide = <A, E>(effect: Effect.Effect<A, E, Services>, state: DurableEngineState.Service) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, state),
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    )
  )

describe("durable schedule-to-close origin", () => {
  it.effect("does not restart the retry budget when a new process re-drives the run", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const flaky = Action.make({
        name: "flaky",
        success: Schema.String,
        error: Schema.String,
        tier: "sealed",
        retryPolicy: RetryPolicy.make({
          initialMs: 10_000,
          factor: 1,
          maxMs: 10_000,
          expirationMs: 100_000,
          maxAttempts: 50
        }),
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.fail("boom")
        })
      })
      const state = DurableEngineState.makeMemory()
      const makeEngine = EngineStore.make({
        owner: { hostId: "retry-origin-host" },
        journalSource: "retry-origin-test",
        isAlive: () => Effect.succeed(false)
      })

      const result = yield* provide(
        Effect.gen(function*() {
          // First process: a few failed attempts, then the process goes away
          // mid-backoff and the run is released for reclaim.
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(OriginFlow, () => flaky)
            yield* executeUntilParked(engine, OriginFlow, {
              executionId: "retry-origin",
              payload: {},
              discard: true
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* TestDatabase.until(Effect.sync(() => dispatches >= 1))
            yield* TestDatabase.until(TestClock.adjust("100 millis").pipe(Effect.map(() => dispatches >= 2)))
            const journal = yield* Journal.Journal
            yield* TestDatabase.until(
              journal.entries({ runId: "retry-origin" as never, limit: 200 }).pipe(Effect.map((page) =>
                page.entries.filter((entry) => entry.eventType === "flows.engine.attempt-finished").length >= 2
              ))
            )
          }))
          const store = yield* RunStore.RunStore
          const dispatchesBeforeRestart = dispatches
          const released = yield* store.get("retry-origin")

          // Long outage: by the time a second process picks the run up, the
          // 100s schedule-to-close budget measured from attempt 1 is spent.
          yield* TestClock.adjust("500 seconds")
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(OriginFlow, () =>
              flaky)
            const fiber = yield* executeUntilParked(engine, OriginFlow, {
              executionId: "retry-origin",
              payload: {},
              discard: true
            }, ["failed"]).pipe(Effect.forkChild({ startImmediately: true }))
            yield* TestDatabase.until(
              TestClock.adjust("100 millis").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined))
            )
            yield* Fiber.await(fiber)
          }))
          return {
            dispatchesBeforeRestart,
            dispatchesAfterRestart: dispatches,
            releasedStatus: released.status,
            row: yield* store.get("retry-origin")
          }
        }),
        state
      )

      expect(result.releasedStatus).toBe("suspended")
      expect(result.dispatchesBeforeRestart).toBeGreaterThan(1)
      // The reclaiming process dispatched nothing: a fresh in-process clock
      // would have granted another full 100 seconds of retries.
      expect(result.dispatchesAfterRestart).toBe(result.dispatchesBeforeRestart)
      expect(result.row.status).toBe("failed")
      expect(JSON.parse(result.row.stateJson).result.exit.cause).toContainEqual({ _tag: "Fail", error: "boom" })
    }))

  it.effect("falls back to the earliest surviving attempt row when attempt 1 was pruned (issue #69)", () =>
    Effect.gen(function*() {
      // A retention job deletes the attempt-1 row between processes. The
      // durable origin must degrade to the earliest surviving row — not to a
      // fresh in-process clock, which would silently restore the unbounded
      // budget #45 fixed.
      let dispatches = 0
      const flaky = Action.make({
        name: "flaky-pruned",
        success: Schema.String,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({
          initialMs: 10_000,
          factor: 1,
          maxMs: 10_000,
          expirationMs: 100_000,
          maxAttempts: 50
        }),
        execute: Effect.suspend(() => {
          dispatches++
          return Effect.fail("boom")
        })
      })
      const state = DurableEngineState.makeMemory()
      const makeEngine = EngineStore.make({
        owner: { hostId: "retry-origin-pruned-host" },
        journalSource: "retry-origin-pruned-test",
        isAlive: () => Effect.succeed(false)
      })

      // The production SQL journal stack with the database kept reachable, so
      // the test can prune the attempt-1 row like a retention job would.
      const journalWithDatabase = Layer.provideMerge(
        Layer.mergeAll(
          SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
          RunStore.layer,
          AttemptStore.layer,
          CacheStore.layer
        ),
        Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      )

      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(OriginFlow, () => flaky)
            yield* executeUntilParked(engine, OriginFlow, {
              executionId: "retry-origin-pruned",
              payload: {},
              discard: true
            }).pipe(Effect.forkChild({ startImmediately: true }))
            yield* TestDatabase.until(Effect.sync(() => dispatches >= 1))
            yield* TestDatabase.until(TestClock.adjust("100 millis").pipe(Effect.map(() => dispatches >= 2)))
            const journal = yield* Journal.Journal
            yield* TestDatabase.until(
              journal.entries({ runId: "retry-origin-pruned" as never, limit: 200 }).pipe(
                Effect.map((page) =>
                  page.entries.filter((entry) => entry.eventType === "flows.engine.attempt-finished").length >= 2
                )
              )
            )
          }))
          const dispatchesBeforeRestart = dispatches

          // Retention prunes the attempt-1 row while the run is parked.
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`DELETE FROM flows_attempts WHERE run_id = 'retry-origin-pruned' AND attempt = 1`

          yield* TestClock.adjust("500 seconds")
          yield* Effect.scoped(Effect.gen(function*() {
            const engine = yield* makeEngine
            yield* engine.register(OriginFlow, () => flaky)
            const fiber = yield* executeUntilParked(engine, OriginFlow, {
              executionId: "retry-origin-pruned",
              payload: {},
              discard: true
            }, ["failed"]).pipe(Effect.forkChild({ startImmediately: true }))
            yield* TestDatabase.until(
              TestClock.adjust("100 millis").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined))
            )
            yield* Fiber.await(fiber)
          }))
          const store = yield* RunStore.RunStore
          return {
            dispatchesBeforeRestart,
            dispatchesAfterRestart: dispatches,
            row: yield* store.get("retry-origin-pruned")
          }
        }).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, state),
          Effect.provideService(Jj.Jj, jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(OwnerIdentity.layer),
          Effect.provide(journalWithDatabase),
          Effect.provide(TestClock.layer())
        )
      )

      expect(result.dispatchesBeforeRestart).toBeGreaterThan(1)
      // The budget is measured from the earliest surviving attempt row: the
      // reclaiming process dispatched nothing, where a current-clock fallback
      // would have granted another full 100 seconds of retries.
      expect(result.dispatchesAfterRestart).toBe(result.dispatchesBeforeRestart)
      expect(result.row.status).toBe("failed")
      expect(JSON.parse(result.row.stateJson).result.exit.cause).toContainEqual({ _tag: "Fail", error: "boom" })
    }))
})
