/**
 * `StoreCopy` copies a store whole: a PostgreSQL schema keeps every table,
 * index, check, foreign key, trigger and identity position of its source, and
 * the source is left exactly as it was.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as ControlDatabaseMigrations from "../src/internal/ControlDatabaseMigrations.ts"

const url = process.env.SMITHERS_HISTORY_TEST_PG_URL!
const roots: Array<string> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const on = <A, E>(filename: string, body: Effect.Effect<A, E, SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(NodeDatabase.layer({ filename }))))

/** An engine and a control store, migrated, with a run recorded in each. */
const seeded = async (directory: string) => {
  const engine = join(directory, "engine.db")
  const control = join(directory, "control.db")
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(engine, directory)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(ControlDatabaseMigrations.layer),
    Effect.provide(NodeDatabase.layer({ filename: control }))
  ))
  await on(
    engine,
    Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,${
        JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
      })`
      yield* sql`INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',1,'one','source',1,0,'example.output','{}','{}')`
    })
  )
  return { engine, control }
}

/** The store's catalog, ordered and with its schema name taken out, so two schemas compare. */
const catalog = (filename: string) =>
  on(
    filename,
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const [current] = yield* sql<{ schema: string }>`SELECT current_schema() AS schema`
      const rows = yield* sql<{ kind: string; name: string; definition: string | null }>`
        SELECT 'column' AS kind, table_name || '.' || column_name AS name,
          concat_ws(' ', data_type, column_default, is_nullable, is_identity, identity_generation,
            is_generated, generation_expression) AS definition
        FROM information_schema.columns WHERE table_schema = current_schema()
        UNION ALL SELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relnamespace = current_schema()::regnamespace
        UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
        UNION ALL SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace
          AND NOT t.tgisinternal
        UNION ALL SELECT 'function', p.proname, pg_get_functiondef(p.oid) FROM pg_proc p
        WHERE p.pronamespace = current_schema()::regnamespace
        ORDER BY 1, 2`
      return rows.map((row) => ({
        ...row,
        definition: row.definition?.replaceAll(current!.schema, "<schema>") ?? null
      }))
    })
  )

const counts = (filename: string) =>
  on(
    filename,
    Effect.flatMap(SqlClient, (sql) =>
      sql<{ runs: number; events: number }>`SELECT (SELECT count(*) FROM flows_runs) AS runs,
        (SELECT count(*) FROM flows_journal_events) AS events`)
  ).then(([row]) => ({ runs: Number(row!.runs), events: Number(row!.events) }))

it("copies a SQLite store into a new file and leaves the source as it was", async () => {
  vi.stubEnv("SMITHERS_BACKEND", "sqlite")
  const directory = mkdtempSync(join(tmpdir(), "store-copy-sqlite-"))
  roots.push(directory)
  const { engine } = await seeded(directory)
  const copy = join(directory, "copy.db")
  await Effect.runPromise(StoreCopy.copy(engine, copy))
  expect(await counts(copy)).toEqual(await counts(engine))
  await Effect.runPromise(StoreCopy.discard(copy))
  // A SQLite copy is its caller's file to delete.
  expect(existsSync(copy)).toBe(true)
})

