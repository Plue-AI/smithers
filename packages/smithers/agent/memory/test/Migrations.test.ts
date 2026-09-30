import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Exit, Layer } from "effect"
import * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const testCrypto = Layer.succeed(Crypto.Crypto)(Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data)
}))

interface ColumnRow {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

interface IndexRow {
  readonly name: string
  readonly unique: number
}

interface NameRow {
  readonly name: string
}

interface SchemaRow {
  readonly name: string
  readonly sql: string | null
}

/**
 * Extracts the multiset of `CHECK (...)` clauses from a table definition.
 * SQLite does not expose them through PRAGMA, and they carry the invariants
 * this package relies on, so they are compared as a sorted set of texts.
 */
const checkClauses = (definition: string): ReadonlyArray<string> => {
  const clauses: Array<string> = []
  for (let index = definition.indexOf("CHECK ("); index >= 0; index = definition.indexOf("CHECK (", index + 1)) {
    let depth = 0
    for (let cursor = index + "CHECK ".length; cursor < definition.length; cursor++) {
      if (definition[cursor] === "(") depth++
      else if (definition[cursor] === ")") {
        depth--
        if (depth > 0) continue
        clauses.push(definition.slice(index, cursor + 1).replaceAll(/\s+/gu, " "))
        break
      }
    }
  }
  return clauses.sort()
}

/**
 * Describes the memory schema in a way that is insensitive to physical column
 * order and to the quoted table name a `RENAME TO` rebuild leaves behind, and
 * sensitive to everything that changes behaviour: which tables exist, their
 * columns and types, nullability, primary keys, indexes, and CHECK clauses.
 */
const describeSchema = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const tables = yield* sql<SchemaRow>`
    SELECT name, sql FROM ${TestDatabase.catalog(sql)}
    WHERE type = 'table' AND name LIKE 'memory_%'
    ORDER BY name
  `
  const described: Array<string> = []
  for (const table of tables) {
    const columns = yield* sql<ColumnRow>`PRAGMA table_info(${sql.unsafe(table.name)})`
    const indexes = yield* sql<IndexRow>`PRAGMA index_list(${sql.unsafe(table.name)})`
    const indexDescriptions: Array<string> = []
    for (const index of indexes) {
      // An implicit index SQLite creates for a primary key or a unique
      // constraint is already described by the column rows below.
      if (index.name.startsWith("sqlite_autoindex_")) continue
      const columnsInIndex = yield* sql<NameRow>`PRAGMA index_info(${sql.unsafe(index.name)})`
      indexDescriptions.push(`${index.name}(unique=${index.unique}) ${columnsInIndex.map((row) => row.name).join(",")}`)
    }
    described.push([
      `table ${table.name}`,
      ...[...columns]
        .map((column) => `  column ${column.name} ${column.type} notnull=${column.notnull} pk=${column.pk}`)
        .sort(),
      ...indexDescriptions.sort().map((value) => `  index ${value}`),
      ...checkClauses(table.sql ?? "").map((value) => `  ${value}`)
    ].join("\n"))
  }
  return described
})

