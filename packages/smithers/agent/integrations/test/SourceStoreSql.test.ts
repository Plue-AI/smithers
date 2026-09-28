import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CursorStore, layerSql as cursorLayerSql } from "../src/core/CursorStore.ts"
import { integrationCursors } from "../src/core/IntegrationCursorMigration.ts"
import * as Migrations from "../src/core/Migrations.ts"
import { layerSql, SourceStore } from "../src/core/SourceStore.ts"
import { record, runWith, sqlLayer } from "./SourceStoreFixtures.ts"

const run = runWith(sqlLayer)

describe("SourceStore search contract", () => {
  it("searches case-insensitively within grants and keeps the newest matching record first", async () => {
    const found = await run(Effect.gen(function*() {
      const store = yield* SourceStore
      yield* store.apply([
        record({ externalId: "older", text: "Deploy Release", updatedAtMs: 1_000 }),
        record({ externalId: "newer", text: "release notes", updatedAtMs: 3_000 }),
        record({
          externalId: "other",
          text: "Release private",
          updatedAtMs: 4_000,
          access: { scope: "container", containerId: "c-private" },
          thread: { containerId: "c-private", threadId: null, parentId: null }
        }),
        record({ externalId: "unmatched", text: "lunch", updatedAtMs: 5_000 })
      ])
      return (yield* store.retrieve({
        allowed: [{ connectionId: "team-chat", containers: ["c-general"] }],
        query: "RELEASE",
        limit: 10
      })).map(({ externalId }) => externalId)
    }))
    expect(found).toEqual(["newer", "older"])
  })
})

const commitPage = (externalIds: ReadonlyArray<string>, cursor: string) =>
  Effect.flatMap(SourceStore, (store) =>
    store.commit({
      provider: "example",
      connectionId: "team-chat",
      stream: "c-general",
      changes: {
        records: externalIds.map((externalId) => record({ externalId })),
        cursor,
        reset: false,
        done: true
      }
    }))

describe("SourceStore (SQLite) transactions", () => {
  // A deliberately failing write inside the page's transaction: the first
  // record is written, the second aborts. Nothing of the page, and not its
  // cursor, may survive.
  it("rolls back a page's records and cursor together when a write fails mid-transaction", async () => {
    const result = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SourceStore
      yield* commitPage(["before"], "c0")
      yield* Dialect.trigger(sql, {
        name: `poison`,
        table: `smithers_integration_records`,
        event: `BEFORE INSERT`,
        when: `NEW.external_id = 'poison'`,
        reject: "deliberate failure"
      })
      const failure = yield* Effect.flip(commitPage(["first", "poison"], "c1"))
      const afterFailure = {
        cursor: yield* store.cursor("team-chat", "c-general"),
        first: yield* store.get("team-chat", "first")
      }
      yield* TestDatabase.dropTrigger(sql, "poison")
      const retried = yield* commitPage(["first", "poison"], "c1")
      return {
        failure,
        afterFailure,
        retried,
        cursor: yield* store.cursor("team-chat", "c-general"),
        first: yield* store.get("team-chat", "first")
      }
    }))
    expect(result.failure.reason).toBe("delivery-failed")
    expect(result.afterFailure.cursor).toBe("c0")
    expect(Option.isNone(result.afterFailure.first)).toBe(true)
    expect(result.retried.inserted).toBe(2)
    expect(result.cursor).toBe("c1")
    expect(Option.isSome(result.first)).toBe(true)
  })

  it("rolls back the records when the cursor write is what fails", async () => {
    const result = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SourceStore
      yield* Dialect.trigger(sql, {
        name: `poison_cursor`,
        table: `smithers_integration_cursors`,
        event: `BEFORE INSERT`,
        reject: "deliberate cursor failure"
      })
      const failure = yield* Effect.flip(commitPage(["first"], "c1"))
      return {
        failure,
        first: yield* store.get("team-chat", "first"),
        cursor: yield* store.cursor("team-chat", "c-general")
      }
    }))
    expect(result.failure.reason).toBe("delivery-failed")
    expect(Option.isNone(result.first)).toBe(true)
    expect(result.cursor).toBeNull()
  })

  it("writes the sync cursor where CursorStore reads it", async () => {
    const cursor = await Effect.runPromise(
      Effect.gen(function*() {
        yield* commitPage(["a"], "shared")
        return yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("team-chat:c-general"))
      }).pipe(
        Effect.provide(Layer.provideMerge(
          Layer.merge(layerSql, cursorLayerSql),
          Layer.provideMerge(Migrations.layer, TestDatabase.layer)
        )),
        Effect.scoped
      )
    )
    expect(cursor).toBe("shared")
  })

  it("fails typed, naming the operation, over an unmigrated database", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* SourceStore
        return [
          yield* Effect.flip(store.apply([record()])),
          yield* Effect.flip(store.get("team-chat", "m-1")),
          yield* Effect.flip(store.retrieve({ allowed: [{ connectionId: "team-chat", containers: ["*"] }], limit: 1 })),
          yield* Effect.flip(store.validate({
            allowed: [],
            references: [{
              connectionId: "team-chat",
              externalId: "m-1",
              updatedAtMs: null,
              version: null,
              retrievedAtMs: 1
            }]
          })),
          yield* Effect.flip(store.revokeConnection("team-chat")),
          yield* Effect.flip(store.reinstate("team-chat")),
          yield* Effect.flip(store.isRevoked("team-chat")),
          yield* Effect.flip(store.cursor("team-chat", "c-general")),
          yield* Effect.flip(commitPage(["a"], "c"))
        ]
      }).pipe(Effect.provide(Layer.provideMerge(layerSql, TestDatabase.layer)), Effect.scoped)
    )
    expect(failures.map((failure) => [failure.reason, failure.details?.["operation"]])).toEqual([
      ["delivery-failed", "revocation read"],
      ["delivery-failed", "read"],
      ["delivery-failed", "retrieve"],
      ["delivery-failed", "validate"],
      ["delivery-failed", "revoke"],
      ["delivery-failed", "reinstate"],
      ["delivery-failed", "revocation read"],
      ["delivery-failed", "read"],
      ["delivery-failed", "stream read"]
    ])
  })

  it("fails decode-failed on a stored row it cannot read back", async () => {
    const failure = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SourceStore
      yield* store.apply([record()])
      yield* sql`UPDATE smithers_integration_records SET payload_json = '{not json' WHERE external_id = 'm-1'`
      return yield* Effect.flip(store.get("team-chat", "m-1"))
    }))
    expect(failure.reason).toBe("decode-failed")
    expect(failure.details).toMatchObject({ connectionId: "team-chat", externalId: "m-1" })
  })
})

