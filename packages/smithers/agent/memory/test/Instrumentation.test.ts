import { Effect, Metric, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import { instrument, operations } from "../src/internal/Instrument.ts"

describe("memory service instrumentation", () => {
  it("preserves adapter metadata and forwards every operation argument exactly once", async () => {
    const metadata = Object.freeze({ adapter: "custom", version: 1 })
    const calls: Array<ReadonlyArray<unknown>> = []
    const input = { namespace: { kind: "flow", id: "private-bank" }, limit: 3, key: "private-key" }
    const context = { transaction: "private-transaction" }
    const service = instrument({
      metadata,
      read: (first: typeof input, second: typeof context, third: string) =>
        Effect.sync(() => {
          calls.push([first, second, third])
          return ["record-one", "record-two"]
        })
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const metric = Metric.withAttributes(operations, { method: "read", outcome: "success" })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const before = (yield* Metric.value(metric)).count
        const rows = yield* service.read(input, context, "private-option")
        return { rows, increment: (yield* Metric.value(metric)).count - before }
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    expect(service.metadata).toBe(metadata)
    expect(result).toEqual({ rows: ["record-one", "record-two"], increment: 1 })
    expect(calls).toEqual([[input, context, "private-option"]])
    expect(calls[0]?.[0]).toBe(input)
    expect(calls[0]?.[1]).toBe(context)
    expect(spans.map((span) => span.name)).toEqual(["MemoryStore.read"])
    expect([...spans[0]!.attributes.entries()].sort()).toEqual([
      ["memory.limit", 3],
      ["memory.namespace_kind", "flow"],
      ["memory.rows", 2]
    ])
    expect(JSON.stringify([...spans[0]!.attributes.entries()])).not.toContain("private")
  })
})
