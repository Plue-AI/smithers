import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as PostgresDatabase from "@smthrs/database/postgres/PostgresDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Crypto, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Migrations from "../src/Migrations.ts"

const url = process.env.SMITHERS_TEST_PG_URL

// Unset SMITHERS_TEST_PG_URL: the default unit suite needs no PostgreSQL service.
const crypto = Layer.succeed(Crypto.Crypto)(Crypto.make({
  randomBytes,
  digest: (algorithm, data) => Effect.succeed(createHash(algorithm.replaceAll("-", "")).update(data).digest())
}))

it.skipIf(!url)(
  "backfills PostgreSQL FTS and upgrades legacy accents without losing namespace or phrase filtering (requires SMITHERS_TEST_PG_URL)",
  async () => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`
    const database = Layer.provideMerge(
      DurableWriter.layer(),
      PostgresDatabase.layer({ url: url!, schema })
    )
    const memory = Layer.provideMerge(MemoryStore.layer, Layer.merge(database, crypto))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* SqlClient.SqlClient
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
        const namespace = { kind: "flow", id: "fold" } as const
        const put = (key: string, value: unknown) => store.putFact({ namespace, key, value, provenance: {} })
        yield* put("string", "Café naïve résumé")
        yield* put("content", { content: "Café naïve résumé" })
        yield* put("json", { menu: "Café naïve résumé" })
        yield* put("separated", "cafe distant naive resume")
        yield* store.putNote({ namespace, id: "note", text: "Café naïve résumé", tags: [], provenance: {} })
        yield* store.putFact({ namespace: "other", key: "foreign", value: "Café naïve résumé", provenance: {} })
        yield* store.enableFts("flow")
        const search = (query: string, limit = 10) =>
          store.searchFts({ namespace, query, limit }).pipe(Effect.map((rows) => rows.map((row) => row.key)))
        const backfilled = yield* search("cafe naive resume")
        const phrase = yield* search("cafe—naive resume")
        const limited = yield* search("cafe naive resume", 2)
        yield* sql`ALTER TABLE memory_fts_flow DROP COLUMN search`
        yield* sql`ALTER TABLE memory_fts_flow ADD COLUMN search TSVECTOR GENERATED ALWAYS AS (
          to_tsvector('simple', record_key || ' ' || text)
        ) STORED`
        const before = yield* search("cafe naive resume")
        yield* sql`DELETE FROM flows_migrations WHERE migration_id >= 7003`
        const applied = yield* Migrations.run
        const after = yield* search("CAFE naive resume")
        const indexes = yield* sql<{ readonly name: string }>`SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = 'memory_fts_flow'`
        return { backfilled, phrase, limited, before, applied, after, indexes }
      }).pipe(Effect.scoped, Effect.provide(memory))
    )
    expect(result.backfilled).toHaveLength(5)
    expect([...result.backfilled].sort()).toEqual(["content", "json", "note", "separated", "string"])
    expect([...result.phrase].sort()).toEqual(["content", "json", "note", "string"])
    expect(result.limited).toEqual(result.backfilled.slice(0, 2))
    expect(result.before).toEqual(["separated"])
    expect(result.applied).toEqual([[7003, "memory_fts_fold"], [7004, "memory_note_lifecycle"]])
    expect(result.after).toEqual(result.backfilled)
    expect(result.indexes).toEqual([{ name: "memory_fts_flow_search" }])
  }
)
