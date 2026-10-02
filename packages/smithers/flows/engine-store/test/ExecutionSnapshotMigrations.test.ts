import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Migrations from "../src/Migrations.ts"
import { executionListing } from "../src/migrations/0006_execution_listing.ts"
import { onFile, state } from "./ExecutionSnapshotFixture.ts"

describe("execution snapshot migration ladder", () => {
  it.effect("upgrades engine head 3005 and run-store head 1002, rolls back interruption, and backfills old edges on reopen", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "snapshot-upgrade-")))
      const file = join(directory, "engine.db")
      const previous = Migrations.sets.map((set) => ({
        ...set,
        migrations: Object.fromEntries(
          Object.entries(set.migrations).filter(([key]) =>
            !(set.namespace === "run-store" && key >= "0003_execution_revisions") &&
            !(set.namespace === "engine-store" && key >= "0006_execution_listing")
          )
        )
      }))
      try {
        yield* onFile(
          file,
          Effect.gen(function*() {
            yield* DatabaseMigrations.run(previous)
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('root', 'completed', 1, ${state}), ('child', 'suspended', 2, ${state})`
            yield* sql`UPDATE flows_runs SET waiting_reason = 'timer', waiting_wake_at_ms = 42 WHERE run_id = 'child'`
            yield* sql`CREATE TABLE flows_run_parents (child_id TEXT NOT NULL, parent_id TEXT NOT NULL, seq BIGINT NOT NULL, PRIMARY KEY (child_id, parent_id))`
            yield* sql`INSERT INTO flows_run_parents VALUES ('child', 'root', 7)`
            const heads = yield* sql<
              { migration_id: number }
            >`SELECT migration_id FROM flows_migrations WHERE migration_id BETWEEN 3000 AND 3999 ORDER BY migration_id`
            expect(heads.map((row) => row.migration_id)).toEqual([3001, 3002, 3003, 3004, 3005])
          })
        )
        const interruptedSets = Migrations.sets.map((set) =>
          set.namespace !== "engine-store" ? set : {
            ...set,
            migrations: {
              ...set.migrations,
              "0006_execution_listing": executionListing.pipe(Effect.andThen(Effect.interrupt))
            }
          }
        )
        const interrupted = yield* Effect.exit(onFile(file, DatabaseMigrations.run(interruptedSets)))
        expect(Exit.isFailure(interrupted)).toBe(true)
        yield* onFile(
          file,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(flows_runs)`
            expect(columns.map((row) => row.name)).not.toContain("execution_parent_id")
            yield* Migrations.run
            expect(yield* Migrations.run).toEqual([])
            const heads = yield* sql<
              { migration_id: number }
            >`SELECT migration_id FROM flows_migrations WHERE migration_id BETWEEN 3000 AND 3999 ORDER BY migration_id`
            expect(heads.map((row) => row.migration_id)).toEqual([
              3001,
              3002,
              3003,
              3004,
              3005,
              3006,
              3007,
              3008,
              3009,
              3010
            ])
          })
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const observed = yield* reader.read(["root", "child"])
            expect(observed.snapshots[0]).toMatchObject({
              lineageId: "root",
              roundOrdinal: 0,
              cancellation: { requestedAtMs: null, acknowledgement: null }
            })
            expect(observed.snapshots[1]).toMatchObject({
              parentRunId: "root",
              status: "suspended",
              waiting: { kind: "timer", wakeAtMs: 42, tokenDigest: null }
            })
            expect(observed.snapshots.every((row) => row.revision > 0)).toBe(true)
            const sql = yield* SqlClient.SqlClient
            expect(
              (yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name GLOB 'flows_runs_listing_*'`).length
            ).toBe(32)
            const creationChange = yield* Effect.exit(
              sql`UPDATE flows_runs SET created_at_ms = 100 WHERE run_id = 'child'`
            )
            expect(Exit.isFailure(creationChange)).toBe(true)
          })
        )
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
