import { Result } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Transcript } from "../src/index.ts"

const context = {
  owner_id: "trusted-owner",
  participant_id: "trusted-participant",
  session_id: "registered-session",
  source_generation: "generation-1"
}
const fixtures = [
  ["codex-0.160", "rollout.jsonl", "codex/0.160.0", Transcript.decodeCodex],
  ["codex-machine-0.160", "rollout.jsonl", "codex/0.160.0", Transcript.decodeCodex],
  ["claude-code-2.1", "session.jsonl", "claude-code/2.1.0", Transcript.decodeClaudeCode]
] as const
const read = (folder: string, file: string) =>
  readFileSync(new URL(`./fixtures/external/${folder}/${file}`, import.meta.url), "utf8")

describe("canonical host drafts through the public Transcript exports", () => {
  for (const [folder, file, profile, decode] of fixtures) {
    it(`${folder}: preserves the independently committed complete golden and caller attribution`, () => {
      const result = Result.getOrThrow(decode(profile, context, read(folder, file)))
      expect(result).toEqual(JSON.parse(read(folder, "drafts.expected.json")))
      expect(
        result.entries.every((e) =>
          e.owner_id === context.owner_id && e.participant_id === context.participant_id &&
          e.session_id === context.session_id && e.origin === "external" && e.read_only
        )
      ).toBe(true)
      expect(result.entries.filter((e) => e.kind === "prompt").every((e) => e.author_id === context.owner_id)).toBe(
        true
      )
      expect(result.entries.filter((e) => e.kind !== "prompt").every((e) => e.author_id === context.participant_id))
        .toBe(true)
    })

    it(`${folder}: replays every record partition with persisted checkpoints and source byte offsets`, () => {
      const input = read(folder, file)
      const expected = Result.getOrThrow(decode(profile, context, input))
      let offset = 0
      for (const line of input.split(/(?<=\n)/)) {
        offset += line.length
        const first = Result.getOrThrow(decode(profile, context, input.slice(0, offset)))
        const next = Result.getOrThrow(
          decode(profile, context, input.slice(offset), JSON.parse(JSON.stringify(first.state)))
        )
        expect([...first.entries, ...next.entries]).toEqual(expected.entries)
        expect(next.state).toEqual(expected.state)
      }
    })
  }

  it.each([undefined, ""])("requires an explicit profile (%s)", (profile) => {
    expect(Result.isFailure(Transcript.decodeCodex(profile, context, ""))).toBe(true)
    expect(Transcript.decodeCodex(profile, context, "")).toMatchObject({ failure: { _tag: "MissingVersion" } })
  })
  it("rejects foreign profiles and missing registration", () => {
    expect(Transcript.decodeCodex("claude-code/2.1.0", context, "")).toMatchObject({
      failure: { _tag: "UnsupportedVersion" }
    })
    for (const key of Object.keys(context)) {
      expect(Transcript.decodeCodex("codex/0.160.0", { ...context, [key]: "" }, "")).toMatchObject({
        failure: { _tag: "InvalidContext" }
      })
    }
  })
  it("rejects every identity rebinding and preserves the supplied checkpoint", () => {
    const initial = Result.getOrThrow(Transcript.decodeCodex("codex/0.160.0", context, ""))
    const saved = JSON.stringify(initial.state)
    for (const key of Object.keys(context)) {
      expect(Transcript.decodeCodex("codex/0.160.0", { ...context, [key]: "foreign" }, "", initial.state))
        .toMatchObject({ failure: { _tag: "StateMismatch" } })
    }
    expect(Transcript.decodeClaudeCode("claude-code/2.1.0", context, "", initial.state)).toMatchObject({
      failure: { _tag: "StateMismatch" }
    })
    expect(JSON.stringify(initial.state)).toBe(saved)
  })
  it("holds an unterminated complete record until framing arrives", () => {
    const input = read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]!
    const first = Result.getOrThrow(Transcript.decodeCodex("codex/0.160.0", context, input))
    expect(first).toMatchObject({ entries: [], needs_more: true, state: { pending: input, offset: 0 } })
    const next = Result.getOrThrow(Transcript.decodeCodex("codex/0.160.0", context, "\n", first.state))
    expect(next.needs_more).toBe(false)
    expect(next.state.offset).toBe(new TextEncoder().encode(input + "\n").length)
  })
})

// Constructed release-drift, malformed, and blank-frame cases are not capture evidence.
it("rejects malformed and unknown semantic records without advancing a checkpoint", () => {
  const state = Result.getOrThrow(
    Transcript.decodeCodex(
      "codex/0.160.0",
      context,
      read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]! + "\n"
    )
  ).state
  for (
    const [input, tag] of [["{\n", "MalformedRecord"], [
      JSON.stringify({ type: "future_semantic" }) + "\n",
      "UnsupportedRecord"
    ]]
  ) {
    expect(Transcript.decodeCodex("codex/0.160.0", context, input!, state)).toMatchObject({
      failure: { _tag: tag, offset: state.offset }
    })
  }
  expect(state.offset).toBeGreaterThan(0)
})
it("pins canonical profiles to recorded CLI releases and accepts blank frames", () => {
  const codex = JSON.parse(read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]!)
  codex.payload.cli_version = "0.159.0"
  expect(Transcript.decodeCodex("codex/0.160.0", context, JSON.stringify(codex) + "\n")).toMatchObject({
    failure: { _tag: "UnsupportedVersion" }
  })
  const claude = read("claude-code-2.1", "session.jsonl").split("\n").filter(Boolean).map((s) => JSON.parse(s)).find(
    (row) => row.type === "user"
  )
  claude.version = "2.1.290"
  expect(Transcript.decodeClaudeCode("claude-code/2.1.0", context, JSON.stringify(claude) + "\n")).toMatchObject({
    failure: { _tag: "UnsupportedVersion" }
  })
  expect(Result.getOrThrow(Transcript.decodeCodex("codex/0.160.0", context, " \n"))).toMatchObject({
    entries: [],
    state: { offset: 2 }
  })
})

