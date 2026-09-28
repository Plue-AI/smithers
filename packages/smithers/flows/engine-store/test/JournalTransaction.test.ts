/**
 * Pins the WAL/state atomicity seam ACROSS packages: `@smthrs/journal`'s
 * `transact` runs a `@smthrs/run-store` state projection and the lifecycle
 * entries describing it in ONE write transaction, because both stores write
 * through the same `DurableWriter` and so join it as savepoints. The
 * journal-only half of the contract stays in `@smthrs/journal`.
 *
 * Prior art: `reference/temporal/service/history/workflow/transaction_impl.go`
 * submits the mutable-state mutation and its event batches as one persistence
 * request.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal } from "@smthrs/journal/Journal"
import { Input, type RunId, type SourceId, type SourceSeq } from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, PubSub } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it.effect(name, () => body().pipe(Effect.provide(TestClock.layer())))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    sourceSeq: 0 as SourceSeq,
    eventType,
    payload
  }, { disableChecks: true })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const stack = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.merge(RunStore.layer),
  Layer.provideMerge(migratedDatabase)
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Scope.Scope>
) => Effect.scoped(body.pipe(Effect.provide(stack)))

const rowsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  sql<{ readonly seq: number; readonly event_type: string }>`
    SELECT seq, event_type FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq ASC
  `

class Rejected extends Error {
  override readonly name = "Rejected"
}

describe("Journal.transact across the journal and run stores", () => {
  effect(
    "commits a lifecycle entry and the state projection it describes together",
    () =>
      withStack(Effect.gen(function*() {
        const journal = yield* Journal
        const runs = yield* RunStore.RunStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const run = runId("atomic-commit")

        yield* journal.transact(Effect.gen(function*() {
          yield* runs.create(run, "{}")
          yield* journal.emitDurableUnfenced(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
          )
        }))

        const row = yield* runs.get(run)
        const rows = yield* rowsOf(sql, run)
        expect(row.status).toBe("pending")
        expect(rows.map((entry) => entry.event_type)).toEqual(["flows.engine.run-decision"])
      }))
  )

  effect("finishes a claimed run with the guide's fenced completion transaction", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const runId = "guide-finish" as RunId
      const sourceId = "driver" as SourceId
      const owner = { hostId: "guide-host", pid: 101, nonce: "guide-owner" }
      yield* runs.create(runId, "{}")
      const claimed = yield* runs.claimAndOwn(
        runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 0
      )
      expect(claimed._tag).toBe("Activated")

      // Keep the transaction body aligned with docs/guides/commit-state-and-entry.md.
      const finish = Effect.gen(function*() {
        const journal = yield* Journal
        const runs = yield* RunStore.RunStore
        return yield* journal.transact(Effect.gen(function*() {
          const receipt = yield* journal.emitDurable({
            runId, sourceId, sourceSeq: 7 as SourceSeq,
            eventType: "run.finished", payload: { outcome: "succeeded" }
          }, owner)
          const result = yield* runs.transitionOwned(runId, owner, "completed")
          if (result._tag !== "Transitioned") return yield* Effect.fail(result)
          return receipt
        }))
      })
      const receipt = yield* finish
      expect(receipt._tag).toBe("Accepted")
      expect((yield* runs.get(runId)).status).toBe("completed")
      expect((yield* rowsOf(sql, runId)).map((entry) => entry.event_type)).toEqual(["run.finished"])
    }))
  )

  effect("rolls the lifecycle entry back with the state write it describes", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-rollback")

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
        yield* journal.emitDurableUnfenced(
          input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "created" })
        )
        return yield* Effect.fail(new Rejected("state transition rejected after the WAL append"))
      })).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      const missing = yield* runs.get(run).pipe(Effect.flip)
      const rows = yield* rowsOf(sql, run)
      // Journal/state equivalence: neither half of the pair survives.
      expect(missing.code).toBe("not_found_row")
      expect(rows).toHaveLength(0)
    })))

  effect("settles a nested transaction once, at the outermost commit", () =>
    withStack(Effect.gen(function*() {
      const journal = yield* Journal
      const runs = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const run = runId("atomic-nested")
      const subscription = yield* journal.changes

      const exit = yield* journal.transact(Effect.gen(function*() {
        yield* runs.create(run, "{}")
        yield* journal.transact(
          journal.emitDurableUnfenced(
            input(run, sourceId("driver"), "flows.engine.run-decision", { decision: "nested" })
          )
        )
        return yield* Effect.fail(new Rejected("outer rejected after the inner append"))
      })).pipe(Effect.exit)

      // The inner transaction is a savepoint of the outer one, so the outer
      // rollback takes the inner append with it — and nothing was published.
      expect(exit._tag).toBe("Failure")
      expect(yield* PubSub.remaining(subscription)).toBe(0)
      expect(yield* rowsOf(sql, run)).toHaveLength(0)
    })))
})
