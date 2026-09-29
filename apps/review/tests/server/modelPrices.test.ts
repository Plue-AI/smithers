import { describe, expect, test } from "bun:test";

import { modelPrices } from "../../src/server/proxy/modelPrices.ts";
import { modelPrices as backendPrices } from "../../../../packages/backend/modelprice/prices.generated.ts";

describe("modelPrices", () => {
  test("exported model prices match backend sheet for every shared model id", () => {
    for (const [id, price] of Object.entries(backendPrices)) {
      expect(modelPrices(id)).toEqual({
        input: price.input, output: price.output,
        cacheRead: price.cacheRead, cacheWrite: price.cacheWrite,
      });
    }
  });
  test("includes GPT-5.6 Sol, Terra, and Luna", () => {
    expect(modelPrices("gpt-5.6-sol")).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4 });
    expect(modelPrices("gpt-5.6-terra")).toEqual({ input: 2, output: 12, cacheWrite: 2.5, cacheRead: 0.2 });
    expect(modelPrices("gpt-5.6-luna")).toEqual({ input: 0.2, output: 1.2, cacheWrite: 0.25, cacheRead: 0.02 });
  });

  test("uses current Anthropic prices", () => {
    expect(modelPrices("claude-fable-5")).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 });
    expect(modelPrices("claude-opus-4-8")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("claude-opus-4-7")).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(modelPrices("claude-haiku-4-5")).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  test("prices GPT-6 Sol including cache writes", () => {
    expect(modelPrices("gpt-6-sol")).toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 });
  });

  test("prices a date-stamped suffix", () => {
    expect(modelPrices("claude-haiku-4-5-20251001").input).toBe(1);
  });

  test("rejects unpriced models, context aliases and arbitrary suffixes", () => {
    for (const id of ["some-unknown-model", "claude-opus-4-8[1m]", "claude-sonnet-4-6-premium"]) {
      expect(() => modelPrices(id)).toThrow("unpriced model");
    }
  });
});
