import * as Dialect from "@smthrs/database/Dialect"
/**
 * `Retention.collect`, the host-facing pass `smithers gc` runs over one file.
 *
 * The operation itself — the bounded pass over the engine ladder inside one
 * `journal.transact` — is pinned in `Retention.test.ts`. What is pinned here
 * is the facade `gc` calls: a terminal run older than the threshold goes with
 * every row that names it, a live run stays, a run a live run stands above or
 * below stays over BOTH lineage relations, a table this database does not have
 * is skipped, and a dry run reports without writing.
 *
 * The requirement is the release policy, Retention.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as Migrations from "../src/Migrations.ts"
import * as Retention from "../src/Retention.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

const insertRun = (
  runId: string,
  status: string,
  finishedAtMs: number | null,
  parentRunId?: string
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const owner = status === "running"
      ? { owner_host_id: "host", owner_pid: 1, owner_nonce: "nonce", heartbeat_at_ms: 1 }
      : { owner_host_id: null, owner_pid: null, owner_nonce: null, heartbeat_at_ms: null }
    yield* sql`INSERT INTO flows_runs ${
      sql.insert({
        run_id: runId,
        status,
        created_at_ms: 1,
        started_at_ms: 1,
        finished_at_ms: finishedAtMs,
        ...owner,
        parent_run_id: parentRunId ?? null,
        state_json: "{}"
      })
    }`
  })

const insertEdge = (childId: string, parentId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS flows_run_parents (
      child_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      PRIMARY KEY (child_id, parent_id)
    )`
    yield* sql`INSERT INTO flows_run_parents ${sql.insert({ child_id: childId, parent_id: parentId, seq: 0 })}`
  })

const insertAttempt = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_attempts ${
      sql.insert({
        run_id: runId,
        step_key_digest: `digest-${runId}`,
        attempt: 0,
        state: "completed",
        started_at_ms: 1,
        meta_json: "{}"
      })
    }`
  })

const insertEvent = (runId: string, seq: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_journal_events ${
      sql.insert({
        run_id: runId,
        seq,
        event_id: `${runId}-${seq}`,
        source_id: "source",
        source_seq: seq,
        emitted_at_ms: 1,
        event_type: "run.started",
        payload_json: "{}",
        meta_json: "{}"
      })
    }`
  })

const count = (table: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM ${sql.literal(table)}`
    return rows[0]?.total ?? 0
  })

const seedTimeTravelReceipt = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_audits (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL
    )`
    yield* sql`CREATE TABLE IF NOT EXISTS flows_time_travel_receipts (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL
    )`
    yield* sql`INSERT INTO flows_time_travel_audits ${sql.insert({ id: `audit-${runId}`, run_id: runId })}`
    yield* sql`INSERT INTO flows_time_travel_receipts ${
      sql.insert({
        id: `receipt-${runId}`,
        audit_id: `audit-${runId}`,
        effect_id: `effect-${runId}`,
        receipt_json: "{}"
      })
    }`
  })

const receiptIds = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly id: string }>`SELECT id FROM flows_time_travel_receipts ORDER BY id`
  return rows.map((row) => row.id)
})

describe("Retention.collect", () => {
  for (const dryRun of [false, true]) {
    it.effect(`scans lineage inside the transaction (dryRun=${dryRun})`, () =>
      migrated(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* insertRun("old-result", "completed", 100)
        yield* insertRun("live-parent", "suspended", null)
        yield* insertAttempt("old-result")
        yield* insertEvent("old-result", 0)
        let opened = false
        const wrapped = new Proxy(sql, {
          get(target, property) {
            if (property !== "withTransaction") return Reflect.get(target, property)
            return <A, E, R>(body: Effect.Effect<A, E, R>) =>
              Effect.gen(function*() {
                if (!opened) {
                  opened = true
                  // Another writer attaches the result immediately before BEGIN.
                  // The eligibility SELECT must not have happened yet.
                  yield* insertEdge("old-result", "live-parent")
                }
                return yield* sql.withTransaction(body)
              })
          }
        })
        const report = yield* Retention.collect({ olderThanMs: 500, dryRun }).pipe(
          Effect.provideService(SqlClient.SqlClient, wrapped)
        )
        expect(opened).toBe(true)
        expect(report.runs).toEqual([])
        expect(yield* count("flows_runs")).toBe(2)
        expect(yield* count("flows_attempts")).toBe(1)
        expect(yield* count("flows_journal_events")).toBe(1)
        expect(yield* count("flows_run_parents")).toBe(1)
      })))
  }

  it.live("recomputes eligibility after a busy transaction rolls back", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old-result", "completed", 100)
      yield* insertRun("live-parent", "pending", null)
      yield* insertAttempt("old-result")
      yield* insertEvent("old-result", 0)
      let attempts = 0
      const wrapped = new Proxy(sql, {
        get(target, property) {
          if (property !== "withTransaction") return Reflect.get(target, property)
          return <A, E, R>(body: Effect.Effect<A, E, R>) =>
            Effect.gen(function*() {
              attempts++
              if (attempts === 2) yield* insertEdge("old-result", "live-parent")
              return yield* sql.withTransaction(body.pipe(Effect.tap(() =>
                attempts === 1
                  ? Effect.fail(
                    new SqlError.SqlError({
                      reason: SqlError.classifySqliteError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))
                    })
                  )
                  : Effect.void
              )))
            })
        }
      })
      const report = yield* Retention.collect({ olderThanMs: 500 }).pipe(
        Effect.provideService(SqlClient.SqlClient, wrapped)
      )
      expect(attempts).toBe(2)
      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
      expect(yield* count("flows_attempts")).toBe(1)
      expect(yield* count("flows_journal_events")).toBe(1)
    })))

  it.effect("reports a transaction failure without deleting history", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old-result", "completed", 100)
      const wrapped = new Proxy(sql, {
        get(target, property) {
          if (property !== "withTransaction") return Reflect.get(target, property)
          return () =>
            Effect.fail(
              new SqlError.SqlError({
                reason: SqlError.classifySqliteError(Object.assign(new Error("I/O failure"), { code: "SQLITE_IOERR" }))
              })
            )
        }
      })
      const failure = yield* Retention.collect({ olderThanMs: 500 }).pipe(
        Effect.provideService(SqlClient.SqlClient, wrapped),
        Effect.flip
      )
      expect(failure).toMatchObject({
        _tag: "@smthrs/engine-store/RetentionError",
        code: "delete_failed",
        cause: { code: "io" }
      })
      expect(yield* count("flows_runs")).toBe(1)
    })))

  it.effect("leaves the schema and SQL change count untouched in a dry run", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old-result", "completed", 100)
      // The driver's BEGIN IMMEDIATE reserves a write lock even for reads, so
      // PRAGMA query_only would reject the transaction before the pass runs.
      // Check persisted changes and both schemas, not the lock mode it uses.
      const changes = yield* sql.onDialectOrElse({
        pg: () => sql`SELECT * FROM flows_runs ORDER BY run_id`,
        orElse: () => sql`SELECT total_changes() AS total`
      })
      const schema = yield* sql`SELECT name, sql FROM ${TestDatabase.catalog(sql)} ${
        sql.literal(sql.onDialectOrElse({
          pg: () => "",
          orElse: () => "UNION ALL SELECT name, sql FROM sqlite_temp_master"
        }))
      }`
      const report = yield* Retention.collect({ olderThanMs: 500, dryRun: true })
      expect(report.runs).toEqual(["old-result"])
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(1)
      expect(
        yield* sql.onDialectOrElse({
          pg: () => sql`SELECT * FROM flows_runs ORDER BY run_id`,
          orElse: () => sql`SELECT total_changes() AS total`
        })
      ).toEqual(changes)
      expect(
        yield* sql`SELECT name, sql FROM ${TestDatabase.catalog(sql)} ${
          sql.literal(sql.onDialectOrElse({
            pg: () => "",
            orElse: () => "UNION ALL SELECT name, sql FROM sqlite_temp_master"
          }))
        }`
      )
        .toEqual(schema)
    })))

  it.effect("counts and deletes receipts through doomed audits while preserving live receipts", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old", "completed", 100)
      yield* insertRun("live", "running", null)
      yield* seedTimeTravelReceipt("old")
      yield* seedTimeTravelReceipt("live")

      const planned = yield* RetentionOps.deleteRuns(
        sql,
        [{ runId: "old", parentRunId: null }],
        { dryRun: true, assumeLadder: false }
      )
      expect(planned.deleted["flows_time_travel_receipts"]).toBe(1)
      expect(yield* receiptIds).toEqual(["receipt-live", "receipt-old"])

      const report = yield* Retention.collect({ olderThanMs: 500 })
      expect(report.deleted["flows_time_travel_receipts"]).toBe(1)
      expect(yield* receiptIds).toEqual(["receipt-live"])
    })))

  it.effect("deletes a terminal run older than the threshold with every row that names it", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)
      yield* insertAttempt("old")
      yield* insertEvent("old", 0)
      yield* insertRun("recent", "completed", 900)
      yield* insertAttempt("recent")

      const report = yield* Retention.collect({ olderThanMs: 500, database: ".flows/engine.db" })

      expect(report.runs).toEqual(["old"])
      expect(report.dryRun).toBe(false)
      expect(report.database).toBe(".flows/engine.db")
      expect(report.deleted["flows_runs"]).toBe(1)
      expect(report.deleted["flows_attempts"]).toBe(1)
      expect(report.deleted["flows_journal_events"]).toBe(1)
      expect(yield* count("flows_runs")).toBe(1)
      expect(yield* count("flows_attempts")).toBe(1)
      expect(yield* count("flows_journal_events")).toBe(0)
    })))

  it.effect("bounds the host-facing default pass to one thousand runs", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      for (let offset = 0; offset < 1_001; offset += 200) {
        const rows = Array.from({ length: Math.min(200, 1_001 - offset) }, (_, index) => ({
          run_id: `aged-${String(offset + index).padStart(4, "0")}`,
          status: "completed",
          created_at_ms: 1,
          started_at_ms: 1,
          finished_at_ms: offset + index + 1,
          state_json: "{}"
        }))
        yield* sql`INSERT INTO flows_runs ${sql.insert(rows)}`
      }

      const first = yield* Retention.collect({ olderThanMs: 2_000 })
      expect(first.runs).toHaveLength(1_000)
      expect(yield* count("flows_runs")).toBe(1)
      expect((yield* Retention.collect({ olderThanMs: 2_000 })).runs).toEqual(["aged-1000"])
      expect(yield* count("flows_runs")).toBe(0)
    })))

  it.effect("keeps a run that has not finished, whatever its age", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("live", "running", null)
      yield* insertRun("waiting", "suspended", null)

      const report = yield* Retention.collect({ olderThanMs: Number.MAX_SAFE_INTEGER })

      expect(report.runs).toEqual([])
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a terminal parent whose descendant is still running", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("parent", "completed", 100)
      yield* insertRun("child", "running", null, "parent")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a terminal parent whose spawned child is still running", () =>
    migrated(Effect.gen(function*() {
      // A spawned child records its parent as a `flows_run_parents` edge and
      // leaves `parent_run_id` NULL. A guard that walked only the column read
      // this pair as unrelated and collected the parent out from under a live
      // child; the facade walks both relations.
      yield* insertRun("spawner", "completed", 100)
      yield* insertRun("spawned", "running", null)
      yield* insertEdge("spawned", "spawner")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a settled child a parked parent can still await", () =>
    migrated(Effect.gen(function*() {
      // Upward: `agent/await` answers out of the child's run row, and a parent
      // parked on an approval can be parked for longer than the threshold
      // before it ever asks.
      yield* insertRun("parked", "suspended", null)
      yield* insertRun("settled", "completed", 100)
      yield* insertEdge("settled", "parked")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("collects a terminal parent once its descendant is terminal too", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("parent", "completed", 100)
      yield* insertRun("child", "cancelled", 200, "parent")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect([...report.runs].sort()).toEqual(["child", "parent"])
      expect(yield* count("flows_runs")).toBe(0)
    })))

  it.effect("keeps a terminal parent whose terminal child is younger than the threshold", () =>
    migrated(Effect.gen(function*() {
      // No lineage filter holds this parent back: the child is terminal, so it
      // is neither live nor under a live run. It is simply inside the
      // retention window, and its row still names the parent, so deleting the
      // parent breaks the foreign key. It becomes collectable with the child.
      yield* insertRun("parent", "completed", 100)
      yield* insertRun("child", "completed", 900, "parent")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("names the runs a pass would collect without touching them", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)
      yield* insertRun("recent", "completed", 900)

      expect(yield* Retention.eligible(500)).toEqual(["old"])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("sweeps a table beyond the engine ladder that this database does have", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old", "completed", 100)
      yield* sql`CREATE TABLE control_run_messages (run_id TEXT NOT NULL)`
      yield* sql`INSERT INTO control_run_messages ${sql.insert({ run_id: "old" })}`

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.deleted["control_run_messages"]).toBe(1)
      expect(yield* count("control_run_messages")).toBe(0)
    })))

  it.effect("rolls back rather than half-deleting when a table refuses", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old", "completed", 100)
      yield* insertAttempt("old")
      yield* insertEvent("old", 0)
      // A table of the inventory this database does have, whose delete cannot
      // succeed. The attempts and the journal are swept before it, so without
      // one transaction around the pass a refusal here destroyed history it
      // could not put back, and left the workspace refusing the same way on
      // every later sweep.
      yield* sql`CREATE TABLE control_runs (run_id TEXT NOT NULL)`
      yield* sql`INSERT INTO control_runs ${sql.insert({ run_id: "old" })}`
      yield* Dialect.trigger(sql, {
        name: `control_runs_refuse`,
        table: `control_runs`,
        event: `BEFORE DELETE`,
        reject: "refused"
      })

      const exit = yield* Effect.exit(Retention.collect({ olderThanMs: 500 }))

      expect(exit._tag).toBe("Failure")
      expect(yield* count("flows_runs")).toBe(1)
      expect(yield* count("flows_attempts")).toBe(1)
      expect(yield* count("flows_journal_events")).toBe(1)
    })))

  it.effect("falls back to the creation time when a terminal run recorded no finish", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("unfinished", "failed", null)

      expect((yield* Retention.collect({ olderThanMs: 2 })).runs).toEqual(["unfinished"])
    })))

  it.effect("reports without writing under a dry run", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)
      yield* insertAttempt("old")

      const report = yield* Retention.collect({ olderThanMs: 500, dryRun: true })

      expect(report.runs).toEqual(["old"])
      expect(report.dryRun).toBe(true)
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(1)
      expect(yield* count("flows_attempts")).toBe(1)
    })))

  it.effect("skips a table this database does not have", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)

      // The time-travel and control tables are migrated by other packages and
      // are absent here; a host that composed only the engine stores must
      // still get a complete sweep of the ones it has.
      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.deleted["flows_time_travel_archive"]).toBeUndefined()
      expect(report.deleted["control_run_messages"]).toBeUndefined()
      expect(report.deleted["flows_runs"]).toBe(1)
    })))

  it.effect("deletes more runs than one statement may bind at once", () =>
    migrated(Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 501 }, (_, index) => `run-${index}`),
        (runId) => insertRun(runId, "completed", 100),
        { discard: true }
      )

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toHaveLength(501)
      expect(report.deleted["flows_runs"]).toBe(501)
      expect(yield* count("flows_runs")).toBe(0)
    })))

  it.effect("collects a handoff lineage that spans a chunk boundary", () =>
    migrated(Effect.gen(function*() {
      // `flows_runs` carries a self-referential foreign key on `parent_run_id`,
      // and SQLite checks it per row rather than at commit. A handoff parent
      // always sorts before its successor, so a lineage straddling a chunk
      // boundary puts the parent in the chunk that is deleted first. A pass
      // that deleted run rows in age order refused there, AFTER it had already
      // removed the attempts and journal of every eligible run, and every
      // later pass refused the same way.
      const runIds = Array.from({ length: 501 }, (_, index) => `run-${index}`)
      yield* Effect.forEach(runIds, (runId, index) =>
        // Distinct finish times: age is what orders the pass, so the pair below
        // straddles the boundary only if the order is not a tie.
        insertRun(runId, "completed", index + 1, index === 500 ? "run-499" : undefined), { discard: true })
      yield* insertAttempt("run-499")
      yield* insertAttempt("run-500")

      const report = yield* Retention.collect({ olderThanMs: 5000 })

      expect(report.runs).toHaveLength(501)
      expect(report.deleted["flows_runs"]).toBe(501)
      expect(yield* count("flows_runs")).toBe(0)
      expect(yield* count("flows_attempts")).toBe(0)
    })))

  it.effect("makes progress on every pass over a continuation lineage longer than the bound", () =>
    migrated(Effect.gen(function*() {
      // A trampoline parent always finishes before its successor, so an
      // oldest-first window over a lineage longer than the bound held only
      // ancestors, each pinned by the round just outside it. Every pass then
      // deleted nothing and selected the same window again.
      const rounds = ["r0", "r1", "r2", "r3", "r4"]
      yield* Effect.forEach(
        rounds,
        (runId, index) => insertRun(runId, "completed", index + 1, index === 0 ? undefined : rounds[index - 1]),
        { discard: true }
      )
      yield* insertAttempt("r0")

      const remaining = new Set(rounds)
      while (remaining.size > 0) {
        const planned = yield* Retention.collect({ olderThanMs: 1000, limit: 2, dryRun: true })
        const report = yield* Retention.collect({ olderThanMs: 1000, limit: 2 })
        expect(report.runs).toEqual(planned.runs)
        expect(report.runs.length).toBeGreaterThan(0)
        expect(report.runs.length).toBeLessThanOrEqual(2)
        for (const runId of report.runs) expect(remaining.delete(runId)).toBe(true)
        expect(yield* count("flows_runs")).toBe(remaining.size)
      }
      expect(yield* count("flows_attempts")).toBe(0)
    })))

  it.effect("pins a handed candidate whose child is outside the list, and every ancestor of it", () =>
    migrated(Effect.gen(function*() {
      // The candidate query never hands deleteRuns such a list, because a
      // blocked child blocks its ancestors before the bound. deleteRuns still
      // owns the foreign key for whatever list it is given.
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("root", "completed", 100)
      yield* insertRun("middle", "completed", 200, "root")
      yield* insertRun("leaf", "completed", 300, "middle")

      const report = yield* RetentionOps.deleteRuns(
        sql,
        [{ runId: "root", parentRunId: null }, { runId: "middle", parentRunId: "root" }],
        { dryRun: false, assumeLadder: false }
      )

      expect(report.runIds).toEqual([])
      expect([...report.pinned].sort()).toEqual(["middle", "root"])
      expect(yield* count("flows_runs")).toBe(3)
    })))

  it.effect("sweeps compacted journal identities with the run they name", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* insertRun("old", "completed", 100)
      yield* insertRun("recent", "completed", 900)
      for (const runId of ["old", "recent"]) {
        yield* sql`INSERT INTO flows_journal_dedup ${
          sql.insert({
            run_id: runId,
            source_id: "source",
            source_seq: 0,
            event_id: `${runId}-0`,
            seq: 0,
            content_hash: "0".repeat(64)
          })
        }`
      }

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual(["old"])
      expect(report.deleted["flows_journal_dedup"]).toBe(1)
      expect(yield* sql`SELECT run_id FROM flows_journal_dedup`).toEqual([{ run_id: "recent" }])
    })))

  it.effect("accounts for every run-naming table the ladder installs", () =>
    migrated(Effect.gen(function*() {
      // A table that names a run and is in none of these sets is a table
      // retention leaks forever. Listing is deliberate, so this pins the list
      // against the catalog rather than trusting it.
      const sql = yield* SqlClient.SqlClient
      const rows: Array<{ table_name: string; column_name: string }> = []
      for (const table of yield* Dialect.tables(sql)) {
        for (const column of yield* Dialect.columns(sql, table.name)) {
          if (column.name.endsWith("run_id") || ["execution_id", "child_id", "parent_id"].includes(column.name)) {
            rows.push({ table_name: table.name, column_name: column.name })
          }
        }
      }
      const cascades = new Set((yield* sql.onDialectOrElse({
        pg: () =>
          sql<{ table_name: string }>`SELECT rel.relname AS table_name
          FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
          WHERE con.confrelid = 'flows_runs'::regclass AND con.confdeltype = 'c'`,
        orElse: () =>
          sql<{ table_name: string }>`SELECT m.name AS table_name
          FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
          WHERE m.type = 'table' AND f."table" = 'flows_runs' AND f.on_delete = 'CASCADE'`
      })).map((row) => row.table_name))
      const inventory = new Set(Retention.runScopedTables.map((entry) => `${entry.table}.${entry.column}`))
      const exempt = new Set([
        // The run row itself, deleted last in generation order.
        "flows_runs.run_id",
        "flows_runs.parent_run_id",
        // Dropped with each run row by the `flows_run_parents_gc` trigger.
        "flows_run_parents.child_id",
        "flows_run_parents.parent_id",
        // Deletion tombstones the change feed reads after the row is gone.
        "flows_run_changes.run_id",
        // The shared step cache outlives the run that first recorded an entry.
        "flows_step_cache.recorded_run_id"
      ])
      const unaccounted = rows
        .map((row) => `${row.table_name}.${row.column_name}`)
        .filter((key) => !inventory.has(key) && !exempt.has(key) && !cascades.has(key.split(".")[0]!))
      expect(unaccounted).toEqual([])
    })))

  it.effect("reports nothing on a database with no run table at all", () =>
    Effect.gen(function*() {
      const report = yield* Retention.collect({ olderThanMs: 500 }).pipe(Effect.provide(TestDatabase.layer))

      expect(report.runs).toEqual([])
      expect(report.deleted).toEqual({})
    }))

  it.effect("turns invalid host-facing limits into empty, non-mutating passes", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)

      expect(yield* Retention.eligible(500, -1)).toEqual([])
      const report = yield* Retention.collect({ olderThanMs: 500, limit: Number.NaN })
      expect(report.runs).toEqual([])
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(1)
    })))

  it("names the terminal statuses the contract lists", () => {
    expect(Retention.terminalStatuses).toEqual(["completed", "failed", "cancelled"])
  })

  it("carries one table inventory for both passes", () => {
    // The drift this closes: `collect` swept the time-travel and control
    // tables and `retain` did not, so an engine workspace that only ever ran
    // `retain` kept every step-cache and time-travel row of every run it
    // deleted. Both passes read this list now, so a table can only be missed
    // by both at once.
    const tables = Retention.runScopedTables.map((entry) => entry.table)
    expect(tables).toEqual([
      "flows_deferred_completions",
      "flows_clock_deadlines",
      "flows_attempts",
      "flows_journal_events",
      "flows_journal_checkpoints",
      "flows_journal_dedup",
      "flows_step_cache_recorded",
      "flows_time_travel_archive",
      "flows_time_travel_snapshots",
      "flows_time_travel_audits",
      "flows_time_travel_edges",
      "control_run_messages",
      "control_runs"
    ])
    // `ladder` is the one thing the two passes read differently: a table the
    // engine's own migrations install is required of an engine database, and
    // everything else is skipped where the host did not compose it.
    expect(Retention.runScopedTables.filter((entry) => entry.ladder).map((entry) => entry.table)).toEqual([
      "flows_deferred_completions",
      "flows_clock_deadlines",
      "flows_attempts",
      "flows_journal_events",
      "flows_journal_checkpoints",
      "flows_journal_dedup",
      "flows_step_cache_recorded"
    ])
  })

  it("re-exports the operation rather than owning a second one", () => {
    expect(Retention.defaultLimit).toBe(1000)
    expect(typeof Retention.make).toBe("function")
    expect(Retention.Retention.key).toBe("@smthrs/engine-store/Retention")
  })
})
