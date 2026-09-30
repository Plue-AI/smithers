/**
 * A consistent copy of one local store, for work that must not touch the
 * original: `smthrs runs verify` resumes a run on a copy.
 *
 * A SQLite store is copied with `VACUUM INTO`, inside one read transaction. A
 * PostgreSQL store is a schema, copied into the schema the copy's filename
 * selects, which the copy creates and so must not exist: its trigger
 * functions, tables with their defaults, identities and checks, rows,
 * identity positions, then keys, indexes and triggers under their own names,
 * all in one transaction that holds the source schema's writer lock, so the
 * copy is one moment of the source and a failed copy leaves no schema. A copy
 * that would still reach into the source (a sequence or function it does not
 * own, a function pinned to another search path or naming the source) is
 * refused and rolled back.
 *
 * @since 1.0.0
 */

import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as CliError from "../CliError.ts"

/**
 * Where the store at `filename` lives on PostgreSQL, or `undefined` for SQLite.
 *
 * @since 1.0.0
 * @category getters
 */
export const postgres = (filename: string) => NodeDatabase.postgresLocation(filename)

/** Opens `filename` read-only for `body`. */
const reading = <A, E>(filename: string, body: Effect.Effect<A, E, SqlClient>) =>
  body.pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))

/** The URL that opens exactly `schema` on the server at `url`. */
const schemaUrl = (url: string, schema: string): string => {
  const parsed = new URL(url)
  parsed.searchParams.set("schema", schema)
  return parsed.toString()
}

/** Every schema-qualified reference to `from` in a definition, pointed at `to`. */
const requalify = (definition: string, from: string, to: string): string => definition.replaceAll(`${from}.`, `${to}.`)

const unsafe = (message: string) => new CliError.Refused({ fault: "bug", code: "verify_copy_unsafe", message })

/**
 * Copies the PostgreSQL schema `from` into `to`, which it creates, on the
 * server at `url`.
 */
