import { Result } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ExternalTranscript } from "../src/index.ts"

// Constructed regression records, not reference-host capture evidence.
const line = (payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: "2026-10-06T00:00:00Z",
    type: "event_msg",
    payload
  }) + "\n"
const session = JSON.stringify({
  type: "session_meta",
  payload: { id: "registered-source", cli_version: "0.160.0", cwd: "/workspace" }
}) + "\n"
const errors = line({ type: "error", message: "Explicit provider failure", turn_id: "turn-1" }) +
  line({ type: "turn_aborted", reason: "Interrupted by the user", turn_id: "turn-2" })
const decode = (chunks: ReadonlyArray<string>) => {
  let state = ExternalTranscript.codexStart
  const entries: Array<ExternalTranscript.Entry> = []
  for (const chunk of chunks) {
    const result = Result.getOrThrow(ExternalTranscript.decodeCodex(state, chunk))
    state = JSON.parse(JSON.stringify(result.state))
    entries.push(...result.entries)
  }
  return { state, entries }
}

describe("Codex explicit errors through the public adapter", () => {
  it("retains provider failure and interruption in source order with read-only metadata", () => {
    const { entries } = decode([session + errors])
    expect(entries).toEqual([
      {
        origin: "external",
        agent_kind: "codex",
        format_version: "codex-rollout/0.160",
        session_id: "registered-source",
        source_id: "registered-source:2",
        read_only: true,
        seq: 0,
        at: 1791244800000,
        turn_id: "turn-1",
        role: "assistant",
        part: { type: "error", message: "Explicit provider failure" }
      },
      {
        origin: "external",
        agent_kind: "codex",
        format_version: "codex-rollout/0.160",
        session_id: "registered-source",
        source_id: "registered-source:3",
        read_only: true,
        seq: 1,
        at: 1791244800000,
        turn_id: "turn-2",
        role: "assistant",
        part: { type: "error", message: "Interrupted by the user" }
      }
    ])
  })

  it("replays every character boundary through serialized parser checkpoints", () => {
    const input = session + errors
    const expected = decode([input])
    for (let offset = 0; offset <= input.length; offset++) {
      expect(decode([input.slice(0, offset), input.slice(offset)])).toEqual(expected)
    }
  })

  it("retains explicit error text without a turn id and prefers message over reason", () => {
    expect(decode([session + line({ type: "error", message: "Failure", reason: "Detail" })]).entries[0]).toMatchObject({
      source_id: "registered-source:2",
      part: { type: "error", message: "Failure" }
    })
    expect(decode([session + line({ type: "turn_aborted", reason: "Stopped" })]).entries[0]).not.toHaveProperty(
      "turn_id"
    )
  })

  it.each([{}, { message: "" }, { message: 42 }, { reason: {} }])(
    "rejects a malformed explicit failure %j atomically",
    (fields) => {
      const state = Result.getOrThrow(ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, session)).state
      const saved = JSON.stringify(state)
      const result = ExternalTranscript.decodeCodex(state, errors + line({ type: "error", ...fields }))
      expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 4 })
      expect(JSON.stringify(state)).toBe(saved)
      expect(result).not.toHaveProperty("success")
    }
  )
})

// Sanitized CLI-written records captured as the real microVM's unprivileged agent.
const captured = readFileSync(new URL("./fixtures/external/codex-machine-0.160/rollout.jsonl", import.meta.url), "utf8")
const capturedGolden = JSON.parse(
  readFileSync(new URL("./fixtures/external/codex-machine-0.160/expected.json", import.meta.url), "utf8")
)
const response = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-10-06T00:00:00Z", type: "response_item", payload }) + "\n"
const request = response({
  type: "custom_tool_call",
  call_id: "call-1",
  name: "exec",
  input: "throw new Error('source text only')"
})

