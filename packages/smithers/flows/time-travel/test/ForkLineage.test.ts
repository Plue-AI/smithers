import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as TimeTravelMigrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"

const seed = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, ${
      JSON.stringify({ version: 1, flowName: "Lineage", payload: {}, result: { _tag: "Success" } })
    })
    `
    yield* sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
         event_type, payload_json, meta_json)
      VALUES (${runId}, 0, ${`${runId}-0`}, 'source', 0, 0, 'test', '{}', '{}')
    `
  })

describe("fork lineage", () => {
  it.effect("records parent_run_id so ancestry is walkable in SQL", () =>
    Effect.gen(function*() {
      const ancestry = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* SqlTimeTravelStore.make
          yield* seed("root")
          const child = yield* store.createFork("root", { lineageId: "root/root", seq: 0 })
          const grandchild = yield* store.createFork(child.runId, { lineageId: "root/root", seq: 0 })
          const rows = yield* sql<{ readonly run_id: string }>`
          WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
            SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = ${grandchild.runId}
            UNION ALL
            SELECT flows_runs.run_id, flows_runs.parent_run_id
            FROM flows_runs JOIN ancestry ON flows_runs.run_id = ancestry.parent_run_id
          )
          SELECT run_id FROM ancestry
        `
          return { rows: rows.map((row) => row.run_id), child: child.runId, grandchild: grandchild.runId }
        }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
      )

      expect(ancestry.rows).toEqual([ancestry.grandchild, ancestry.child, "root"])
    }))

  it.effect("exposes the lineage edge on the decoded run row", () =>
    Effect.gen(function*() {
      const row = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const store = yield* SqlTimeTravelStore.make
          const runs = yield* RunStore.make
          yield* seed("root")
          const child = yield* store.createFork("root", { lineageId: "root/root", seq: 0 })
          return yield* runs.get(child.runId)
        }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
      )

      expect(row.parentRunId).toBe("root")
      expect(row.status).toBe("pending")
    }))

  it.effect("forks a fork at a frame that includes its own creation marker", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* SqlTimeTravelStore.make
          yield* seed("root")
          const child = yield* store.createFork("root", { lineageId: "root/root", seq: 0 })
          // seq 1 is the child's own fork-created marker. Forking above it
          // copies a row that already carries the marker's source id, so the
          // grandchild's own marker must take a distinct source_seq or die on
          // the journal's `UNIQUE (run_id, source_id, source_seq)`.
          const grandchild = yield* store.createFork(child.runId, { lineageId: "root/root", seq: 1 })
          const markers = yield* sql<{ readonly seq: number; readonly source_seq: number }>`
          SELECT seq, source_seq FROM flows_journal_events
          WHERE run_id = ${grandchild.runId} AND source_id = 'flows/time-travel/fork'
          ORDER BY seq
        `
          return { markers }
        }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
      )

      // Every marker keeps `source_seq = seq`: the copied one at the fork
      // offset, the grandchild's own strictly above it.
      expect(result.markers).toEqual([
        { seq: 1, source_seq: 1 },
        { seq: 2, source_seq: 2 }
      ])
    }))

  // The fork copies the frame's anchors with the prefix, so a fresh engine
  // incarnation can fork the child again without ever projecting its journal.
  it.effect("copies public fork prefixes, attempts, and anchors across an engine restart", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-public-fork-lineage-")))
      const filename = join(directory, "lineage.sqlite")
      const layer = () => {
        const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
        const migrated = Layer.provideMerge(TimeTravelMigrations.layer, database)
        const persistence = Layer.mergeAll(
          SqlJournal.layer({ capacity: 32, overflow: "reject" }),
          RunStore.layer,
          CacheStore.layer,
          SqlTimeTravelStore.layer,
          Layer.succeed(Jj.Jj)(Jj.makeNoop({
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void
          }))
        ).pipe(Layer.provideMerge(migrated))
        return TimeTravel.layer.pipe(Layer.provideMerge(persistence))
      }
      try {
        const child = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES ('public-root', 'suspended', 0,
                      ${JSON.stringify({ version: 1, flowName: "Lineage", payload: {} })})
            `
              for (
                const [seq, eventType, payload] of [
                  [0, "flows.engine.run-decision", { state: { version: 1, flowName: "Lineage", payload: {} } }],
                  [1, "flows.engine.snapshot-identified", { snapshotId: "change-a" }],
                  [2, "flows.engine.attempt-started", { stepKeyDigest: "digest", attempt: 0 }],
                  [3, "flows.engine.attempt-finished", { stepKeyDigest: "digest", attempt: 0, state: "succeeded" }]
                ] as const
              ) {
                yield* sql`
                INSERT INTO flows_journal_events
                  (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                VALUES ('public-root', ${seq}, ${`root-${seq}`}, 'fork-lineage', ${seq}, 0,
                        ${eventType}, ${JSON.stringify(payload)},
                        ${JSON.stringify({ lineageId: "public-root/root" })})
              `
              }
              yield* sql`
              INSERT INTO flows_attempts
                (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
                 heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json)
              VALUES ('public-root', 'digest', 0, 'succeeded', 0, 1, 1, NULL, NULL, '{}', '{}')
            `
              const timeTravel = yield* TimeTravel
              return yield* timeTravel.fork({
                runId: "public-root",
                frame: { lineageId: "public-root/root", seq: 3 }
              }, { workspaceRoot: directory })
            }).pipe(Effect.provide(layer()))
          )
        )

        const result = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              const grandchild = yield* timeTravel.fork({
                runId: child.runId,
                // Fork at the inherited tail rather than copying the child's
                // own marker; this keeps the source identity unique and lets
                // the test reach the anchor-copy contract below.
                frame: { lineageId: "public-root/root", seq: 3 }
              }, { workspaceRoot: directory })
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const attempts = yield* sql<{ readonly run_id: string; readonly step_key_digest: string }>`
              SELECT run_id, step_key_digest FROM flows_attempts
              WHERE run_id IN (${child.runId}, ${grandchild.runId}) ORDER BY run_id
            `
              const markers = yield* sql<
                { readonly run_id: string; readonly seq: number; readonly payload_json: string }
              >`
              SELECT run_id, seq, payload_json FROM flows_journal_events
              WHERE run_id IN (${child.runId}, ${grandchild.runId})
                AND event_type = 'flows.time-travel.fork-created'
              ORDER BY run_id, seq
            `
              const edges = yield* sql<{ readonly parent_run_id: string; readonly child_run_id: string }>`
              SELECT parent_run_id, child_run_id FROM flows_time_travel_edges ORDER BY child_run_id
            `
              const anchors = yield* sql<{ readonly run_id: string; readonly change_id: string }>`
              SELECT run_id, change_id FROM flows_time_travel_snapshots ORDER BY run_id
            `
              return { anchors, attempts, edges, grandchild, markers }
            }).pipe(Effect.provide(layer()))
          )
        )

        expect(result.attempts.map((row) => row.step_key_digest)).toEqual(["digest", "digest"])
        expect(result.edges).toEqual([
          { parent_run_id: "public-root", child_run_id: child.runId },
          { parent_run_id: child.runId, child_run_id: result.grandchild.runId }
        ])
        expect(
          result.markers.map((row) => ({ runId: row.run_id, offset: JSON.parse(row.payload_json).forkJournalOffset }))
        )
          .toEqual([
            { runId: child.runId, offset: 3 },
            { runId: result.grandchild.runId, offset: 3 }
          ])
        expect(result.anchors).toEqual([
          { run_id: "public-root", change_id: "change-a" },
          { run_id: child.runId, change_id: "change-a" },
          { run_id: result.grandchild.runId, change_id: "change-a" }
        ])
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
