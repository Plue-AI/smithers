import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { AgentTurnFrameSchema, decodeAgentTurnFrame } from "../src/NativeAgent.ts"
import type { AgentTurnFrame } from "../src/NativeAgent.ts"

const parses = (value: unknown): boolean => AgentTurnFrameSchema.safeParse(value).success

const runHistoryCard = {
  id: "history",
  kind: "file",
  title: "Saved file",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "org/repo", path: "a.ts", content: "Saved", truncated: false }
}

describe("AgentTurnFrame — proxy family", () => {
  /* The frames the client store acts on, one valid instance each. */
  const accepted: ReadonlyArray<readonly [string, unknown]> = [
    ["delta", { runId: "r1", type: "delta", kind: "text", text: "hi" }],
    ["done", { runId: "r1", type: "done", reason: "stop" }],
    ["done, cancelled with an error", {
      runId: "r1",
      type: "done",
      reason: "cancelled",
      error: "the user stopped the turn"
    }],
    ["done carrying the call's usage", {
      runId: "r1",
      type: "done",
      reason: "tool_call",
      usage: { inputTokens: 10_000, outputTokens: 120, cachedInputTokens: 9_400 }
    }],
    ["done carrying partial usage", { runId: "r1", type: "done", usage: { outputTokens: 3 } }],
    ["card", { runId: "r1", type: "card", card: runHistoryCard }],
    ["card.update", {
      runId: "r1",
      type: "card.update",
      id: "history",
      patch: { kind: "file", title: "Runs (3)" }
    }],
    ["tool_call", {
      runId: "r1",
      type: "tool_call",
      call_id: "c1",
      name: "files.read",
      arguments: JSON.stringify({ path: "README.md" })
    }],
    ["park carrying a card", { runId: "r1", type: "park", code: "approval", card: runHistoryCard }]
  ]

  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ["a frame without runId", { type: "delta", kind: "text", text: "hi" }],
    ["done with an unknown reason", { runId: "r1", type: "done", reason: "abandoned" }],
    ["done with negative usage", { runId: "r1", type: "done", usage: { inputTokens: -1 } }],
    ["done with fractional usage", { runId: "r1", type: "done", usage: { outputTokens: 1.5 } }],
    ["done with non-numeric usage", { runId: "r1", type: "done", usage: { cachedInputTokens: "9" } }],
    ["a card of an unknown kind", { runId: "r1", type: "card", card: { ...runHistoryCard, kind: "runs" } }],
    ["a card whose payload misses a required field", {
      runId: "r1",
      type: "card",
      card: { ...runHistoryCard, payload: { repo: "org/repo" } }
    }],
    ["card.update without a kind", { runId: "r1", type: "card.update", id: "history", patch: { title: "Runs (3)" } }],
    ["card.update whose payload contradicts its kind", {
      runId: "r1",
      type: "card.update",
      id: "history",
      patch: { kind: "file", payload: { repo: 5 } }
    }],
    ["tool_call without arguments", { runId: "r1", type: "tool_call", call_id: "c1", name: "files.read" }],
    ["tool_call whose arguments are not a string", {
      runId: "r1",
      type: "tool_call",
      call_id: "c1",
      name: "files.read",
      arguments: { path: "README.md" }
    }],
    ["park carrying a malformed card", {
      runId: "r1",
      type: "park",
      code: "approval",
      card: { ...runHistoryCard, payload: {} }
    }]
  ]

  test("every frame the client store acts on parses", () => {
    expect(accepted.map(([name, value]) => [name, parses(value)])).toEqual(accepted.map(([name]) => [name, true]))
  })

  test("the decoder answers a frame for each of them", () => {
    expect(accepted.map(([name, value]) => [name, decodeAgentTurnFrame(value) !== null]))
      .toEqual(accepted.map(([name]) => [name, true]))
  })

  test("a malformed instance of each frame is rejected", () => {
    expect(rejected.map(([name, value]) => [name, parses(value)])).toEqual(rejected.map(([name]) => [name, false]))
  })

  test("the decoder answers null for each of them", () => {
    expect(rejected.map(([name, value]) => [name, decodeAgentTurnFrame(value)]))
      .toEqual(rejected.map(([name]) => [name, null]))
  })

  test("the decoder keeps a legacy card frame readable without its private payload", () => {
    const frame = decodeAgentTurnFrame({ runId: "r1", type: "card", card: { ...runHistoryCard, kind: "run-history" } })
    expect(frame).toEqual({
      runId: "r1",
      type: "card",
      card: {
        ...runHistoryCard,
        kind: "retired",
        status: "acted",
        loading: false,
        payload: { was: "run-history" }
      }
    })
  })

  test("the decoder answers null for a value that is not an object", () => {
    expect(decodeAgentTurnFrame("{}")).toBe(null)
    expect(decodeAgentTurnFrame(null)).toBe(null)
  })
})

