import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  AGENT_TURN_COMMAND_NAME_MAX_CHARS,
  AGENT_TURN_COMMAND_SUMMARY_MAX_CHARS,
  AGENT_TURN_COMMANDS_MAX,
  AgentTurnCommandsSchema,
  AgentTurnFrameSchema,
  decodeAgentTurnFrame,
  readAgentTurnCommands
} from "../src/NativeAgent.ts"
import type { AgentTurnFrame } from "../src/NativeAgent.ts"

const parses = (value: unknown): boolean => AgentTurnFrameSchema.safeParse(value).success

/*
 * A card whose nested run omits `labels` — `RunRecordSchema` defaults it. The
 * frame type declares the field required, so only the decoded frame carries
 * what a subscriber reads.
 */
const runHistoryCard = {
  id: "history",
  kind: "run-history",
  title: "Runs",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repoId: "repo",
    status: "done",
    runs: [{ runId: "run-1", repoId: "repo", label: "//:test", status: "done", startedAt: 0 }]
  }
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
      patch: { kind: "run-history", title: "Runs (3)" }
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
      card: { ...runHistoryCard, payload: { repoId: "repo", status: "done" } }
    }],
    ["card.update without a kind", { runId: "r1", type: "card.update", id: "history", patch: { title: "Runs (3)" } }],
    ["card.update whose payload contradicts its kind", {
      runId: "r1",
      type: "card.update",
      id: "history",
      patch: { kind: "run-history", payload: { repoId: 5 } }
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

  test("the decoder applies nested card defaults the input omitted", () => {
    // The wire value never carried the field the frame type declares required.
    expect(Object.hasOwn(runHistoryCard.payload.runs[0]!, "labels")).toBe(false)
    const frame = decodeAgentTurnFrame({ runId: "r1", type: "card", card: runHistoryCard })
    if (frame === null || frame.type !== "card" || frame.card.kind !== "run-history") {
      throw new Error("expected a decoded run-history card frame")
    }
    expect(frame.card.payload.runs[0]!.labels).toEqual([])
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

/*
 * The command catalog a turn carries as data. The serving side's front door
 * (apps/server frontDoor.ts) offers it to a decision model, so it is bounded
 * exactly like the recommender's list — and read leniently, because a client
 * that sends a catalog this contract does not allow must still get its turn.
 */
describe("the turn body's offered command catalog", () => {
  const commands = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `namespace.command-${index}`, summary: "does a thing" }))

  test("accepts a well-formed list and answers it decoded", () => {
    const list = commands(3)
    expect(readAgentTurnCommands(list)).toEqual(list)
    expect(AgentTurnCommandsSchema.safeParse(list).success).toBe(true)
  })

  test("accepts exactly the cap and refuses one more", () => {
    expect(readAgentTurnCommands(commands(AGENT_TURN_COMMANDS_MAX))).toHaveLength(AGENT_TURN_COMMANDS_MAX)
    expect(readAgentTurnCommands(commands(AGENT_TURN_COMMANDS_MAX + 1))).toBeUndefined()
  })

  test("bounds a name and a summary by length, and refuses an empty name", () => {
    const long = (length: number) => "n".repeat(length)
    expect(readAgentTurnCommands([{ name: long(AGENT_TURN_COMMAND_NAME_MAX_CHARS), summary: "" }])).toHaveLength(1)
    expect(readAgentTurnCommands([{ name: long(AGENT_TURN_COMMAND_NAME_MAX_CHARS + 1), summary: "" }])).toBeUndefined()
    expect(readAgentTurnCommands([{ name: "a", summary: long(AGENT_TURN_COMMAND_SUMMARY_MAX_CHARS) }])).toHaveLength(1)
    expect(readAgentTurnCommands([{ name: "a", summary: long(AGENT_TURN_COMMAND_SUMMARY_MAX_CHARS + 1) }]))
      .toBeUndefined()
    expect(readAgentTurnCommands([{ name: "", summary: "" }])).toBeUndefined()
  })

  test("a body without the field, or with a shape this contract does not allow, is undefined rather than a refusal", () => {
    expect(readAgentTurnCommands(undefined)).toBeUndefined()
    expect(readAgentTurnCommands(null)).toBeUndefined()
    expect(readAgentTurnCommands("runs.list")).toBeUndefined()
    expect(readAgentTurnCommands([{ name: "a" }])).toBeUndefined()
    expect(readAgentTurnCommands([{ name: "a", summary: 7 }])).toBeUndefined()
    expect(readAgentTurnCommands([])).toEqual([])
  })
})