it("copies a PostgreSQL schema whole, continues its identities and drops the copy", async () => {
  const prefix = `test_copy_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  vi.stubEnv("SMITHERS_POSTGRES_URL", url)
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  const directory = mkdtempSync(join(tmpdir(), "store-copy-postgres-"))
  roots.push(directory)
  try {
    const { engine, control } = await seeded(directory)
    const engineCopy = join(directory, "copy_engine.db")
    const controlCopy = join(directory, "copy_control.db")
    const before = { engine: await catalog(engine), counts: await counts(engine) }
    await Effect.runPromise(StoreCopy.copy(engine, engineCopy))
    await Effect.runPromise(StoreCopy.copy(control, controlCopy))
    expect(StoreCopy.postgres(engineCopy)?.schema).toBe(`${prefix}_copy_engine_db`)
    expect(await catalog(engineCopy)).toEqual(before.engine)
    expect(await catalog(controlCopy)).toEqual(await catalog(control))
    expect(new Set(before.engine.map((row) => row.kind))).toEqual(
      new Set(["column", "constraint", "index", "trigger", "function"])
    )
    expect(await counts(engineCopy)).toEqual(before.counts)
    // A row the copy appends takes the next identity, and the triggers fire there.
    await on(
      engineCopy,
      Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',2,'two','source',2,0,'example.output','{}','{}')`
      })
    )
    const refused = await on(
      engineCopy,
      Effect.flip(
        Effect.flatMap(
          SqlClient,
          (sql) =>
            sql`INSERT INTO flows_plan_input_heads(run_id, plan_id, base_digest, generation)
          VALUES ('run-1', 'plan', 'base', 0)`
        )
      )
    )
    // The copied trigger refuses a head without an environment; with one, the row lands.
    expect(String((refused as { readonly cause?: unknown }).cause)).toContain("ConstraintError")
    await on(
      engineCopy,
      Effect.flatMap(
        SqlClient,
        (sql) =>
          sql`INSERT INTO flows_plan_input_heads(run_id, plan_id, base_digest, generation, environment_digest)
        VALUES ('run-1', 'plan', 'base', 0, 'environment')`
      )
    )
    expect(await counts(engineCopy)).toEqual({ runs: 1, events: 2 })
    expect(await counts(engine)).toEqual(before.counts)
    expect(await catalog(engine)).toEqual(before.engine)
    // A copy never lands on its own source, nor off the source's server.
    await expect(Effect.runPromise(StoreCopy.copy(engine, engine))).rejects.toBeDefined()
    await Effect.runPromise(StoreCopy.discard(engineCopy))
    await Effect.runPromise(StoreCopy.discard(controlCopy))
    const left = await on(
      `${url}?schema=public`,
      Effect.flatMap(
        SqlClient,
        (sql) =>
          sql<{ name: string }>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`} ORDER BY 1`
      )
    )
    expect(left.map((row) => row.name)).toEqual([`${prefix}_control_db`, `${prefix}_engine_db`])
  } finally {
    await on(
      `${url}?schema=public`,
      Effect.gen(function*() {
        const sql = yield* SqlClient
        for (
          const row of yield* sql<
            { name: string }
          >`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`}`
        ) yield* sql`DROP SCHEMA ${sql(row.name)} CASCADE`
      })
    ).catch(() => undefined)
  }
})

it("refuses a PostgreSQL copy that exists already or would reach its source, and leaves no schema", async () => {
  const prefix = `test_copy_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  vi.stubEnv("SMITHERS_POSTGRES_URL", url)
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  const directory = mkdtempSync(join(tmpdir(), "store-copy-refusals-"))
  roots.push(directory)
  const admin = <A, E>(body: Effect.Effect<A, E, SqlClient>) => on(`${url}?schema=public`, body)
  const schemas = () =>
    admin(
      Effect.flatMap(SqlClient, (sql) =>
        sql<{ name: string }>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`} ORDER BY 1`)
    ).then((rows) =>
      rows.map((row) =>
        row.name
      )
    )
  const code = (effect: Effect.Effect<void, unknown>) =>
    Effect.runPromise(Effect.flip(effect)).then((error) => (error as { readonly code?: unknown }).code)
  try {
    const source = join(directory, "source.db")
    await on(
      source,
      Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`CREATE TABLE rows (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, value TEXT)`
        yield* sql`INSERT INTO rows (value) VALUES ('one')`
      })
    )
    // An existing destination is never adopted, and never dropped.
    const taken = join(directory, "taken.db")
    await on(taken, Effect.flatMap(SqlClient, (sql) => sql`CREATE TABLE keep (id INTEGER)`))
    expect(await code(StoreCopy.copy(source, taken))).toBeUndefined()
    expect(await schemas()).toEqual([`${prefix}_source_db`, `${prefix}_taken_db`])

    // A default drawing from a sequence the source owns would advance the source.
    await on(
      source,
      Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`CREATE SEQUENCE counter`
        yield* sql`CREATE TABLE counted (n BIGINT DEFAULT nextval('counter'))`
      })
    )
    expect(await code(StoreCopy.copy(source, join(directory, "reaching.db")))).toBe("verify_copy_unsafe")
    // A function pinned to a search path resolves its names somewhere else.
    await on(
      source,
      Effect.gen(function*() {
        const sql = yield* SqlClient
        yield* sql`DROP TABLE counted`
        yield* sql`DROP SEQUENCE counter`
        yield* sql.unsafe(
          `CREATE FUNCTION pinned() RETURNS integer LANGUAGE sql SET search_path = public AS 'SELECT 1'`
        )
      })
    )
    expect(await code(StoreCopy.copy(source, join(directory, "pinned.db")))).toBe("verify_copy_unsafe")
    // Each refused copy rolled its schema back.
    expect(await schemas()).toEqual([`${prefix}_source_db`, `${prefix}_taken_db`])
  } finally {
    await admin(Effect.gen(function*() {
      const sql = yield* SqlClient
      for (
        const row of yield* sql<
          { name: string }
        >`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`}`
      ) yield* sql`DROP SCHEMA ${sql(row.name)} CASCADE`
    })).catch(() => undefined)
  }
})
