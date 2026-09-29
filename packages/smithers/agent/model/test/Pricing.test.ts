import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Pricing from "../src/Pricing.ts"

const million = 1_000_000

describe("Pricing.lookup", () => {
  it("resolves exact ids, seats, gateway ids and dated snapshots to the rate card", () => {
    const sol = Pricing.table["gpt-5.6-sol"]
    expect(sol).toMatchObject({ input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20, provider: "openai" })
    expect(Pricing.lookup("gpt-5.6-sol", { at: 0 })).toBe(sol)
    expect(Pricing.lookup("openai:gpt-5.6-sol", { at: 0 })).toBe(sol)
    expect(Pricing.lookup(" openrouter/openai/gpt-5.6-sol ", { at: 0 })).toBe(sol)
    expect(Pricing.lookup("claude-haiku-4-5-20251001", { at: 0 })).toBe(Pricing.table["claude-haiku-4-5"])
    expect(Pricing.lookup("anthropic/claude-haiku-4-5-20251001", { at: 0 })).toBe(Pricing.table["claude-haiku-4-5"])
  })

  it("answers undefined for a model the table does not price", () => {
    expect(Pricing.lookup("unknown-model")).toBeUndefined()
    expect(Pricing.lookup("")).toBeUndefined()
    expect(Pricing.lookup("toString")).toBeUndefined()
    expect(Pricing.lookup("gpt-5.6-sol-2026")).toBeUndefined()
  })

  it("switches to a dated successor from its start instant", () => {
    const current = Pricing.table["gemini-3.8-flash"]!
    const from = Date.parse(current.nextFrom!)
    expect(Pricing.lookup("gemini-3.8-flash", { at: from - 1 })).toBe(current)
    expect(Pricing.lookup("gemini-3.8-flash", { at: from })).toBe(current.next)
    expect(Pricing.lookup("gemini-3.8-flash", { at: from })).toMatchObject({ input: 1.5, output: 7.5 })
  })

  it("prefers an exact override row over the bare model's card", () => {
    const seat = { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 }
    const table = { ...Pricing.table, "openai:gpt-5.6-sol": seat }
    expect(Pricing.lookup("openai:gpt-5.6-sol", { table })).toBe(seat)
    expect(Pricing.lookup("gpt-5.6-sol", { table, at: 0 })).toBe(Pricing.table["gpt-5.6-sol"])
    expect(Pricing.lookup("gpt-5.6-sol", { table: { "gpt-5.6-sol": seat } })).toBe(seat)
  })
})

describe("Pricing.weigh", () => {
  const rates = { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 }

  it("charges each token class inside the input count at its own rate", () => {
    expect(Pricing.weigh({ inputTokens: 10, cachedInputTokens: 3, cacheWriteTokens: 2, outputTokens: 4 }, rates))
      .toBe(5 * 5 + 3 * 0.5 + 2 * 6.25 + 4 * 25)
    expect(Pricing.weigh({ inputTokens: 10, outputTokens: 0 }, rates)).toBe(50)
    expect(Pricing.weigh({ inputTokens: 5, cachedInputTokens: 3, cacheWriteTokens: 2, outputTokens: 0 }, rates))
      .toBe(3 * 0.5 + 2 * 6.25)
  })

  it.each([
    ["no input count", { outputTokens: 1 }],
    ["no output count", { inputTokens: 1 }],
    ["a total only", { totalTokens: 10 }],
    ["a negative counter", { inputTokens: 1, outputTokens: -1 }],
    ["a non-finite counter", { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 1 }],
    ["a NaN cache count", { inputTokens: 1, outputTokens: 1, cacheWriteTokens: Number.NaN }],
    ["cache classes above the input count", {
      inputTokens: 4,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      outputTokens: 0
    }]
  ])("is NaN for %s", (_name, usage) => {
    expect(Pricing.weigh(usage, rates)).toBeNaN()
  })
})