it("retains inert Claude image and redacted thinking blocks", () => {
  const base = { uuid: "image-id", sessionId: "source", version: "2.1.277", timestamp: "2026-10-05T00:00:00Z" }
  const image = { type: "image", source: { type: "base64", data: "opaque" } }
  const hidden = { type: "redacted_thinking", data: "opaque" }
  const input = JSON.stringify({ ...base, type: "user", message: { role: "user", content: [image] } }) + "\n" +
    JSON.stringify({
      ...base,
      uuid: "hidden-id",
      type: "assistant",
      message: { role: "assistant", content: [hidden] }
    }) + "\n"
  const actual = Result.getOrThrow(Transcript.decodeClaudeCode("claude-code/2.1.0", context, input))
  expect(actual.entries.map((e) => [e.kind, e.body])).toEqual([["attachment", image], ["thinking", hidden]])
})

it("preserves structured and omitted successful tool output without executing requests", () => {
  const meta = read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]! + "\n"
  const row = (payload: unknown) => JSON.stringify({ type: "response_item", payload }) + "\n"
  for (const output of [{ content: "reported" }, undefined, "reported"]) {
    const request = row({ type: "custom_tool_call", call_id: "c", name: "functions.exec", input: "do not execute" })
    const result = Result.getOrThrow(
      Transcript.decodeCodex(
        "codex/0.160.0",
        context,
        meta + request + row({ type: "custom_tool_call_output", call_id: "c", output })
      )
    )
    expect(result.entries.map((e) => [e.kind, e.body, e.failed])).toEqual([["tool_request", {
      name: "functions.exec",
      input: "do not execute"
    }, undefined], ["tool_result", { name: "functions.exec", output }, false]])
  }
  const unpaired = Result.getOrThrow(
    Transcript.decodeCodex(
      "codex/0.160.0",
      context,
      meta + row({ type: "custom_tool_call_output", call_id: "missing", output: "reported" })
    )
  )
  expect(unpaired.entries).toEqual([])
})

it("does not correlate a successful output to a different pending request", () => {
  const meta = read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]! + "\n"
  const row = (payload: unknown) => JSON.stringify({ type: "response_item", payload }) + "\n"
  const actual = Result.getOrThrow(
    Transcript.decodeCodex(
      "codex/0.160.0",
      context,
      meta + row({ type: "custom_tool_call", call_id: "pending", name: "functions.exec", input: "inert" }) +
        row({ type: "custom_tool_call_output", call_id: "different", output: {} })
    )
  )
  expect(actual.entries.map((e) => e.kind)).toEqual(["tool_request"])
  expect(actual.state.native).toMatchObject({ calls: { pending: { name: "functions.exec", input: "inert" } } })
})

it("preserves interleaved assistant blocks and ignores sidechain results and attachments", () => {
  const base = { sessionId: "source", version: "2.1.277", timestamp: "2026-10-05T00:00:00Z" }
  const row = (type: string, uuid: string, content: unknown, extra = {}) =>
    JSON.stringify({ ...base, type, uuid, message: { role: type, content }, ...extra }) + "\n"
  const blocks = [
    { type: "text", text: "first" },
    { type: "tool_use", id: "c", name: "Bash", input: { command: "inert" } },
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "last" }
  ]
  const first = Result.getOrThrow(
    Transcript.decodeClaudeCode("claude-code/2.1.0", context, row("assistant", "a", blocks))
  )
  expect(first.entries.map((e) => [e.kind, e.body])).toEqual([
    ["assistant", "first"],
    ["tool_request", { name: "Bash", input: { command: "inert" } }],
    ["thinking", "reason"],
    ["assistant", "last"]
  ])
  const result = Result.getOrThrow(
    Transcript.decodeClaudeCode(
      "claude-code/2.1.0",
      context,
      row(
        "user",
        "b",
        [{ type: "tool_result", tool_use_id: "c", content: "sidechain" }, { type: "image", source: {} }],
        { isSidechain: true }
      ),
      first.state
    )
  )
  expect(result.entries).toEqual([])
  expect(result.state.native).toMatchObject({ calls: { c: { name: "Bash" } } })
})
it("retains readable Codex reasoning without authority from source identity", () => {
  const meta = read("codex-machine-0.160", "rollout.jsonl").split("\n")[0]! + "\n"
  const row = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "Reasoning", id: "reasoning-source", summary_text: ["reported reasoning"] }
    }
  }) + "\n"
  const actual = Result.getOrThrow(Transcript.decodeCodex("codex/0.160.0", context, meta + row))
  expect(actual.entries).toHaveLength(1)
  expect(actual.entries[0]).toMatchObject({
    kind: "thinking",
    body: "reported reasoning",
    source_id: "reasoning-source",
    author_id: context.participant_id
  })
})
