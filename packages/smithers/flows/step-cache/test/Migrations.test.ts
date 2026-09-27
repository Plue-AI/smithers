/**
 * The step cache owns `flows_step_cache` and reserves migration id block
 * 2000 — see the journal architecture at
 * https://smithers.sh/concepts/journal.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as Initial from "../src/migrations/0001_initial.ts"
import * as CreatedAtIndex from "../src/migrations/0002_created_at_index.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

describe("step-cache migrations", () => {
  it.effect("opens the earlier RC sweep-index history without changing cache or run receipts", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* DatabaseMigrations.run([{
        namespace: "step-cache",
        idOffset: 2000,
        migrations: {
          "0001_initial": Initial.initial,
          "0002_sweep_indexes": Effect.gen(function*() {
            yield* sql`CREATE INDEX flows_step_cache_created_at_idx ON flows_step_cache (created_at_ms)`
            yield* sql`CREATE INDEX flows_step_cache_recorded_created_at_idx
              ON flows_step_cache_recorded (created_at_ms)`
          })
        }
      }, {
        namespace: "later",
        idOffset: 3000,
        migrations: { "0001_initial": Effect.void }
      }])
      for (const table of ["flows_step_cache", "flows_step_cache_recorded"]) {
        yield* sql`INSERT INTO ${sql(table)} VALUES ('key', '{"answer":42}', '{}', 123, 'run-existing', 7)`
      }
      const before = yield* sql`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
      expect(yield* Migrations.run).toEqual([])
      expect(yield* Migrations.run).toEqual([])
      expect(yield* sql`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`).toEqual(before)
      for (const table of ["flows_step_cache", "flows_step_cache_recorded"]) {
        expect(yield* sql`SELECT result_json, recorded_run_id, recorded_event_seq FROM ${sql(table)}`).toEqual([
          { result_json: "{\"answer\":42}", recorded_run_id: "run-existing", recorded_event_seq: 7 }
        ])
        const plan = yield* TestDatabase.explain(sql, sql`DELETE FROM ${sql(table)} WHERE created_at_ms < ${10}`)
        expect(plan.map((row) => row.detail).join("\n")).toContain(`${table}_created_at_idx`)
      }
    }).pipe(Effect.provide(TestDatabase.layer)))

  // The CommonJS build converts every module with esbuild under `"type":
  // "module"`, where a default import of a sibling resolves to the sibling's
  // whole exports object rather than the Effect it exported. A migration
  // module therefore exports a named binding and never a default, and the
  // set holds Effects however the package was built.
  it("holds an Effect under every migration id", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.map(([id]) => id)).toEqual(["0001_initial", "0002_created_at_index"])
    for (const [, migration] of entries) {
      expect(Effect.isEffect(migration)).toBe(true)
      expect(typeof migration.pipe).toBe("function")
    }
    expect(Migrations.set.migrations["0001_initial"]).toBe(Initial.initial)
    expect(Migrations.set.migrations["0002_created_at_index"]).toBe(CreatedAtIndex.createdAtIndex)
  })

  it("exports each migration as a named binding and never as a default", () => {
    expect("default" in Initial).toBe(false)
    expect(Object.keys(Initial)).toEqual(["initial"])
    expect(Effect.isEffect(Initial.initial)).toBe(true)
    expect("default" in CreatedAtIndex).toBe(false)
    expect(Object.keys(CreatedAtIndex)).toEqual(["createdAtIndex"])
  })

  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("sweepExpired's age predicate reads an index on both tables", () =>
    Effect.gen(function*() {
      const plans = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const head = yield* TestDatabase.explain(sql, sql`DELETE FROM flows_step_cache WHERE created_at_ms < ${10}`)
        const ledger = yield* TestDatabase.explain(
          sql,
          sql`SELECT key_digest FROM flows_step_cache_recorded WHERE created_at_ms < ${10}`
        )
        return [head, ledger].map((rows) => rows.map((row) => row.detail).join("\n"))
      }))
      expect(plans[0]).toContain("flows_step_cache_created_at_ms")
      expect(plans[1]).toContain("flows_step_cache_recorded_created_at_ms")
    }))

  it.effect("creates the head table, the recorded ledger, their expiry indexes, and nothing else", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM ${
          TestDatabase.catalog(sql)
        } WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_migrations",
        "flows_step_cache",
        "flows_step_cache_recorded"
      ])
      for (const table of ["flows_step_cache", "flows_step_cache_recorded"]) {
        const cacheSql = master.find((row) => row.name === table)?.sql ?? ""
        expect(cacheSql).toContain("length(key_digest) > 0")
        expect(cacheSql).toMatch(/json_valid\(result_json\)|result_json IS JSON/)
        expect(cacheSql).toMatch(/json_valid\(meta_json\)|meta_json IS JSON/)
        expect(cacheSql).toMatch(/typeof\(created_at_ms\) = 'integer'|trunc\(created_at_ms\)/)
        expect(cacheSql).toContain("length(recorded_run_id) > 0")
        expect(cacheSql).toMatch(/typeof\(recorded_event_seq\) = 'integer'|trunc\(recorded_event_seq\)/)
      }
      const ledgerSql = master.find((row) => row.name === "flows_step_cache_recorded")?.sql ?? ""
      expect(ledgerSql).toContain("PRIMARY KEY (key_digest, recorded_run_id, recorded_event_seq)")
      expect(
        master.filter((row) => row.type === "index" && row.sql !== null).map((row) =>
          row.sql?.replace(/\s+/g, " ").replace(/test_[a-z0-9]+\./g, "").replace(" USING btree", "")
        )
          .sort()
      ).toEqual([
        "CREATE INDEX flows_step_cache_created_at_ms ON flows_step_cache (created_at_ms)",
        "CREATE INDEX flows_step_cache_recorded_created_at_ms ON flows_step_cache_recorded (created_at_ms)"
      ])
    }))

  it.effect("reserves its own migration id block so ids cannot collide", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([[2001, "step-cache_initial"], [2002, "step-cache_created_at_index"]])
    }))

  it.effect("enforces every cache row invariant at the schema boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const invalidRows = [
          "('', '{}', '{}', 0, 'run', 0)",
          "('bad-result', 'not-json', '{}', 0, 'run', 0)",
          "('bad-meta', '{}', 'not-json', 0, 'run', 0)",
          "('negative-created', '{}', '{}', -1, 'run', 0)",
          "('fractional-created', '{}', '{}', 0.5, 'run', 0)",
          "('unsafe-created', '{}', '{}', 9007199254740992, 'run', 0)",
          "('empty-run', '{}', '{}', 0, '', 0)",
          "('negative-seq', '{}', '{}', 0, 'run', -1)",
          "('fractional-seq', '{}', '{}', 0, 'run', 0.5)",
          "('unsafe-seq', '{}', '{}', 0, 'run', 9007199254740992)"
        ] as const
        return yield* Effect.forEach(invalidRows, (values) =>
          Effect.exit(sql.unsafe(
            `INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ${values}`
          )))
      }))

      expect(outcomes.every(Exit.isFailure)).toBe(true)
    }))
})
