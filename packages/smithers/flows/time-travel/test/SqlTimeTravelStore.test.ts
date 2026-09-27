import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

describe("SqlTimeTravelStore", () => {
  it.effect("archives and truncates attached descendants in one database write", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)

          const store = yield* SqlTimeTravelStore.make
          for (const runId of ["parent", "child", "grandchild", "detached"]) {
            const status = runId === "child" || runId === "grandchild" ? "completed" : "suspended"
            yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, ${status}, 0, '{}')
          `
          }
          // The truncation is owner-fenced: the archive only commits while
          // `flows_runs` records this owner for the run. The run table's
          // CHECK keeps owner columns on `running` rows only.
          yield* sql`
          UPDATE flows_runs
          SET status = 'running',
            owner_host_id = ${owner.hostId}, owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce},
            heartbeat_at_ms = 0
          WHERE run_id = 'parent'
        `
          const journalRows = [
            { runId: "parent", seq: 0 },
            { runId: "parent", seq: 2 },
            { runId: "child", seq: 0 },
            { runId: "grandchild", seq: 0 },
            { runId: "detached", seq: 0 }
          ] as const
          for (const row of journalRows) {
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES (
              ${row.runId},
              ${row.seq},
              ${`${row.runId}-${row.seq}`},
              ${`source-${row.runId}`},
              ${row.seq},
              0,
              'test',
              '{}',
              '{}'
            )
          `
          }
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'child', 'child', 1)
        `
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('child', 0, 'grandchild', 'continuation', 1)
        `
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'detached', 'child', 0)
        `

          const archive = yield* store.archiveAndTruncate(
            "parent",
            { lineageId: "parent/root", seq: 0 },
            [],
            owner
          )
          const remaining = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_journal_events ORDER BY run_id, seq
        `
          const archived = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_time_travel_archive ORDER BY run_id, seq
        `
          const edges = yield* sql<{ readonly child_run_id: string }>`
          SELECT child_run_id FROM flows_time_travel_edges ORDER BY child_run_id
        `
          return { archive, remaining, archived, edges }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.archive.archived).toBe(3)
      expect(result.archive.orphaned.map((edge) => edge.childRunId)).toEqual(["detached"])
      expect(result.remaining).toEqual([
        { run_id: "detached", seq: 0 },
        { run_id: "parent", seq: 0 }
      ])
      expect(result.archived).toEqual([
        { run_id: "child", seq: 0 },
        { run_id: "grandchild", seq: 0 },
        { run_id: "parent", seq: 2 }
      ])
      expect(result.edges).toEqual([{ child_run_id: "detached" }])
    }))

  it.effect("rejects archiveAndTruncate from a superseded owner with fence_lost and truncates nothing", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* SqlTimeTravelStore.make
          yield* sql`
          INSERT INTO flows_runs
            (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
          VALUES ('parent', 'running', 0, '{}',
                  ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
        `
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
             event_type, payload_json, meta_json)
          VALUES ('parent', 2, 'parent-2', 'source-parent', 2, 0, 'test', '{}', '{}')
        `
          // A live successor takes the run before the superseded rewinder's
          // archive commits.
          yield* sql`
          UPDATE flows_runs
          SET owner_host_id = 'host-b', owner_pid = 4321, owner_nonce = 'nonce-b'
          WHERE run_id = 'parent'
        `
          const failure = yield* Effect.flip(
            store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [], owner)
          )
          const remaining = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = 'parent'
        `
          const archived = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_time_travel_archive WHERE run_id = 'parent'
        `
          return { failure, remaining, archived }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.failure).toMatchObject({ code: "fence_lost" })
      expect(result.remaining).toEqual([{ seq: 2 }])
      expect(result.archived).toEqual([])
    }))

  it.effect("archives an attached child held by the supplied child owner", () =>
    Effect.gen(function*() {
      const childOwner = { ...owner, nonce: "child-owner" }
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* SqlTimeTravelStore.make
          for (const [runId, runOwner] of [["parent", owner], ["child", childOwner]] as const) {
            yield* sql`
              INSERT INTO flows_runs
                (run_id, status, created_at_ms, state_json,
                 owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
              VALUES (${runId}, 'running', 0, '{}',
                      ${runOwner.hostId}, ${runOwner.pid}, ${runOwner.nonce}, 0)
            `
          }
          for (const [runId, seq] of [["parent", 0], ["parent", 2], ["child", 0]] as const) {
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES (${runId}, ${seq}, ${`${runId}-${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
            `
          }
          yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES
              ('parent', 2, 'child', 'child', 1),
              ('parent', 2, 'missing-child', 'child', 1)
          `

          const archive = yield* store.archiveAndTruncate(
            "parent",
            { lineageId: "parent/root", seq: 0 },
            [],
            owner,
            new Map([["child", childOwner]])
          )
          const live = yield* sql<{ readonly run_id: string; readonly seq: number }>`
            SELECT run_id, seq FROM flows_journal_events ORDER BY run_id, seq
          `
          const archived = yield* sql<{ readonly run_id: string; readonly seq: number }>`
            SELECT run_id, seq FROM flows_time_travel_archive ORDER BY run_id, seq
          `
          return { archive, live, archived }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.archive.archived).toBe(2)
      expect(result.live).toEqual([{ run_id: "parent", seq: 0 }])
      expect(result.archived).toEqual([
        { run_id: "child", seq: 0 },
        { run_id: "parent", seq: 2 }
      ])
    }))
})

it.effect("archiveAndTruncate forgets lossy source identities in the live journal", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const journal = yield* Journal.Journal
      const store = yield* SqlTimeTravelStore.make
      yield* sql`INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES ('rewind-lossy', 'running', 0, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)`
      const input = new JournalEvent.Input({
        runId: "rewind-lossy" as JournalEvent.RunId,
        sourceId: "producer" as JournalEvent.SourceId,
        sourceSeq: 0 as JournalEvent.SourceSeq,
        eventType: "event",
        payload: "artifact"
      })
      yield* journal.emitDurable(
        new JournalEvent.Input({
          runId: input.runId,
          sourceId: "lifecycle" as JournalEvent.SourceId,
          eventType: "started",
          payload: null
        }),
        owner
      )
      yield* journal.emitLossy(input)
      yield* journal.flush
      yield* store.archiveAndTruncate("rewind-lossy", { lineageId: "main", seq: 0 }, [], owner)
      expect(yield* journal.emitLossy(input)).toMatchObject({ _tag: "Accepted", seq: 1 })
      yield* journal.flush
      expect((yield* journal.entries({ runId: input.runId, limit: 10 })).entries).toHaveLength(2)
    }).pipe(Effect.provide(
      SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
      )
    ))
  ))

it.effect("archives both histories when a rewound run reuses journal sequences", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const journal = yield* Journal.Journal
      const store = yield* SqlTimeTravelStore.make
      yield* sql`INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES ('rewind-twice', 'running', 0, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)`
      const emit = (eventType: string) =>
        journal.emitDurable(
          new JournalEvent.Input({
            runId: "rewind-twice" as JournalEvent.RunId,
            sourceId: "producer" as JournalEvent.SourceId,
            eventType,
            payload: null
          }),
          owner
        )
      yield* emit("baseline")
      yield* emit("original-future")
      yield* journal.flush
      const frame = { lineageId: "main", seq: 0 } as const
      yield* store.recordSnapshot({ runId: "rewind-twice", frame, changeId: "baseline" })
      yield* store.recordSnapshot({ runId: "rewind-twice", frame: { ...frame, seq: 1 }, changeId: "old-future" })
      const first = yield* store.archiveAndTruncate("rewind-twice", frame, [], owner)
      // The journal allocates from the truncated tail, so the resumed history
      // re-uses seq 1: the coordinate the first rewind already archived.
      const replacement = yield* emit("replacement-future")
      yield* journal.flush
      // The resumed history has no anchor at the reused coordinate.
      expect(yield* store.snapshotAt("rewind-twice", { ...frame, seq: 1 })).toEqual({
        runId: "rewind-twice",
        frame,
        changeId: "baseline"
      })
      const second = yield* store.archiveAndTruncate("rewind-twice", frame, [], owner)
      const archived = yield* sql<
        { readonly generation: number; readonly seq: number; readonly event_type: string }
      >`
        SELECT generation, seq, event_type FROM flows_time_travel_archive
        WHERE run_id = 'rewind-twice' ORDER BY generation, seq
      `

      expect(replacement.seq).toBe(1)
      expect(first.archived).toBe(1)
      expect(second.archived).toBe(1)
      expect(archived).toEqual([
        { generation: 0, seq: 1, event_type: "original-future" },
        { generation: 1, seq: 1, event_type: "replacement-future" }
      ])
      expect(yield* store.archivedAt("rewind-twice", 1)).toBe(true)
    }).pipe(Effect.provide(
      SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
      )
    ))
  ))

it.effect("archives attached children with their own generations and rolls back archive collisions", () =>
  Effect.gen(function*() {
    yield* Migrations.run
    const sql = yield* SqlClient.SqlClient
    const store = yield* SqlTimeTravelStore.make
    yield* sql`INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES ('parent', 'running', 0, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)`
    yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES ('child', 'completed', 0, '{}')`
    yield* sql`INSERT INTO flows_journal_generations VALUES ('child', 3, -1)`
    const frame = { lineageId: "main", seq: 0 } as const
    const append = (iteration: number) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('parent', 1, 'child', 'child', 1)`
        for (const runId of ["parent", "child"]) {
          yield* sql`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES (${runId}, 1, ${`${runId}-${iteration}`}, 'source', 1, 0, 'test', '{}', '{}')`
          yield* store.recordSnapshot({ runId, frame: { ...frame, seq: 1 }, changeId: `${runId}-${iteration}` })
        }
      })
    yield* append(0)
    expect((yield* store.archiveAndTruncate("parent", frame, [], owner)).archived).toBe(2)
    yield* append(1)
    expect((yield* store.archiveAndTruncate("parent", frame, [], owner)).archived).toBe(2)
    expect(yield* sql`SELECT run_id, generation, event_id FROM flows_time_travel_archive ORDER BY run_id, generation`)
      .toEqual([
        { run_id: "child", generation: 3, event_id: "child-0" },
        { run_id: "child", generation: 4, event_id: "child-1" },
        { run_id: "parent", generation: 0, event_id: "parent-0" },
        { run_id: "parent", generation: 1, event_id: "parent-1" }
      ])
    yield* append(2)
    // A collision in either insert must preserve the entire live transaction,
    // including snapshots deleted before the attached-child insert is reached.
    for (const runId of ["parent", "child"]) {
      yield* sql`INSERT INTO flows_time_travel_archive
        SELECT e.run_id, g.generation, e.seq, e.event_id, e.source_id, e.source_seq,
          e.emitted_at_ms, e.event_type, e.payload_json, e.meta_json, 0
        FROM flows_journal_events e JOIN flows_journal_generations g ON e.run_id = g.run_id
        WHERE e.run_id = ${runId}`
      const before = {
        live: yield* sql`SELECT * FROM flows_journal_events`,
        archive: yield* sql`SELECT * FROM flows_time_travel_archive`,
        snapshots: yield* sql`SELECT * FROM flows_time_travel_snapshots`,
        generations: yield* sql`SELECT * FROM flows_journal_generations`,
        edges: yield* sql`SELECT * FROM flows_time_travel_edges`
      }
      expect((yield* Effect.flip(store.archiveAndTruncate("parent", frame, [], owner))).code).toBe("unknown")
      expect({
        live: yield* sql`SELECT * FROM flows_journal_events`,
        archive: yield* sql`SELECT * FROM flows_time_travel_archive`,
        snapshots: yield* sql`SELECT * FROM flows_time_travel_snapshots`,
        generations: yield* sql`SELECT * FROM flows_journal_generations`,
        edges: yield* sql`SELECT * FROM flows_time_travel_edges`
      }).toEqual(before)
      yield* sql`DELETE FROM flows_time_travel_archive WHERE run_id = ${runId} AND event_id = ${`${runId}-2`}`
    }
  }).pipe(Effect.provide(TestDatabase.layer)))
