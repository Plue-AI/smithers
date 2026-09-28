// Runs under real Bun (spawned by NativeBunAffectedRows.test.ts): no shim or Node SQLite.
import * as BunDatabase from "@smthrs/database/bun/BunDatabase"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import { Crypto, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { createHash, randomBytes } from "node:crypto"
import * as MemoryStore from "../../src/MemoryStore.ts"

const crypto = Layer.succeed(Crypto.Crypto)(Crypto.make({
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  digest: (algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest()))
}))

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  const count = <E, R>(raw: Effect.Effect<unknown, E, R>) =>
    writer.write(raw.pipe(Effect.flatMap(DurableWriter.affectedRows)))
  yield* sql`CREATE TABLE affected (id INTEGER PRIMARY KEY)`
  const insert = yield* count(sql`INSERT INTO affected(id) VALUES (1)`.raw)
  const conflictIgnore = yield* count(sql`INSERT OR IGNORE INTO affected(id) VALUES (1)`.raw)
  const returning = yield* sql`INSERT INTO affected(id) VALUES (2) RETURNING id`.raw
  const deleteMatch = yield* count(sql`DELETE FROM affected WHERE id = 1`.raw)
  const deleteMiss = yield* count(sql`DELETE FROM affected WHERE id = 1`.raw)
  const transaction = yield* sql.withTransaction(count(sql`DELETE FROM affected WHERE id = 2`.raw))
  const remaining = yield* sql`SELECT id FROM affected`

  const store = yield* MemoryStore.MemoryStore
  const fact = { namespace: "flow-bun-affected", key: "key" }
  yield* store.putFact({ ...fact, value: "stored", provenance: {} })
  const deleted = yield* store.deleteFact(fact)
  const deletedAgain = yield* store.deleteFact(fact)
  const after = (yield* store.getFact(fact)) ?? null
  return {
    insert,
    conflictIgnore,
    returning,
    deleteMatch,
    deleteMiss,
    transaction,
    remaining,
    deleted,
    deletedAgain,
    after
  }
})

const database = Layer.provideMerge(DurableWriter.layer(), BunDatabase.layer({ filename: ":memory:" }))
const result = await Effect.runPromise(
  program.pipe(Effect.provide(Layer.provideMerge(MemoryStore.layer, Layer.merge(crypto, database))), Effect.scoped)
)
console.log(JSON.stringify(result))
