/**
 * The journal owns exactly one table family. The composed whole-schema
 * assertion — every table every storage package contributes — lives with the
 * composition, in `@smthrs/engine-store`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly type: "index" | "table" | "trigger"
  readonly sql: string | null
}

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

describe("journal migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the journal tables and nothing else", () =>
    Effect.gen(function*() {
      const master = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        return yield* sql<SqliteMasterRow>`SELECT name, type, sql FROM ${
          TestDatabase.catalog(sql)
        } WHERE name LIKE 'flows_%'`
      }))

      expect(master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_journal_checkpoints",
        "flows_journal_dedup",
        "flows_journal_events",
        "flows_migrations"
      ])
      expect(master.some((row) => row.name === "flows_journal_events_event_type_idx" && row.type === "index")).toBe(
        true
      )
      const journalSql = master.find((row) => row.name === "flows_journal_events")?.sql ?? ""
      expect(journalSql).toContain("PRIMARY KEY (run_id, seq)")
      expect(journalSql).toContain("UNIQUE (run_id, source_id, source_seq)")
      expect(master.some((row) => row.name === "flows_journal_dedup_insert_guard" && row.type === "trigger")).toBe(true)
      expect(master.some((row) => row.name === "flows_journal_events_run_event_type_idx" && row.type === "index")).toBe(
        true
      )
      const dedupSql = master.find((row) => row.name === "flows_journal_dedup")?.sql ?? ""
      expect(dedupSql).toContain("PRIMARY KEY (run_id, source_id, source_seq)")
      expect(dedupSql).toContain("content_hash")
      const checkpointSql = master.find((row) => row.name === "flows_journal_checkpoints")?.sql ?? ""
      expect(checkpointSql).toContain("PRIMARY KEY (run_id, seq)")
      expect(checkpointSql).toContain("compacted_at_ms")
    }))

  it.effect("namespaces its migration identity by package", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([[1, "journal_initial"], [2, "journal_checkpoints"], [3, "journal_startup_index"], [
        4,
        "journal_dedup"
      ], [5, "journal_run_event_type"]])
    }))
})
