/**
 * In-memory SQLite database layer for tests.
 *
 * @since 0.1.0
 */
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Fragment } from "effect/unstable/sql/Statement"
import { randomUUID } from "node:crypto"
import * as DurableWriter from "../DurableWriter.ts"
import * as NodeDatabase from "../node/NodeDatabase.ts"

/**
 * Provides the production Node SQLite client and durable writer over a fresh
 * in-memory database.
 *
 * @category layers
 * @since 0.1.0
 */
export const sqliteLayer = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))

/** Drops a PostgreSQL test schema in the order every product transaction locks.
 *
 * Each PostgreSQL transaction first takes the schema's writer advisory lock
 * and only then touches tables. A bare `DROP SCHEMA` skips that lock and takes
 * its table locks one by one, so a transaction still in flight on the same
 * schema — a background fiber the case left running — could hold one table
 * while waiting for another the drop already holds: a deadlock. Dropping
 * inside `withTransaction` takes the writer lock first, so the drop waits for
 * that transaction to commit and later ones wait for the drop.
 *
 * `sql` must be a client whose `search_path` is `schema`, which the writer
 * lock is keyed by. Dropping an already dropped schema is a no-op.
 *
 * @category testing
 * @since 1.0.0
 */
export const dropSchema = (sql: SqlClient.SqlClient, schema: string): Effect.Effect<void, SqlError> =>
  sql.withTransaction(sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`).pipe(Effect.asVoid)

/** Isolated production database, selected by the matrix runner.
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> = Layer.unwrap(
  Effect.gen(function*() {
    const url = process.env.SMITHERS_TEST_PG_URL
    if (!url) return sqliteLayer
    const PostgresDatabase = yield* Effect.promise(() => import("../postgres/PostgresDatabase.ts"))
    const schema = `test_${randomUUID().replaceAll("-", "")}`
    const cleanup = Layer.effectDiscard(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.addFinalizer(() => dropSchema(sql, schema).pipe(Effect.orDie))
    }))
    return Layer.provideMerge(
      DurableWriter.layer(),
      Layer.provideMerge(
        cleanup,
        PostgresDatabase.layer({
          url,
          schema,
          postgres: { connectTimeout: Infinity, idleTimeout: Infinity, connectionTTL: Infinity }
        })
      )
    )
  })
)

/** Wait for asynchronous database work without relying on a synchronous driver.
 * @category testing
 * @since 1.0.0
 */
export const until = <E, R>(predicate: Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 2000; attempt++) {
      if (yield* predicate) return
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
    }
    return yield* Effect.die("Database condition did not settle within 2000 polls")
  })

const disabledChecks = new WeakMap<
  SqlClient.SqlClient,
  ReadonlyArray<{ table_name: string; name: string; definition: string }>
>()
/** Corruption fixtures bypass checks, then restore enforcement for subsequent writes.
 * @category testing
 * @since 1.0.0
 */
export const checks = (sql: SqlClient.SqlClient, enabled: boolean) =>
  Effect.gen(function*() {
    if (!sql.onDialectOrElse({ pg: () => true, orElse: () => false })) {
      yield* sql.unsafe(`PRAGMA ignore_check_constraints = ${enabled ? "OFF" : "ON"}`)
      return
    }
    if (!enabled) {
      const constraints = yield* sql<{ table_name: string; name: string; definition: string }>`
      SELECT rel.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = current_schema() AND con.contype = 'c'`
      disabledChecks.set(sql, constraints)
      for (const constraint of constraints) {
        yield* sql`ALTER TABLE ${sql(constraint.table_name)} DROP CONSTRAINT ${sql(constraint.name)}`
      }
    } else {
      for (const constraint of disabledChecks.get(sql) ?? []) {
        yield* sql`ALTER TABLE ${sql(constraint.table_name)} ADD CONSTRAINT ${sql(constraint.name)} ${
          sql.literal(constraint.definition)
        } NOT VALID`
      }
      disabledChecks.delete(sql)
    }
  })
const disabledForeignKeys = new WeakMap<
  SqlClient.SqlClient,
  ReadonlyArray<{ table_name: string; name: string; definition: string }>
>()
/** Fixtures can retain orphaned rows to test existence guards.
 * @category testing
 * @since 1.0.0
 */
export const foreignKeys = (sql: SqlClient.SqlClient, enabled: boolean) =>
  Effect.gen(function*() {
    if (!sql.onDialectOrElse({ pg: () => true, orElse: () => false })) {
      yield* sql.unsafe(`PRAGMA foreign_keys = ${enabled ? "ON" : "OFF"}`)
      return
    }
    if (!enabled) {
      const constraints = yield* sql<{ table_name: string; name: string; definition: string }>`
      SELECT rel.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = current_schema() AND con.contype = 'f'`
      disabledForeignKeys.set(sql, constraints)
      for (const constraint of constraints) {
        yield* sql`ALTER TABLE ${sql(constraint.table_name)} DROP CONSTRAINT ${sql(constraint.name)}`
      }
    } else {
      for (const constraint of disabledForeignKeys.get(sql) ?? []) {
        yield* sql`ALTER TABLE ${sql(constraint.table_name)} ADD CONSTRAINT ${sql(constraint.name)} ${
          sql.literal(constraint.definition)
        } NOT VALID`
      }
      disabledForeignKeys.delete(sql)
    }
  })
/** Removes a fixture trigger using the backend's catalog.
 * @category testing
 * @since 1.0.0
 */
export const dropTrigger = (sql: SqlClient.SqlClient, name: string) =>
  Effect.gen(function*() {
    if (!sql.onDialectOrElse({ pg: () => true, orElse: () => false })) {
      yield* sql`DROP TRIGGER ${sql(name)}`
      return
    }
    const rows = yield* sql<{ table_name: string }>`SELECT rel.relname AS table_name
    FROM pg_trigger trg JOIN pg_class rel ON rel.oid = trg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = current_schema() AND trg.tgname = ${name}`
    for (const row of rows) yield* sql`DROP TRIGGER ${sql(name)} ON ${sql(row.table_name)}`
  })

/** Catalog relation for schema assertions, including actual stored definitions.
 * @category testing
 * @since 1.0.0
 */
export const catalog = (sql: SqlClient.SqlClient) =>
  sql.onDialectOrElse({
    pg: () =>
      sql`(
    SELECT rel.relname AS name, rel.relname AS tbl_name, 'table' AS type,
      (SELECT string_agg(att.attname || ' ' || format_type(att.atttypid, att.atttypmod), ', ')
        FROM pg_attribute att WHERE att.attrelid = rel.oid AND att.attnum > 0 AND NOT att.attisdropped)
      || COALESCE((SELECT string_agg(pg_get_constraintdef(con.oid), ', ') FROM pg_constraint con WHERE con.conrelid = rel.oid), '') AS sql
    FROM pg_class rel JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = current_schema() AND rel.relkind = 'r'
    UNION ALL SELECT indexname, tablename, 'index', indexdef FROM pg_indexes idx WHERE schemaname = current_schema()
      AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = to_regclass(quote_ident(idx.schemaname) || '.' || quote_ident(idx.indexname)))
    UNION ALL SELECT trg.tgname, rel.relname, 'trigger', pg_get_triggerdef(trg.oid)
      FROM pg_trigger trg JOIN pg_class rel ON rel.oid = trg.tgrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = current_schema() AND NOT trg.tgisinternal
  )`,
    orElse: () => sql.literal("sqlite_master")
  })

/** Explains a real statement; small PostgreSQL fixtures force consideration of indexes.
 * @category testing
 * @since 1.0.0
 */
export const explain = (
  sql: SqlClient.SqlClient,
  statement: Fragment
): Effect.Effect<ReadonlyArray<{ detail: string }>, SqlError> =>
  sql.onDialectOrElse({
    pg: () =>
      sql.withTransaction(Effect.gen(function*() {
        yield* sql`SET LOCAL enable_seqscan = off`
        return (yield* sql<{ "QUERY PLAN": string }>`EXPLAIN ${statement}`).map((row) => ({
          detail: row["QUERY PLAN"]
        }))
      })),
    orElse: () => sql<{ detail: string }>`EXPLAIN QUERY PLAN ${statement}`
  })
