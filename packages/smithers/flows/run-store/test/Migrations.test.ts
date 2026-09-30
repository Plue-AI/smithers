/**
 * The run store owns `flows_runs` and `flows_attempts` and reserves migration
 * id block 1000. Its runner installs the journal's set first, because the SQL
 * `RunStore` fences through the journal's consensus lease table.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

describe("run-store migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the run and attempt tables and their indexes", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM ${
          TestDatabase.catalog(sql)
        } WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_attempts",
        "flows_consensus_leases",
        "flows_journal_checkpoints",
        "flows_journal_dedup",
        "flows_journal_events",
        "flows_migrations",
        "flows_run_changes",
        "flows_run_source",
        "flows_runs"
      ])
      const indexes = master.filter((row) => row.type === "index").map((row) => row.name)
      expect(indexes).toContain("flows_runs_parent_run_id_idx")
      expect(indexes).toContain("flows_runs_cancel_requested_idx")
      expect(indexes).toContain("flows_runs_waiting_reason_wake_at_idx")
      expect(indexes).toContain("flows_runs_lineage_idx")
      expect(master.find((row) => row.name === "flows_runs_lineage_idx")?.sql).toContain("UNIQUE INDEX")
      const runsSql = master.find((row) => row.name === "flows_runs")?.sql ?? ""
      const attemptsSql = master.find((row) => row.name === "flows_attempts")?.sql ?? ""
      expect(runsSql).toMatch(/status (?:IN|= ANY)/)
      expect(runsSql).toContain("status = 'running'")
      expect(runsSql).toContain("status <> 'running'")
      expect(attemptsSql).toMatch(/FOREIGN KEY \(run_id\) REFERENCES flows_runs ?\(run_id\)/)
    }))

  it.effect("reserves its own migration id block above the journal's so ids cannot collide", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied.map(([id]) => id)).toEqual([1, 2, 3, 4, 5, 6, 1001, 1002, 1003, 1004])
      expect(applied.filter(([id]) => id >= 1000)).toEqual([
        [1001, "run-store_initial"],
        [1002, "run-store_lineage"],
        [1003, "run-store_execution_revisions"],
        [1004, "run-store_waiting_request"]
      ])
    }))

  for (const missing of ["owner_host_id", "owner_pid", "owner_nonce", "heartbeat_at_ms"] as const) {
    it.effect(`rejects a half-populated owner tuple missing ${missing} on the owner CHECK`, () =>
      Effect.gen(function*() {
        const exit = yield* migrated(Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          return yield* Effect.exit(sql`INSERT INTO flows_runs (
            run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
          ) VALUES (
            'run', 'running', 0,
            ${missing === "owner_host_id" ? null : "host"},
            ${missing === "owner_pid" ? null : 1},
            ${missing === "owner_nonce" ? null : "nonce"},
            ${missing === "heartbeat_at_ms" ? null : 0}, '{}'
          )`)
        }))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
          .toMatch(
            /CHECK constraint failed: \(\s*status = 'running' AND\s*owner_host_id IS NOT NULL|violates check constraint/
          )
      }))
  }

  it.effect("accepts a complete owner tuple", () =>
    Effect.gen(function*() {
      const rows = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run', 'running', 0, 'host', 1, 'nonce', 0, '{}')`
        return yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs`
      }))
      expect(rows).toEqual([{ run_id: "run" }])
    }))
})