const copySchema = (url: string, from: string, to: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    yield* sql.withTransaction(Effect.gen(function*() {
      // Every writer of the source holds this lock for its transaction.
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${from}, 2099))`
      // Created here, never adopted: an existing schema fails the copy, and a
      // failed copy rolls the new schema back with everything else.
      yield* sql`CREATE SCHEMA ${sql(to)}`
      // Unqualified names in the definitions below resolve into the copy.
      yield* sql`SELECT set_config('search_path', quote_ident(${to}), true)`
      const [names] = yield* sql<{ source: string; target: string }>`
        SELECT quote_ident(${from}) AS source, quote_ident(${to}) AS target`
      const source = names!.source
      const target = names!.target
      const functions = yield* sql<{ name: string; definition: string; config: string | null; body: string }>`
        SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition,
          array_to_string(p.proconfig, ',') AS config, p.prosrc AS body FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${from} AND p.prokind = 'f' ORDER BY p.proname`
      for (const row of functions) {
        // A body resolves its names on the caller's search path, which is the
        // copy's; one pinned elsewhere or naming the source would reach it.
        if (row.config !== null || row.body.includes(from)) {
          return yield* Effect.fail(unsafe(`Function ${row.name} of ${from} cannot be copied apart from it`))
        }
        yield* sql.unsafe(requalify(row.definition, source, target))
      }
      const tables = yield* sql<{ name: string; columns: string }>`
        SELECT quote_ident(c.relname) AS name,
          (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${from} AND c.relkind IN ('r', 'p') ORDER BY c.relname`
      for (const table of tables) {
        // Indexes and their constraints come after the rows, under their own names.
        yield* sql.unsafe(
          `CREATE TABLE ${target}.${table.name} (LIKE ${source}.${table.name} INCLUDING ALL EXCLUDING INDEXES)`
        )
        yield* sql.unsafe(
          `INSERT INTO ${target}.${table.name} (${table.columns}) OVERRIDING SYSTEM VALUE ` +
            `SELECT ${table.columns} FROM ${source}.${table.name}`
        )
      }
      // An identity continues where the source's did, so a row the copy
      // writes never collides with a copied one.
      const identities = yield* sql<{ name: string; column: string }>`
        SELECT quote_ident(c.relname) AS name, a.attname AS column FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${from} AND a.attidentity <> '' AND NOT a.attisdropped ORDER BY c.relname, a.attnum`
      for (const identity of identities) {
        const [position] = yield* sql<{ lastValue: number | null }>`
          SELECT s.last_value AS "lastValue" FROM pg_sequences s
          WHERE format('%I.%I', s.schemaname, s.sequencename)::regclass =
            pg_get_serial_sequence(${`${source}.${identity.name}`}, ${identity.column})::regclass`
        // A sequence nothing has drawn from starts where the copy's does.
        if (position?.lastValue === null || position === undefined) continue
        yield* sql`SELECT setval(pg_get_serial_sequence(${`${target}.${identity.name}`}, ${identity.column}), ${position.lastValue})`
      }
      // Keys first, so a foreign key finds the key it references.
      const constraints = yield* sql<{ name: string; table: string; definition: string }>`
        SELECT quote_ident(con.conname) AS name, quote_ident(c.relname) AS table,
          pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${from} AND con.contype IN ('p', 'u', 'x', 'f')
        ORDER BY con.contype = 'f', c.relname, con.conname`
      for (const constraint of constraints) {
        yield* sql.unsafe(
          `ALTER TABLE ${target}.${constraint.table} ADD CONSTRAINT ${constraint.name} ${
            requalify(constraint.definition, source, target)
          }`
        )
      }
      const indexes = yield* sql<{ definition: string }>`
        SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${from}
          AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
        ORDER BY c.relname`
      for (const row of indexes) yield* sql.unsafe(requalify(row.definition, source, target))
      const triggers = yield* sql<{ definition: string }>`
        SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${from} AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`
      for (const row of triggers) yield* sql.unsafe(requalify(row.definition, source, target))
      // Nothing the copy holds may depend on anything the source holds: a
      // default drawing from the source's sequence would advance it.
      // A default, trigger or rule names no schema of its own; its table does.
      const reaching = yield* sql<{ object: string; referenced: string }>`
        SELECT o.type || ' ' || o.identity AS object, r.identity AS referenced FROM pg_depend d
        CROSS JOIN LATERAL pg_identify_object(d.classid, d.objid, d.objsubid) o
        CROSS JOIN LATERAL pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid) r
        WHERE r.schema = ${from} AND ${to} = COALESCE(o.schema, (
          SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = CASE d.classid
            WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = d.objid)
            WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = d.objid)
            WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = d.objid)
            WHEN 'pg_constraint'::regclass THEN (SELECT conrelid FROM pg_constraint WHERE oid = d.objid)
          END))
        LIMIT 1`
      if (reaching.length > 0) {
        return yield* Effect.fail(
          unsafe(`The copy of ${from} would reach its source: ${reaching[0]!.object} uses ${reaching[0]!.referenced}`)
        )
      }
    }))
  }).pipe(
    // The server's catalog schema: opening it creates nothing of the copy's.
    Effect.provide(NodeDatabase.layer({ filename: schemaUrl(url, "public") }))
  )

/**
 * Copies the store at `from` to `to`, on the backend `from` is on. `to` must be
 * a filename the same backend places apart from `from`: a new SQLite file, or
 * a filename whose PostgreSQL schema does not exist yet.
 *
 * @since 1.0.0
 * @category constructors
 */
export const copy = (from: string, to: string): Effect.Effect<void, unknown> => {
  const source = postgres(from)
  if (source === undefined) return reading(from, Effect.flatMap(SqlClient, (sql) => sql`VACUUM INTO ${to}`))
  const target = postgres(to)
  if (target === undefined || target.url !== source.url || target.schema === source.schema) {
    return Effect.fail(unsafe("A copy of a PostgreSQL store needs a schema of its own on the same server"))
  }
  return copySchema(source.url, source.schema, target.schema)
}

/**
 * Removes a copy {@link copy} made: a PostgreSQL copy's schema. Call it only
 * for a copy that succeeded, which is the only kind whose schema this caller
 * created. A SQLite copy is a file its caller deletes with the directory it
 * made for it.
 *
 * @since 1.0.0
 * @category destructors
 */
export const discard = (to: string): Effect.Effect<void, unknown> => {
  const target = postgres(to)
  if (target === undefined) return Effect.void
  return Effect.flatMap(SqlClient, (sql) => sql`DROP SCHEMA IF EXISTS ${sql(target.schema)} CASCADE`).pipe(
    Effect.asVoid,
    Effect.provide(NodeDatabase.layer({ filename: schemaUrl(target.url, "public") }))
  )
}
