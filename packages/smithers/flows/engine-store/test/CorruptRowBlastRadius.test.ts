/**
 * The blast radius of a corrupt row must be that row.
 *
 * `completedDeferreds` and `pendingClocks` learned this the expensive way
 * (issue B-08): decoding a whole batch through `Effect.orDie` made one
 * unreadable row fatal for every row beside it, and both are swept by
 * `register`, so a single bad row killed every registration of that flow.
 * `dueClocks`, `waitingRuns`, `runParents`, and `runChildren` are the same
 * shape — enumerations whose caller wants the rows it can act on — and each
 * had the same failure mode, with its own outage: no timer in the store
 * fires, no parked run is ever swept, no cycle check can read a run's
 * ancestry, and no cancellation reaches a child.
 *
 * Point reads (`deferred`, `clock`, `waiting`) are deliberately excluded and
 * still die: they answer a question about ONE row, and reporting "no such
 * row" for a row that exists but will not decode would re-run work whose
 * side effects already happened.
 *
 * Every corrupt row here is written straight through SQL because that is the
 * only way to produce the shape — the service's own writers cannot emit one,
 * and the point is what the reader does with a row it did not write. A BLOB
 * satisfies each column's `length(...) > 0` check and its TEXT affinity —
 * SQLite does not coerce a blob — and fails the row schema, which is what a
 * page-level corruption or a foreign writer leaves behind.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)

const flowName = "CorruptRow/Flow"

/** What one read returned, and the storage-integrity warnings it emitted. */
interface Read<A> {
  readonly value: A
  readonly warnings: ReadonlyArray<string>
}

/** Seeds rows and reads them back through the real SQL service. */
const read = <A>(
  body: (
    sql: SqlClient.SqlClient,
    state: DurableEngineState.Service
  ) => Effect.Effect<A>
): Effect.Effect<Read<A>, unknown> => {
  const logs: Array<string> = []
  const capture = Logger.make((options) => {
    logs.push(String(options.message))
  })
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const state = yield* DurableEngineState.make
        const value = yield* body(sql, state)
        return {
          value,
          warnings: logs.filter((message) => message.includes("malformed"))
        }
      }).pipe(
        Effect.provide(migratedDatabase),
        Effect.provide(Logger.layer([capture]))
      )
    )
  )
}

/** A parked run row, so a clock row has a live run to hang off. */
const seedRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql`
    INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
    VALUES (${runId}, 'suspended', 0, '{}')
  `.pipe(Effect.orDie, Effect.asVoid)

describe("a corrupt row costs its own row and nothing else", () => {
  it.effect("dueClocks fires every readable timer beside an unreadable one", () =>
    Effect.gen(function*() {
      const result = yield* read((sql, state) =>
        Effect.gen(function*() {
          yield* seedRun(sql, "readable-run")
          yield* seedRun(sql, "corrupt-run")
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${flowName}, 'readable-run', 'readable-clock', 'answer', 10, NULL)
          `.pipe(Effect.orDie)
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${flowName}, 'corrupt-run', x'00ff', 'answer', 10, NULL)
          `.pipe(Effect.orDie)
          return yield* state.dueClocks(1000)
        })
      )

      expect(result.value.map((row) => row.clockName)).toEqual(["readable-clock"])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("clock deadline")
      expect(result.warnings[0]).toContain("corrupt-run")
    }))

  it.effect("waitingRuns sweeps every readable parked run beside an unreadable one", () =>
    Effect.gen(function*() {
      const result = yield* read((sql, state) =>
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO flows_runs
              (run_id, status, created_at_ms, waiting_reason, waiting_wake_at_ms, state_json)
            VALUES ('readable-run', 'suspended', 0, 'timer', 10, '{}')
          `.pipe(Effect.orDie)
          yield* sql`
            INSERT INTO flows_runs
              (run_id, status, created_at_ms, waiting_reason, waiting_wake_at_ms, state_json)
            VALUES ('corrupt-run', 'suspended', 0, x'00ff', 20, '{}')
          `.pipe(Effect.orDie)
          return yield* state.waitingRuns()
        })
      )

      expect(result.value.map((row) => row.runId)).toEqual(["readable-run"])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("waiting run")
      expect(result.warnings[0]).toContain("corrupt-run")
    }))

  it.effect("runParents lists every readable parent edge beside an unreadable one", () =>
    Effect.gen(function*() {
      const result = yield* read((sql, state) =>
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO flows_run_parents (child_id, parent_id, seq)
            VALUES ('child-run', 'readable-parent', 1)
          `.pipe(Effect.orDie)
          yield* sql`
            INSERT INTO flows_run_parents (child_id, parent_id, seq)
            VALUES ('child-run', x'00ff', 2)
          `.pipe(Effect.orDie)
          return yield* state.runParents("child-run")
        })
      )

      expect(result.value.map((edge) => edge.parentId)).toEqual(["readable-parent"])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("run parent")
      expect(result.warnings[0]).toContain("child-run")
    }))

  it.effect("runChildren lists every readable child edge beside an unreadable one", () =>
    Effect.gen(function*() {
      const result = yield* read((sql, state) =>
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO flows_run_parents (child_id, parent_id, seq)
            VALUES ('readable-child', 'parent-run', 1)
          `.pipe(Effect.orDie)
          yield* sql`
            INSERT INTO flows_run_parents (child_id, parent_id, seq)
            VALUES (x'00ff', 'parent-run', 2)
          `.pipe(Effect.orDie)
          return yield* state.runChildren("parent-run")
        })
      )

      expect(result.value.map((edge) => edge.childId)).toEqual(["readable-child"])
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("run parent")
      expect(result.warnings[0]).toContain("parent-run")
    }))
})
