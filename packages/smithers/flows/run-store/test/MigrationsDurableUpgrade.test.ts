import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as Dialect from "@smthrs/database/Dialect"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import type * as Consensus from "@smthrs/journal/Consensus"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { Effect, Exit, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import { initial } from "../src/migrations/0001_initial.ts"
import * as RunStore from "../src/RunStore.ts"

const database = (filename: string) => Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

const withDatabase = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient | DurableWriter.DurableWriter | Consensus.Consensus>
) => Effect.scoped(effect.pipe(Effect.provide(SqlConsensus.layer), Effect.provide(database(filename))))

const initialSet: DatabaseMigrations.MigrationSet = {
  namespace: Migrations.set.namespace,
  idOffset: Migrations.set.idOffset,
  migrations: { "0001_initial": initial }
}

describe("run-store durable migration upgrade", () => {
  it.effect(
    "rolls back an interrupted 0002, then preserves old rows and enforces the upgraded constraints",
    () =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-run-store-migration-")))
        const filename = join(directory, "upgrade.sqlite")
        try {
          yield* withDatabase(
            filename,
            Effect.gen(function*() {
              yield* DatabaseMigrations.run([JournalMigrations.set, initialSet])
              const sql = yield* Effect.service(SqlClient.SqlClient)
              yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('legacy-run', 'pending', 7, '{"legacy":true}')
          `
              yield* sql`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, meta_json
            ) VALUES ('legacy-run', 'legacy-step', 0, 'running', 8, '{"legacy":true}')
          `
            })
          )

          const interruptedLineage = Effect.gen(function*() {
            const sql = yield* Effect.service(SqlClient.SqlClient)
            yield* sql`
          ALTER TABLE flows_runs
          ADD COLUMN lineage_id TEXT CHECK (lineage_id IS NULL OR length(lineage_id) > 0)
        `
            return yield* Effect.interrupt
          })
          const interruptedSet: DatabaseMigrations.MigrationSet = {
            ...initialSet,
            migrations: {
              ...initialSet.migrations,
              "0002_lineage": interruptedLineage
            }
          }
          const interrupted = yield* Effect.exit(
            Effect.scoped(
              DatabaseMigrations.run([JournalMigrations.set, interruptedSet]).pipe(Effect.provide(database(filename)))
            )
          )
          expect(Exit.isFailure(interrupted)).toBe(true)

          const beforeUpgrade = yield* withDatabase(
            filename,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const columns = yield* Dialect.columns(sql, "flows_runs").withoutTransform
              const applied = yield* sql<{ readonly migration_id: number }>`
            SELECT migration_id FROM flows_migrations ORDER BY migration_id
          `.withoutTransform
              return { applied, columns }
            })
          )
          expect(beforeUpgrade.columns.map((column) => column.name)).not.toContain("lineage_id")
          expect(beforeUpgrade.applied.map((row) => row.migration_id)).toEqual([1, 2, 3, 4, 5, 6, 1001])

          const upgraded = yield* withDatabase(
            filename,
            Effect.gen(function*() {
              const applied = yield* Migrations.run
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const runs = yield* RunStore.make
              const attempts = yield* AttemptStore.make
              const legacyRun = yield* runs.get("legacy-run")
              const legacyAttempt = Option.getOrThrow(
                yield* attempts.get({ runId: "legacy-run", stepKeyDigest: "legacy-step", attempt: 0 })
              )

              yield* runs.create("lineage-round-one", "{}", { lineageId: "durable-lineage", roundOrdinal: 1 })
              const duplicateLineage = yield* Effect.exit(
                runs.create("lineage-round-one-duplicate", "{}", {
                  lineageId: "durable-lineage",
                  roundOrdinal: 1
                })
              )
              const missingRunAttempt = yield* Effect.exit(sql`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, meta_json
            ) VALUES ('missing-run', 'orphan', 0, 'running', 9, '{}')
          `)
              const columns = yield* Dialect.columns(sql, "flows_runs").withoutTransform
              const indexes = yield* sql<{ readonly name: string; readonly unique: number }>`
            PRAGMA index_list(flows_runs)
          `.withoutTransform
              const foreignKeys = yield* sql<{
                readonly from: string
                readonly table: string
                readonly to: string
              }>`PRAGMA foreign_key_list(flows_attempts)`.withoutTransform
              const rejectedRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM flows_runs
            WHERE run_id = 'lineage-round-one-duplicate'
          `.withoutTransform
              const orphanRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM flows_attempts
            WHERE run_id = 'missing-run'
          `.withoutTransform
              return {
                applied,
                columns,
                duplicateLineage,
                foreignKeys,
                indexes,
                legacyAttempt,
                legacyRun,
                missingRunAttempt,
                orphanRows,
                rejectedRows
              }
            })
          )

          expect(upgraded.applied).toEqual([[1002, "run-store_lineage"], [1003, "run-store_execution_revisions"], [
            1004,
            "run-store_waiting_request"
          ]])
          expect(upgraded.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "lineage_id",
            "round_ordinal"
          ]))
          expect(upgraded.legacyRun).toMatchObject({
            runId: "legacy-run",
            stateJson: "{\"legacy\":true}",
            lineageId: null,
            roundOrdinal: null
          })
          expect(upgraded.legacyAttempt).toMatchObject({
            runId: "legacy-run",
            stepKeyDigest: "legacy-step",
            meta: { legacy: true }
          })
          expect(Exit.isFailure(upgraded.duplicateLineage)).toBe(true)
          expect(upgraded.indexes).toContainEqual(expect.objectContaining({
            name: "flows_runs_lineage_idx",
            unique: 1
          }))
          expect(upgraded.rejectedRows).toEqual([{ count: 0 }])
          expect(Exit.isFailure(upgraded.missingRunAttempt)).toBe(true)
          expect(upgraded.foreignKeys).toContainEqual(expect.objectContaining({
            table: "flows_runs",
            from: "run_id",
            to: "run_id"
          }))
          expect(upgraded.orphanRows).toEqual([{ count: 0 }])
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }),
    120_000
  )
})
