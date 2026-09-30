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
    ["an unknown onExceeded", { max: 1, onExceeded: "pause" }]
  ])("rejects %s", async (_label, usd) => {
    const exit = await Effect.runPromiseExit(Budget.make({ usd } as Budget.Policy))
    expect(exit).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(exit)).toContain("ConfigurationError")
  })

  it.each(["fail", "warn", "skip-remaining", "park"] as const)(
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

  it("admits a judged run: judge readings are priced under the rate card, not left unknown", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const budget = yield* Budget.make({ usd: { max: 1 } })
      yield* budget.record("turn-1", charged(0.4), "anthropic/claude-sonnet-5")
      // Jev through the gateway: 0.042 USD per million input tokens, output free.
      expect((yield* budget.admitReading("reading-jev"))._tag).toBe("proceed")
      yield* budget.record("reading-jev", { inputTokens: 12_000, outputTokens: 3 }, "typesafe-ai/jev")
      // A subscription judge records its seat's model id.
      expect((yield* budget.admitReading("reading-luna"))._tag).toBe("proceed")
      yield* budget.record("reading-luna", { inputTokens: 2_000, outputTokens: 100 }, "openai:gpt-6-luna")
      const verdict = yield* Effect.scoped(budget.reserve("turn-2"))
      expect(verdict._tag).toBe("proceed")
      // 0.4 + 12,000 x 0.042e-6 + (2,000 x 0.1e-6 + 100 x 0.5e-6), with the 0.4 turn as the forecast.
      const refused = yield* Budget.make({ usd: { max: 0.8007 } })
      yield* refused.record("turn-1", charged(0.4), "anthropic/claude-sonnet-5")
      yield* refused.record("reading-jev", { inputTokens: 12_000, outputTokens: 3 }, "typesafe-ai/jev")
      yield* refused.record("reading-luna", { inputTokens: 2_000, outputTokens: 100 }, "openai:gpt-6-luna")
      const over = yield* refused.check("turn-2")
      expect(over).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd", next: 0.4 } })
      if (over._tag !== "refuse") throw new Error("expected a refusal")
      expect(over.exceeded.used).toBeCloseTo(0.4 + 0.000504 + 0.00025, 12)
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

describe("a USD park", () => {
  it("refuses without latching, and a raised ceiling from the envelope admits the call", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const envelope = { capabilities: [], flows: [], budget: { usd: 1, onExceeded: "park" as const } }
        expect(Budget.policyFromEnvelope(envelope)).toEqual({ usd: { max: 1, onExceeded: "park" } })
        const tight = yield* Budget.make(Budget.policyFromEnvelope(envelope))
        yield* inRun("run-park", tight.record("a", charged(0.6), "any-model"))
        const parked = yield* inRun("run-park", tight.check("b"))
        expect(parked).toMatchObject({
          _tag: "refuse",
          exceeded: { scope: "usd", onExceeded: "park", max: 1, next: 0.6 }
        })
        if (parked._tag !== "refuse") throw new Error("expected a refusal")
        // A park is lifted by a raise, so the refusal is not a Skipped latch.
        expect(parked.failure).toBeInstanceOf(Budget.BudgetExceeded)
        expect(yield* inRun("run-park", tight.check("b"))).toMatchObject({ _tag: "refuse" })

        const proposed = Budget.raise(envelope.budget, parked.exceeded)
        expect(proposed).toEqual({ usd: 2.2, onExceeded: "park" })
        const raised = Budget.raisedBy(envelope, [proposed])
        // A restarted host recovers the 0.6 already spent from the journal.
        const resumed = yield* Budget.make(Budget.policyFromEnvelope(raised))
        expect((yield* inRun("run-park", resumed.check("b")))._tag).toBe("proceed")
        yield* inRun("run-park", resumed.record("b", charged(0.6), "any-model"))
        expect((yield* inRun("run-park", resumed.check("c")))._tag).toBe("proceed")
        yield* inRun("run-park", resumed.record("c", charged(0.6), "any-model"))
        // 1.8 spent across both hosts and a 0.6 forecast is past 2.2.
        const again = yield* inRun("run-park", resumed.check("d"))
        expect(again).toMatchObject({ _tag: "refuse", exceeded: { scope: "usd", max: 2.2, next: 0.6 } })
        if (again._tag !== "refuse") throw new Error("expected a refusal")
        expect(again.exceeded.used).toBeCloseTo(1.8, 12)
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )
  })

  it("proposes dollars rounded up to the cent", () => {
    const exceeded = (used: number, reserved: number, next: number, max: number) =>
      new Budget.BudgetExceeded({ scope: "usd", onExceeded: "park", used, reserved, max, next, message: "over" })
    expect(Budget.raise({ usd: 1, tokens: 10 }, exceeded(0.7, 0, 0.4, 1))).toEqual({ usd: 2.1, tokens: 10 })
    expect(Budget.raise({ usd: 0.5 }, exceeded(0.251, 0.1, 0.0001, 0.5))).toEqual({ usd: 0.86 })
    expect(Budget.raise({ usd: 0 }, exceeded(0, 0, 0, 0))).toEqual({ usd: 0 })
  })

  it("applies the largest approved USD raise and never lowers one", () => {
    const envelope = { capabilities: [], flows: [], budget: { usd: 1, tokens: 100 } }
    expect(Budget.raisedBy(envelope, [{ usd: 2.2 }, { usd: 1.5 }, { tokens: 50 }]).budget).toEqual({
      usd: 2.2,
      tokens: 100
    })
    expect(Budget.raisedBy(envelope, [{ usd: 0.5 }]).budget.usd).toBe(1)
    expect(Budget.raisedBy({ ...envelope, budget: {} }, [{ usd: 3 }]).budget).toEqual({})
  })

  it("takes the envelope's onExceeded over the composition default for every ceiling", () => {
    expect(
      Budget.policyFromEnvelope(
        { capabilities: [], flows: [], budget: { usd: 0.25, tokens: 10, onExceeded: "park" } },
        { onExceeded: "fail" }
      )
    ).toEqual({ tokens: { max: 10, onExceeded: "park" }, usd: { max: 0.25, onExceeded: "park" } })
  })
})
