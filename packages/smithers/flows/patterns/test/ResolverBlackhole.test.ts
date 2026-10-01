import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { Clock, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Burndown from "../src/Burndown.ts"

// Deterministic boundary fixture: DNS is unavailable for exactly ten minutes.
// The real memory engine drives the action; Burndown projects the real outcome
// into rows and release calls. No timers or retry machinery are mocked.
describe("resolver blackhole row outcomes", () => {
  it.effect("ten minutes of DNS loss yields zero failed rows and releases every item as landed", () => {
    const probeTimes: number[] = []
    const releases: Array<{ id: string; status: Burndown.Status }> = []
    const Status = Action.make("ResolverBlackhole/Status", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Unreachable.Unreachable,
      effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize" }
    })
    const Work = Flow.make("ResolverBlackhole/Work", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Unreachable.Unreachable,
      body: (payload) => Status.call(payload)
    })
    const layer = Layer.mergeAll(
      Status.toLayer(({ id }) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          probeTimes.push(now)
          return now >= 600000 ?
            `collected ${id}`
            : yield* Effect.fail(new Unreachable.Unreachable({ message: "getaddrinfo EAI_AGAIN github.com" }))
        })
      ),
      Interpreter.layer(Work)
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const fiber = yield* Burndown.round({
        input: undefined,
        round: 0,
        items: [{ id: "a" }, { id: "b" }]
      }, {
        key: "resolver-blackhole",
        concurrency: 2,
        claim: () => Effect.void,
        work: ({ item, executionId }) => Work.execute(item, { executionId }),
        release: ({ item, status }) =>
          Effect.sync(() => {
            releases.push({ id: item.id, status })
          }),
        detail: (output) => output
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(600000)
      expect(releases).toEqual([])
      expect(probeTimes.filter((at) => at === 0)).toHaveLength(2)
      expect(probeTimes.every((at) => at < 600000)).toBe(true)
      yield* TestClock.adjust(15000)
      const result = yield* Fiber.join(fiber)
      expect(result.rows.filter((row) => row.status === "failed")).toEqual([])
      expect(result.rows).toEqual([
        { id: "a", status: "landed", detail: "collected a" },
        { id: "b", status: "landed", detail: "collected b" }
      ])
      expect(result.launched).toBe(2)
      expect(releases.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
        { id: "a", status: "landed" },
        { id: "b", status: "landed" }
      ])
      expect(probeTimes.filter((at) => at === 615000)).toHaveLength(2)
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped, Effect.provide(NodeCrypto.layer))
  })
})
