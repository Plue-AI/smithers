/**
 * Pins issue #92: `DurableEngineState.make` creates schema objects outside
 * the journal migration ladder — the run-parent table and its indexes, the
 * GC trigger (SQLite-only syntax), and the stale-running partial index — and
 * a future Postgres/PGlite backend dies at layer construction on them. They
 * were previously inline `sql` literals with no machine-readable inventory,
 * so the porting plan in the database roadmap
 * could omit them silently.
 *
 * The inventory in `internal/EngineStateSchema` is now the single source of
 * truth, and this test diffs the database's schema objects across `make` to
 * prove nothing is created that the inventory does not declare.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStateSchema from "../src/internal/EngineStateSchema.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const schemaObjects = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name AS "name" FROM ${TestDatabase.catalog(sql)} WHERE name NOT LIKE 'sqlite_%'
  `.pipe(Effect.orDie)
  return new Set(rows.map((row) => String(row.name)))
})

describe("out-of-ladder engine-store schema (issue #92)", () => {
  it.effect("creates exactly the objects the porting inventory declares", () =>
    Effect.gen(function*() {
      const created = yield* withCrypto(
        Effect.gen(function*() {
          const before = yield* schemaObjects
          yield* DurableEngineState.make
          const after = yield* schemaObjects
          return [...after].filter((name) => !before.has(name)).sort()
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(created).toEqual(
        EngineStateSchema.statements.map((statement) => statement.name).sort()
      )
    }))

  it("declares which dialects each out-of-ladder statement is known to accept", () => {
    expect(EngineStateSchema.statements.length).toBeGreaterThan(0)
    for (const statement of EngineStateSchema.statements) {
      expect(statement.dialects.length).toBeGreaterThan(0)
      expect(statement.dialects).toContain("sqlite")
    }
    // Spawn edges and their SQLite GC trigger are now owned by migration 0006.
    expect(EngineStateSchema.statements.map((statement) => statement.name)).toEqual([
      "flows_runs_stale_running_idx"
    ])
  })

  it.effect("is idempotent: a second construction over the same database adds nothing", () =>
    Effect.gen(function*() {
      const created = yield* withCrypto(
        Effect.gen(function*() {
          yield* DurableEngineState.make
          const before = yield* schemaObjects
          yield* DurableEngineState.make
          const after = yield* schemaObjects
          return [...after].filter((name) => !before.has(name))
        }).pipe(Effect.provide(migratedDatabase))
      )
      expect(created).toEqual([])
    }))

  it("installs nothing over a read-only client", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-state-readonly-"))
    const filename = join(root, "engine.db")
    const database = (readOnly: boolean) =>
      Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename, readOnly }))
    try {
      // A migrated store written before the out-of-ladder index existed.
      await Effect.runPromise(withCrypto(
        Effect.gen(function*() {
          yield* DurableEngineState.make
          const sql = yield* SqlClient.SqlClient
          for (const statement of EngineStateSchema.statements) yield* sql.unsafe(`DROP INDEX ${statement.name}`)
        }).pipe(Effect.provide(Layer.provideMerge(Migrations.layer, database(false))))
      ))
      const created = await Effect.runPromise(withCrypto(
        Effect.gen(function*() {
          const before = yield* schemaObjects
          yield* DurableEngineState.make
          return [...(yield* schemaObjects)].filter((name) => !before.has(name))
        }).pipe(Effect.provide(database(true)))
      ))
      expect(created).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
