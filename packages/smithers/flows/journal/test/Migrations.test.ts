/**
 * The journal owns its event, checkpoint, dedup, and consensus-lease tables.
 * The composed whole-schema assertion — every table every storage package
 * contributes — lives with the composition, in `@smthrs/engine-store`.
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
        "flows_consensus_leases",
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
      const leaseSql = master.find((row) => row.name === "flows_consensus_leases")?.sql ?? ""
      expect(leaseSql).toMatch(/run_id TEXT PRIMARY KEY|PRIMARY KEY \(run_id\)/)
      for (const column of ["owner_host_id", "owner_pid", "owner_nonce", "granted_at_ms", "heartbeat_at_ms"]) {
        expect(leaseSql).toContain(column)
      }
      for (const column of ["claim_host_id", "claim_pid", "claim_nonce", "claimed_at_ms"]) {
        expect(leaseSql).toContain(column)
      }
    }))

  it.effect("backfills a lease for every running or claimed run a pre-consensus database holds", () =>
    Effect.gen(function*() {
      const leases = yield* Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // The run rows a database migrated before `0006_consensus` carries:
        // a running owner, a pending claim, a settled run, and a run that is
        // neither. Only the first two hold a fence worth keeping.
        yield* sql`CREATE TABLE flows_runs (
          run_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          owner_host_id TEXT,
          owner_pid INTEGER,
          owner_nonce TEXT,
          heartbeat_at_ms INTEGER,
          claim_host_id TEXT,
          claim_pid INTEGER,
          claim_nonce TEXT,
          claimed_at_ms INTEGER
        )`
        yield* sql`INSERT INTO flows_runs VALUES
          ('running', 'running', 'host-a', 1, 'owner-a', 40, NULL, NULL, NULL, NULL),
          ('claimed', 'pending', NULL, NULL, NULL, NULL, 'host-b', 2, 'owner-b', 50),
          ('settled', 'completed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('idle', 'suspended', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
        yield* Migrations.run
        return yield* sql<{
          readonly run_id: string
          readonly owner_host_id: string | null
          readonly owner_pid: number | null
          readonly owner_nonce: string | null
          readonly granted_at_ms: number | null
          readonly heartbeat_at_ms: number | null
          readonly claim_host_id: string | null
          readonly claim_pid: number | null
          readonly claim_nonce: string | null
          readonly claimed_at_ms: number | null
        }>`SELECT * FROM flows_consensus_leases ORDER BY run_id`
      }).pipe(Effect.provide(TestDatabase.layer))
      expect(leases).toEqual([
        {
          run_id: "claimed",
          owner_host_id: null,
          owner_pid: null,
          owner_nonce: null,
          granted_at_ms: null,
          heartbeat_at_ms: null,
          claim_host_id: "host-b",
          claim_pid: 2,
          claim_nonce: "owner-b",
          claimed_at_ms: 50
        },
        {
          run_id: "running",
          owner_host_id: "host-a",
          owner_pid: 1,
          owner_nonce: "owner-a",
          granted_at_ms: 40,
          heartbeat_at_ms: 40,
          claim_host_id: null,
          claim_pid: null,
          claim_nonce: null,
          claimed_at_ms: null
        }
      ])
    }))

  it.effect("namespaces its migration identity by package", () =>
    Effect.gen(function*() {
      const applied = yield* (Migrations.run.pipe(Effect.provide(TestDatabase.layer)))
      expect(applied).toEqual([
        [1, "journal_initial"],
        [2, "journal_checkpoints"],
        [3, "journal_startup_index"],
        [4, "journal_dedup"],
        [5, "journal_run_event_type"],
        [6, "journal_consensus"]
      ])
    }))
})