describe("Pricing.costUsd", () => {
  it("prices cache writes at the cache-write rate", () => {
    const usage = { inputTokens: 1_001_000, cachedInputTokens: 0, cacheWriteTokens: million, outputTokens: 0 }
    expect(Pricing.costUsd(usage, { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 })).toBe(6.255)
  })

  it("prices the whole call at the long-context card from its threshold", () => {
    const sol = Pricing.table["gpt-5.6-sol"]!
    const below = { inputTokens: 271_999, outputTokens: million }
    const at = { inputTokens: 272_000, outputTokens: million }
    expect(Pricing.costUsd(below, sol)).toBeCloseTo(271_999 * 4 / million + 20, 9)
    expect(Pricing.costUsd(at, sol)).toBeCloseTo(272_000 * 8 / million + 30, 9)
    // Cache reads and writes count toward the prompt size.
    expect(Pricing.costUsd({ inputTokens: 272_000, cachedInputTokens: 272_000, outputTokens: 0 }, sol))
      .toBeCloseTo(272_000 * 0.8 / million, 9)
  })

  it("adds a per-call charge once and nothing for a flat card without one", () => {
    expect(Pricing.costUsd({ inputTokens: 0, outputTokens: 0 }, Pricing.table["typesafe-ai/jev"]!)).toBe(0.002)
    expect(Pricing.costUsd({ inputTokens: million, outputTokens: 0 }, Pricing.table["claude-opus-4-8"]!)).toBe(5)
  })

  it("prices a per-call endpoint that reports no token usage at its per-call charge", () => {
    const jev = Pricing.table["typesafe-ai/jev"]!
    expect(Pricing.costUsd({}, jev)).toBe(0.002)
    expect(Pricing.costUsd({ inputTokens: 1 }, jev)).toBeNaN()
    expect(Pricing.costUsd({ outputTokens: 1 }, jev)).toBeNaN()
    expect(Pricing.cost({}, "typesafe-ai/jev")).toEqual({ costUsd: 0.002, costSource: "estimated" })
    expect(Pricing.costUsd({}, Pricing.table["claude-opus-4-8"]!)).toBeNaN()
  })

  it("is NaN for usage it cannot price", () => {
    expect(Pricing.costUsd({ totalTokens: 10 }, Pricing.table["gpt-5.6-sol"]!)).toBeNaN()
  })
})

describe("Pricing.cost", () => {
  const usage = { inputTokens: million, outputTokens: 0 }

  it("prefers a valid reported charge", () => {
    expect(Pricing.cost({ ...usage, costUsd: 0.25 }, "claude-opus-4-8")).toEqual({
      costUsd: 0.25,
      costSource: "reported"
    })
    expect(Pricing.cost({ ...usage, costUsd: 0 }, undefined)).toEqual({ costUsd: 0, costSource: "reported" })
  })

  it("estimates from the rate card when the report is missing or invalid", () => {
    const estimated = { costUsd: 5, costSource: "estimated" }
    expect(Pricing.cost(usage, "claude-opus-4-8")).toEqual(estimated)
    expect(Pricing.cost({ ...usage, costUsd: -1 }, "claude-opus-4-8")).toEqual(estimated)
    expect(Pricing.cost({ ...usage, costUsd: Number.NaN }, "claude-opus-4-8")).toEqual(estimated)
    expect(Pricing.cost({ ...usage, costUsd: Number.POSITIVE_INFINITY }, "claude-opus-4-8")).toEqual(estimated)
  })

  it("uses the table and instant it is given", () => {
    const table = { "my-seat": { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } }
    expect(Pricing.cost(usage, "my-seat", { table })).toEqual({ costUsd: 1, costSource: "estimated" })
    const from = Date.parse(Pricing.table["gemini-3.8-flash"]!.nextFrom!)
    expect(Pricing.cost(usage, "gemini-3.8-flash", { at: from })).toEqual({ costUsd: 1.5, costSource: "estimated" })
  })

  it("is undefined without a model, for an unpriced model, and for malformed usage", () => {
    expect(Pricing.cost(usage, undefined)).toBeUndefined()
    expect(Pricing.cost(usage, "unknown-model")).toBeUndefined()
    expect(Pricing.cost({ totalTokens: 10 }, "claude-opus-4-8")).toBeUndefined()
  })
})

describe("Pricing schemas", () => {
  it("accept only non-negative finite rates and the two cost sources", () => {
    const decodeRates = Schema.decodeUnknownSync(Pricing.Rates)
    expect(decodeRates({ input: 1, cacheRead: 0, cacheWrite: 2, output: 3 })).toEqual({
      input: 1,
      cacheRead: 0,
      cacheWrite: 2,
      output: 3
    })
    expect(() => decodeRates({ input: -1, cacheRead: 0, cacheWrite: 0, output: 0 })).toThrow()
    expect(() => decodeRates({ input: 1, cacheRead: 0, output: 0 })).toThrow()
    const decodeSource = Schema.decodeUnknownSync(Pricing.CostSource)
    expect(decodeSource("reported")).toBe("reported")
    expect(decodeSource("estimated")).toBe("estimated")
    expect(() => decodeSource("guessed")).toThrow()
  })
})

describe("the rate card", () => {
  it("prices every row's cache classes and never below zero", () => {
    const rows = Object.values(Pricing.table)
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) {
      for (const rate of [row.input, row.cacheRead, row.cacheWrite, row.output]) {
        expect(Number.isFinite(rate) && rate >= 0).toBe(true)
      }
    }
  })
})