describe("recorded member-machine Codex edits and failures", () => {
  it("matches independently mapped golden content including both turns and the failed edit", () => {
    expect(decode([captured])).toEqual(capturedGolden)
    const entries = capturedGolden.entries as ReadonlyArray<ExternalTranscript.Entry>
    expect(entries.filter((e) => e.part.type === "prompt")).toHaveLength(2)
    expect(entries.filter((e) => e.part.type === "edit" && e.part.outcome === "applied")).toHaveLength(2)
    expect(entries.filter((e) => e.part.type === "edit" && e.part.outcome === "failed")).toHaveLength(1)
    expect(entries.filter((e) => e.part.type === "tool" && e.part.status === "error")).toHaveLength(2)
  })

  it("replays the complete capture at every record boundary with JSON-persisted checkpoints", () => {
    const records = captured.split(/(?<=\n)/)
    expect(decode(records)).toEqual(capturedGolden)
    let offset = 0
    for (const record of records) {
      offset += record.length
      expect(decode([captured.slice(0, offset), captured.slice(offset)])).toEqual(capturedGolden)
    }
  })

  it("retains a non-edit script failure and its exact inert parent input", () => {
    const output = "Script failed\nScript error:\nsource text only"
    const first = decode([session + request])
    expect(first.entries).toEqual([])
    expect(first.state.calls).toEqual({ "call-1": { name: "exec", input: "throw new Error('source text only')" } })
    const next = Result.getOrThrow(
      ExternalTranscript.decodeCodex(
        first.state,
        response({ type: "custom_tool_call_output", call_id: "call-1", output })
      )
    )
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0]?.part).toEqual({
      type: "tool",
      call_id: "call-1",
      command: "throw new Error('source text only')",
      reads: [],
      status: "error",
      output,
      duration_ms: 0
    })
    expect(next.state).not.toHaveProperty("calls")
  })

  it.each([
    { call_id: "", input: "inert" },
    { call_id: 1, input: "inert" },
    { call_id: "call-1", input: {} }
  ])("rejects malformed source requests %j", (fields) => {
    const result = ExternalTranscript.decodeCodex(
      ExternalTranscript.codexStart,
      session + response({ type: "custom_tool_call", ...fields })
    )
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 2 })
  })

  it("rejects a repeated request without changing its persisted input", () => {
    const state = decode([session + request]).state
    const saved = JSON.stringify(state)
    const result = ExternalTranscript.decodeCodex(state, request)
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 3 })
    expect(JSON.stringify(state)).toBe(saved)
  })

  it("rejects an unpaired failure without publishing a partial batch", () => {
    const result = ExternalTranscript.decodeCodex(
      ExternalTranscript.codexStart,
      session + errors +
        response({ type: "custom_tool_call_output", call_id: "unpaired", output: "Script failed\nUnpaired failure" })
    )
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 4 })
    expect(result).not.toHaveProperty("success")
  })

  it("does not invent errors or edits from a missing successful output", () => {
    expect(decode([session + request + response({ type: "custom_tool_call_output", call_id: "call-1" })]).entries)
      .toEqual([])
  })
})

// Unknown source semantics must stop admission; an error part is not a rejection.
describe("fail-closed semantic records", () => {
  it.each([
    JSON.stringify({ type: "future-record", payload: {} }) + "\n",
    JSON.stringify({ type: "event_msg", payload: { type: "future-event" } }) + "\n",
    JSON.stringify({ type: "response_item", payload: { type: "future-item" } }) + "\n"
  ])("rejects unknown Codex records atomically: %s", (row) => {
    const state = decode([session]).state
    const saved = JSON.stringify(state)
    const result = ExternalTranscript.decodeCodex(state, errors + row)
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "unsupported_record", line: 4 })
    expect(JSON.stringify(state)).toBe(saved)
    expect(result).not.toHaveProperty("success")
  })

  it("rejects unnamed response semantics as a changed record shape", () => {
    const result = ExternalTranscript.decodeCodex(ExternalTranscript.codexStart, session + response({}))
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 2 })
  })

  it("rejects unknown Claude metadata instead of assuming it is bookkeeping", () => {
    const result = ExternalTranscript.decodeClaude(
      ExternalTranscript.claudeStart,
      "{\"type\":\"some-future-row\",\"uuid\":7}\n"
    )
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "unsupported_record", line: 1 })
  })

  it.each(["", "same"])("rejects empty or repeated Claude request IDs (%s) without changing the checkpoint", (id) => {
    const row = (callId: string) =>
      JSON.stringify({
        type: "assistant",
        uuid: "record",
        sessionId: "session",
        version: "2.1.277",
        message: { content: [{ type: "tool_use", id: callId, name: "Bash", input: { command: "must remain inert" } }] }
      }) + "\n"
    const state = Result.getOrThrow(ExternalTranscript.decodeClaude(ExternalTranscript.claudeStart, row("same"))).state
    const saved = JSON.stringify(state)
    const result = ExternalTranscript.decodeClaude(state, row(id))
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 2 })
    expect(JSON.stringify(state)).toBe(saved)
  })
})

describe("encrypted reasoning in model-facing records", () => {
  it("retains exactly one body marker beside surrounding content in source order", () => {
    const input = session +
      line({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "Before" }] } }) +
      response({ type: "reasoning", id: "reasoning-source", encrypted_content: "ciphertext", summary: [] }) +
      line({ type: "item_completed", item: { type: "AgentMessage", content: [{ type: "Text", text: "After" }] } })
    const expected = decode([input])
    expect(expected.entries.map((entry) => entry.part)).toEqual([{ type: "text", text: "Before", final: false }, {
      type: "encrypted"
    }, { type: "text", text: "After", final: false }])
    for (let offset = 0; offset <= input.length; offset++) {
      expect(decode([input.slice(0, offset), input.slice(offset)])).toEqual(expected)
    }
  })

  it.each(["", 42, {}])("rejects malformed ciphertext %j", (encrypted_content) => {
    const result = ExternalTranscript.decodeCodex(
      ExternalTranscript.codexStart,
      session + response({ type: "reasoning", encrypted_content })
    )
    expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "malformed_record", line: 2 })
  })

  it("skips a reasoning copy with no encrypted body", () => {
    expect(decode([session + response({ type: "reasoning", encrypted_content: null })]).entries).toEqual([])
    expect(decode([session + response({ type: "reasoning" })]).entries).toEqual([])
  })
})
