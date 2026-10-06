import { Result } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Transcript as External } from "../src/index.ts"

const context = {
  owner_id: "registered-owner",
  participant_id: "registered-agent",
  session_id: "registered-session",
  source_generation: "generation-1"
}
const fixture = (name: string, suffix: string) =>
  readFileSync(new URL(`./fixtures/external/${name}.${suffix}`, import.meta.url), "utf8")
const ok = (result: Result.Result<External.ExternalDecoded, External.ExternalDecodeError>) => Result.getOrThrow(result)
const claude = (r: unknown) => JSON.stringify(r) + "\n"
const codex = (p: unknown, type = "response_item") => claude({ timestamp: "2026-10-03T00:00:00Z", type, payload: p })
const user = (content: unknown, extra = {}) => ({
  uuid: "u",
  type: "user",
  message: { role: "user", content },
  ...extra
})
const assistant = (content: unknown, extra = {}) => ({
  uuid: "a",
  type: "assistant",
  message: { role: "assistant", content },
  ...extra
})
const decodeC = (r: unknown) => External.decodeClaudeCode("claude-code/2.1.0", context, claude(r))
const decodeX = (p: unknown, type?: string) => External.decodeCodex("codex/0.160.0", context, codex(p, type))
const error = (r: Result.Result<External.ExternalDecoded, External.ExternalDecodeError>, tag = "MalformedRecord") => {
  expect(Result.isFailure(r)).toBe(true)
  if (Result.isFailure(r)) expect(r.failure._tag).toBe(tag)
}

for (const name of ["claude-synthetic", "codex-synthetic", "codex-recorded"]) {
  describe(name, () => {
    const decode = name.startsWith("claude") ? External.decodeClaudeCode : External.decodeCodex
    const version = name.startsWith("claude") ? "claude-code/2.1.0" : "codex/0.160.0"
    const input = fixture(name, "jsonl")
    const expected: unknown = JSON.parse(fixture(name, "expected.json"))
    it("matches independently committed complete golden output through public exports", () => {
      expect(ok(decode(version, context, input)).entries).toEqual(expected)
      expect(ok(decode(version, context, input)).needs_more).toBe(false)
    })
    const partitions = 2 ** (input.split("\n").length - 2)
    it.each(Array.from({ length: Math.ceil(partitions / 2048) }, (_, i) => i * 2048))(
      "replays every record-boundary partition with checkpoints (batch %i)",
      (start) => {
        const lines = input.match(/[^\n]*\n/g)!
        // Enumerate every partition, including one chunk and every individual record.
        for (let mask = start; mask < Math.min(start + 2048, partitions); mask++) {
          let state: External.ExternalState | undefined
          const entries: Array<External.ExternalDraft> = []
          let chunk = ""
          for (let i = 0; i < lines.length; i++) {
            chunk += lines[i]
            if (i === lines.length - 1 || mask & (1 << i)) {
              const next = ok(decode(version, context, chunk, state))
              entries.push(...next.entries)
              state = JSON.parse(JSON.stringify(next.state)) as External.ExternalState
              chunk = ""
            }
          }
          expect(entries).toEqual(expected)
        }
      }
    )
    it("waits on an incomplete final record and resumes without losing UTF-8 offsets", () => {
      const last = input.lastIndexOf("\n", input.length - 2) + 1
      const split = last + 3
      const first = ok(decode(version, context, input.slice(0, split)))
      expect(first.needs_more).toBe(true)
      const next = ok(decode(version, context, input.slice(split), first.state))
      expect([...first.entries, ...next.entries]).toEqual(expected)
      expect(next.needs_more).toBe(false)
    })
    it("does not require providers, dispatch, publication, registration or process access", () => {
      const trusted = Object.freeze({ ...context })
      const state = ok(decode(version, trusted, input)).state
      Object.freeze(state)
      Object.freeze(state.calls)
      expect(ok(decode(version, trusted, "", state)).entries).toEqual([])
      expect(trusted).toEqual(context)
      const entries = ok(decode(version, trusted, input)).entries
      for (const entry of entries) {
        expect(entry.owner_id).toBe("registered-owner")
        expect(entry.participant_id).toBe("registered-agent")
        expect(entry.session_id).toBe("registered-session")
        expect(entry.read_only).toBe(true)
        expect(entry.origin).toBe("external")
        expect(entry).not.toHaveProperty("run_id")
      }
    })
  })
}

it("retains exactly one encrypted body placeholder per source body", () => {
  const entries = ok(External.decodeCodex("codex/0.160.0", context, fixture("codex-recorded", "jsonl"))).entries
  expect(entries.filter((e) => e.body === "Encrypted by Codex")).toHaveLength(1)
  const encrypted = ok(decodeX({
    type: "agent_message",
    id: "encrypted",
    content: [
      { type: "input_text", text: "must not leak alongside ciphertext" },
      { type: "encrypted_content", encrypted_content: "cipher" },
      { type: "encrypted_content", encrypted_content: "cipher2" }
    ]
  })).entries
  expect(encrypted).toHaveLength(1)
  expect(encrypted[0]).toMatchObject({ source_id: "encrypted", body: "Encrypted by Codex", source_offset: 0 })
})

