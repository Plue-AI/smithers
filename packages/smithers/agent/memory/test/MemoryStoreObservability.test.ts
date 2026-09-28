import { Effect, Metric, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import { operations } from "../src/internal/Instrument.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "observed" } as const

const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

describe("MemoryStore observability", () => {
  it.each([undefined, null, 42, false, ["flow"], { label: "flow" }])(
    "refuses a nonstring namespace kind %j without recording private values",
    async (kind) => {
      const { spans, tracer } = recordingTracer()
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          const error = yield* Effect.flip(store.putFact({
            namespace: { kind, id: "private-id" } as unknown as Parameters<
              MemoryStore.Service["putFact"]
            >[0]["namespace"],
            key: "private-key",
            value: "private-value",
            provenance: {}
          }))
          return { error, rows: yield* store.listFacts({ namespace }) }
        }).pipe(Effect.provide(TestMemory.layer), Effect.provideService(Tracer.Tracer, tracer))
      )
      expect(result.error.code).toBe("invalid_namespace")
      expect(result.rows).toEqual([])
      const put = spans.find((span) => span.name === "MemoryStore.putFact")
      expect(put).toBeDefined()
      expect(put!.attributes.has("memory.namespace_kind")).toBe(false)
      expect(JSON.stringify([...put!.attributes.entries()])).not.toContain("private")
    }
  )

  it("traces each operation with shape attributes and never values", async () => {
    const { spans, tracer } = recordingTracer()
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        yield* store.putFact({ namespace, key: "secret-key", value: "secret-value", provenance: {} })
        yield* store.listFacts({ namespace, limit: 5 })
      }).pipe(Effect.provide(TestMemory.layer), Effect.provideService(Tracer.Tracer, tracer))
    )
    const put = spans.find((span) => span.name === "MemoryStore.putFact")
    const list = spans.find((span) => span.name === "MemoryStore.listFacts")
    expect(put?.attributes.get("memory.namespace_kind")).toBe("flow")
    expect(list?.attributes.get("memory.limit")).toBe(5)
    expect(list?.attributes.get("memory.rows")).toBe(1)
    const serialized = JSON.stringify(spans.map((span) => [...span.attributes.entries()]))
    expect(serialized).not.toContain("secret")
  })

  it("counts operation outcomes by method", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const failures = Metric.withAttributes(operations, { method: "putFact", outcome: "failure" })
        const before = (yield* Metric.value(failures)).count
        yield* store.putFact({ namespace, key: "", value: "value", provenance: {} }).pipe(Effect.ignore)
        return { before, after: (yield* Metric.value(failures)).count }
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(counts.after).toBe(counts.before + 1)
  })
})
