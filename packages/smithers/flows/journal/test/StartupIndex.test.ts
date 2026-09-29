import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

const previous = {
  ...Migrations.set,
  migrations: Object.fromEntries(
    Object.entries(Migrations.set.migrations).filter(([id]) => id < "0003_startup_index")
  )
}
const other: DatabaseMigrations.MigrationSet = {
  namespace: "later-package",
  idOffset: 4000,
  migrations: { "0001_initial": Effect.void }
}

describe("journal startup ordering", () => {
  it.effect("upgrades a retained database after higher package migrations and avoids a history sort", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* DatabaseMigrations.run([previous, other])
      yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n < 4999)
      INSERT INTO flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      SELECT CASE WHEN n % 2 = 0 THEN 'run-a' ELSE 'run-b' END, n, 'event-' || n, 'source', n, n / 3, 'event', '{}', 'null' FROM numbers`
      const query = () =>
        sql<{ run_id: string; seq: number; emitted_at_ms: number }>`
      SELECT run_id, seq, emitted_at_ms FROM flows_journal_events
      ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC LIMIT 20`
      const expected = yield* query()
      const before = yield* TestDatabase.explain(
        sql,
        sql`SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json FROM flows_journal_events ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC LIMIT 20`
      )
      expect(before.some((row) => /TEMP B-TREE|Sort/.test(row.detail))).toBe(true)
      expect(yield* DatabaseMigrations.run([Migrations.set, other])).toEqual([
        [3, "journal_startup_index"],
        [4, "journal_dedup"],
        [5, "journal_run_event_type"],
        [6, "journal_consensus"]
      ])
      const after = yield* TestDatabase.explain(
        sql,
        sql`SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json FROM flows_journal_events ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC LIMIT 20`
      )
      expect(after.some((row) => row.detail.includes("flows_journal_events_startup_idx"))).toBe(true)
      expect(after.some((row) => /TEMP B-TREE|Sort/.test(row.detail))).toBe(false)
      expect(yield* query()).toEqual(expected)
      expect(yield* DatabaseMigrations.run([Migrations.set, other])).toEqual([])
      expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_journal_events`)[0]!.count).toBe(5000)
    }).pipe(Effect.provide(TestDatabase.layer)))
})
