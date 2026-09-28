import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { afterAll, describe, expect, it } from "vitest"
import type { DatabaseService } from "../src/Database.ts"
import * as Embedding from "../src/Embedding.ts"
import { digest } from "../src/internal/Digest.ts"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

// Tests keep the constructor's owner alive through every projection assertion.
const projectorScope = Scope.makeUnsafe()
afterAll(() => Effect.runPromise(Scope.close(projectorScope, Exit.void)))
const makeProjector = (options: Semantic.Options): Semantic.Projector =>
  Effect.runSync(Semantic.makeProjector(options).pipe(Scope.provide(projectorScope)))

const searchRow = (overrides: Partial<MemoryStore.SearchRow>): MemoryStore.SearchRow => ({
  id: "id",
  kind: "note",
  bank: "flow-bank",
  namespace: { kind: "flow", id: "bank" },
  key: "key",
  text: "text",
  tags: [],
  updatedAtMs: 0,
  status: "accepted",
  ...overrides
})

const storeOf = (rows: ReadonlyArray<MemoryStore.SearchRow>) =>
  MemoryStore.MemoryStore.of({ searchRows: () => Effect.succeed(rows) } as unknown as MemoryStore.Service)

const projection = (overrides: Partial<Semantic.Vector>): Semantic.Vector => ({
  bank: "flow-bank",
  recordKind: "note",
  recordId: "key",
  model: Semantic.defaultModel,
  contentDigest: digest("text"),
  dimensions: 2,
  vector: [1, 0],
  updatedAtMs: 0,
  ...overrides
})

const vectorStoreOf = (vectors: ReadonlyArray<Semantic.Vector>): Semantic.VectorStore => ({
  scan: () =>
    Stream.fromIterable(
      Array.from({ length: Math.ceil(vectors.length / 64) }, (_, index) => vectors.slice(index * 64, index * 64 + 64))
    ),
  upsert: () => Effect.void
})

const collectVectors = (store: Semantic.VectorStore, banks: ReadonlyArray<string>, model: string) =>
  Stream.runCollect(store.scan(banks, model)).pipe(Effect.map((pages) => pages.flat()))

const queryVector = Embedding.make(() => Effect.succeed([[1, 0]]))

