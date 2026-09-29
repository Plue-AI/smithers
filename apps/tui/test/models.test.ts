import * as NodeControl from "@smthrs/cli/NodeControl"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Models from "../src/models.ts"

/** Claude Code signs its own requests, so resolving its seat never reaches the executor. */
const unusedExecutor = {} as RequestExecutor.RequestExecutor

describe("seatOf", () => {
  const available: ReadonlyArray<Models.Model> = [{ seat: "test:worker", label: "Test", provider: "Test" }]
  test.each(
    [
      ["sol", "openai:gpt-6-sol"],
      ["astra", "openai:gpt-6-astra"],
      ["luna", Models.delegateModels.luna],
      // A Claude alias stays an alias: the seat resolver runs it on a key or on Claude Code.
      ["opus", "opus"],
      ["fable", "fable"],
      [" Sonnet ", "sonnet"],
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
    expect(Models.detect({ CEREBRAS_API_KEY: "test", OPENAI_API_KEY: "test" }).defaultSeat).toBe(
      Models.delegateModels.cerebras
    )
    expect(Models.detect({ OPENAI_API_KEY: "test", MOONSHOT_API_KEY: "test" }).defaultSeat).toBe(
      Models.delegateModels.sol
    )
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

  test("offers the routing graph's seats whose provider runs here", () => {
    const service = Models.routing(available, {}, true)!
    expect(Effect.runSync(service.candidates)).toEqual(["luna", "sol", "astra"])
  })

  test("offers the Claude seats on Claude Code as on an Anthropic key", () => {
    for (const seat of ["claude-code:opus", "anthropic:claude-opus-5-5"]) {
      const claude = { ...available, models: [{ seat, label: "Claude Opus 5.5", provider: "Claude" }] }
      expect(Effect.runSync(Models.routing(claude, {}, true)!.candidates)).toEqual(["opus", "fable", "sonnet"])
    }
  })

  test("routes nothing unjudged or when the operator named the worker seat", () => {
    expect(Models.routing(available, {}, false)).toBeUndefined()
    expect(Models.routing(available, { SMITHERS_TUI_WORKER_SEAT: "openai:gpt-6-sol" }, true)).toBeUndefined()
  })
})

describe("delegable", () => {
  test("names aliases and detected seats whose provider is reachable", () => {
    const openai = [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" }]
    expect(Models.delegable(openai)).not.toContain("cerebras")
    expect(Models.delegable(openai)).toContain("sol")
    expect(Models.delegable(openai)).toContain("openai:gpt-6-sol")
    expect(Models.delegable([{ seat: Models.delegateModels.cerebras, label: "Qwen 3.8", provider: "Cerebras" }]))
      .toEqual(["cerebras", "qwen", Models.delegateModels.cerebras])
    const claude = Models.detect({ ANTHROPIC_API_KEY: "test" }).models
    expect(Models.delegable(claude)).toEqual(expect.arrayContaining(["opus", "sonnet", "fable"]))
    expect(Models.delegable(claude)).not.toContain("claude-code:opus")
    expect(Models.delegable([])).toEqual([])
  })
})

describe("Claude Code seats", () => {
  const claudeOnPath = (status: object) => {
    const directory = mkdtempSync(join(tmpdir(), "tui-claude-"))
    writeFileSync(join(directory, "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 })
    return directory
  }

  test("offers claude-code seats for a Claude Code subscription, and Anthropic seats instead for a key", () => {
    const directory = claudeOnPath({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    try {
      const claude = (models: ReadonlyArray<Models.Model>) =>
        models.filter((model) => model.seat.startsWith("claude-code:") || model.seat.startsWith("anthropic:"))
      expect(claude(Models.detect({ PATH: directory }).models)).toEqual([
        { seat: "claude-code:opus", label: "Claude Opus 5.5", provider: "Claude Code" },
        { seat: "claude-code:sonnet", label: "Claude Sonnet 5.5", provider: "Claude Code" },
        { seat: "claude-code:fable", label: "Claude Fable 5.1", provider: "Claude Code" }
      ])
      expect(Models.delegable(Models.detect({ PATH: directory }).models)).toEqual(expect.arrayContaining([
        "opus", "sonnet", "fable", "claude-code:opus", "claude-code:sonnet", "claude-code:fable"
      ]))
      const keyed = claude(Models.detect({ PATH: directory, ANTHROPIC_API_KEY: "k" }).models).map((model) => model.seat)
      expect(keyed).toEqual(["anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-fable-5-1"])
      expect(Models.seatOf("claude-code:opus", [])).toBe("claude-code:opus")
      expect(Models.labelOf("claude-code:fable", [])).toBe("Claude Fable 5.1")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("runs an agent file's `model: opus` on Claude Code when no Anthropic key is set", async () => {
    const directory = claudeOnPath({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })
    try {
      const environment = { PATH: directory }
      const seat = Models.seatOf("opus", Models.detect(environment).models)!
      expect(seat).toBe("opus")
      // The Anthropic route would refuse without a key; Claude Code runs it.
      const resolved = await Effect.runPromise(NodeControl.seatResolver(environment, unusedExecutor).resolve(seat))
      expect([resolved.id, resolved.modelId]).toEqual(["opus", "claude-opus-5-5"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("offers none when Claude Code is signed out", () => {
    const directory = claudeOnPath({ loggedIn: false, authMethod: "none" })
    try {
      expect(Models.detect({ PATH: directory }).models.filter((model) => model.provider === "Claude Code")).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
