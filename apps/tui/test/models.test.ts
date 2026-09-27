import * as Providers from "@smthrs/cli/Providers"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Models from "../src/models.ts"

describe("seatOf", () => {
  const available: ReadonlyArray<Models.Model> = [{ seat: "test:worker", label: "Test", provider: "Test" }]
  test.each(
    [
      ["sol", "openai:gpt-6-sol"],
      ["astra", "openai:gpt-6-astra"],
      ["luna", Models.delegateModels.luna],
      ["opus", "anthropic:claude-opus-5-5"],
      ["fable", "anthropic:claude-fable-5-1"],
      ["qwen", Models.delegateModels.cerebras],
      [" Sol ", "openai:gpt-6-sol"],
      ["openai:gpt-6-sol", "openai:gpt-6-sol"],
      ["anthropic:claude-opus-5-5", "anthropic:claude-opus-5-5"],
      ["cerebras:gpt-oss-120b", "cerebras:gpt-oss-120b"],
      ["test:other", "test:other"],
      ["gpt-9", undefined],
      ["nowhere:model", undefined],
      ["openai:", undefined],
      ["", undefined]
    ] as const
  )("%p resolves to %p", (declared, seat) => {
    expect(Models.seatOf(declared, available)).toBe(seat)
  })
})

describe("default chat seat", () => {
  test("prefers Cerebras, then Sol, then another available provider", () => {
    expect(Models.detect({ CEREBRAS_API_KEY: "test", OPENAI_API_KEY: "test" }).defaultSeat).toBe(Models.delegateModels.cerebras)
    expect(Models.detect({ OPENAI_API_KEY: "test", MOONSHOT_API_KEY: "test" }).defaultSeat).toBe(Models.delegateModels.sol)
    expect(Models.detect({ OPENAI_API_KEY: "test", SMITHERS_TUI_SEAT: "custom:chat" }).defaultSeat).toBe("custom:chat")
  })
})

describe("routing", () => {
  const available: Models.Available = {
    models: [
      { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" },
      { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenRouter" },
      { seat: "cerebras:qwen", label: "Qwen", provider: "Cerebras" },
      { seat: Models.delegateModels.cerebras, label: "Qwen 3.8", provider: "Cerebras" },
      { seat: "gemini:gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Gemini" }
    ],
    defaultSeat: undefined,
    workerSeat: undefined,
    environment: {}
  }

  test("offers each non-Cerebras seat once, by its alias when it has one", () => {
    const service = Models.routing(available, {}, true)!
    expect(Effect.runSync(service.candidates)).toEqual([
      { id: "sol", description: Providers.seatDescriptions.sol! },
      { id: "gemini:gemini-2.5-pro", description: "Gemini 2.5 Pro" }
    ])
  })

  test("routes nothing unjudged or when the operator named the worker seat", () => {
    expect(Models.routing(available, {}, false)).toBeUndefined()
    expect(Models.routing(available, { SMITHERS_TUI_WORKER_SEAT: "openai:gpt-6-sol" }, true)).toBeUndefined()
  })
})
