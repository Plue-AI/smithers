import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import { literalFtsQuery } from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import { namespace, other, run, runWithDatabase } from "./fixtures/MemoryStoreHarness.ts"

describe("MemoryStore search and FTS", () => {
  it("can retrieve superseded notes from an unfiltered FTS history query", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "old", text: "durable old guidance", tags: [], provenance: {} })
      yield* store.putNote({
        namespace,
        id: "new",
        text: "durable revised guidance",
        tags: [],
        provenance: {},
        supersedes: ["old"]
      })
      yield* store.enableFts("flow")
      const current = yield* store.searchFts({ namespace, query: "durable" })
      const history = yield* store.searchFts({ namespace, query: "durable", includeSuperseded: true })
      return { current, history }
    }))
    expect(result.current.map((row) => row.key)).toEqual(["new"])
    expect(result.history.map((row) => row.key).sort()).toEqual(["new", "old"])
  })

  it("filters note matches by prefix after FTS ranking", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (const id of ["note-runbook", "other-runbook"]) {
        yield* store.putNote({ namespace, id, text: "durable recovery", tags: [], provenance: {} })
      }
      yield* store.enableFts("flow")
      return yield* store.searchFts({ namespace, query: "durable", prefix: "note-", limit: 1 })
    }))
    expect(rows.map((row) => [row.kind, row.key, row.text])).toEqual([
      ["note", "note-runbook", "durable recovery"]
    ])
  })

  it("filters authoritative raw rows by tags, status, and supersession", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "fact-1",
        value: { content: "fact text", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-1",
        text: "note text",
        tags: ["scope:project", "branch:main"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "not authoritative",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      return yield* store.searchRows({
        namespace,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
    }))

    expect(rows.map((row) => [row.kind, row.key, row.text])).toEqual([
      ["fact", "fact-1", "fact text"],
      ["note", "note-1", "note text"]
    ])
    expect(rows.every((row) => row.bank === "flow-project-1")).toBe(true)
  })

  it("fails loudly before FTS enablement, then backfills and updates the per-kind index", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-fts",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      const disabled = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 10 }))
      yield* store.enableFts("flow")
      const backfilled = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "fresh recovery procedure", tags: ["scope:project"] },
        provenance: {}
      })
      const stale = yield* store.searchFts({ namespace, query: "checkout", limit: 10 })
      const fresh = yield* store.searchFts({ namespace, query: "fresh recovery", limit: 10 })
      const compiled = yield* store.searchFts({
        namespace,
        query: literalFtsQuery("fresh recovery"),
        limit: 10
      })
      return { disabled, backfilled, stale, fresh, compiled }
    }))

    expect(result.disabled.code).toBe("fts_not_enabled")
    expect(result.backfilled.map((row) => row.key).sort()).toEqual(["note-fts", "runbook"])
    expect(result.stale).toEqual([])
    expect(result.fresh.map((row) => row.key)).toEqual(["runbook"])
    expect(result.compiled.map((row) => row.key)).toEqual(["runbook"])
    expect(result.fresh[0]?.rank).toEqual(expect.any(Number))
  })

  it("indexes backfilled facts with the same text and query semantics as live writes", async () => {
    const vectors = [
      { value: "rootstringtoken", queries: [["rootstringtoken", true]] as const },
      {
        value: {
          content: "contenttoken",
          tags: ["scope:tagonlytoken"],
          hiddenkeytoken: "ignored"
        },
        queries: [["contenttoken", true], ["tagonlytoken", false], ["hiddenkeytoken", false]] as const
      },
      {
        value: { indexedkeytoken: "objectvaluetoken" },
        queries: [["objectvaluetoken", true], ["indexedkeytoken", true]] as const
      },
      { value: ["arraytoken"], queries: [["arraytoken", true]] as const },
      { value: "Unicode café 東京", queries: [["café", true], ["東京", true]] as const }
    ] as const
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      for (const [index, vector] of vectors.entries()) {
        yield* store.putFact({ namespace, key: `before-${index}`, value: vector.value, provenance: {} })
      }
      yield* store.enableFts("flow")
      for (const [index, vector] of vectors.entries()) {
        yield* store.putFact({ namespace, key: `after-${index}`, value: vector.value, provenance: {} })
      }
      const rows = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow
        WHERE namespace_id = 'project-1' AND record_kind = 'fact'
        ORDER BY record_id
      `
      const matches: Array<readonly [string, boolean, ReadonlyArray<string>]> = []
      for (const vector of vectors) {
        for (const [query, expectedMatch] of vector.queries) {
          const found = yield* store.searchFts({ namespace, query, limit: 20 })
          matches.push([query, expectedMatch, found.map((row) => row.id).sort()])
        }
      }
      return { rows, matches }
    }))

    const textById = new Map(result.rows.map((row) => [row.record_id, row.text]))
    for (const index of vectors.keys()) {
      expect(textById.get(`before-${index}`)).toBe(textById.get(`after-${index}`))
    }
    for (const [query, expectedMatch, ids] of result.matches) {
      const index = vectors.findIndex((vector) => vector.queries.some(([term]) => term === query))
      expect(ids).toEqual(expectedMatch ? [`after-${index}`, `before-${index}`] : [])
    }
  })

  it("orders, tags, and limits authoritative raw rows", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "plain", value: "a bare string", provenance: {} })
      yield* store.putFact({
        namespace,
        key: "tagged",
        value: { content: "structured", tags: ["scope:project", 7] },
        provenance: {}
      })
      const all = yield* store.searchRows({ namespace })
      const none = yield* store.searchRows({ namespace, limit: 0 })
      const one = yield* store.searchRows({ namespace, limit: 1 })
      const generous = yield* store.searchRows({ namespace, limit: 99 })
      const single = yield* store.searchRows({
        namespace,
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      })
      const negative = yield* Effect.flip(store.searchRows({ namespace, limit: -1 }))
      const fractional = yield* Effect.flip(store.searchRows({ namespace, limit: 1.5 }))
      return { all, none, one, generous, single, negative, fractional }
    }))

    expect(result.all.map((row) => [row.key, row.text, row.tags])).toEqual([
      ["plain", "a bare string", []],
      ["tagged", "structured", ["scope:project"]]
    ])
    expect(result.none).toEqual([])
    expect(result.one.map((row) => row.key)).toEqual(["plain"])
    expect(result.generous).toHaveLength(2)
    expect(result.single.map((row) => row.key)).toEqual(["tagged"])
    expect([result.negative, result.fractional].map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
  })

  it("matches the previous full-sort semantics at the exact limit and limit plus one", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < 5; index++) {
        yield* store.putFact({ namespace, key: `fact-${index}`, value: `value-${index}`, provenance: {} })
        yield* TestClock.adjust("1 millis")
      }
      const all = yield* store.searchRows({ namespace })
      const exact = yield* store.searchRows({ namespace, limit: 3 })
      yield* store.putFact({ namespace, key: "fact-plus-one", value: "newest", provenance: {} })
      const after = yield* store.searchRows({ namespace })
      const limitedAfter = yield* store.searchRows({ namespace, limit: 3 })
      return { all, exact, after, limitedAfter }
    }))

    expect(result.exact).toEqual(result.all.slice(0, 3))
    expect(result.limitedAfter).toEqual(result.after.slice(0, 3))
    expect(result.exact).toHaveLength(3)
    expect(result.limitedAfter).toHaveLength(3)
  })

  // `limit` names how many rows the caller GETS, not how many the query looks
  // at. A LIMIT applied before the status, supersession and tag filters silently
  // under-fills, and the shortfall is invisible: the caller sees a short list,
  // not an error.
  it("counts the limit against rows that pass every filter, not the rows SQL touched", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      // Oldest first, so an unfiltered `limit: 1` takes the pending note and a
      // post-filter would then discard it, leaving nothing.
      yield* store.putNote({ namespace, id: "a-pending", text: "p", tags: [], provenance: {}, status: "pending" })
      yield* store.putNote({ namespace, id: "b-accepted", text: "a", tags: [], provenance: {} })
      yield* store.putNote({ namespace, id: "c-rejected", text: "r", tags: [], provenance: {}, status: "rejected" })
      return {
        accepted: yield* store.listNotes({ namespace, status: "accepted", limit: 1 }),
        acceptedUnlimited: yield* store.listNotes({ namespace, status: "accepted" }),
        selection: yield* store.listNotes({ namespace, status: ["pending", "rejected"], limit: 2 }),
        emptySelection: yield* store.listNotes({ namespace, status: [], limit: 2 }),
        any: yield* store.listNotes({ namespace, status: "any", limit: 3 })
      }
    }))

    expect(result.accepted.map((note) => note.id)).toEqual(["b-accepted"])
    expect(result.accepted).toEqual(result.acceptedUnlimited)
    expect(result.selection.map((note) => note.id)).toEqual(["a-pending", "c-rejected"])
    expect(result.emptySelection).toEqual([])
    expect(result.any.map((note) => note.id)).toEqual(["a-pending", "b-accepted", "c-rejected"])
  })

  // 512 was the old overscan window, so a namespace larger than it is the only
  // size at which the earlier "read a wide window and filter it" approximation
  // is distinguishable from an exact answer.
  it("finds tag-filtered rows past the old overscan window", async () => {
    const total = 520
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < total; index++) {
        const id = `note-${String(index).padStart(4, "0")}`
        // listNotes reads oldest first and searchRows newest first, so a match
        // at each end makes both directions page all the way past the window.
        const wanted = index < 3 || index >= total - 3
        yield* store.putNote({
          namespace,
          id,
          text: `row ${index}`,
          tags: [wanted ? "scope:project" : "scope:other"],
          provenance: {}
        })
        yield* TestClock.adjust("1 millis")
      }
      const tagGroup = { tags: ["scope:project"], match: "any_strict" } as const
      return {
        ascending: yield* store.listNotes({ namespace, tagGroups: [tagGroup], limit: 6 }),
        descending: yield* store.searchRows({ namespace, tagGroups: [tagGroup], limit: 6 }),
        everything: yield* store.listNotes({ namespace, tagGroups: [tagGroup] })
      }
    }))

    const oldest = ["note-0000", "note-0001", "note-0002"]
    const newest = ["note-0517", "note-0518", "note-0519"]
    expect(result.ascending.map((note) => note.id)).toEqual([...oldest, ...newest])
    expect(result.descending.map((row) => row.id)).toEqual([...newest].reverse().concat([...oldest].reverse()))
    expect(result.everything).toHaveLength(6)
  })

  // enableFts is documented as a setup step, so hosts call it on every boot.
  // Once a kind is enabled its projection is maintained row by row; a repeat
  // call must leave that projection alone instead of rebuilding it under the
  // writer. A row written straight into the FTS table survives only if the
  // second call did not DELETE and backfill.
  it("does not rebuild the FTS projection when the kind is already enabled", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "runbook", value: { content: "restore the primary" }, provenance: {} })
      yield* store.enableFts("flow")
      yield* sql`INSERT INTO memory_fts_flow (record_id, record_kind, namespace_id, record_key, text)
        VALUES ('marker', 'fact', ${namespace.id}, 'marker', 'sentinel projection')`
      yield* store.enableFts("flow")
      const rows = yield* sql<{ readonly record_id: string }>`SELECT record_id FROM memory_fts_flow ORDER BY record_id`
      return rows.map((row) => row.record_id)
    }))

    expect(result).toEqual(["marker", "runbook"])
  })

  // The backfill derives searchable text in SQL; it must match what the live
  // projection wrote for a string value, a content object, and any other JSON.
  it("backfills FTS text for every value shape the live projection indexes", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const put = (key: string, value: unknown) => store.putFact({ namespace, key, value, provenance: {} })
      yield* put("plain", "restore the primary")
      yield* put("content", { content: "rotate the keys", tags: ["ops"] })
      yield* put("object", { content: 7, note: "reindex the shards" })
      yield* put("number", 42)
      yield* store.enableFts("flow")
      const live = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow ORDER BY record_id`
      yield* sql`DELETE FROM memory_fts_kinds WHERE namespace_kind = 'flow'`
      yield* store.enableFts("flow")
      const rebuilt = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow ORDER BY record_id`
      return { live, rebuilt }
    }))

    expect(result.rebuilt).toEqual(result.live)
    expect(result.rebuilt.map((row) => row.text)).toEqual([
      "rotate the keys",
      "42",
      "{\"content\":7,\"note\":\"reindex the shards\"}",
      "restore the primary"
    ])
  })

  it("pages the fact side of a tag-filtered search past the old overscan window", async () => {
    const total = 520
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < total; index++) {
        yield* store.putFact({
          namespace,
          key: `fact-${String(index).padStart(4, "0")}`,
          value: `row ${index}`,
          tags: [index < 2 ? "scope:project" : "scope:other"],
          provenance: {}
        })
        yield* TestClock.adjust("1 millis")
      }
      const tagGroup = { tags: ["scope:project"], match: "any_strict" } as const
      return {
        limited: yield* store.searchRows({ namespace, tagGroups: [tagGroup], limit: 2 }),
        prefixed: yield* store.searchRows({ namespace, tagGroups: [tagGroup], prefix: "fact-0000", limit: 2 })
      }
    }))

    expect(result.limited.map((row) => row.key)).toEqual(["fact-0001", "fact-0000"])
    expect(result.prefixed.map((row) => row.key)).toEqual(["fact-0000"])
  })

  it("returns no FTS matches for an empty record selection", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "other", value: "needle", provenance: {} })
      yield* store.enableFts("flow")
      return yield* store.searchFts({ namespace, query: "needle", records: [], limit: 1 })
    }))
    expect(rows).toEqual([])
  })

  it("refills FTS pages using exact kind and id selections before the limit", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < 520; index++) {
        yield* store.putFact({ namespace, key: `other-${index}`, value: "needle", provenance: {} })
      }
      yield* store.putFact({ namespace, key: "zzzz-note", value: "needle", provenance: {} })
      yield* store.putNote({ namespace, id: "zzzz-note", text: "needle", tags: [], provenance: {} })
      yield* store.putFact({ namespace, key: "zzzz-fact", value: "needle", provenance: {} })
      yield* store.enableFts("flow")
      return yield* store.searchFts({
        namespace,
        query: "needle",
        records: [{ kind: "note", id: "zzzz-note" }, { kind: "fact", id: "zzzz-fact" }],
        limit: 2
      })
    }))
    expect(rows.map(({ kind, id }) => ({ kind, id })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "fact", id: "zzzz-fact" },
      { kind: "note", id: "zzzz-note" }
    ])
  })

  it("reads filtered FTS pages in one transaction with larger rank pages", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const original = yield* MemoryStore.MemoryStore
        for (let index = 0; index < 520; index++) {
          yield* original.putFact({
            namespace,
            key: `row-${index}`,
            value: "needle",
            tags: [index === 519 ? "scope:project" : "scope:other"],
            provenance: {}
          })
        }
        yield* original.enableFts("flow")
        const pages: Array<{ readonly size: number; readonly transaction: boolean }> = []
        const observed = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            const query = Reflect.apply(target, thisArg, argumentsList)
            if (!statement.includes("AS rank")) return query
            return (query as Effect.Effect<ReadonlyArray<unknown>>).pipe(Effect.tap((rows) =>
              Effect.gen(function*() {
                pages.push({
                  size: rows.length,
                  transaction: Option.isSome(yield* Effect.serviceOption(sql.transactionService))
                })
              })
            ))
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, observed))
        const rows = yield* store.searchFts({
          namespace,
          query: "needle",
          limit: 2,
          tagGroups: [{ tags: ["scope:project"], match: "any_strict" }]
        })
        return { rows, pages }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result.rows.map((row) => row.id)).toEqual(["row-519"])
    expect(result.pages).toEqual([{ size: 512, transaction: true }, { size: 8, transaction: true }])
  })

  it.each([
    { records: Array.from({ length: 65 }, () => ({ kind: "fact", id: "a" })) },
    { records: [{ kind: "message", id: "a" }] },
    { records: [{ kind: "fact", id: "" }] }
  ])("validates FTS record identities %#", async ({ records }) => {
    const failure = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.enableFts("flow")
      return yield* Effect.flip(store.searchFts({
        namespace,
        query: "needle",
        records: records as MemoryStore.SearchFtsInput["records"]
      }))
    }))
    expect(failure.code).toBe("invalid_argument")
  })

  it("resolves FTS matches by id so an older match is not lost to a recency window", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.enableFts("flow")
      // The only note carrying the query term is the oldest of ten. A lookup
      // built from the newest few rows cannot see it.
      yield* store.putNote({ namespace, id: "note-00", text: "durable wombat procedure", tags: [], provenance: {} })
      for (let index = 1; index < 10; index++) {
        yield* store.putNote({
          namespace,
          id: `note-${String(index).padStart(2, "0")}`,
          text: "durable release checklist",
          tags: [],
          provenance: {}
        })
      }
      yield* store.putFact({
        namespace,
        key: "fact-quokka",
        value: { content: "durable quokka runbook" },
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putFact({
        namespace,
        key: "other-quokka",
        value: { content: "durable quokka aside" },
        tags: ["scope:other"],
        provenance: {}
      })
      return {
        oldest: yield* store.searchFts({ namespace, query: "wombat", limit: 1 }),
        tagged: yield* store.searchFts({
          namespace,
          query: "quokka",
          tagGroups: [{ tags: ["scope:project"], match: "any_strict" }],
          limit: 10
        }),
        prefixed: yield* store.searchFts({ namespace, query: "quokka", prefix: "fact-", limit: 10 })
      }
    }))

    expect(result.oldest.map((row) => row.id)).toEqual(["note-00"])
    expect(result.tagged.map((row) => row.id)).toEqual(["fact-quokka"])
    expect(result.prefixed.map((row) => row.id)).toEqual(["fact-quokka"])
  })

  it("bounds the SQL rowset before decoding rows outside the search limit", async () => {
    const rows = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "newest", value: "safe", provenance: {} })
      yield* TestDatabase.checks(sql, false)
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, tags_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'project-1', 'outside-limit', '{oops', NULL, NULL, '{}', -1, -1)`
      return yield* store.searchRows({ namespace, limit: 1 })
    }))

    expect(rows.map((row) => row.key)).toEqual(["newest"])
  })

  it("rejects invalid search limits before reading backend tables", async () => {
    const failures = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_facts ${sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))}`
      const rows = yield* Effect.flip(store.searchRows({ namespace, limit: -1 }))
      yield* sql`DROP TABLE memory_fts_kinds ${
        sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
      }`
      const fts = yield* Effect.flip(store.searchFts({ namespace, query: "query", limit: -1 }))
      return [rows, fts]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
  })

  it("enables FTS per namespace kind and applies query, limit, and filter boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const badKind = yield* Effect.flip(store.enableFts("run" as MemoryStore.EnableFtsInput))
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-note",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-extra",
        text: "durable rollback drill",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-pending",
        text: "durable draft",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      yield* store.enableFts("flow")
      yield* store.enableFts("flow")
      const blank = yield* store.searchFts({ namespace, query: "   " })
      const surrogate = yield* store.searchFts({ namespace, query: "\uD800durable" })
      const zeroLimit = yield* store.searchFts({ namespace, query: "durable", limit: 0 })
      const negativeLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: -1 }))
      const fractionalLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 0.5 }))
      const defaulted = yield* store.searchFts({ namespace, query: "durable" })
      const truncated = yield* store.searchFts({ namespace, query: "durable", limit: 2, status: "any" })
      const filtered = yield* store.searchFts({
        namespace,
        query: "durable",
        limit: 10,
        status: "any",
        includeSuperseded: true,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
      yield* store.deleteFact({ namespace, key: "runbook" })
      const afterDelete = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      const otherKind = yield* Effect.flip(
        store.searchFts({ namespace: { kind: "agent", id: "fleet" }, query: "durable" })
      )
      return {
        badKind,
        blank,
        surrogate,
        zeroLimit,
        negativeLimit,
        fractionalLimit,
        defaulted,
        truncated,
        filtered,
        afterDelete,
        otherKind
      }
    }))

    expect([result.badKind.code, result.badKind.message]).toEqual([
      "invalid_namespace",
      "FTS namespace kind is invalid"
    ])
    expect(result.blank).toEqual([])
    expect(result.surrogate.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.zeroLimit).toEqual([])
    expect([result.negativeLimit, result.fractionalLimit].map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
    expect(result.defaulted.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.truncated).toHaveLength(2)
    expect(result.filtered.map((row) => row.key).sort()).toEqual([
      "durable-extra",
      "durable-note",
      "durable-pending",
      "runbook"
    ])
    expect(result.afterDelete.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note"])
    expect(result.otherKind.code).toBe("fts_not_enabled")
  })
})
