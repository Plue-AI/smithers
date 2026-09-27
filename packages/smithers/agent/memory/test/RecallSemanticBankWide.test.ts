import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import { digest } from "../src/internal/Digest.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const queryVector = Embedding.make(() => Effect.succeed([[1, 0]]))
const fixture = <A, E>(
  body: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient | DurableWriter | Embedding.Embedding>
) =>
  Effect.runPromise(body.pipe(
    Effect.provideService(Embedding.Embedding, queryVector),
    Effect.provide(TestMemory.layerWithDatabase),
    Effect.provide(TestClock.layer())
  ))

const projection = (key: string, overrides: Partial<Semantic.Vector> = {}): Semantic.Vector => ({
  bank: "flow-bank",
  recordKind: "note",
  recordId: key,
  model: Semantic.defaultModel,
  contentDigest: digest(key),
  dimensions: 2,
  vector: [1, 0],
  updatedAtMs: 0,
  ...overrides
})

const ports = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  return {
    store: yield* MemoryStore.MemoryStore,
    vectors: Semantic.makeSqlVectorStore({ sql, write: writer.write }),
    sql
  }
})

describe("bank-wide semantic recall", () => {
  it("finds the oldest best match beyond every former recent window with bounded pages and top-k", async () => {
    const result = await fixture(Effect.gen(function*() {
      const { store, vectors } = yield* ports
      yield* TestClock.setTime(0)
      yield* store.putNote({ namespace: "flow-bank", id: "zz-old-best", text: "old best", tags: [], provenance: {} })
      yield* vectors.upsert(projection("zz-old-best", { contentDigest: digest("old best") }))
      yield* TestClock.setTime(1_000)
      for (let index = 0; index < 512; index++) {
        const id = `new-${String(index).padStart(3, "0")}`
        yield* store.putNote({ namespace: "flow-bank", id, text: id, tags: [], provenance: {} })
        yield* vectors.upsert(projection(id, { vector: [1, 1], updatedAtMs: 1_000 }))
      }
      expect((yield* store.searchRows({ namespace: "flow-bank", limit: 100 })).map((row) => row.id)).not.toContain(
        "zz-old-best"
      )
      const counts = { pages: 0, scanned: 0, maximumVectors: 0, maximumVectorBytes: 0, maximumAuthorityIds: 0 }
      const boundedVectors: Semantic.VectorStore = {
        ...vectors,
        scan: (banks, model) =>
          vectors.scan(banks, model).pipe(Stream.tap((page) =>
            Effect.sync(() => {
              counts.pages++
              counts.scanned += page.length
              counts.maximumVectors = Math.max(counts.maximumVectors, page.length)
              counts.maximumVectorBytes = Math.max(
                counts.maximumVectorBytes,
                page.reduce((sum, row) => sum + row.vector.length * 4, 0)
              )
              expect(page.every((row) => row.vector instanceof Float32Array)).toBe(true)
            })
          ))
      }
      const observedStore = {
        ...store,
        searchRows: (input: MemoryStore.SearchRowsInput) => {
          counts.maximumAuthorityIds = Math.max(counts.maximumAuthorityIds, input.records?.length ?? 0)
          return store.searchRows(input)
        }
      }
      const rows = yield* Semantic.recall({ banks: ["flow-bank"], query: "best", budget: "high", maxTokens: 65_536 }, {
        vectorStore: boundedVectors,
        halfLifeMs: 100_000
      }).pipe(Effect.provideService(MemoryStore.MemoryStore, observedStore))
      return { rows, counts }
    }))
    expect(result.rows).toHaveLength(20)
    expect(result.rows[0]).toMatchObject({ key: "zz-old-best", text: "old best" })
    expect(result.rows.slice(1).map((row) => row.key)).toEqual(
      Array.from({ length: 19 }, (_, index) => `new-${String(index).padStart(3, "0")}`)
    )
    expect(result.counts).toEqual({
      pages: 9,
      scanned: 513,
      maximumVectors: 64,
      maximumVectorBytes: 512,
      maximumAuthorityIds: 64
    })
  })

  it("joins exact kind, namespace, current content, accepted status, supersession and live TTL", async () => {
    const rows = await fixture(Effect.gen(function*() {
      const { store, vectors } = yield* ports
      yield* TestClock.setTime(0)
      for (const id of ["accepted", "pending", "rejected", "superseded", "superseder", "stale", "untagged"]) {
        yield* store.putNote({
          namespace: "flow-bank",
          id,
          text: id,
          tags: id === "untagged" ? [] : ["scope:allowed"],
          provenance: {},
          status: id === "pending" || id === "rejected" ? id : "accepted"
        })
        yield* vectors.upsert(projection(id, { contentDigest: digest(id === "stale" ? "old text" : id) }))
      }
      yield* store.supersede({ supersederId: "superseder", targetId: "superseded" })
      for (const key of ["live", "expired", "deleted", "wrong-kind"]) {
        yield* store.putFact({
          namespace: "flow-bank",
          key,
          value: key,
          tags: ["scope:allowed"],
          provenance: {},
          ...(key === "expired" ? { ttlMs: 1 } : {})
        })
        yield* vectors.upsert(projection(key, { recordKind: key === "wrong-kind" ? "note" : "fact" }))
      }
      yield* store.deleteFact({ namespace: "flow-bank", key: "deleted" })
      yield* vectors.upsert(projection("deleted", { recordKind: "fact" }))
      yield* store.putFact({ namespace: "user-bank", key: "live", value: "live", provenance: {} })
      yield* vectors.upsert(projection("live", { bank: "user-bank", recordKind: "fact" }))
      yield* vectors.upsert(projection("foreign-model", { model: "foreign", dimensions: 1, vector: [1] }))
      yield* TestClock.setTime(2)
      return yield* Semantic.recall({
        banks: ["flow-bank"],
        query: "match",
        tagGroups: [{ tags: ["scope:allowed"], match: "all_strict" }]
      }, { vectorStore: vectors })
    }))
    expect(rows.map((row) => row.key)).toEqual(["accepted", "live", "superseder"])
    expect(rows.every((row) => row.bank === "flow-bank")).toBe(true)
  })

  it("breaks equal-key ties by bank independently of requested bank order", async () => {
    const result = await fixture(Effect.gen(function*() {
      const { store, vectors } = yield* ports
      for (const bank of ["flow-a", "flow-b"]) {
        yield* store.putFact({ namespace: bank, key: "same", value: "same", provenance: {} })
        yield* vectors.upsert(projection("same", { bank, recordKind: "fact" }))
      }
      const forward = yield* Semantic.recall({ banks: ["flow-a", "flow-b"], query: "q" }, { vectorStore: vectors })
      const backward = yield* Semantic.recall({ banks: ["flow-b", "flow-a"], query: "q" }, { vectorStore: vectors })
      return { forward, backward }
    }))
    expect(result.forward).toEqual(result.backward)
    expect(result.forward.map((row) => row.bank)).toEqual(["flow-a", "flow-b"])
  })

  it("finishes at its opening projection watermark while writers keep adding later keys", async () => {
    const observed = await fixture(Effect.gen(function*() {
      const { vectors } = yield* ports
      const expected = Array.from({ length: 128 }, (_, index) => `a-${String(index).padStart(3, "0")}`)
      for (const key of expected) yield* vectors.upsert(projection(key))
      let pages = 0
      const collected: Array<string> = []
      yield* Stream.runForEach(
        vectors.scan(["flow-bank", "bank"], Semantic.defaultModel),
        (page) =>
          Effect.gen(function*() {
            pages++
            expect(pages).toBeLessThanOrEqual(2)
            collected.push(...page.map((row) => row.recordId))
            for (let index = 0; index < 64; index++) {
              yield* vectors.upsert(projection(`z-new-${pages}-${index}`))
            }
          })
      )
      return { pages, collected, expected }
    }))
    expect(observed.pages).toBe(2)
    expect(observed.collected).toEqual(observed.expected)
  })

  it("bounds work by the opening count when delete/reinsert churn reuses SQLite rowids", async () => {
    const result = await fixture(Effect.gen(function*() {
      const { store, vectors } = yield* ports
      let current = Array.from({ length: 128 }, (_, index) => `a-${String(index).padStart(3, "0")}`)
      const insert = (key: string) =>
        store.putFact({ namespace: "flow-bank", key, value: key, provenance: {} }).pipe(
          Effect.andThen(vectors.upsert(projection(key, { recordKind: "fact" })))
        )
      for (const key of current) yield* insert(key)
      let pages = 0
      let scanned = 0
      yield* Stream.runForEach(vectors.scan(["flow-bank"], Semantic.defaultModel), (page) =>
        Effect.gen(function*() {
          pages++
          scanned += page.length
          expect(pages).toBeLessThanOrEqual(2)
          for (const key of current) yield* store.deleteFact({ namespace: "flow-bank", key })
          current = Array.from({ length: 64 }, (_, index) => `z-${pages}-${String(index).padStart(3, "0")}`)
          for (const key of current) yield* insert(key)
        }))
      return { pages, scanned }
    }))
    expect(result).toEqual(process.env.SMITHERS_TEST_PG_URL ? { pages: 1, scanned: 64 } : { pages: 2, scanned: 128 })
  })

  it("refuses oversized adapter pages and invalid exact identity filters", async () => {
    await fixture(Effect.gen(function*() {
      const { store, vectors } = yield* ports
      const failure = yield* Effect.flip(Semantic.recall({ banks: ["flow-bank"], query: "q" }, {
        vectorStore: { ...vectors, scan: () => Stream.succeed(Array.from({ length: 65 }, () => projection("x"))) }
      }))
      expect(failure.code).toBe("invalid_argument")
      for (
        const records of [
          Array.from({ length: 65 }, () => ({ kind: "note" as const, id: "x" })),
          [{ kind: "other" as "note", id: "x" }],
          [{ kind: "note" as const, id: "" }]
        ]
      ) {
        expect((yield* Effect.flip(store.searchRows({ namespace: "flow-bank", records }))).code).toBe(
          "invalid_argument"
        )
      }
      expect(yield* store.searchRows({ namespace: "flow-bank", records: [] })).toEqual([])
    }))
  })
})
