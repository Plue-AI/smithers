/** Canonical, caller-attributed drafts over the two existing source decoders.
 * @since 1.0.0-rc.1
 */
import { Result } from "effect"
import * as Source from "./ExternalTranscript.ts"

/** Trusted host registration, never identities asserted in source text.
 * @since 1.0.0-rc.1
 */
export interface Context {
  readonly owner_id: string
  readonly participant_id: string
  readonly session_id: string
  readonly source_generation: string
}
/** Versioned adapter contracts consumed by backend chat.ExternalDraft.
 * These are adapter versions, not CLI versions; Claude v1 reads CLI 2.1.277.
 * @since 1.0.0-rc.1
 */
export type Profile = "claude-code/2.1.0" | "codex/0.160.0"
/** Inert conversation draft; reported tool input never becomes an executable step.
 * @since 1.0.0-rc.1
 */
export interface Draft {
  readonly id: string
  readonly source_id: string
  readonly source_offset: number
  readonly origin: "external"
  readonly read_only: true
  readonly agent: "claude-code" | "codex"
  readonly source_format_version: Profile
  readonly session_id: string
  readonly participant_id: string
  readonly owner_id: string
  readonly author_id: string
  readonly kind: "prompt" | "assistant" | "thinking" | "attachment" | "tool_request" | "tool_result" | "edit" | "error"
  readonly body: unknown
  readonly call_id?: string
  readonly failed?: boolean
}
/** Serializable parser state bound to the registration and explicit adapter.
 * @since 1.0.0-rc.1
 */
export interface State {
  readonly profile: Profile
  readonly context: Context
  readonly pending: string
  readonly offset: number
  readonly native: Source.CodexState | Source.ClaudeState
}
/** Tagged rejection. The caller's checkpoint and receipt remain unchanged.
 * @since 1.0.0-rc.1
 */
export interface DecodeError {
  readonly _tag:
    | "MissingVersion"
    | "UnsupportedVersion"
    | "MalformedRecord"
    | "UnsupportedRecord"
    | "InvalidContext"
    | "StateMismatch"
  readonly offset: number
  readonly detail: string
}
/** Canonical entries and the next serializable checkpoint.
 * @since 1.0.0-rc.1
 */
