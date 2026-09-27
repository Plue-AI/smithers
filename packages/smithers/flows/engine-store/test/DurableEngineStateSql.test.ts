import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { type Ownership } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = {
  hostId: "durable-state",
  pid: 1,
  nonce: "owner"
}

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const insertOwnedRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json
      ) VALUES (
        ${runId},
        'running',
        0,
        ${owner.hostId},
        ${owner.pid},
        ${owner.nonce},
        0,
        '{}'
      )
    `
  })

describe("SQL DurableEngineState", () => {
  it.effect("allocates parent sequences using the global sequence index", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const previous = Migrations.sets.map((set) => ({
        ...set,
        migrations: Object.fromEntries(
          Object.entries(set.migrations).filter(([key]) =>
            !(set.namespace === "engine-store" && key >= "0007_run_parent_sequence")
          )
        )
      }))
      yield* DatabaseMigrations.run(previous)
      const state = yield* DurableEngineState.make
      yield* state.recordRunParent("unrelated-child", "unrelated-parent")
      yield* Migrations.run
      expect(yield* Migrations.run).toEqual([])
      yield* state.recordRunParent("child", "parent")
      const plan = yield* TestDatabase.explain(
        sql,
        sql`SELECT COALESCE(MAX(seq), 0) + 1 FROM flows_run_parents WHERE TRUE
      `
      )
      expect(plan.map((row) => row.detail).join("\n")).toContain("flows_run_parents_seq_idx")
      expect(yield* state.runParents("child")).toEqual([{ childId: "child", parentId: "parent", seq: 2 }])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("upgrades existing completions as unconsumed and persists their first observation", () =>
    withCrypto(
      Effect.gen(function*() {
        const previous = Migrations.sets.map((set) => ({
          ...set,
          migrations: Object.fromEntries(
            Object.entries(set.migrations).filter(([key]) =>
              !(set.namespace === "engine-store" && key >= "0008_deferred_consumption")
            )
          )
        }))
        yield* DatabaseMigrations.run(previous)
        yield* insertOwnedRun("pre-consumption-migration")
        const first = yield* DurableEngineState.make
        const row = {
          flowName: "DurableState/Upgrade",
          executionId: "pre-consumption-migration",
          deferredName: "answer",
          exit: Exit.succeed("legacy"),
          completedAtMs: 10
        }
        yield* first.completeDeferred(row)
        yield* Migrations.run
        expect(yield* Migrations.run).toEqual([])
        const upgraded = yield* DurableEngineState.make
        expect(yield* upgraded.completedDeferreds(row.flowName)).toHaveLength(1)
        yield* upgraded.consumeDeferred(row, 20)
        const restarted = yield* DurableEngineState.make
        yield* restarted.consumeDeferred(row, 30)
        yield* restarted.completeDeferred({ ...row, exit: Exit.succeed("duplicate") })
        expect(yield* restarted.completedDeferreds(row.flowName)).toEqual([])
        expect(Option.getOrThrow(yield* restarted.deferred(row)).exit).toEqual(Exit.succeed("legacy"))
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT consumed_at_ms FROM flows_deferred_completions`).toEqual([{ consumed_at_ms: 20 }])
      }).pipe(Effect.provide(TestDatabase.layer))
    ))

  it.effect("preserves the first deferred completion across competing services", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("deferred-race")
          const first = yield* DurableEngineState.make
          const second = yield* DurableEngineState.make
          const address = {
            flowName: "DurableState/Flow",
            executionId: "deferred-race",
            deferredName: "answer"
          }
          const outcomes = yield* Effect.all([
            first.completeDeferred({
              ...address,
              exit: Exit.succeed("left"),
              metadata: { writer: "left" },
              completedAtMs: 10
            }),
            second.completeDeferred({
              ...address,
              exit: Exit.succeed("right"),
              metadata: { writer: "right" },
              completedAtMs: 11
            })
          ], { concurrency: "unbounded" })
          return {
            outcomes,
            row: Option.getOrThrow(yield* first.deferred(address)),
            completed: yield* second.completedDeferreds(address.flowName)
          }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result.outcomes.map((outcome) => outcome._tag).sort()).toEqual([
        "Completed",
        "Existing"
      ])
      expect(result.outcomes[0]!.row).toEqual(result.outcomes[1]!.row)
      const exit = result.row.exit as Exit.Exit<string>
      expect(Exit.isSuccess(exit) && ["left", "right"].includes(exit.value)).toBe(true)
      expect(result.completed).toEqual([{
        flowName: "DurableState/Flow",
        executionId: "deferred-race",
        deferredName: "answer"
      }])
    }))

  it.effect("fences clock creation and completes a deadline with one compare-and-set winner", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("clock-race")
          const first = yield* DurableEngineState.make
          const second = yield* DurableEngineState.make
          const clock = {
            flowName: "DurableState/Flow",
            executionId: "clock-race",
            clockName: "wake",
            deferredName: "DurableClock/wake",
            dueAtMs: 100,
            completedAtMs: null
          }
          const scheduled = yield* first.scheduleClock(clock, owner)
          const duplicate = yield* second.scheduleClock(
            { ...clock, dueAtMs: 200 },
            owner
          )
          const stale = yield* Effect.exit(first.scheduleClock(
            { ...clock, clockName: "stale" },
            { ...owner, nonce: "stale" }
          ))
          const completions = yield* Effect.all([
            first.completeClock(clock, 100),
            second.completeClock(clock, 101)
          ], { concurrency: "unbounded" })
          return {
            scheduled,
            duplicate,
            stale,
            completions,
            row: Option.getOrThrow(yield* first.clock(clock)),
            due: yield* first.dueClocks(Number.MAX_SAFE_INTEGER)
          }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result.scheduled._tag).toBe("Scheduled")
      expect(result.duplicate).toMatchObject({
        _tag: "Existing",
        row: { dueAtMs: 100 }
      })
      expect(Exit.isFailure(result.stale) && Cause.hasInterruptsOnly(result.stale.cause)).toBe(true)
      expect(result.completions.map((outcome) => outcome._tag).sort()).toEqual([
        "AlreadyCompleted",
        "Completed"
      ])
      expect([100, 101]).toContain(result.row.completedAtMs)
      expect(result.due).toEqual([])
    }))

  it.effect("answers attempt survivors with one range read: none when fresh, earliest plus contiguous latest when pruned (issue #77)", () =>
    Effect.gen(function*() {
      const insertAttempt = (attempt: number, startedAtMs: number) =>
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`
          INSERT INTO flows_attempts (
            run_id, step_key_digest, attempt, state, started_at_ms, meta_json
          ) VALUES (
            'survivors-run', 'digest-a', ${attempt}, 'failed', ${startedAtMs}, '{}'
          )
        `
        })
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun("survivors-run")
          const state = yield* DurableEngineState.make
          const survivors = state.attemptSurvivors!
          const fresh = yield* survivors("survivors-run", "digest-a")
          // Retention pruned attempt 1; 2..3 survive contiguously, 5 is beyond
          // a gap and must not extend the resumed counter.
          yield* insertAttempt(2, 20)
          yield* insertAttempt(3, 30)
          yield* insertAttempt(5, 50)
          const pruned = yield* survivors("survivors-run", "digest-a")
          const otherKey = yield* survivors("survivors-run", "digest-b")
          return { fresh, pruned, otherKey }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Option.isNone(result.fresh)).toBe(true)
      expect(Option.isNone(result.otherKey)).toBe(true)
      expect(Option.getOrThrow(result.pruned)).toEqual({ earliestAttempt: 2, earliestStartedAtMs: 20, latest: 3 })
    }))

  it.effect("creates the partial index the stale-running sweep's per-tick query needs (issue #79)", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* DurableEngineState.make
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${TestDatabase.catalog(sql)}
          WHERE type = 'index' AND tbl_name = 'flows_runs'
        `
          return indexes.map((row) => row.name)
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result).toContain("flows_runs_stale_running_idx")
    }))
})