describe("AgentTurnFrame — chain family (DESIGN.md §14)", () => {
  const frames: ReadonlyArray<AgentTurnFrame> = [
    { runId: "lineage-1", type: "link.authored", link: 0, scriptDigest: "d0", script: "```flow\nreturn done({})\n```" },
    { runId: "lineage-1", type: "call.started", link: 0, ordinal: 0, name: "grep" },
    { runId: "lineage-1", type: "call.settled", link: 0, ordinal: 0, name: "grep", verdict: "run" },
    {
      runId: "lineage-1",
      type: "call.settled",
      link: 1,
      ordinal: 0,
      name: "grep",
      verdict: "replay",
      resultDigest: "abc"
    },
    { runId: "lineage-1", type: "gate.rejected", link: 1, kind: "catalog", message: "unknown entry: frobnicate" },
    { runId: "lineage-1", type: "link.ended", link: 1, outcome: "to" },
    { runId: "lineage-1", type: "steering.drained", link: 2, count: 1 },
    { runId: "lineage-1", type: "park", code: "approval" }
  ]

  test("every chain frame round-trips through the schema", () => {
    for (const frame of frames) {
      const parsed = AgentTurnFrameSchema.safeParse(frame)
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data).toEqual(frame)
    }
  })

  test("the decoder answers the chain family too", () => {
    for (const frame of frames) expect(decodeAgentTurnFrame(frame)).toEqual(frame)
  })

  test("verdict, gate kind, outcome, and park code are closed vocabularies", () => {
    expect(parses({ runId: "r", type: "call.settled", link: 0, ordinal: 0, name: "x", verdict: "cached" })).toBe(false)
    expect(parses({ runId: "r", type: "gate.rejected", link: 0, kind: "vibes" })).toBe(false)
    expect(parses({ runId: "r", type: "link.ended", link: 0, outcome: "crashed" })).toBe(false)
    expect(parses({ runId: "r", type: "park", code: "nap" })).toBe(false)
  })

  test("link and ordinal are non-negative integers; drained count is positive", () => {
    expect(parses({ runId: "r", type: "link.ended", link: -1, outcome: "done" })).toBe(false)
    expect(parses({ runId: "r", type: "call.started", link: 0, ordinal: 1.5, name: "x" })).toBe(false)
    expect(parses({ runId: "r", type: "steering.drained", link: 0, count: 0 })).toBe(false)
  })

  test("an unknown frame type is rejected", () => {
    expect(parses({ runId: "r", type: "link.rebased", link: 0 })).toBe(false)
  })
})

/*
 * The dependency law of DESIGN.md §14: @smthrs/rpc mirrors chain vocabulary and
 * imports only runtime-free canonical entry points. This keeps the Worker
 * and both bridges free of Effect runtime imports.
 */
describe("RPC sources stay runtime-free", () => {
  test("only runtime-free canonical record and serializer entry points cross the Smithers boundary", () => {
    const dir = join(import.meta.dirname, "../src")
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
      const source = readFileSync(join(dir, file), "utf8")
      // Covers bare, subpath, single-quoted, and dynamic import specifiers.
      expect(source).not.toMatch(/(from\s+|import\()\s*["']@smthrs\/(?!canonical\/(?:Record|Serializer)["'])/)
      expect(source).not.toMatch(/(from\s+|import\()\s*["']effect(["']|\/)/)
    }
  })
})
