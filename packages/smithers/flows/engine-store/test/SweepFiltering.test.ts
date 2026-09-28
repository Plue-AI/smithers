/**
 * Pins issue #68: the parked-run sweep used to do an unfiltered
 * `waitingRuns()` scan plus one `store.get` per parked row, every heartbeat,
 * in every driver — linear in total parked runs even though it acts only on
 * released or cancel-requested rows. The sweep must fetch only actionable
 * rows through the `WaitingRunsFilter` (reason `released`, and the
 * cancel-requested predicate added for this issue), so a quota/event-parked
 * fleet costs the sweeper nothing per tick.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`:
 * the filter's cancel predicate reads `flows_runs.cancel_requested_at_ms`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("SweepFiltering/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

/** Inserts a suspended, unowned, parked run row directly (fences bypassed). */
const insertParkedRun = (
  runId: string,
  reason: string,
  cancelRequestedAtMs: number | null
) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({
      version: 1,
      flowName: TestFlow._tag,
      payload: {}
    })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        cancel_requested_at_ms,
        waiting_reason,
        state_json
      ) VALUES (
        ${runId},
        'suspended',
        0,
        ${cancelRequestedAtMs},
        ${reason},
        ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

describe("the parked-run sweep fetches only actionable rows (issue #68)", () => {
  it.effect("never issues store.get for rows that are neither released nor cancel-requested", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            // A quota-parked fleet the sweep must not touch, plus the two
            // actionable shapes.
            yield* insertParkedRun("neutral-quota", "quota", null)
            yield* insertParkedRun("neutral-event", "event", null)
            yield* insertParkedRun("actionable-cancel", "event", 1)
            yield* insertParkedRun("actionable-released", "released", null)

            // Spy on store.get: the sweep's per-row guard is the only reader
            // for runs no execute/resume ever touches.
            const store = yield* RunStore.RunStore
            const getCounts = new Map<string, number>()
            const spyingStore: RunStore.RunStore["Service"] = {
              ...store,
              get: (runId) => {
                getCounts.set(runId, (getCounts.get(runId) ?? 0) + 1)
                return store.get(runId)
              }
            }

            yield* RunDriver.make({
              owner: { hostId: "sweep-filter-host", pid: 1, nonce: "owner-1" },
              journalSource: "sweep-filtering",
              isAlive: () => Effect.succeed(false),
              engine: Effect.succeed(fakeEngine)
            }).pipe(Effect.provideService(RunStore.RunStore, spyingStore))

            for (let i = 0; i < 5; i++) {
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            }
            yield* TestDatabase.until(
              Effect.sync(() =>
                (getCounts.get("actionable-cancel") ?? 0) > 0 && (getCounts.get("actionable-released") ?? 0) > 0
              )
            )
            return {
              neutralQuota: getCounts.get("neutral-quota") ?? 0,
              neutralEvent: getCounts.get("neutral-event") ?? 0,
              actionableCancel: getCounts.get("actionable-cancel") ?? 0,
              actionableReleased: getCounts.get("actionable-released") ?? 0
            }
          })
        ).pipe(
          Effect.provide(services),
          Effect.provide(TestClock.layer())
        )
      )

      // The sweep still examines and wakes the actionable rows…
      expect(result.actionableCancel).toBeGreaterThanOrEqual(1)
      expect(result.actionableReleased).toBeGreaterThanOrEqual(1)
      // …but pays nothing for the parked fleet it cannot act on.
      expect(result.neutralQuota).toBe(0)
      expect(result.neutralEvent).toBe(0)
    }))
})