describe("SourceStore (SQLite) durability and migrations", () => {
  const directories: Array<string> = []

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })

  const database = () => {
    const directory = mkdtempSync(join(tmpdir(), "integrations-records-"))
    directories.push(directory)
    return join(directory, "control.db")
  }

  const open = (filename: string, sets: ReadonlyArray<DatabaseMigrations.MigrationSet> = [Migrations.set]) =>
  <A>(
    effect: Effect.Effect<A, unknown, SourceStore | CursorStore | SqlClient.SqlClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.provideMerge(
            Layer.merge(layerSql, cursorLayerSql),
            Layer.provideMerge(
              Layer.effectDiscard(DatabaseMigrations.run(sets)),
              Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
            )
          )
        ),
        Effect.scoped,
        Effect.orDie
      ) as Effect.Effect<A>
    )

  it("keeps records, cursors and revocations across a second open of the same file", async () => {
    const filename = database()
    await open(filename)(Effect.gen(function*() {
      const store = yield* SourceStore
      yield* commitPage(["a", "b"], "c1")
      yield* store.revokeContainer("other-chat", "c-private")
    }))
    const reopened = await open(filename)(Effect.gen(function*() {
      const store = yield* SourceStore
      return {
        cursor: yield* store.cursor("team-chat", "c-general"),
        found:
          (yield* store.retrieve({ allowed: [{ connectionId: "team-chat", containers: ["c-general"] }], limit: 10 }))
            .map((found) => found.externalId),
        revoked: yield* store.isRevoked("other-chat", "c-private")
      }
    }))
    expect(reopened).toEqual({ cursor: "c1", found: ["a", "b"], revoked: true })
  })

  // A control database that already holds the cursor table gains the record
  // tables as an append to the integrations block, without losing a cursor.
  it("appends the record tables to a database that only has the cursor migration", async () => {
    const filename = database()
    const cursorsOnly: DatabaseMigrations.MigrationSet = {
      ...Migrations.set,
      migrations: { "0001_integration_cursors": integrationCursors }
    }
    await open(filename, [cursorsOnly])(
      Effect.flatMap(CursorStore, (cursors) => cursors.set("telegram", "42"))
    )
    const [cursor, ledger] = await open(filename)(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* commitPage(["a"], "c1")
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
      return [
        yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("telegram")),
        rows.map((row) => [Number(row.migration_id), row.name])
      ] as const
    }))
    expect(cursor).toBe("42")
    expect(ledger).toEqual([
      [8001, "integrations_integration_cursors"],
      [8002, "integrations_integration_records"]
    ])
  })
})
