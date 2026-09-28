/**
 * The two ways the lineage projection can be asked a question the database
 * cannot answer.
 *
 * Everything the projection gets RIGHT is proved in `EngineLineage.test.ts`
 * against rows a real engine and a real `TimeTravel.fork` wrote; a lineage
 * assertion over run rows a test hand-wrote would agree with the fixture and
 * nothing else. What is left here is the pair of failure shapes, which no
 * engine produces on purpose: a composition whose journal lives somewhere
 * else, and a journal table that exists but no longer answers.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

/** A durable run store with no journal table beside it. */
const database = Layer.provideMerge(
  Layer.mergeAll(RunStore.layer, NodeCrypto.layer),
  Layer.provideMerge(RunStoreMigrations.layer, TestDatabase.layer)
)

describe("control run lineage over a database that cannot answer", () => {
  it("projects ancestry over a database whose journal keeps no table here", async () => {
    // A composition whose journal is somewhere else: the run store is durable,
    // `flows_journal_events` does not exist, and the honest answer to "is this
    // a fork?" is "no evidence", not a failed projection.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* SqlControlRuntime.make()
        const store = yield* RunStore.RunStore
        yield* store.create("solo", JSON.stringify({ version: 1, flowName: "Reviewer", payload: {} })).pipe(
          Effect.orDie
        )
        yield* store.create(
          "spawn",
          JSON.stringify({ version: 1, flowName: "Reviewer", payload: {} }),
          { parentRunId: "solo" }
        ).pipe(Effect.orDie)
        return yield* Effect.all({
          solo: runtime.getRun("solo"),
          spawn: runtime.getRun("spawn"),
          listed: Effect.map(runtime.queryRuns({ limit: 500 }), (page) => page.items)
        })
      }).pipe(Effect.provide(database), Effect.scoped, Effect.orDie)
    )

    expect(observed.solo).toMatchObject({ runId: "solo", flowId: "Reviewer", status: "accepted" })
    expect(observed.solo.origin).toBeUndefined()
    expect(observed.spawn).toMatchObject({ parentRunId: "solo", origin: "child" })
    expect(observed.listed.map((item) => item.runId)).toEqual(["solo", "spawn"])
  })

  it("refuses to call a broken fork query no fork evidence", async () => {
    // A journal table that exists but does not answer the fork question — a
    // partially migrated database, a schema the deployment never finished — is
    // not the same as no journal at all. Reading "no fork evidence" out of it
    // would report every fork in the deployment as an ordinary child, and it
    // would report it silently.
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE flows_journal_events (unrelated TEXT)`.pipe(Effect.orDie)
        const runtime = yield* SqlControlRuntime.make()
        const store = yield* RunStore.RunStore
        yield* store.create("solo", JSON.stringify({ version: 1, flowName: "Reviewer", payload: {} })).pipe(
          Effect.orDie
        )
        return yield* Effect.flip(runtime.getRun("solo"))
      }).pipe(Effect.provide(database), Effect.scoped, Effect.orDie)
    )

    expect(failure._tag).toBe("/control/PersistenceError")
  })
})
