import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import { layerMemory, SourceStore } from "../src/core/SourceStore.ts"
import { type Changes, DEFAULT_MAX_PAGES, MAX_PAGES_LIMIT, runSync, type SyncAdapter } from "../src/core/Sync.ts"
import { record, runWith, sqlLayer } from "./SourceStoreFixtures.ts"

/**
 * A provider stand-in that serves a fixed sequence of pages keyed by the
 * cursor it is asked with, and records every cursor it was asked for.
 */
const scripted = (
  pages: Readonly<Record<string, Changes | IntegrationError>>,
  overrides: Partial<SyncAdapter> = {}
) => {
  const asked: Array<string | null> = []
  const adapter: SyncAdapter = {
    provider: "example",
    connectionId: "team-chat",
    stream: "c-general",
    changes: (cursor) =>
      Effect.suspend(() => {
        asked.push(cursor)
        const answer = pages[cursor ?? "<start>"]
        if (answer === undefined) return Effect.die(new Error(`unscripted cursor ${cursor}`))
        return answer instanceof IntegrationError ? Effect.fail(answer) : Effect.succeed(answer)
      }),
    ...overrides
  }
  return { adapter, asked }
}

const changes = (ids: ReadonlyArray<string>, cursor: string | null, extra: Partial<Changes> = {}): Changes => ({
  records: ids.map((externalId) => record({ externalId })),
  cursor,
  reset: false,
  done: false,
  ...extra
})

const contract = (name: string, layer: Layer.Layer<SourceStore>) => {
  const run = runWith(layer)

  describe(name, () => {
    it("commits page after page until the adapter is done, and reports the counts", async () => {
      const { adapter, asked } = scripted({
        "<start>": changes(["a", "b"], "p1"),
        p1: changes(["b", "c"], "p2"),
        p2: changes([], "p3", { done: true })
      })
      const report = await run(runSync({ adapter }))
      expect(asked).toEqual([null, "p1", "p2"])
      expect(report).toEqual({
        provider: "example",
        connectionId: "team-chat",
        stream: "c-general",
        pages: 3,
        inserted: 3,
        updated: 0,
        unchanged: 1,
        tombstoned: 0,
        swept: 0,
        cursor: "p3",
        reset: false,
        done: true
      })
    })

    it("stops at the page budget and the next run resumes from the committed cursor", async () => {
      const { adapter, asked } = scripted({
        "<start>": changes(["a"], "p1"),
        p1: changes(["b"], "p2"),
        p2: changes(["c"], "p3", { done: true })
      })
      const [first, second, stored] = await run(Effect.gen(function*() {
        const first = yield* runSync({ adapter, maxPages: 2 })
        const second = yield* runSync({ adapter })
        return [first, second, yield* Effect.flatMap(SourceStore, (store) => store.get("team-chat", "c"))] as const
      }))
      expect(first).toMatchObject({ pages: 2, cursor: "p2", done: false })
      expect(second).toMatchObject({ pages: 1, inserted: 1, cursor: "p3", done: true })
      expect(asked).toEqual([null, "p1", "p2"])
      expect(Option.isSome(stored)).toBe(true)
    })

    it("keeps the cursor when a page names none, and re-applies a repeated page idempotently", async () => {
      const { adapter } = scripted({
        "<start>": changes(["a"], null, { done: true })
      })
      const [first, second] = await run(Effect.gen(function*() {
        return [yield* runSync({ adapter }), yield* runSync({ adapter })] as const
      }))
      expect(first).toMatchObject({ inserted: 1, cursor: null, done: true })
      expect(second).toMatchObject({ inserted: 0, unchanged: 1, cursor: null, done: true })
    })

    it("leaves earlier pages committed when the adapter fails, and resumes after them", async () => {
      const failing = scripted({
        "<start>": changes(["a"], "p1"),
        p1: new IntegrationError("poll-failed", "provider unavailable", { retryable: true })
      })
      const recovered = scripted({
        p1: changes(["b"], "p2", { done: true })
      })
      const [failure, cursor, report] = await run(Effect.gen(function*() {
        const failure = yield* Effect.flip(runSync({ adapter: failing.adapter }))
        const cursor = yield* Effect.flatMap(SourceStore, (store) => store.cursor("team-chat", "c-general"))
        return [failure, cursor, yield* runSync({ adapter: recovered.adapter })] as const
      }))
      expect(failure.reason).toBe("poll-failed")
      expect(cursor).toBe("p1")
      expect(recovered.asked).toEqual(["p1"])
      expect(report).toMatchObject({ inserted: 1, cursor: "p2", done: true })
    })

    it("tombstones what a reset listing no longer contains once the listing completes", async () => {
      const incremental = scripted({ "<start>": changes(["a", "b", "c"], "i1", { done: true }) })
      const full = scripted({
        i1: changes(["a"], "f1", { reset: true }),
        f1: changes(["c"], "f2", { done: true })
      })
      const [report, visible] = await run(Effect.gen(function*() {
        yield* runSync({ adapter: incremental.adapter })
        const report = yield* runSync({ adapter: full.adapter })
        const visible = yield* Effect.flatMap(
          SourceStore,
          (store) => store.retrieve({ allowed: [{ connectionId: "team-chat", containers: ["*"] }], limit: 10 })
        )
        return [report, visible.map((found) => found.externalId)] as const
      }))
      expect(report).toMatchObject({ pages: 2, unchanged: 2, swept: 1, reset: true, done: true })
      expect(visible).toEqual(["a", "c"])
    })

    it("carries a full listing across runs and sweeps only when it completes", async () => {
      const incremental = scripted({ "<start>": changes(["a", "b"], "i1", { done: true }) })
      const full = scripted({
        i1: changes(["a"], "f1", { reset: true }),
        f1: changes([], "f2", { done: true })
      })
      const [first, second] = await run(Effect.gen(function*() {
        yield* runSync({ adapter: incremental.adapter })
        return [
          yield* runSync({ adapter: full.adapter, maxPages: 1 }),
          yield* runSync({ adapter: full.adapter, maxPages: 1 })
        ] as const
      }))
      expect(first).toMatchObject({ swept: 0, reset: true, done: false })
      expect(second).toMatchObject({ swept: 1, reset: false, done: true })
    })

    it("refuses a revoked connection before calling the provider", async () => {
      const { adapter, asked } = scripted({ "<start>": changes(["a"], "p1", { done: true }) })
      const failure = await run(Effect.gen(function*() {
        yield* Effect.flatMap(SourceStore, (store) => store.revokeConnection("team-chat"))
        return yield* Effect.flip(runSync({ adapter }))
      }))
      expect(failure.reason).toBe("permission-denied")
      expect(asked).toEqual([])
    })

    it("refuses a page that promises more without a cursor, writing nothing", async () => {
      const { adapter } = scripted({ "<start>": changes(["a"], null) })
      const [failure, stored] = await run(Effect.gen(function*() {
        const failure = yield* Effect.flip(runSync({ adapter }))
        return [failure, yield* Effect.flatMap(SourceStore, (store) => store.get("team-chat", "a"))] as const
      }))
      expect(failure.reason).toBe("decode-failed")
      expect(Option.isNone(stored)).toBe(true)
    })

    it("refuses records from another connection", async () => {
      const { adapter } = scripted({
        "<start>": { records: [record({ connectionId: "other-chat" })], cursor: "p1", reset: false, done: true }
      })
      const failure = await run(Effect.flip(runSync({ adapter })))
      expect(failure.reason).toBe("invalid-config")
    })

    it("refuses a page budget outside 1 to the limit", async () => {
      const { adapter, asked } = scripted({})
      const failures = await run(
        Effect.forEach([0, MAX_PAGES_LIMIT + 1, 2.5], (maxPages) => Effect.flip(runSync({ adapter, maxPages })))
      )
      expect(failures.map((failure) => failure.reason)).toEqual(["invalid-config", "invalid-config", "invalid-config"])
      expect(asked).toEqual([])
      expect(DEFAULT_MAX_PAGES).toBe(10)
    })
  })
}