for (const decode of [External.decodeClaudeCode, External.decodeCodex]) {
  it.each([undefined, "", "unknown", "codex/1", "claude-code/1"])("rejects explicit profile %s", (version) => {
    error(decode(version, context, ""), version ? "UnsupportedVersion" : "MissingVersion")
  })
}
it("requires caller attribution and fences checkpoints across sources", () => {
  for (const key of Object.keys(context)) {
    error(External.decodeClaudeCode("claude-code/2.1.0", { ...context, [key]: "" }, ""), "InvalidContext")
  }
  const state = ok(External.decodeClaudeCode("claude-code/2.1.0", context, "")).state
  for (const key of Object.keys(context)) {
    error(External.decodeClaudeCode("claude-code/2.1.0", { ...context, [key]: "other" }, "", state), "StateMismatch")
  }
  error(External.decodeCodex("codex/0.160.0", context, "", state), "StateMismatch")
})
it.each(["bad\n", "null\n", "[]\n", "1\n", "{}\n", "\n"])("rejects malformed complete JSONL %s", (line) => {
  error(External.decodeClaudeCode("claude-code/2.1.0", context, line))
})
it.each([
  user(2),
  user([], { uuid: 1 }),
  user("x", { version: "next" }),
  user("x", { message: { role: "assistant", content: "x" } }),
  user([{ type: "text", text: 2 }]),
  user([null]),
  user([{ type: "tool_result", tool_use_id: "absent", content: "x" }]),
  user([{ type: "tool_result", tool_use_id: "x", content: "x", is_error: "yes" }]),
  assistant([{ type: "tool_use", id: "", name: "Read", input: {} }]),
  assistant([{ type: "tool_use", id: "x", name: 2, input: {} }]),
  assistant([{ type: "tool_use", id: "x", name: "Read" }])
])("rejects changed Claude shapes", (record) => error(decodeC(record)))
it.each([{ type: "new" }, user([{ type: "new" }])])(
  "rejects unknown Claude semantics",
  (r) => error(decodeC(r), "UnsupportedRecord")
)
it.each([
  { type: "new" },
  { type: "message", role: "root", content: [] },
  { type: "message", role: "user", content: [{ type: "new" }] },
  { type: "reasoning", summary: [{ type: "new", text: "x" }] },
  { type: "reasoning", summary: [], content: [{ type: "new" }] },
  { type: "agent_message", content: [{ type: "new" }] }
])("rejects unknown Codex semantics", (p) => error(decodeX(p), "UnsupportedRecord"))
it.each([
  null,
  { type: "message", content: [] },
  { type: "message", role: "user", content: null },
  { type: "function_call", call_id: "x", name: "Read", arguments: {} },
  { type: "function_call_output", call_id: "absent", output: "x" },
  { type: "reasoning", summary: [], encrypted_content: 2 }
])("rejects malformed Codex shapes", (p) => error(decodeX(p)))
it("rejects unknown metadata and changed envelope shapes", () => {
  error(decodeX({ type: "new" }, "event_msg"), "UnsupportedRecord")
  error(decodeX({}, "new"), "UnsupportedRecord")
  error(decodeX({ cli_version: "next" }, "session_meta"))
  error(
    External.decodeCodex(
      "codex/0.160.0",
      context,
      claude({ type: "response_item", payload: { type: "message", role: "user", content: [] } })
    )
  )
})
it("retains Codex interruption reports as failed parts", () => {
  expect(ok(decodeX({ type: "turn_aborted", reason: "interrupted" }, "event_msg")).entries[0]).toMatchObject({
    kind: "error",
    failed: true,
    body: { interrupted: { type: "turn_aborted", reason: "interrupted" } }
  })
})
it("retains explicit Claude parts and skips only named metadata", () => {
  expect(
    ok(decodeC(assistant([
      { type: "thinking", thinking: "reasoning" },
      { type: "redacted_thinking", data: "hidden" },
      { type: "image", source: { type: "base64", data: "abc" } }
    ]))).entries.map((e) => [e.kind, e.body])
  ).toEqual([
    ["thinking", "reasoning"],
    ["thinking", { redacted: "hidden" }],
    ["attachment", { type: "base64", data: "abc" }]
  ])
  for (const type of ["queue-operation", "file-history-snapshot", "progress"]) {
    expect(ok(decodeC({ type })).entries).toEqual([])
  }
  expect(ok(decodeC({ type: "system", subtype: "compact_boundary" })).entries[0]?.body).toEqual({
    compact_boundary: { type: "system", subtype: "compact_boundary" }
  })
})
it("maps Codex parts and explicit metadata skip rules", () => {
  expect(
    ok(
      decodeX({
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }]
      })
    ).entries[0]?.kind
  ).toBe("attachment")
  expect(ok(decodeX({ type: "message", role: "assistant", content: [{ type: "encrypted_content" }] })).entries[0]?.body)
    .toBe("Encrypted by Codex")
  expect(
    ok(
      decodeX({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
        content: [{ type: "reasoning_text", text: "thought" }],
        encrypted_content: null
      })
    ).entries.map((e) => e.body)
  ).toEqual(["summary", "thought"])
  expect(ok(decodeX({ type: "agent_message", content: [{ type: "input_text", text: "plain" }] })).entries[0]?.body)
    .toBe("plain")
  for (const type of ["turn_context", "world_state", "token_usage_record"]) {
    expect(ok(decodeX({}, type)).entries).toEqual([])
  }
  for (
    const type of [
      "task_started",
      "task_complete",
      "task_completed",
      "token_count",
      "item_completed",
      "user_message",
      "agent_message",
      "agent_reasoning"
    ]
  ) expect(ok(decodeX({ type }, "event_msg")).entries).toEqual([])
  for (const role of ["system", "developer"]) {
    expect(ok(decodeX({ type: "message", role, content: [{ type: "input_text", text: "instructions" }] })).entries)
      .toEqual([])
  }
})
it("correlates tools across interruption, protects hostile keys and rejects duplicate/results", () => {
  const first = ok(decodeC(assistant([{ type: "tool_use", id: "__proto__", name: "Read", input: {} }])))
  const next = External.decodeClaudeCode(
    "claude-code/2.1.0",
    context,
    claude(user([{ type: "tool_result", tool_use_id: "__proto__", content: [{ type: "text", text: "ok" }] }])),
    first.state
  )
  expect(ok(next).entries).toHaveLength(1)
  expect(ok(next).entries[0]?.call_id).toBe("__proto__")
  error(
    External.decodeClaudeCode(
      "claude-code/2.1.0",
      context,
      claude(assistant([{ type: "tool_use", id: "__proto__", name: "Read", input: {} }])),
      first.state
    )
  )
  error(
    External.decodeClaudeCode(
      "claude-code/2.1.0",
      context,
      claude(user([{ type: "tool_result", tool_use_id: "__proto__" }])),
      first.state
    )
  )
  expect(first.state.calls).toHaveProperty("__proto__")
  const request = codex({ type: "function_call", call_id: "x", name: "Read", arguments: "{}" })
  expect(
    ok(
      External.decodeCodex(
        "codex/0.160.0",
        context,
        request +
          codex({ type: "function_call_output", call_id: "x", output: [{ type: "input_image", image_url: "image" }] })
      )
    ).entries[1]?.body
  ).toEqual([{ type: "input_image", image_url: "image" }])
  error(
    External.decodeCodex(
      "codex/0.160.0",
      context,
      request + codex({ type: "function_call_output", call_id: "x", output: [{ type: "new" }] })
    ),
    "UnsupportedRecord"
  )
})
it("preserves Unicode byte offsets, CRLF and every character split", () => {
  const input = claude(user("é🪄")).replace("\n", "\r\n") + claude(assistant("done"))
  const expected = ok(External.decodeClaudeCode("claude-code/2.1.0", context, input)).entries
  expect(expected[1]?.source_offset).toBe(new TextEncoder().encode(input.split("\n")[0] + "\n").length)
  for (let i = 0; i <= input.length; i++) {
    const a = ok(External.decodeClaudeCode("claude-code/2.1.0", context, input.slice(0, i)))
    const b = ok(External.decodeClaudeCode("claude-code/2.1.0", context, input.slice(i), a.state))
    expect([...a.entries, ...b.entries]).toEqual(expected)
  }
})

it("validates nested tool bodies and retains reported edit details", () => {
  error(decodeC(user("text", { isApiErrorMessage: "yes" })))
  const request = claude(assistant([{ type: "tool_use", id: "edit", name: "MultiEdit", input: { file_path: "a" } }]))
  const decode = (content: unknown) =>
    External.decodeClaudeCode(
      "claude-code/2.1.0",
      context,
      request +
        claude(
          user([{ type: "tool_result", tool_use_id: "edit", content }], { toolUseResult: { diff: "reported diff" } })
        )
    )
  const entries = ok(decode([{ type: "image", source: { type: "base64", data: "AA" } }])).entries
  expect(entries[2]).toMatchObject({ kind: "edit", body: { report_details: { diff: "reported diff" } }, failed: false })
  error(decode([{ type: "unknown" }]), "UnsupportedRecord")
  error(decode(1))
  error(decode([{ type: "text", text: 2 }]))
  const input = codex({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "inert" }) +
    codex({
      type: "custom_tool_call_output",
      call_id: "patch",
      output: [{ type: "input_text", text: "Error: permission denied" }]
    })
  expect(ok(External.decodeCodex("codex/0.160.0", context, input)).entries[2]).toMatchObject({
    kind: "edit",
    failed: true
  })
})
