import { describe, expect, test } from "bun:test"
import { cachePercent, meterTokens, runMeterLabel, runMeterOf, runMeterParts, runMeterText, windowPercent } from "./RunMeter"

const at = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, occurredAt: sequence, payload })
const settled = (sequence: number, usage: Record<string, unknown> | undefined) =>
  at(sequence, "control.agent.model-settled", usage === undefined ? { text: "ok" } : { text: "ok", usage })

describe("the run meter", () => {
  test("sums usage over the run, takes context from the latest call and the window from the latest seat", () => {
    const meter = runMeterOf([
      at(1, "control.agent.turn-opened", { seat: "anthropic:claude-haiku-4-5" }),
      settled(2, { inputTokens: 24_000, outputTokens: 1200, cachedInputTokens: 22_000 }),
      at(3, "control.agent.turn-opened", { seat: "openai:gpt-4o" }),
      settled(4, { inputTokens: 10_112, outputTokens: 800, cachedInputTokens: 10_000 })
    ])
    expect(meter).toEqual({ input: 34_112, output: 2000, cached: 32_000, context: 10_112, window: 128_000 })
    expect(runMeterText(meter!)).toBe("↑34k ↓2.0k · 7.9%/128k · cache 94%")
    expect(runMeterLabel(meter!)).toBe("34k tokens in, 2.0k out, 7.9% of 128k window, cache 94%")
  })

  test("a seat whose model the catalog does not know has no window, never an invented one", () => {
    const meter = runMeterOf([
      at(1, "control.agent.turn-opened", { seat: "acme:mystery-model-9" }),
      settled(2, { inputTokens: 5000, outputTokens: 100 })
    ])!
    expect(meter.window).toBeUndefined()
    expect(runMeterText(meter)).toBe("↑5.0k ↓100")
  })

  test("the label says the danger and warning levels in words", () => {
    const meter = runMeterOf([
      at(1, "control.agent.turn-opened", { seat: "openai:gpt-4o" }),
      settled(2, { inputTokens: 120_000, outputTokens: 2000, cachedInputTokens: 30_000 })
    ])!
    expect(runMeterLabel(meter)).toBe("120k tokens in, 2.0k out, 93.8% of 128k window, nearly full, cache 25%, low")
  })

  test("a journal without usage has no meter", () => {
    expect(runMeterOf([])).toBeUndefined()
    expect(runMeterOf([at(1, "control.agent.turn-opened", { seat: "openai:gpt-4o" }), settled(2, undefined)])).toBeUndefined()
    expect(runMeterOf([settled(1, { reasoningTokens: 5 })])).toBeUndefined()
  })

  test("omits the window without a seat and the cache when no call reported cached reads", () => {
    const meter = runMeterOf([settled(1, { inputTokens: 1200, outputTokens: 80 })])!
    expect(meter.window).toBeUndefined()
    expect(meter.cached).toBeUndefined()
    expect(windowPercent(meter)).toBeUndefined()
    expect(cachePercent(meter)).toBeUndefined()
    expect(runMeterText(meter)).toBe("↑1.2k ↓80")
  })

  test("a reported zero is a measured 0% cache, and flags below half", () => {
    const parts = runMeterParts(runMeterOf([settled(1, { inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0 })])!)
    expect(parts.cache).toBe("cache 0%")
    expect(parts.cacheWarning).toBe(true)
  })

  test("a window above 90% is flagged; 90% is not", () => {
    const seat = at(1, "control.agent.turn-opened", { seat: "openai:gpt-4o" })
    const over = runMeterParts(runMeterOf([seat, settled(2, { inputTokens: 116_000, outputTokens: 1 })])!)
    expect(over.window).toBe("90.6%/128k")
    expect(over.windowDanger).toBe(true)
    expect(runMeterParts(runMeterOf([seat, settled(2, { inputTokens: 115_200, outputTokens: 1 })])!).windowDanger).toBe(false)
  })

  test("formats tokens as the terminal does", () => {
    expect([0, 999, 1000, 9_950, 10_000, 999_499, 1_500_000].map(meterTokens))
      .toEqual(["0", "999", "1.0k", "9.9k", "10k", "999k", "1.5M"])
  })
})
