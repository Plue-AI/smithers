/**
 * Pins the namespacing contract of the composed migrator: two storage packages
 * that both ship an `0001_initial` must migrate to distinct identities, and a
 * package that mis-declares its namespace or id block must fail the migration
 * loudly rather than silently shadow its neighbour's table.
 *
 * Derived contract: `docs/concepts/migration-ladder.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const createTable = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY)`)
  })

const alpha: Migrations.MigrationSet = {
  namespace: "alpha",
  idOffset: 0,
  migrations: { "0001_initial": createTable("alpha_rows") }
}

const beta: Migrations.MigrationSet = {
  namespace: "beta",
  idOffset: Migrations.idBlock,
  migrations: { "0001_initial": createTable("beta_rows") }
}

const provided = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.exit(effect.pipe(Effect.provide(TestDatabase.layer)))

const failureMessage = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.map(provided(effect), (exit) => {
    if (exit._tag !== "Failure") throw new Error("expected the migration to fail")
    return JSON.stringify(exit.cause)
  })

const migrationFailure = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.map(provided(effect), (exit) => {
    if (!Exit.isFailure(exit)) throw new Error("expected the migration to fail")
    const failure = Result.getOrUndefined(Cause.findError(exit.cause))
    if (!(failure instanceof Migrator.MigrationError)) throw new Error("expected a MigrationError")
    return failure
  })

describe("composed migrations", () => {
  it.effect("applies migration id zero on a fresh database", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": createTable("zero_rows") }
      }
      const exit = yield* provided(Migrations.run([zero]))

      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : []).toEqual([[0, "zero_initial"]])
    }))

  it.effect("records and persists the id-zero migration like any other", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: {
          "0000_initial": createTable("zero_rows"),
          "0001_second": createTable("zero_more_rows")
        }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const first = yield* Migrations.run([zero])
          const second = yield* Migrations.run([zero])
          const records = yield* sql<
            { readonly migration_id: number; readonly name: string }
          >`SELECT migration_id, name FROM ${sql(Migrations.table)} ORDER BY migration_id`
          return { first, records, second }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.first).toEqual([
        [0, "zero_initial"],
        [1, "zero_second"]
      ])
      expect(result.second).toEqual([])
      expect(result.records).toEqual([
        { migration_id: 0, name: "zero_initial" },
        { migration_id: 1, name: "zero_second" }
      ])
    }))

  it.effect("reruns idempotently when migration ids are safe integers", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const first = yield* Migrations.run([alpha])
          const second = yield* Migrations.run([alpha])
          return { first, second }
        }).pipe(
          Effect.provideService(SqlClient.SafeIntegers, true),
          Effect.provide(TestDatabase.layer)
        )
      )

      expect(result.first).toEqual([[1, "alpha_initial"]])
      expect(result.second).toEqual([])
    }))

  it.effect("rejects an out-of-range bigint migration id as bad state", () =>
    Effect.gen(function*() {
      const invalidId = BigInt(Number.MAX_SAFE_INTEGER) + 1n
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* Migrations.run([])
          yield* sql`INSERT INTO ${sql(Migrations.table)} (migration_id, name) VALUES (${invalidId}, 'invalid')`
          yield* Migrations.loader([])
        }).pipe(
          Effect.provideService(SqlClient.SafeIntegers, true),
          Effect.provide(TestDatabase.sqliteLayer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const failure = Result.getOrUndefined(Cause.findError(exit.cause))
      expect(failure).toBeInstanceOf(Migrator.MigrationError)
      expect(failure).toMatchObject({
        kind: "BadState",
        message: `${Migrations.table} contains an invalid migration_id: ${invalidId}`
      })
    }))

  it.effect("rolls back a failing id-zero migration with the whole run", () =>
    Effect.gen(function*() {
      const broken: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": Effect.fail("zero migration failed") }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const failed = yield* Effect.exit(Migrations.run([broken]))
          const records = yield* sql<
            { readonly migration_id: number }
          >`SELECT migration_id FROM ${sql(Migrations.table)}`
          return { failed, records }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(Exit.isFailure(result.failed)).toBe(true)
      if (Exit.isFailure(result.failed)) {
        const defect = Cause.findDefect(result.failed.cause)
        expect(Result.isSuccess(defect)).toBe(true)
        if (Result.isSuccess(defect)) {
          expect(defect.success).toBeInstanceOf(Migrator.MigrationError)
          expect(defect.success).toMatchObject({ kind: "Failed", message: `Migration "0_zero_initial" failed` })
        }
      }
      expect(result.records).toEqual([])
    }))

  it.effect("applies migration id zero through a hand-wired loader", () =>
    Effect.gen(function*() {
      const zero: Migrations.MigrationSet = {
        namespace: "zero",
        idOffset: 0,
        migrations: { "0000_initial": createTable("zero_rows") }
      }
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          // Creates the migrations table the standalone loader reads.
          yield* Migrations.run([])
          const resolved = yield* Migrations.loader([zero])
          const records = yield* sql<
            { readonly migration_id: number; readonly name: string }
          >`SELECT migration_id, name FROM ${sql(Migrations.table)}`
          return { records, resolved: resolved.map(([id, name]) => [id, name]) }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.resolved).toEqual([[0, "zero_initial"]])
      expect(result.records).toEqual([{ migration_id: 0, name: "zero_initial" }])
    }))

  it.effect("lifts each package's local ids into the block it reserves", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Migrations.run([alpha, beta]))
      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : []).toEqual([
        [1, "alpha_initial"],
        [1001, "beta_initial"]
      ])
    }))

  it.effect("runs migrations in id order however the sets are supplied", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Migrations.run([beta, alpha]))
      expect(exit._tag === "Success" ? exit.value : []).toEqual([
        [1, "alpha_initial"],
        [1001, "beta_initial"]
      ])
    }))

  it.effect("snapshots a migration plan before the caller can mutate its record", () =>
    Effect.gen(function*() {
      const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
        "0001_initial": createTable("snapshot_initial")
      }
      const set: Migrations.MigrationSet = {
        namespace: "snapshot",
        idOffset: 0,
        migrations
      }
      const run = Migrations.run([set])
      migrations["0002_late"] = createTable("snapshot_late")

      const result = yield* (
        Effect.gen(function*() {
          const completed = yield* run
          const sql = yield* SqlClient.SqlClient
          const records = yield* sql<{
            readonly migration_id: number
          }>`SELECT migration_id FROM ${sql(Migrations.table)} ORDER BY migration_id`
          return { completed, records }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.completed).toEqual([[1, "snapshot_initial"]])
      expect(result.records).toEqual([{ migration_id: 1 }])
    }))

  it.effect("installs every set's tables through the layer", () =>
    Effect.gen(function*() {
      const exit = yield* provided(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<
            { readonly name: string }
          >`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'table' ORDER BY name`
        }).pipe(Effect.provide(Migrations.layer([alpha, beta])))
      )
      expect(exit._tag === "Success" ? exit.value.map((row) => row.name) : []).toEqual([
        "alpha_rows",
        "beta_rows",
        Migrations.table
      ].sort())
    }))

  it.effect("rejects a duplicate namespace", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.run([alpha, { ...beta, namespace: "alpha" }])))
        .toContain("Duplicate migration namespace: alpha")
    }))

  it.effect("rejects a duplicate id offset", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.run([alpha, { ...beta, idOffset: 0 }])))
        .toContain("Duplicate migration id offset 0 for namespace beta")
    }))

  // Two keys in one set are the only id collision the other rules still allow:
  // distinct offsets that are multiples of `idBlock`, with every local id below
  // `idBlock`, leave two namespaces in disjoint ranges. Zero-padding differs,
  // the realized id does not, so the message names the two keys rather than
  // reporting a package as colliding with itself.
  it.effect("rejects two keys in one set that realize the same id", () =>
    Effect.gen(function*() {
      const overlapping: Migrations.MigrationSet = {
        namespace: "gamma",
        idOffset: Migrations.idBlock * 2,
        migrations: {
          "0001_first": createTable("gamma_first"),
          "01_second": createTable("gamma_second")
        }
      }
      const failure = yield* migrationFailure(Migrations.run([overlapping]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(`Migration id 2001 is claimed twice: gamma "0001_first" and gamma "01_second"`)
    }))

  it.effect("rejects a set the migrator's high-water mark would silently skip", () =>
    Effect.gen(function*() {
      // `Migrator` runs only ids above the highest applied one, so migrating the
      // 1000 block first leaves `alpha`'s id 1 looking done. Failing here is the
      // whole point: the alternative is a missing table and a passing migration.
      const message = yield* failureMessage(Effect.flatMap(
        Migrations.run([beta]),
        () => Migrations.run([alpha, beta])
      ))
      expect(message).toContain("Migration 1_alpha_initial would be skipped")
      expect(message).toContain("already applied migration id 1001")
    }))

  it.effect("applies package-local forward migrations below another package's global cursor", () =>
    Effect.gen(function*() {
      const next = {
        ...alpha,
        migrations: {
          ...alpha.migrations,
          "0002_second": createTable("alpha_second"),
          "0003_third": createTable("alpha_third")
        }
      }
      const result = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* Migrations.run([alpha, beta])
        const applied = yield* Migrations.run([next, beta])
        const repeated = yield* Migrations.run([next, beta])
        const rows = yield* sql<
          { migration_id: number; name: string }
        >`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
        return { applied, repeated, rows }
      }).pipe(Effect.provide(TestDatabase.layer))
      expect(result.applied).toEqual([[2, "alpha_second"], [3, "alpha_third"]])
      expect(result.repeated).toEqual([])
      expect(result.rows.map((row) => row.migration_id)).toEqual([1, 2, 3, 1001])
    }))

  it.effect("rejects inserting a migration before its package's own applied cursor", () =>
    Effect.gen(function*() {
      const original = { ...alpha, migrations: { "0003_third": createTable("alpha_third") } }
      const next = { ...alpha, migrations: { ...alpha.migrations, ...original.migrations } }
      const message = yield* failureMessage(
        Effect.flatMap(Migrations.run([original, beta]), () => Migrations.run([next, beta]))
      )
      expect(message).toContain("Migration 1_alpha_initial would be skipped")
    }))

  it.effect("rolls back all lower-block appends when a later append fails", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* Migrations.run([alpha, beta])
        const next = {
          ...alpha,
          migrations: {
            ...alpha.migrations,
            "0002_second": createTable("alpha_second"),
            "0003_failure": Effect.fail("migration failure")
          }
        }
        const exit = yield* Effect.exit(Migrations.run([next, beta]))
        expect(exit._tag).toBe("Failure")
        expect(yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'alpha_second'`).toEqual([])
        expect(yield* sql`SELECT migration_id FROM flows_migrations WHERE migration_id IN (2, 3)`).toEqual([])
        const corrected = { ...next, migrations: { ...next.migrations, "0003_failure": createTable("alpha_third") } }
        expect(yield* Migrations.run([corrected, beta])).toEqual([[2, "alpha_second"], [3, "alpha_failure"]])
      }).pipe(Effect.provide(TestDatabase.layer))
    }))

  it.effect("accepts a set every id of which is already applied", () =>
    Effect.gen(function*() {
      const exit = yield* provided(Effect.flatMap(
        Migrations.run([alpha, beta]),
        () => Migrations.run([alpha])
      ))
      expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
    }))

  it.effect("rolls back partial DDL and migration records when a later migration fails", () =>
    Effect.gen(function*() {
      const broken: Migrations.MigrationSet = {
        namespace: "rerun",
        idOffset: 0,
        migrations: {
          "0001_first": createTable("rerun_first"),
          "0002_second": Effect.fail("second migration failed")
        }
      }
      const corrected: Migrations.MigrationSet = {
        ...broken,
        migrations: {
          "0001_first": createTable("rerun_first"),
          "0002_second": createTable("rerun_second")
        }
      }

      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const failed = yield* Effect.exit(Migrations.run([broken]))
          const tablesAfterFailure = yield* sql<
            { readonly name: string }
          >`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'table' ORDER BY name`
          const recordsAfterFailure = yield* sql<
            { readonly migration_id: number }
          >`SELECT migration_id FROM ${sql(Migrations.table)} ORDER BY migration_id`
          const completed = yield* Migrations.run([corrected])
          const tablesAfterRerun = yield* sql<
            { readonly name: string }
          >`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'table' ORDER BY name`
          return { completed, failed, recordsAfterFailure, tablesAfterFailure, tablesAfterRerun }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(Exit.isFailure(result.failed)).toBe(true)
      if (Exit.isFailure(result.failed)) {
        const defect = Cause.findDefect(result.failed.cause)
        expect(Result.isSuccess(defect)).toBe(true)
        if (Result.isSuccess(defect)) {
          expect(defect.success).toBeInstanceOf(Migrator.MigrationError)
          expect(defect.success).toMatchObject({ kind: "Failed" })
        }
      }
      expect(result.tablesAfterFailure.map((row) => row.name)).toEqual([Migrations.table])
      expect(result.recordsAfterFailure).toEqual([])
      expect(result.completed).toEqual([
        [1, "rerun_first"],
        [2, "rerun_second"]
      ])
      expect(result.tablesAfterRerun.map((row) => row.name)).toEqual([
        Migrations.table,
        "rerun_first",
        "rerun_second"
      ].sort())
    }))

  it.effect("accepts an empty array of migration sets", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const completed = yield* Migrations.run([])
          const tables = yield* sql<
            { readonly name: string }
          >`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'table' ORDER BY name`
          return { completed, tables }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.completed).toEqual([])
      expect(result.tables.map((row) => row.name)).toEqual([Migrations.table])
    }))

  it.effect("accepts a migration set with no migrations", () =>
    Effect.gen(function*() {
      const empty: Migrations.MigrationSet = {
        namespace: "empty",
        idOffset: 0,
        migrations: {}
      }
      const exit = yield* provided(Migrations.run([empty]))

      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : "failed").toEqual([])
    }))

  it.effect("accepts local migration ids at both block boundaries", () =>
    Effect.gen(function*() {
      const boundary: Migrations.MigrationSet = {
        namespace: "boundary",
        idOffset: 0,
        migrations: {
          "0000_zero": createTable("boundary_zero"),
          "0999_last": createTable("boundary_last")
        }
      }
      const exit = yield* provided(Migrations.run([boundary]))

      expect(exit._tag).toBe("Success")
      expect(exit._tag === "Success" ? exit.value : []).toEqual([
        [0, "boundary_zero"],
        [999, "boundary_last"]
      ])
    }))

  it.effect("rejects a local migration id equal to idBlock", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "neighbour",
        idOffset: 0,
        migrations: { "1000_claim": createTable("neighbour_rows") }
      }
      const failure = yield* migrationFailure(Migrations.run([invalid]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(
        `Local migration id 1000 for key "1000_claim" in namespace neighbour is outside the block range 0..999 ` +
          `and would claim a neighbouring package's block`
      )
    }))

  it.effect("rejects a maximum-safe-integer local migration id", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "huge_local",
        idOffset: 0,
        migrations: { "9007199254740991_claim": createTable("huge_local_rows") }
      }
      const failure = yield* migrationFailure(Migrations.run([invalid]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(
        `Local migration id 9007199254740991 for key "9007199254740991_claim" in namespace huge_local is outside ` +
          `the block range 0..999 and would claim a neighbouring package's block`
      )
    }))

  it.effect("rejects a misaligned migration id offset", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "misaligned",
        idOffset: 500,
        migrations: { "0001_initial": createTable("misaligned_rows") }
      }
      const failure = yield* migrationFailure(Migrations.run([invalid]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(
        "Invalid migration id offset 500 for namespace misaligned: an id offset must be a multiple of idBlock (1000)"
      )
    }))

  it.effect("rejects an unsafe migration id offset", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "unsafe",
        idOffset: 1e21,
        migrations: { "0001_initial": createTable("unsafe_rows") }
      }
      const failure = yield* migrationFailure(Migrations.run([invalid]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(
        "Invalid migration id offset 1e+21 for namespace unsafe: an id offset must be a safe integer in the range " +
          "0..9007199254740991"
      )
    }))

  it.effect("rejects a realized migration id outside the safe integer range", () =>
    Effect.gen(function*() {
      const offset = Math.floor(Number.MAX_SAFE_INTEGER / Migrations.idBlock) * Migrations.idBlock
      const invalid: Migrations.MigrationSet = {
        namespace: "overflow",
        idOffset: offset,
        migrations: { "0999_tail": createTable("overflow_rows") }
      }
      const failure = yield* migrationFailure(Migrations.run([invalid]))

      expect(failure.kind).toBe("BadState")
      expect(failure.message).toBe(
        `Migration id 9007199254741000 for key "0999_tail" in namespace overflow is outside the safe integer range ` +
          `0..${Number.MAX_SAFE_INTEGER}`
      )
    }))

  it.effect("rejects a negative idOffset as bad migration state", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "negative",
        idOffset: -1,
        migrations: { "1000_initial": createTable("negative_rows") }
      }
      const exit = yield* provided(Migrations.run([invalid]))
      const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

      expect(failure).toBeInstanceOf(Migrator.MigrationError)
      expect(failure).toMatchObject({ kind: "BadState" })
    }))

  it.effect("rejects a non-integer idOffset as bad migration state", () =>
    Effect.gen(function*() {
      const invalid: Migrations.MigrationSet = {
        namespace: "fractional",
        idOffset: 0.5,
        migrations: { "0001_initial": createTable("fractional_rows") }
      }
      const exit = yield* provided(Migrations.run([invalid]))
      const failure = Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findError(exit.cause)) : undefined

      expect(failure).toBeInstanceOf(Migrator.MigrationError)
      expect(failure).toMatchObject({ kind: "BadState" })
    }))

  it.effect("reports a migrations table it cannot read", () =>
    Effect.gen(function*() {
      expect(yield* failureMessage(Migrations.loader([alpha])))
        .toContain(`Could not read ${Migrations.table}`)
    }))

  it.effect("rejects a malformed migration key", () =>
    Effect.gen(function*() {
      const malformed: Migrations.MigrationSet = {
        namespace: "delta",
        idOffset: 0,
        migrations: { initial: createTable("delta_rows") }
      }
      expect(yield* failureMessage(Migrations.run([malformed])))
        .toContain("Malformed migration key")
    }))
})