export interface Decoded {
  readonly entries: ReadonlyArray<Draft>
  readonly state: State
  readonly needs_more: boolean
}
const identities = ["owner_id", "participant_id", "session_id", "source_generation"] as const
const bytes = (text: string): number => new TextEncoder().encode(text).length
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const decode = (
  agent: Draft["agent"],
  version: string | undefined,
  context: Context,
  chunk: string,
  previous?: State
): Result.Result<Decoded, DecodeError> => {
  const fail = (_tag: DecodeError["_tag"], detail: string, offset = previous?.offset ?? 0) =>
    Result.fail({ _tag, offset, detail })
  if (version === undefined || version === "") return fail("MissingVersion", "Explicit adapter profile required")
  const profile = agent === "codex" ? "codex/0.160.0" : "claude-code/2.1.0"
  if (version !== profile) return fail("UnsupportedVersion", version)
  if (identities.some((key) => typeof context?.[key] !== "string" || context[key].length === 0)) {
    return fail("InvalidContext", "Complete registration required")
  }
  if (previous && (previous.profile !== profile || identities.some((key) => previous.context[key] !== context[key]))) {
    return fail("StateMismatch", "Checkpoint belongs to another registration")
  }
  const binding = {
    owner_id: context.owner_id,
    participant_id: context.participant_id,
    session_id: context.session_id,
    source_generation: context.source_generation
  }
  let native = previous?.native ?? (agent === "codex" ? Source.codexStart : Source.claudeStart)
  let offset = previous?.offset ?? 0
  const lines = ((previous?.pending ?? "") + chunk).split("\n")
  const pending = lines.pop()!
  const entries: Array<Draft> = []
  for (const line of lines) {
    const result: Result.Result<
      Source.Decoded<Source.CodexState | Source.ClaudeState>,
      Source.ExternalTranscriptError
    > = agent === "codex"
      ? Source.decodeCodex(native as Source.CodexState, line + "\n")
      : Source.decodeClaude(native as Source.ClaudeState, line + "\n")
    if (Result.isFailure(result)) {
      const tags = {
        missing_version: "MissingVersion",
        unsupported_version: "UnsupportedVersion",
        malformed_record: "MalformedRecord",
        unsupported_record: "UnsupportedRecord"
      } as const
      return fail(tags[result.failure.code], result.failure.message, offset)
    }
    const row = line.trim() === "" ? {} : object(JSON.parse(line))
    const payload = object(row["payload"])
    // Pin the canonical contracts to recorded releases; the display projection's broader release line is not certification.
    if (
      (agent === "codex" && row["type"] === "session_meta" && payload["cli_version"] !== "0.160.0") ||
      (agent === "claude-code" && ["user", "assistant", "system", "attachment"].includes(String(row["type"])) &&
        row["version"] !== "2.1.277")
    ) return fail("UnsupportedVersion", "CLI release is not validated for this adapter", offset)
    const nativeId = agent === "claude-code" ? row["uuid"] : payload["id"] ?? object(payload["item"])["id"]
    const source_id = typeof nativeId === "string" && nativeId !== "" ? nativeId : `offset:${offset}`
    let index = 0
    const emit = (kind: Draft["kind"], body: unknown, call_id?: string, failed?: boolean) =>
      entries.push({
        id: JSON.stringify([agent, binding.session_id, binding.source_generation, offset, source_id, index++]),
        source_id,
        source_offset: offset,
        origin: "external",
        read_only: true,
        agent,
        source_format_version: profile,
        session_id: binding.session_id,
        participant_id: binding.participant_id,
        owner_id: binding.owner_id,
        author_id: kind === "prompt" ? binding.owner_id : binding.participant_id,
        kind,
        body,
        ...(call_id === undefined ? {} : { call_id }),
        ...(failed === undefined ? {} : { failed })
      })
    const message = object(row["message"])
    const blocks = Array.isArray(message["content"]) && row["isSidechain"] !== true &&
        (row["type"] === "user" || row["type"] === "assistant") ?
      message["content"].map(object) :
      []
    const consumed = new Set<Source.Entry>()
    if (agent === "claude-code") {
      const before = (native as Source.ClaudeState).calls
      const after = (result.success.state as Source.ClaudeState).calls
      for (const block of blocks) {
        const matching = result.success.entries.find((entry) =>
          !consumed.has(entry) &&
          ((block["type"] === "text" && entry.part.type === "text" && entry.part.text === block["text"]) ||
            (block["type"] === "thinking" && entry.part.type === "reasoning" && entry.part.text === block["thinking"]))
        )
        if (matching !== undefined) {
          consumed.add(matching)
          const part = matching.part as Source.Part & { readonly text: string }
          emit(part.type === "text" ? "assistant" : "thinking", part.text)
        }
        const id = typeof block["id"] === "string" ? block["id"] : ""
        if (block["type"] === "tool_use" && after[id] !== undefined && before[id] === undefined) {
          emit("tool_request", { name: after[id]!.name, input: after[id]!.input }, id)
        }
        const callId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : ""
        if (block["type"] === "tool_result" && before[callId] !== undefined && after[callId] === undefined) {
          emit(
            "tool_result",
            { name: before[callId]!.name, output: block["content"] },
            callId,
            block["is_error"] === true
          )
        }
        if (block["type"] === "image") emit("attachment", block)
        if (block["type"] === "redacted_thinking") emit("thinking", block)
      }
    } else if (row["type"] === "response_item" && payload["type"] === "custom_tool_call") {
      emit("tool_request", { name: payload["name"], input: payload["input"] }, String(payload["call_id"]))
    } else if (row["type"] === "response_item" && payload["type"] === "custom_tool_call_output") {
      const id = String(payload["call_id"])
      const call = (native as Source.CodexState).calls?.[id]
      if (call !== undefined) {
        const report = typeof payload["output"] === "string"
          ? payload["output"]
          : (JSON.stringify(payload["output"]) ?? "")
        emit("tool_result", { name: call.name, output: payload["output"] }, id, report.includes("Script failed"))
      }
    }
    for (const entry of result.success.entries) {
      if (consumed.has(entry)) continue
      const part = entry.part
      switch (part.type) {
        case "prompt":
          emit("prompt", part.text)
          break
        case "text":
          emit("assistant", part.text)
          break
        case "reasoning":
          emit("thinking", part.text)
          break
        case "encrypted":
          emit("assistant", "Encrypted by Codex")
          break
        case "error":
          emit("error", part.message, undefined, true)
          break
        case "edit":
          emit("edit", part, part.call_id, part.outcome === "failed")
          break
        case "tool":
          if (agent === "codex" && row["type"] === "event_msg") {
            emit("tool_request", { name: "exec_command", input: { command: part.command } }, part.call_id)
            emit("tool_result", { name: "exec_command", output: part.output }, part.call_id, part.status === "error")
          }
          break
        case "search":
        case "helper":
        case "compaction":
        case "goal":
          emit("assistant", part)
          break
      }
    }
    native = result.success.state
    offset += bytes(line + "\n")
  }
  return Result.succeed({
    entries,
    state: { profile, context: binding, pending, offset, native },
    needs_more: pending !== ""
  })
}
/** Decode Claude CLI 2.1.277 into the backend's inert drafts with caller-owned identities.
 * @since 1.0.0-rc.1
 */
export const decodeClaudeCode = (
  version: string | undefined,
  context: Context,
  chunk: string,
  previous?: State
): Result.Result<Decoded, DecodeError> => decode("claude-code", version, context, chunk, previous)
/** Decode Codex CLI 0.160.0 into the backend's inert drafts with caller-owned identities.
 * @since 1.0.0-rc.1
 */
export const decodeCodex = (
  version: string | undefined,
  context: Context,
  chunk: string,
  previous?: State
): Result.Result<Decoded, DecodeError> => decode("codex", version, context, chunk, previous)