contract("runSync (memory)", layerMemory)
contract("runSync (SQLite)", sqlLayer as unknown as Layer.Layer<SourceStore>)

describe("runSync (SQLite) crash between page and checkpoint", () => {
  // The page's write fails inside its transaction, as a crash between writing
  // the records and checkpointing the cursor would. The earlier page stays
  // committed, the failed page leaves nothing, and a rerun resumes from the
  // earlier page's cursor.
  it("keeps the previous page, drops the failed one, and resumes from the last checkpoint", async () => {
    const run = runWith(sqlLayer)
    const { adapter, asked } = scripted({
      "<start>": changes(["a"], "p1"),
      p1: changes(["b", "poison"], "p2", { done: true })
    })
    const result = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SourceStore
      yield* Dialect.trigger(sql, {
        name: `poison`,
        table: `smithers_integration_records`,
        event: `BEFORE INSERT`,
        when: `NEW.external_id = 'poison'`,
        reject: "deliberate failure"
      })
      const failure = yield* Effect.flip(runSync({ adapter }))
      const checkpoint = yield* store.cursor("team-chat", "c-general")
      const partial = yield* store.get("team-chat", "b")
      yield* TestDatabase.dropTrigger(sql, "poison")
      const resumed = yield* runSync({ adapter })
      return { failure, checkpoint, partial, resumed }
    }))
    expect(result.failure.reason).toBe("delivery-failed")
    expect(result.checkpoint).toBe("p1")
    expect(Option.isNone(result.partial)).toBe(true)
    expect(result.resumed).toMatchObject({ pages: 1, inserted: 2, cursor: "p2", done: true })
    expect(asked).toEqual([null, "p1", "p1"])
  })
})
