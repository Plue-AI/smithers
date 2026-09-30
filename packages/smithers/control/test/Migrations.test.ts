import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as PlanMigrations from "@smthrs/plan-store/Migrations"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as StepCacheMigrations from "@smthrs/step-cache/Migrations"
import * as TimeTravelMigrations from "@smthrs/time-travel/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as Migrations from "../src/Migrations.ts"
import { initial } from "../src/migrations/0001_control_tables.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

const tableNames = [
  "control_credentials",
  "control_grants",
  "control_mutations",
  "control_plan_keys",
  "control_plans",
  "control_run_keys",
  "control_run_messages",
  "control_run_resumes",
  "control_runs",
  "control_sequences",
  "control_signal_commands",
  "control_tokens"
] as const

const siblingOffsets = [
  JournalMigrations.set.idOffset,
  RunStoreMigrations.set.idOffset,
  StepCacheMigrations.set.idOffset,
  EngineMigrations.set.idOffset,
  PlanMigrations.set.idOffset,
  TimeTravelMigrations.set.idOffset
]

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(TestDatabase.layer))

describe("control migrations", () => {
  it.live("retries standalone bootstrap behind another connection's write lock without advancing the ledger", () =>
    Effect.scoped(Effect.gen(function*() {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "control-bootstrap-lock-"))),
        (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true }))
      )
      const filename = join(directory, "control.sqlite")
      yield* Effect.gen(function*() {
        yield* DatabaseMigrations.run([])
        const blocker = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close())
        )
        blocker.exec("BEGIN IMMEDIATE")
        let released = false
        const release = () => {
          if (!released) {
            blocker.exec("ROLLBACK")
            released = true
          }
        }
        const timer = setTimeout(release, 100)
        yield* SqlControlRuntime.migrate.pipe(Effect.ensuring(Effect.sync(() => {
          clearTimeout(timer)
          release()
        })))
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT * FROM control_runs`).toEqual([])
        expect(yield* sql`SELECT * FROM flows_migrations`).toEqual([])
        expect(yield* Migrations.run).toHaveLength(6)
      }).pipe(Effect.provide(NodeDatabase.layer({ filename })))
    })))

  it("reserves the next migration block without colliding with a sibling", () => {
    expect(Migrations.set.idOffset % DatabaseMigrations.idBlock).toBe(0)
    expect(Migrations.set.idOffset).toBe(Math.max(...siblingOffsets) + DatabaseMigrations.idBlock)
    expect(siblingOffsets).not.toContain(Migrations.set.idOffset)

    for (const key of Object.keys(Migrations.set.migrations)) {
      const localId = Number.parseInt(key, 10)
      expect(localId).toBeGreaterThanOrEqual(0)
      expect(localId).toBeLessThan(DatabaseMigrations.idBlock)
    }
  })

  it.effect("creates every control table and reruns idempotently", () =>
    withDatabase(Effect.gen(function*() {
      yield* Migrations.run
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM ${TestDatabase.catalog(sql)}
        WHERE type = 'table' AND name LIKE 'control_%'
        ORDER BY name
      `

      expect(rows.map((row) => row.name)).toEqual(tableNames)
    })))

  it.effect("records the migration after the standalone runtime bootstrap", () =>
    withDatabase(Effect.gen(function*() {
      yield* SqlControlRuntime.migrate
      const completed = yield* Migrations.run
      expect(completed).toHaveLength(6)
      expect(completed[0]?.[0]).toBe(Migrations.set.idOffset + 1)
    })))

  it.effect("upgrades a database whose initial control migration is already recorded", () =>
    withDatabase(Effect.gen(function*() {
      yield* DatabaseMigrations.run([{ ...Migrations.set, migrations: { "0001_control_tables": initial } }])
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO control_sequences (name, value) VALUES ('upgrade-sentinel', 42)`
      const completed = yield* Migrations.run
      expect(completed.map(([id]) => id)).toEqual([
        Migrations.set.idOffset + 2,
        Migrations.set.idOffset + 3,
        Migrations.set.idOffset + 4,
        Migrations.set.idOffset + 5,
        Migrations.set.idOffset + 6
      ])
      expect(yield* sql`SELECT * FROM control_run_keys`).toEqual([])
      expect(yield* sql`SELECT value FROM control_sequences WHERE name = 'upgrade-sentinel'`).toEqual([{ value: 42 }])
    })))

  it("leaves an older store untouched over a read-only client", async () => {
    const root = mkdtempSync(join(tmpdir(), "control-readonly-bootstrap-"))
    const filename = join(root, "control.db")
    try {
      const db = new DatabaseSync(filename)
      db.exec("CREATE TABLE flows_migrations (id INTEGER)")
      db.close()
      const tables = await Effect.runPromise(
        Effect.gen(function*() {
          yield* SqlControlRuntime.migrate
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
        }).pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))
      )
      expect(tables).toEqual([{ name: "flows_migrations" }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