describe("RecallSemantic", () => {
  it("ranks by cosine and recency decay", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () =>
        Effect.succeed([
          {
            id: "near",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "near",
            text: "near",
            tags: [],
            status: "accepted",
            updatedAtMs: 1000
          },
          {
            id: "old",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "old",
            text: "old",
            tags: [],
            status: "accepted",
            updatedAtMs: 0
          }
        ])
    } as unknown as MemoryStore.Service)
    const vectors: Semantic.Vector[] = [
      {
        bank: "bank",
        recordKind: "note",
        recordId: "near",
        model: "test",
        contentDigest: digest("near"),
        dimensions: 2,
        vector: [1, 0],
        updatedAtMs: 1000
      },
      {
        bank: "bank",
        recordKind: "note",
        recordId: "old",
        model: "test",
        contentDigest: digest("old"),
        dimensions: 2,
        vector: [0.99, 0.01],
        updatedAtMs: 0
      }
    ]
    const embedding = Embedding.make(() => Effect.succeed([[1, 0]]))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(1_000)
        return yield* Semantic.recall({ banks: ["bank"], query: "q", budget: "low" }, {
          vectorStore: vectorStoreOf(vectors),
          model: "test",
          halfLifeMs: 1000
        })
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, embedding),
        Effect.provide(TestClock.layer())
      )
    )
    expect(result[0]?.key).toBe("near")
  })

  it("scans one resolved namespace for duplicate and aliased banks", async () => {
    let scans = 0
    const listedBanks: Array<ReadonlyArray<string>> = []
    const store = MemoryStore.MemoryStore.of({
      searchRows: () =>
        Effect.sync(() => {
          scans += 1
          return [searchRow({ id: "one", key: "one", text: "one" })]
        })
    } as unknown as MemoryStore.Service)
    const rows = await Effect.runPromise(
      Semantic.recall({ banks: ["bank", "flow-bank", "bank"], query: "q" }, {
        vectorStore: {
          scan: (banks) =>
            Stream.fromEffect(Effect.sync(() => {
              listedBanks.push(banks)
              return [projection({ bank: "bank", recordId: "one", contentDigest: digest("one") })]
            })),
          upsert: () => Effect.void
        },
        halfLifeMs: 1_000
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(scans).toBe(1)
    expect(listedBanks).toEqual([["bank"]])
    expect(rows.map((row) => row.key)).toEqual(["one"])
  })

  it("logs projection failures without failing the committed write path", async () => {
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () => Effect.fail(new (class extends Error {})()) as never
      }
    })
    await expect(Effect.runPromise(
      projector.project({
        bank: "bank",
        recordKind: "note",
        recordId: "key",
        text: "text",
        updatedAtMs: 0
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )).resolves.toBeUndefined()
  })

  it("serializes same-record projections while other records proceed, then releases the key", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const embedded: Array<string> = []
    const writes: Array<string> = []
    const embedding = Embedding.make((inputs) =>
      Effect.gen(function*() {
        embedded.push(...inputs)
        if (inputs[0] === "first") {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(gate)
        }
        return inputs.map(() => [1])
      })
    )
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            writes.push(vector.contentDigest)
          })
      }
    })
    const row = (text: string, recordId = "key"): Semantic.ProjectionInput => ({
      bank: "bank",
      recordKind: "fact",
      recordId,
      text,
      updatedAtMs: 0
    })

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Effect.forkChild(projector.project(row("first")), { startImmediately: true })
        yield* Deferred.await(entered)
        const second = yield* Effect.forkChild(projector.project(row("second")), { startImmediately: true })
        yield* Effect.sleep("10 millis")
        const whileBlocked = { embedded: [...embedded], writes: [...writes], active: projector.activeKeys() }
        yield* projector.project(row("other", "other-key"))
        const otherDone = { embedded: [...embedded], writes: [...writes], active: projector.activeKeys() }
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return { whileBlocked, otherDone }
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )

    expect(observed.whileBlocked).toEqual({ embedded: ["first"], writes: [], active: 1 })
    expect(observed.otherDone).toEqual({ embedded: ["first", "other"], writes: [digest("other")], active: 1 })
    expect(embedded).toEqual(["first", "other", "second"])
    expect(writes).toEqual([digest("other"), digest("first"), digest("second")])
    expect(projector.activeKeys()).toBe(0)
  })

  it("releases the record key when a blocked projection is interrupted", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const embedding = Embedding.make(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
    const projector = makeProjector({
      vectorStore: { scan: () => Stream.empty, upsert: () => Effect.void }
    })
    const row: Semantic.ProjectionInput = {
      bank: "bank",
      recordKind: "note",
      recordId: "key",
      text: "t",
      updatedAtMs: 0
    }

    const activeWhileHeld = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(projector.project(row), { startImmediately: true })
        yield* Deferred.await(entered)
        const active = projector.activeKeys()
        yield* Fiber.interrupt(fiber)
        return active
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )

    expect(activeWhileHeld).toBe(1)
    expect(projector.activeKeys()).toBe(0)
  })

  it("drops a projection whose provider exceeds the projection timeout", async () => {
    let writes = 0
    const projector = makeProjector({
      projectionTimeout: "20 millis",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () =>
          Effect.sync(() => {
            writes += 1
          })
      }
    })

    await expect(Effect.runPromise(
      projector.project({ bank: "bank", recordKind: "note", recordId: "key", text: "t", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, Embedding.make(() => Effect.never)),
        Effect.timeout("2 seconds")
      )
    )).resolves.toBeUndefined()
    expect(writes).toBe(0)
    expect(projector.activeKeys()).toBe(0)
  })

  it("returns a decorated write at commit when the embedding provider hangs", async () => {
    const namespace = { kind: "flow", id: "hung" } as const
    const committed = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const decorated = Semantic.decorateStore(
          store,
          makeProjector({ vectorStore, projectionTimeout: "20 millis" }),
          Embedding.make(() => Effect.never)
        )
        yield* decorated.putFact({ namespace, key: "k", value: { content: "v" }, provenance: {} }).pipe(
          Effect.timeout("2 seconds")
        )
        return yield* store.getFact({ namespace, key: "k" })
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(committed?.value).toEqual({ content: "v" })
  })

  it("keeps the newest vector when an older projection from another projector lands late", async () => {
    const namespace = { kind: "flow", id: "race" } as const
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const slow = Embedding.make((inputs) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(inputs.map(Embedding.inProcessVector))
          )
        )
        const fast = Embedding.makeInProcess()
        const writerOne = Semantic.decorateStore(store, makeProjector({ vectorStore }), slow)
        const writerTwo = Semantic.decorateStore(store, makeProjector({ vectorStore }), fast)

        const first = yield* Effect.forkChild(
          writerOne.putFact({ namespace, key: "k", value: { content: "first" }, provenance: {} }),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        yield* Effect.sleep("5 millis")
        yield* writerTwo.putFact({ namespace, key: "k", value: { content: "second" }, provenance: {} })
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        const fact = yield* store.getFact({ namespace, key: "k" })
        const rows = yield* sql<{ readonly content_digest: string; readonly updated_at_ms: number }>`
          SELECT content_digest, updated_at_ms FROM memory_vectors WHERE record_kind = 'fact' AND record_id = 'k'`
        const recalled = yield* Semantic.recall({ banks: ["flow-race"], query: "second" }, { vectorStore }).pipe(
          Effect.provideService(Embedding.Embedding, fast)
        )
        return { fact, rows, recalled: recalled.map((row) => row.key) }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.fact?.value).toEqual({ content: "second" })
    expect(result.rows).toEqual([{ content_digest: digest("second"), updated_at_ms: result.fact?.updatedAtMs }])
    expect(result.recalled).toEqual(["k"])
  })

  it("propagates projection interruption", async () => {
    const embedding = Embedding.make(() => Effect.interrupt)
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () => Effect.void
      }
    })
    const exit = await Effect.runPromiseExit(
      projector.project({ bank: "bank", recordKind: "note", recordId: "key", text: "text", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("skips foreign models and gives matching-model dimension failures their own code", async () => {
    const runRecall = (options: Semantic.Options) =>
      Effect.runPromise(
        Semantic.recall({ banks: ["flow-bank"], query: "q" }, options).pipe(
          Effect.provideService(MemoryStore.MemoryStore, storeOf([])),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )
    const failing = (options: Semantic.Options) =>
      Effect.runPromise(
        Effect.flip(Semantic.recall({ banks: ["flow-bank"], query: "q" }, options)).pipe(
          Effect.provideService(MemoryStore.MemoryStore, storeOf([])),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )

    const foreignModel = await runRecall({ vectorStore: vectorStoreOf([projection({ model: "other" })]) })
    const storedDimensions = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 3, vector: [1, 0] })])
    })
    const vectorLength = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 2, vector: [1, 0, 0] })])
    })
    const zeroHalfLife = await failing({ vectorStore: vectorStoreOf([]), halfLifeMs: 0 })
    const infiniteHalfLife = await failing({
      vectorStore: vectorStoreOf([]),
      halfLifeMs: Number.POSITIVE_INFINITY
    })

    expect(foreignModel).toEqual([])
    expect([storedDimensions, vectorLength, zeroHalfLife, infiniteHalfLife].map((error) => [
      error.code,
      error.message
    ])).toEqual([
      ["vector_model_mismatch", "embedding dimensions do not match the query vector"],
      ["vector_model_mismatch", "embedding dimensions do not match the query vector"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"]
    ])
  })

  it("skips unresolved, non-accepted, untagged, and orthogonal rows, then breaks ties by key", async () => {
    const store = storeOf([
      searchRow({ id: "tie-b", key: "tie-b", text: "b", tags: ["scope:project"], updatedAtMs: 5 }),
      searchRow({ id: "tie-a", key: "tie-a", text: "a", tags: ["scope:project"], updatedAtMs: 5 }),
      searchRow({ id: "pending", key: "pending", text: "p", tags: ["scope:project"], status: "pending" }),
      searchRow({ id: "untagged", key: "untagged", text: "u", tags: [] }),
      searchRow({ id: "orthogonal", key: "orthogonal", text: "o", tags: ["scope:project"] })
    ])
    const rows = await Effect.runPromise(
      Semantic.recall({
        banks: ["flow-bank"],
        query: "q",
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      }, {
        vectorStore: vectorStoreOf([
          projection({ recordId: "tie-b", recordKind: "note", contentDigest: digest("b"), updatedAtMs: 5 }),
          projection({ recordId: "tie-a", recordKind: "note", contentDigest: digest("a"), updatedAtMs: 5 }),
          projection({ recordId: "orphan" }),
          projection({ recordId: "pending", contentDigest: digest("p") }),
          projection({ recordId: "untagged", contentDigest: digest("u") }),
          projection({ recordId: "orthogonal", contentDigest: digest("o"), vector: [0, 1] })
        ]),
        halfLifeMs: 1000
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows.map((row) => [row.bank, row.key])).toEqual([
      ["flow-bank", "tie-a"],
      ["flow-bank", "tie-b"]
    ])
  })

  it("skips a joined row whose current text does not match the vector digest", async () => {
    const rows = await Effect.runPromise(
      Semantic.recall({ banks: ["flow-bank"], query: "q" }, {
        vectorStore: vectorStoreOf([
          projection({ recordId: "changed", contentDigest: digest("old text") })
        ]),
        halfLifeMs: 1_000
      }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf([searchRow({ id: "changed", key: "changed", text: "current text" })])
        ),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows).toEqual([])
  })

  it("does not score a stale vector left behind by a failed projection", async () => {
    let currentText = "old text"
    let stored: Semantic.Vector | undefined
    let rejectProjection = false
    let upsertAttempts = 0
    const vectorStore: Semantic.VectorStore = {
      scan: () => Stream.suspend(() => Stream.succeed(stored === undefined ? [] : [stored])),
      upsert: (vector) => {
        upsertAttempts += 1
        return rejectProjection
          ? Effect.fail(new MemoryError({ code: "store", message: "projection unavailable" }))
          : Effect.sync(() => {
            stored = vector
          })
      }
    }
    const projector = makeProjector({ vectorStore })
    const store = MemoryStore.MemoryStore.of({
      searchRows: () => Effect.sync(() => [searchRow({ id: "row", key: "row", text: currentText })])
    } as unknown as MemoryStore.Service)

    const rows = await Effect.runPromise(
      Effect.gen(function*() {
        yield* projector.project({
          bank: "flow-bank",
          recordKind: "note",
          recordId: "row",
          text: currentText,
          updatedAtMs: 0
        })
        currentText = "unrelated replacement"
        rejectProjection = true
        yield* projector.project({
          bank: "flow-bank",
          recordKind: "note",
          recordId: "row",
          text: currentText,
          updatedAtMs: 1
        })
        return yield* Semantic.recall({ banks: ["flow-bank"], query: "q" }, { vectorStore, halfLifeMs: 1_000 })
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(upsertAttempts).toBe(3)
    expect(stored?.contentDigest).toBe(digest("old text"))
    expect(rows).toEqual([])
  })

  it("limits results by the declared budget and then by the token cap", async () => {
    const keys = Array.from({ length: 6 }, (_, index) => `row-${index}`)
    const store = storeOf(keys.map((key) => searchRow({ id: key, key, text: `text for ${key}` })))
    const options = {
      vectorStore: vectorStoreOf(
        keys.map((key, index) =>
          projection({ recordId: key, contentDigest: digest(`text for ${key}`), vector: [1, index / 100] })
        )
      ),
      halfLifeMs: 1000
    }
    const recall = (input: Recall.Input) =>
      Effect.runPromise(
        Semantic.recall(input, options).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )

    const low = await recall({ banks: ["flow-bank"], query: "q", budget: "low" })
    const mid = await recall({ banks: ["flow-bank"], query: "q" })
    const high = await recall({ banks: ["flow-bank"], query: "q", budget: "high" })
    const capped = await recall({ banks: ["flow-bank"], query: "q", budget: "high", maxTokens: 120 })

    expect(Semantic.budgetLimits).toEqual({ low: 3, mid: 8, high: 20 })
    expect(low).toHaveLength(3)
    expect(mid).toHaveLength(6)
    expect(high).toHaveLength(6)
    expect(capped.length).toBeLessThan(6)
  })

  it("uses the wall clock and the default half-life when the caller declares neither", async () => {
    const store = storeOf([searchRow({ id: "fresh", key: "fresh", text: "fresh" })])
    const rows = await Effect.runPromise(
      Semantic.recall({ banks: ["flow-bank"], query: "q" }, {
        vectorStore: vectorStoreOf([
          projection({ recordId: "fresh", contentDigest: digest("fresh"), updatedAtMs: Date.now() })
        ])
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows.map((row) => row.key)).toEqual(["fresh"])
    expect(rows[0]?.score).toBeGreaterThan(0.99)
  })

  it("defaults to the in-process embedding model", () => {
    expect(Semantic.defaultModel).toBe(Embedding.inProcessModel)
  })

  it("round-trips vectors through the migration-owned table and updates them on conflict", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "a",
          dimensions: 2,
          vector: [0.5, -0.25],
          updatedAtMs: 7
        })
        yield* vectors.upsert({
          bank: "agent-fleet",
          recordKind: "note",
          recordId: "note",
          model: "test",
          contentDigest: "b",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 8
        })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "note",
          recordId: "foreign",
          model: "other",
          contentDigest: "foreign",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 8
        })
        const before = yield* collectVectors(vectors, ["flow-one", "agent-fleet", "user-empty"], "test")
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "c",
          dimensions: 2,
          vector: [1, 0],
          updatedAtMs: 9
        })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "stale",
          dimensions: 2,
          vector: [0, 1],
          updatedAtMs: 8
        })
        const after = yield* collectVectors(vectors, ["flow-one"], "test")
        return { before, after }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.before.map((vector) => [vector.bank, vector.recordId, vector.recordKind, vector.dimensions])).toEqual(
      [
        ["flow-one", "runbook", "fact", 2],
        ["agent-fleet", "note", "note", 1]
      ]
    )
    expect(Array.from(result.before[0]!.vector)).toEqual([0.5, -0.25])
    expect(result.after).toHaveLength(1)
    expect(result.after[0]).toMatchObject({ contentDigest: "c", updatedAtMs: 9 })
    expect(Array.from(result.after[0]!.vector)).toEqual([1, 0])
  })

  it.each(
    [
      ["bank", { bank: "" }, ["bank"]],
      ["recordId", { recordId: "" }, ["recordId"]],
      ["model", { model: "" }, ["model"]],
      ["contentDigest", { contentDigest: "" }, ["contentDigest"]],
      ["dimension length", { dimensions: 2, vector: [1] }, ["dimensions"]],
      ["minimum dimensions", { dimensions: 0, vector: [] }, ["dimensions"]],
      ["maximum dimensions", { dimensions: 65_537, vector: new Array(65_537).fill(1) }, ["dimensions"]],
      ["finite component", { vector: [Number.NaN] }, ["vector", "0"]],
      ["negative time", { updatedAtMs: -1 }, ["updatedAtMs"]],
      ["safe integer time", { updatedAtMs: Number.MAX_SAFE_INTEGER + 1 }, ["updatedAtMs"]]
    ] as const
  )("rejects malformed upsert field %s before persistence", async (_label, override, path) => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        return yield* Effect.flip(vectors.upsert({
          bank: "flow-one",
          recordKind: "note",
          recordId: "key",
          model: "test",
          contentDigest: "digest",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 0,
          ...override
        }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure).toMatchObject(
      _label === "bank" ? { code: "invalid_namespace" } : { code: "invalid_argument", path }
    )
  })

  it.each([0, 1])(
    "rejects a sparse vector component at index %i without replacing its SQL projection",
    async (hole) => {
      const sparse = new Array<number>(2)
      sparse[1 - hole] = 9
      expect(Object.hasOwn(sparse, hole)).toBe(false)
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const writer = yield* DurableWriter
          const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
          const original: Semantic.Vector = {
            bank: "flow-one",
            recordKind: "note",
            recordId: "key",
            model: "test",
            contentDigest: "original",
            dimensions: 2,
            vector: [1, 2],
            updatedAtMs: 1
          }
          yield* vectors.upsert(original)
          const failure = yield* Effect.flip(vectors.upsert({
            ...original,
            vector: sparse,
            contentDigest: "invalid",
            updatedAtMs: 2
          }))
          return { failure, rows: yield* collectVectors(vectors, ["flow-one"], "test") }
        }).pipe(Effect.provide(TestMemory.layerWithDatabase))
      )
      expect(result.failure).toMatchObject({
        code: "invalid_argument",
        message: "vector components must be finite",
        path: ["vector", String(hole)]
      })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ contentDigest: "original", updatedAtMs: 1 })
      expect(Array.from(result.rows[0]!.vector)).toEqual([1, 2])
    }
  )

  it("validates a malformed upsert before constructing or running SQL", async () => {
    let statements = 0
    let writes = 0
    const database = {
      sql: (() => {
        statements += 1
        return Effect.void
      }) as unknown as SqlClient.SqlClient,
      write: (effect: Effect.Effect<unknown, unknown, unknown>) => {
        writes += 1
        return effect
      }
    } as unknown as DatabaseService
    const failure = await Effect.runPromise(Effect.flip(
      Semantic.makeSqlVectorStore(database).upsert({
        bank: "",
        recordKind: "note",
        recordId: "key",
        model: "test",
        contentDigest: "digest",
        dimensions: 1,
        vector: [1],
        updatedAtMs: 0
      })
    ))

    expect(failure).toMatchObject({ code: "invalid_namespace" })
    expect({ statements, writes }).toEqual({ statements: 0, writes: 0 })
  })

  it("reports a typed store error when the vector table is unavailable", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`DROP TABLE memory_vectors ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        return [
          yield* Effect.flip(vectors.upsert({
            bank: "flow-one",
            recordKind: "fact",
            recordId: "runbook",
            model: "test",
            contentDigest: "a",
            dimensions: 1,
            vector: [1],
            updatedAtMs: 0
          })),
          yield* Effect.flip(collectVectors(vectors, ["flow-one"], "test"))
        ]
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "memory vector upsert failed"],
      ["store", "memory vector scan failed"]
    ])
    expect(failures.map((error) => error.cause)).toEqual([
      expect.objectContaining({ _tag: "@smthrs/database/DatabaseError" }),
      expect.objectContaining({ _tag: "SqlError" })
    ])
  })

  it("rejects corrupt vector dimensions and byte lengths as a typed store error", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`INSERT INTO memory_vectors (
          record_kind, record_id, namespace_kind, namespace_id,
          embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
        ) VALUES ('note', 'bad', 'flow', 'one', 'test', 'digest', 2, ${new Uint8Array(4)}, 0)`
        return yield* Effect.flip(collectVectors(vectors, ["flow-one"], "test"))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(failure).toMatchObject({
      code: "store",
      message: "stored memory vector flow/one note/bad (model test) has invalid dimensions or byte length",
      path: ["flow", "one", "note", "bad", "test"]
    })
  })

  it("projects a decorated fact and note write after the authoritative commit", async () => {
    const projected: Array<Semantic.ProjectionInput> = []
    const projector: Semantic.Projector = {
      project: (row) =>
        Effect.sync(() => {
          projected.push(row)
        }),
      activeKeys: () => 0
    }
    const facts = new Map<string, MemoryStore.PutFactInput>()
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: (input) => Effect.sync(() => void facts.set(input.key, input)),
        getFact: (input) =>
          Effect.sync(() => {
            const fact = facts.get(input.key)
            return fact === undefined
              ? undefined
              : {
                ...fact,
                namespace: typeof fact.namespace === "string"
                  ? { kind: "flow" as const, id: fact.namespace }
                  : fact.namespace,
                createdAtMs: 7,
                updatedAtMs: 7
              }
          }),
        putNote: (input) =>
          Effect.succeed({
            namespace: typeof input.namespace === "string"
              ? { kind: "flow" as const, id: input.namespace }
              : input.namespace,
            id: input.id,
            text: input.text,
            tags: input.tags,
            provenance: input.provenance,
            status: input.status ?? "accepted",
            createdAtMs: 11
          })
      }),
      projector,
      Embedding.makeInProcess()
    )
    const namespace = { kind: "flow", id: "one" } as const

    const note = await Effect.runPromise(Effect.gen(function*() {
      yield* decorated.putFact({ namespace, key: "string", value: "already text", provenance: {} })
      yield* decorated.putFact({ namespace, key: "json", value: { content: "structured" }, provenance: {} })
      yield* decorated.putFact({ namespace, key: "fallback", value: { other: "value" }, provenance: {} })
      return yield* decorated.putNote({ namespace, id: "note", text: "note text", tags: [], provenance: {} })
    }))
    const passthrough = await Effect.runPromise(Effect.flip(decorated.listAllFacts))

    expect(projected.map((row) => [row.recordKind, row.recordId, row.text])).toEqual([
      ["fact", "string", "already text"],
      ["fact", "json", "structured"],
      ["fact", "fallback", "{\"other\":\"value\"}"],
      ["note", "note", "note text"]
    ])
    expect(projected.every((row) => row.bank === "flow-one")).toBe(true)
    expect(projected.at(-1)?.updatedAtMs).toBe(11)
    expect(projected[0]?.updatedAtMs).toBe(7)
    expect(note.id).toBe("note")
    expect(passthrough.message).toBe("listAllFacts is unavailable")
  })

  it("returns a committed fact success when its post-commit lookup fails", async () => {
    let writes = 0
    let projections = 0
    const projector: Semantic.Projector = {
      project: () =>
        Effect.sync(() => {
          projections += 1
        }),
      activeKeys: () => 0
    }
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: () =>
          Effect.sync(() => {
            writes += 1
          }),
        getFact: () => Effect.fail(new MemoryError({ code: "store", message: "lookup failed" }))
      }),
      projector,
      Embedding.makeInProcess()
    )

    await expect(Effect.runPromise(
      decorated.putFact({
        namespace: { kind: "flow", id: "one" },
        key: "fact",
        value: "value",
        provenance: {}
      })
    )).resolves.toBeUndefined()
    expect({ writes, projections }).toEqual({ writes: 1, projections: 0 })
  })

  it("skips projection when a committed fact disappears before readback", async () => {
    let writes = 0
    let projections = 0
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: () =>
          Effect.sync(() => {
            writes += 1
          }),
        getFact: () => Effect.succeed(undefined)
      }),
      {
        project: () =>
          Effect.sync(() => {
            projections += 1
          }),
        activeKeys: () => 0
      },
      Embedding.makeInProcess()
    )

    await Effect.runPromise(decorated.putFact({
      namespace: { kind: "flow", id: "one" },
      key: "removed",
      value: "old value",
      provenance: {}
    }))
    expect({ writes, projections }).toEqual({ writes: 1, projections: 0 })
  })

  it("returns a committed note success when its projector interrupts", async () => {
    let writes = 0
    const projector: Semantic.Projector = { project: () => Effect.interrupt, activeKeys: () => 0 }
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putNote: (input) =>
          Effect.sync(() => {
            writes += 1
            return {
              namespace: typeof input.namespace === "string"
                ? { kind: "flow" as const, id: input.namespace }
                : input.namespace,
              id: input.id,
              text: input.text,
              tags: input.tags,
              provenance: input.provenance,
              status: input.status ?? "accepted",
              createdAtMs: 1
            }
          })
      }),
      projector,
      Embedding.makeInProcess()
    )

    const note = await Effect.runPromise(
      decorated.putNote({
        namespace: { kind: "flow", id: "one" },
        id: "note",
        text: "value",
        tags: [],
        provenance: {}
      })
    )
    expect(note.id).toBe("note")
    expect(writes).toBe(1)
  })

  it("names the projected model and digest a committed row", async () => {
    const upserted: Array<Semantic.Vector> = []
    const projector = makeProjector({
      model: "test-model",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            upserted.push(vector)
          })
      }
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "same text",
          updatedAtMs: 1
        })
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "same text",
          updatedAtMs: 2
        })
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "edited text",
          updatedAtMs: 3
        })
      }).pipe(Effect.provideService(Embedding.Embedding, Embedding.makeInProcess()))
    )

    expect(upserted.map((vector) => vector.model)).toEqual(["test-model", "test-model", "test-model"])
    expect(upserted[0]?.contentDigest).toBe(upserted[1]?.contentDigest)
    expect(upserted[2]?.contentDigest).not.toBe(upserted[0]?.contentDigest)
    expect(upserted[0]?.dimensions).toBe(64)
    expect(projector.activeKeys()).toBe(0)
  })

  it("snapshots every projector field before embedding awaits", async () => {
    const upserted: Array<Semantic.Vector> = []
    const row = {
      bank: "flow-one",
      recordKind: "fact" as "fact" | "note",
      recordId: "record",
      text: "embedded text",
      updatedAtMs: 1
    }
    const embedding = Embedding.make((inputs) =>
      Effect.sync(() => {
        row.bank = "flow-mutated"
        row.text = "mutated text"
        row.updatedAtMs = 2
        row.recordKind = "note"
        row.recordId = "mutated-record"
        return inputs.map(() => [1])
      })
    )
    const projector = makeProjector({
      model: "test",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            upserted.push(vector)
          })
      }
    })

    await Effect.runPromise(projector.project(row).pipe(Effect.provideService(Embedding.Embedding, embedding)))

    expect(upserted).toHaveLength(1)
    expect(upserted[0]).toMatchObject({
      bank: "flow-one",
      contentDigest: digest("embedded text"),
      updatedAtMs: 1,
      recordKind: "fact",
      recordId: "record"
    })
  })

  it("recalls decorated SQL rows with a provider dimension other than 64", async () => {
    const model = "provider/three-dimensional"
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const authoritative = yield* MemoryStore.MemoryStore
        const embedding = yield* Embedding.Embedding
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const options = { vectorStore, model, halfLifeMs: 1_000 }
        const decorated = Semantic.decorateStore(authoritative, makeProjector(options), embedding)
        const namespace = { kind: "flow", id: "semantic-e2e" } as const

        yield* decorated.putNote({
          namespace,
          id: "note",
          text: "semantic note",
          tags: [],
          provenance: {}
        })
        yield* decorated.putFact({
          namespace,
          key: "fact",
          value: { content: "semantic fact" },
          provenance: {}
        })
        const recalled = yield* Semantic.recall({ banks: ["flow-semantic-e2e"], query: "semantic" }, options)
        const counts = yield* sql<{ readonly embedding_model: string; readonly count: number }>`
          SELECT embedding_model, count(*) AS count
          FROM memory_vectors
          GROUP BY embedding_model
          ORDER BY embedding_model
        `
        return { recalled, counts }
      }).pipe(
        Effect.provide(Embedding.layerFake(() => [1, 0, 0])),
        Effect.provide(TestMemory.layerWithDatabase)
      )
    )

    expect(result.recalled.map((row) => [row.key, row.text])).toEqual([
      ["fact", "semantic fact"],
      ["note", "semantic note"]
    ])
    expect(result.counts).toEqual([{ embedding_model: model, count: 2 }])
  })

  it("installs semantic recall as the recall service", async () => {
    const rows = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["flow-bank"], query: "runbook" })),
        Effect.provide(Semantic.layer({
          vectorStore: vectorStoreOf([
            projection({ recordId: "runbook", model: "test", contentDigest: digest("durable recovery") })
          ]),
          model: "test",
          halfLifeMs: 1_000
        })),
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf([searchRow({ id: "runbook", key: "runbook", text: "durable recovery" })])
        ),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows).toEqual([
      { bank: "flow-bank", key: "runbook", text: "durable recovery", score: 1, updatedAtMs: 0 }
    ])
  })
})