describe("memory migrations", () => {
  it("upgrades the legacy global message key without losing rows", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE memory_threads (
          thread_id TEXT PRIMARY KEY,
          namespace_kind TEXT NOT NULL,
          namespace_id TEXT NOT NULL,
          title TEXT,
          metadata_json TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )`
        yield* sql`CREATE TABLE memory_messages (
          id TEXT PRIMARY KEY CHECK (length(id) > 0),
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          at_ms INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES memory_threads (thread_id)
        )`
        yield* sql`CREATE INDEX memory_messages_thread_order_idx
          ON memory_messages (thread_id, at_ms, id)`
        yield* sql`INSERT INTO memory_threads (
          thread_id, namespace_kind, namespace_id, created_at_ms, updated_at_ms
        ) VALUES ('legacy-thread', 'global', 'history', 1, 1)`
        yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
          VALUES ('shared', 'legacy-thread', 'user', 'legacy', 1)`
        const store = yield* MemoryStore.make
        yield* store.appendMessage({ threadId: "new-thread", id: "shared", role: "assistant", text: "new", at: 2 })
        const table = yield* sql<{ readonly sql: string }>`SELECT sql FROM ${TestDatabase.catalog(sql)}
          WHERE type = 'table' AND name = 'memory_messages'`
        return {
          definition: table[0]?.sql,
          messages: yield* Effect.all([
            store.listMessages({ threadId: "legacy-thread" }),
            store.listMessages({ threadId: "new-thread" })
          ])
        }
      }).pipe(Effect.provide(TestDatabase.sqliteLayer), Effect.provide(testCrypto))
    )

    expect(result.definition).toMatch(/PRIMARY KEY\s*\(\s*thread_id\s*,\s*id\s*\)/iu)
    expect(result.messages).toEqual([
      [{ threadId: "legacy-thread", id: "shared", role: "user", text: "legacy", at: 1 }],
      [{ threadId: "new-thread", id: "shared", role: "assistant", text: "new", at: 2 }]
    ])
  })

  it("records the completed memory schema exactly once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Migrations.run
        const second = yield* Migrations.run
        const sql = yield* SqlClient.SqlClient
        const recorded = yield* sql`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
        return { first, second, recorded }
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(result.first).toEqual([[7001, "memory_initial"], [7002, "memory_indexes"], [7003, "memory_fts_fold"]])
    expect(result.second).toEqual([])
    expect(result.recorded).toEqual([
      { migration_id: 7001, name: "memory_initial" },
      { migration_id: 7002, name: "memory_indexes" },
      { migration_id: 7003, name: "memory_fts_fold" }
    ])
  })

  // PostgreSQL FTS tables enabled before the fold carry a search column that
  // keeps accents. The migration regenerates it so rows indexed then match a
  // folded query; on SQLite, FTS5 already folds and the migration is a no-op.
  it("regenerates PostgreSQL FTS search columns that predate the diacritic fold", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* MemoryStore.MemoryStore
        const namespace = { kind: "flow", id: "fold" } as const
        yield* store.putFact({ namespace, key: "menu", value: "Café naïve résumé", provenance: {} })
        yield* store.enableFts("flow")
        if (Dialect.isPostgres(sql)) {
          yield* sql`ALTER TABLE memory_fts_flow DROP COLUMN search`
          yield* sql`ALTER TABLE memory_fts_flow ADD COLUMN search TSVECTOR GENERATED ALWAYS AS (
            to_tsvector('simple', regexp_replace((record_key || ' ' || text) COLLATE "pg_c_utf8",
              '[^[:alnum:]]+', ' ', 'g'))
          ) STORED`
        }
        const search = (query: string) =>
          store.searchFts({ namespace, query, limit: 5 }).pipe(Effect.map((rows) => rows.map((row) => row.key)))
        const before = yield* search("cafe")
        yield* sql`DELETE FROM flows_migrations WHERE migration_id = 7003`
        const applied = yield* Migrations.run
        const indexes = Dialect.isPostgres(sql) ?
          yield* sql<NameRow>`SELECT indexname AS name FROM pg_indexes WHERE tablename = 'memory_fts_flow'` :
          []
        return {
          postgres: Dialect.isPostgres(sql),
          before,
          applied,
          after: [yield* search("cafe"), yield* search("naive"), yield* search("RESUME"), yield* search("café")],
          indexes: indexes.map((row) => row.name)
        }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result.before).toEqual(result.postgres ? [] : ["menu"])
    expect(result.applied).toEqual([[7003, "memory_fts_fold"]])
    expect(result.after).toEqual([["menu"], ["menu"], ["menu"], ["menu"]])
    expect(result.indexes).toEqual(result.postgres ? ["memory_fts_flow_search"] : [])
  })

  // A database that recorded only memory_initial before the index migration
  // existed still carries the unusable expiry index. Migrating it must run the
  // later migrations, swap the index, and add the supersedes lookup.
  it("upgrades a database that only recorded memory_initial", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* Migrations.run
        yield* sql`DROP INDEX memory_facts_expires_at_idx`
        yield* sql`DROP INDEX memory_note_supersedes_target_idx`
        yield* sql`CREATE INDEX memory_facts_expiry_idx
          ON memory_facts (updated_at_ms, ttl_ms) WHERE ttl_ms IS NOT NULL`
        yield* sql`DELETE FROM flows_migrations WHERE migration_id >= 7002`
        const before = yield* sql<
          NameRow
        >`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE type = 'index' AND name LIKE 'memory_facts_%'`
        const applied = yield* Migrations.run
        const after = yield* sql<NameRow>`SELECT name FROM ${TestDatabase.catalog(sql)}
          WHERE type = 'index' AND (name LIKE 'memory_facts_%' OR name LIKE 'memory_note_supersedes_%')
          ORDER BY name`
        return { applied, before: before.map((row) => row.name), after: after.map((row) => row.name) }
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(result.before).toEqual(["memory_facts_expiry_idx"])
    expect(result.applied).toEqual([[7002, "memory_indexes"], [7003, "memory_fts_fold"]])
    expect(result.after).toEqual(["memory_facts_expires_at_idx", "memory_note_supersedes_target_idx"])
  })

  // The expiry sweep filters on the computed sum, and every default note read
  // asks whether an accepted note supersedes the candidate. Both must be index
  // lookups, not scans: the reviewer's probe measured a 40-note page at
  // hundreds of milliseconds against a few thousand edges without them.
  it("serves the expiry sweep and the supersession filter from indexes", async () => {
    const plans = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Migrations.run
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const explain = (query: string) =>
          TestDatabase.explain(sql, sql`${sql.literal(query)}`).pipe(
            Effect.map((rows) => rows.map((row) => row.detail).join("\n"))
          )
        return {
          expiry: yield* explain(`SELECT namespace_kind, namespace_id, fact_key FROM memory_facts
            WHERE ttl_ms IS NOT NULL AND updated_at_ms + ttl_ms <= 5 LIMIT 256`),
          notes: yield* explain(`SELECT notes.id FROM memory_notes notes
            WHERE notes.namespace_kind = 'flow' AND notes.namespace_id = 'bank' AND notes.status = 'accepted'
              AND NOT EXISTS (
                SELECT 1 FROM memory_note_supersedes edges
                JOIN memory_notes superseder ON superseder.id = edges.superseder_id
                WHERE edges.target_id = notes.id AND superseder.status = 'accepted')
            ORDER BY notes.created_at_ms DESC, notes.id LIMIT 40`)
        }
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(plans.expiry).toContain("memory_facts_expires_at_idx")
    expect(plans.notes).toContain("memory_note_supersedes_target_idx")
    expect(plans.notes).not.toContain("SCAN edges")
  })

  it("rolls back partial schema creation without recording a failed migration", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        // A conflicting table makes index creation fail after memory_facts was
        // created. Both the new table and the migration identity must roll back.
        yield* sql`CREATE TABLE memory_vectors (invalid INTEGER)`
        const failure = yield* Effect.exit(Migrations.run)
        const facts = yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'memory_facts'`
        const recorded = yield* sql`SELECT migration_id FROM flows_migrations`
        return { failure, facts, recorded }
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(Exit.isFailure(result.failure)).toBe(true)
    expect(result.facts).toEqual([])
    expect(result.recorded).toEqual([])
  })

  // A database written before migration 0005 has a `memory_facts` table with no
  // `tags_json` column. Opening the store over it must add the column and keep
  // the rows, not fail and not start over.
  it("adds the fact tags column to a database written before it existed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE memory_facts (
          namespace_kind TEXT NOT NULL,
          namespace_id TEXT NOT NULL,
          fact_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          ttl_ms INTEGER,
          provenance_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (namespace_kind, namespace_id, fact_key)
        )`
        yield* sql`INSERT INTO memory_facts (
          namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
          provenance_json, created_at_ms, updated_at_ms
        ) VALUES ('flow', 'legacy', 'kept', '"survivor"', NULL, '{}', 0, 0)`

        const store = yield* MemoryStore.make
        const columns = yield* Dialect.columns(sql, "memory_facts")
        const facts = yield* store.listFacts({ namespace: { kind: "flow", id: "legacy" } })
        return { columns: columns.map((column) => column.name), facts }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.provide(testCrypto))
    )

    expect(result.columns).toContain("tags_json")
    expect(result.facts.map((fact) => [fact.key, fact.value])).toEqual([["kept", "survivor"]])
  })

  it("reopens the store over a populated database without losing rows or search", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* MemoryStore.MemoryStore
        yield* first.putFact({
          namespace: { kind: "flow", id: "reopen" },
          key: "runbook",
          value: { content: "restore the primary", tags: ["scope:project"] },
          provenance: {}
        })
        yield* first.enableFts("flow")
        const before = yield* first.searchFts({
          namespace: { kind: "flow", id: "reopen" },
          query: "restore",
          limit: 10
        })

        // Rebuilding the service on one connection must not reset rows or
        // search. DurableMemory.test.ts separately exercises process restart.
        const second = yield* MemoryStore.make
        const facts = yield* second.listFacts({ namespace: { kind: "flow", id: "reopen" } })
        const after = yield* second.searchFts({
          namespace: { kind: "flow", id: "reopen" },
          query: "restore",
          limit: 10
        })

        return { after: after.map((row) => row.key), before: before.map((row) => row.key), facts: facts.length }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.before).toEqual(["runbook"])
    expect(result.facts).toBe(1)
    expect(result.after).toEqual(["runbook"])
  })
})
