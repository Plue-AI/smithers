import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Effect, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

describe("Embedding provider sparse responses", () => {
  it.each(["missing first vector", "missing later vector", "missing component"] as const)(
    "refuses a batch with %s instead of returning incomplete embeddings",
    async (shape) => {
      const componentHole = new Array<number>(2)
      componentHole[1] = 2
      const vectors = shape === "missing component"
        ? [componentHole]
        : new Array<ReadonlyArray<number>>(shape === "missing later vector" ? 2 : 1)
      if (shape === "missing later vector") vectors[0] = [1, 2]
      expect(
        Object.hasOwn(shape === "missing component" ? componentHole : vectors, shape === "missing later vector" ? 1 : 0)
      ).toBe(false)
      const input = shape === "missing later vector" ? ["a", "b"] : ["a"]
      const service = Embedding.make(() => Effect.succeed(vectors))
      await expect(Effect.runPromise(service.embedMany(input))).rejects.toMatchObject({
        code: "embedding_unavailable",
        message: "embedding provider returned an invalid batch"
      })
    }
  )
})

describe("Embedding provider validation controls", () => {
  it.each(
    [
      ["no vectors", []],
      ["too few vectors", [[1, 2]]],
      ["too many vectors", [[1, 2], [3, 4], [5, 6]]],
      ["zero dimensions", [[], []]],
      ["shorter later vector", [[1, 2], [3]]],
      ["longer later vector", [[1], [2, 3]]],
      ["NaN first", [[Number.NaN, 2], [3, 4]]],
      ["NaN later", [[1, 2], [Number.NaN, 4]]],
      ["positive infinity first", [[Number.POSITIVE_INFINITY, 2], [3, 4]]],
      ["negative infinity first", [[Number.NEGATIVE_INFINITY, 2], [3, 4]]],
      ["positive infinity later", [[1, 2], [3, Number.POSITIVE_INFINITY]]],
      ["negative infinity later", [[1, 2], [Number.NEGATIVE_INFINITY, 4]]]
    ] as const
  )("rejects %s with a typed provider failure", async (_shape, vectors) => {
    const service = Embedding.make(() => Effect.succeed(vectors))
    await expect(Effect.runPromise(service.embedMany(["a", "b"]))).rejects.toMatchObject({
      code: "embedding_unavailable",
      message: "embedding provider returned an invalid batch"
    })
  })

  it("preserves ordered finite components including zero and finite numeric extremes", async () => {
    const service = Embedding.make(() => Effect.succeed([[0, Number.MIN_VALUE], [-1, Number.MAX_VALUE]]))
    expect(await Effect.runPromise(service.embedMany(["a", "b"]))).toEqual({
      embeddings: [{ vector: [0, Number.MIN_VALUE] }, { vector: [-1, Number.MAX_VALUE] }]
    })
  })

  it.each(["missing vector", "missing component"] as const)(
    "failed projection with a %s preserves the prior SQL vector and recovers without zero substitution",
    async (shape) => {
      const rows = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* DurableWriter
          const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
          const projector = yield* Semantic.makeProjector({ vectorStore })
          // Vector writes are accepted only while the authoritative note still
          // holds the projected text, so each step first commits its note.
          const project = (text: string, updatedAtMs: number, embedding: Embedding.Service) =>
            Effect.gen(function*() {
              yield* sql`INSERT INTO memory_notes (
                id, namespace_kind, namespace_id, text, tags_json, provenance_json, status, created_at_ms
              ) VALUES ('key', 'flow', 'bank', ${text}, '[]', '{}', 'accepted', ${updatedAtMs})
              ON CONFLICT (id) DO UPDATE SET text = excluded.text`
              yield* projector.project({ bank: "flow-bank", recordKind: "note", recordId: "key", text, updatedAtMs })
            }).pipe(Effect.provideService(Embedding.Embedding, embedding))
          const scan = () =>
            Stream.runCollect(vectorStore.scan(["flow-bank"], Semantic.defaultModel))
              .pipe(Effect.map((pages) =>
                pages.flat().map(({ vector, updatedAtMs }) => ({ vector: Array.from(vector), updatedAtMs }))
              ))
          yield* project("original", 1, Embedding.make(() => Effect.succeed([[1, 2]])))
          const prior = yield* scan()
          const components = new Array<number>(2)
          components[1] = 2
          const malformed = shape === "missing vector" ? new Array<ReadonlyArray<number>>(1) : [components]
          yield* project("malformed", 2, Embedding.make(() => Effect.succeed(malformed)))
          const afterFailure = yield* scan()
          yield* project("repaired", 3, Embedding.make(() => Effect.succeed([[3, 4]])))
          return { prior, afterFailure, recovered: yield* scan() }
        })).pipe(Effect.provide(TestMemory.layerWithDatabase))
      )
      expect(rows.prior).toEqual([{ vector: [1, 2], updatedAtMs: 1 }])
      expect(rows.afterFailure).toEqual([{ vector: [1, 2], updatedAtMs: 1 }])
      expect(rows.recovered).toEqual([{ vector: [3, 4], updatedAtMs: 3 }])
    }
  )
})
