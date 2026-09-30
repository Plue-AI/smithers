import { FlowRuntime } from "@smthrs/flow"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Exit, Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"

const inRun = <A, E, R>(executionId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]))
const inScope = <A, E>(scope: Scope.Scope, effect: Effect.Effect<A, E, Scope.Scope>) => Scope.provide(scope)(effect)

/** One call the provider reported the charge for, so its dollars are exact. */
const charged = (costUsd: number) => ({ inputTokens: 10, outputTokens: 5, costUsd })

describe("USD budget configuration", () => {
  it.each([
    ["a negative ceiling", { max: -1 }],
    ["a non-finite ceiling", { max: Number.POSITIVE_INFINITY }],
    ["a NaN ceiling", { max: Number.NaN }],
    ["a park policy", { max: 1, onExceeded: "park" }]
  ])("rejects %s", async (_label, usd) => {
    const exit = await Effect.runPromiseExit(Budget.make({ usd } as Budget.Policy))
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(exit)).toContain("ConfigurationError")
  })

  it.each(["fail", "warn", "skip-remaining"] as const)(
    "refuses the first reservation under a zero %s ceiling",
    async (onExceeded) => {
      await Effect.runPromise(Effect.gen(function*() {
        const budget = yield* Budget.make({ usd: { max: 0, onExceeded } })
        const verdict = yield* Effect.scoped(budget.reserve("first"))
        expect(verdict).toMatchObject({
          _tag: onExceeded === "warn" ? "warn" : "refuse",
          exceeded: { scope: "usd", max: 0, onExceeded }
        })
      }))
    }
  )
})

describe("USD budget admission", () => {
  it("refuses a call whose forecast would cross the ceiling, with the dollars that broke it", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 1 } })
      expect((yield* Effect.scoped(budget.reserve("a")))._tag).toBe("proceed")
      yield* budget.record("a", charged(0.4), "any-model")
      expect((yield* Effect.scoped(budget.reserve("b")))._tag).toBe("proceed")
      yield* budget.record("b", charged(0.3), "any-model")
      // 0.7 spent and a 0.4 forecast is 1.1 past a 1 dollar ceiling.
      const verdict = yield* Effect.scoped(budget.reserve("c"))
      expect(verdict).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "usd", onExceeded: "fail", max: 1, next: 0.4, reserved: 0 }
      })
      if (verdict._tag !== "refuse") throw new Error("expected a refusal")
      expect(verdict.exceeded.used).toBeCloseTo(0.7, 12)
      expect(verdict.exceeded.message).toBe(
        "The run has spent $0.7 of its $1 approved, has $0 reserved, and the next call is projected at $0.4"
      )
      // A step the ledger already charged replays free.
      expect((yield* Effect.scoped(budget.reserve("a")))._tag).toBe("proceed")
    }))
  })

  it("holds the whole ceiling for an unmeasured first call, so a concurrent second waits", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 5 } })
      const scope = yield* Scope.make()
      expect((yield* inScope(scope, budget.reserve("first")))._tag).toBe("proceed")
      expect(yield* Effect.scoped(budget.reserve("second"))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "usd", used: 0, reserved: 5, next: 5 }
      })
      yield* Scope.close(scope, Exit.void)
      expect((yield* Effect.scoped(budget.reserve("second")))._tag).toBe("proceed")
    }))
  })

  it("latches skip-remaining so every later call is skipped", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 0.5, onExceeded: "skip-remaining" } })
      yield* budget.record("a", charged(0.5), "any-model")
      const refused = yield* budget.check("b")
      expect(refused).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd" } })
      if (refused._tag !== "refuse") throw new Error("expected a refusal")
      expect(refused.failure).toBeInstanceOf(Budget.Skipped)
      expect(yield* budget.check("c")).toMatchObject({ _tag: "refuse", failure: { _tag: Budget.skippedTag } })
    }))
  })

  it("lets a USD refusal win over a token warning on the same call", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 10, onExceeded: "warn" }, usd: { max: 1 } })
      yield* budget.record("a", charged(0.9), "any-model")
      expect(yield* budget.check("b")).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd" } })
    }))
  })

  it("warns past a warn ceiling and still proceeds", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 1, onExceeded: "warn" } })
      yield* budget.record("a", charged(0.9), "any-model")
      expect(yield* budget.check("b")).toMatchObject({ _tag: "warn", exceeded: { scope: "usd" } })
    }))
  })

  it("admits a reading until the ceiling is spent, projecting nothing", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 1 } })
      yield* budget.record("a", charged(0.9), "any-model")
      expect((yield* budget.admitReading("reading-1"))._tag).toBe("proceed")
      yield* budget.record("reading-1", charged(0.1), "any-model")
      expect(yield* budget.admitReading("reading-2")).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd" } })
    }))
  })

  it("prices estimated usage under the policy's own rows", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({
        usd: { max: 1 },
        prices: { "house-model": { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }
      })
      yield* budget.record("a", { inputTokens: 1, outputTokens: 0 }, "house-model")
      expect(yield* budget.check("b")).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd", used: 1 } })
    }))
  })

  it("fails closed once a call's model has no price, and still replays a charged step", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 100 } })
      yield* budget.record("priced", charged(0.1), "any-model")
      yield* budget.record("unpriced", { inputTokens: 10, outputTokens: 5 }, "no-such-model")
      const failure = yield* Effect.flip(budget.check("next"))
      expect(failure).toBeInstanceOf(Budget.AccountingUnavailable)
      expect(failure.message).toContain("\"unpriced\" has no USD price")
      expect((yield* budget.check("priced"))._tag).toBe("proceed")
    }))
  })

  it("does not fail an unpriced call under a policy with no USD ceiling", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 1_000 } })
      yield* budget.record("unpriced", { inputTokens: 10, outputTokens: 5 }, "no-such-model")
      expect((yield* budget.check("next"))._tag).toBe("proceed")
    }))
  })
})

describe("USD budget recovery", () => {
  it("recovers a run's dollars from its journal records", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Budget.make({ usd: { max: 1 } })
        yield* inRun("run-usd", first.record("a", charged(0.6), "any-model"))
        const second = yield* Budget.make({ usd: { max: 1 } })
        expect(yield* inRun("run-usd", second.check("b"))).toMatchObject({
          _tag: "refuse",
          exceeded: { scope: "usd", used: 0.6, next: 0.6 }
        })
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("recovers a run's dollars from its spend ledger when there is no journal", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const ledger = Budget.memoryLedger()
      const first = yield* Budget.make({ usd: { max: 1 } }, { ledger })
      yield* inRun("run-ledger", first.record("a", charged(0.6), "any-model"))
      expect(yield* ledger.run("run-ledger")).toEqual(new Map([["a", { spent: 15, costUsd: 0.6 }]]))
      const second = yield* Budget.make({ usd: { max: 1 } }, { ledger })
      expect(yield* inRun("run-ledger", second.check("b"))).toMatchObject({
        _tag: "refuse",
        exceeded: { scope: "usd", used: 0.6 }
      })
    }))
  })

  it("fails closed on a recovered record written without dollars", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Budget.make({})
        yield* inRun("run-old", first.record("a", { inputTokens: 10, outputTokens: 5 }, "no-such-model"))
        const second = yield* Budget.make({ usd: { max: 1 } })
        const failure = yield* Effect.flip(inRun("run-old", second.check("b")))
        expect(failure).toBeInstanceOf(Budget.AccountingUnavailable)
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })
})
