/** Pure external transcript normalization. No importer or executable run is created.
 * @since 1.0.0-rc.1
 */
import { Result } from "effect"

/** Trusted registration context, supplied by host ingest, never transcript text.
 * @since 1.0.0-rc.1
 */
export interface Context {
  readonly owner_id: string
  readonly participant_id: string
  readonly session_id: string
  readonly source_generation: string
}
/** Supported release/shape profiles; no implicit latest version.
 * @since 1.0.0-rc.1
 */
export type Profile = "claude-code/2.1.0" | "codex/0.160.0"
/** Non-executable conversation/event draft. Tool/edit payloads are reported data.
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
/** Serializable checkpoint. Persist alongside the entries and outbox receipt.
 * @since 1.0.0-rc.1
 */
export interface State {
  readonly profile: Profile
  readonly context: Context
  readonly pending: string
  readonly offset: number
  readonly calls: Readonly<Record<string, { readonly name: string; readonly input: unknown }>>
}
/** Tagged, source-local rejection; the supplied checkpoint remains unchanged.
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
/** Successful incremental decode. An unterminated final record requires more input.
 * @since 1.0.0-rc.1
 */
export interface Decoded {
  readonly entries: ReadonlyArray<Draft>
  readonly state: State
  readonly needs_more: boolean
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object")
  return value as Record<string, unknown>
}
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("expected string")
  return value
}
const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error("expected array")
  return value
}
const bytes = (value: string): number => new TextEncoder().encode(value).length
const unsupported = (name: string): never => {
  throw new Unsupported(name)
}
class Unsupported extends Error {}

const decode = (
  agent: Draft["agent"],
  version: string | undefined,
  context: Context,
  chunk: string,
  previous?: State
): Result.Result<Decoded, DecodeError> => {
  const fail = (_tag: DecodeError["_tag"], detail: string, offset = previous?.offset ?? 0) =>
    Result.fail({ _tag, offset, detail })
  if (version === undefined || version === "") return fail("MissingVersion", "explicit adapter profile required")
  const supported = agent === "claude-code" ? "claude-code/2.1.0" : "codex/0.160.0"
  if (version !== supported) return fail("UnsupportedVersion", version)
  if (
    [context.owner_id, context.participant_id, context.session_id, context.source_generation].some((s) =>
      typeof s !== "string" || s.length === 0
    )
  ) {
    return fail("InvalidContext", "owner, participant, session and source generation required")
  }
  if (
    previous &&
    (previous.profile !== version ||
      Object.keys(context).some((key) => context[key as keyof Context] !== previous.context[key as keyof Context]))
  ) return fail("StateMismatch", "checkpoint belongs to another source")
  const profile = version as Profile
  const entries: Array<Draft> = []
  const calls: Record<string, { name: string; input: unknown }> = { ...previous?.calls }
  const input = (previous?.pending ?? "") + chunk
  let offset = previous?.offset ?? 0
  const lines = input.split("\n")
  const pending = lines.pop()!
  for (const line of lines) {
    try {
      const r = record(JSON.parse(line))
      const source_id = agent === "claude-code"
        ? string(r.uuid ?? `offset:${offset}`)
        : string(record(r.payload).id ?? `offset:${offset}`)
      let part = 0
      const emit = (kind: Draft["kind"], body: unknown, call_id?: string, failed?: boolean) => {
        entries.push({
          id: JSON.stringify([agent, context.session_id, context.source_generation, offset, source_id, part++]),
          source_id,
          source_offset: offset,
          origin: "external",
          read_only: true,
          agent,
          source_format_version: profile,
          session_id: context.session_id,
          participant_id: context.participant_id,
          owner_id: context.owner_id,
          author_id: kind === "prompt" ? context.owner_id : context.participant_id,
          kind,
          body,
          ...(call_id === undefined ? {} : { call_id }),
          ...(kind === "error" ? { failed: true } : failed === undefined ? {} : { failed })
        })
      }
      const request = (id: unknown, name: unknown, input: unknown) => {
        const call = string(id)
        if (!call || Object.hasOwn(calls, call)) throw new Error("duplicate/empty tool id")
        const tool = string(name)
        Object.defineProperty(calls, call, {
          value: { name: tool, input },
          enumerable: true,
          configurable: true,
          writable: true
        })
        emit("tool_request", { name: tool, input }, call)
      }
      const result = (id: unknown, output: unknown, failed: boolean) => {
        const call = string(id)
        if (!Object.hasOwn(calls, call)) throw new Error("unpaired tool result")
        if (output === undefined) throw new Error("missing tool output")
        emit("tool_result", output, call, failed)
        const tool = calls[call]!
        if (["Edit", "Write", "MultiEdit", "apply_patch"].includes(tool.name)) {
          emit(
            "edit",
            {
              tool: tool.name,
              input: tool.input,
              report: output,
              ...(r.toolUseResult === undefined ? {} : { report_details: r.toolUseResult })
            },
            call,
            failed
          )
        }
        delete calls[call]
      }
      const type = string(r.type)
      if (agent === "claude-code") {
        if (r.version !== undefined && r.version !== "2.1.0") throw new Error("release differs from adapter profile")
        if (["queue-operation", "file-history-snapshot", "progress"].includes(type)) {
          // Known bookkeeping only; no conversation semantics.
        } else if (type === "system" && r.subtype === "compact_boundary") {
          emit("assistant", { compact_boundary: r })
        } else if (type === "user" || type === "assistant") {
          string(r.uuid)
          const message = record(r.message)
          if (message.role !== type) throw new Error("message role mismatch")
          if (r.isApiErrorMessage !== undefined && typeof r.isApiErrorMessage !== "boolean") {
            throw new Error("invalid error marker")
          }
          const kind = r.isApiErrorMessage === true ? "error" : type === "user" ? "prompt" : "assistant"
          if (typeof message.content === "string") emit(kind, message.content)
          else {for (const value of array(message.content)) {
              const p = record(value)
              switch (p.type) {
                case "text":
                  emit(kind, string(p.text))
                  break
                case "thinking":
                  emit("thinking", string(p.thinking))
                  break
                case "redacted_thinking":
                  emit("thinking", { redacted: string(p.data) })
                  break
                case "image":
                  emit("attachment", record(p.source))
                  break
                case "tool_use":
                  request(p.id, p.name, record(p.input))
                  break
                case "tool_result":
                  if (p.is_error !== undefined && typeof p.is_error !== "boolean") {
                    throw new Error("invalid tool status")
                  }
                  if (p.content !== undefined && typeof p.content !== "string") {
                    for (const item of array(p.content)) {
                      const body = record(item)
                      if (body.type === "text") string(body.text)
                      else if (body.type === "image") record(body.source)
                      else unsupported(`Claude tool content: ${String(body.type)}`)
                    }
                  }
                  result(p.tool_use_id, p.content, p.is_error === true)
                  break
                default:
                  unsupported(`Claude content: ${String(p.type)}`)
              }
            }}
        } else unsupported(`Claude record: ${type}`)
      } else {
        const p = record(r.payload)
        string(r.timestamp)
        if (type === "session_meta") {
          if (p.cli_version !== "0.160.0") throw new Error("release differs from adapter profile")
        } else if (["turn_context", "world_state", "token_usage_record"].includes(type)) {
          // Context/usage is not a conversation entry.
        } else if (type === "event_msg") {
          const event = string(p.type)
          if (event === "error") emit("error", string(p.message))
          else if (event === "turn_aborted") emit("error", { interrupted: p })
          else if (
            ![
              "task_started",
              "task_complete",
              "task_completed",
              "turn_aborted",
              "token_count",
              "item_completed",
              "user_message",
              "agent_message",
              "agent_reasoning"
            ].includes(event)
          ) unsupported(`Codex event: ${event}`)
          // Message/item event notifications duplicate canonical response_item bodies.
        } else if (type === "response_item") {
          switch (p.type) {
            case "message": {
              const role = string(p.role)
              if (!["user", "assistant", "developer", "system"].includes(role)) unsupported(`Codex role: ${role}`)
              const content = array(p.content).map(record)
              if (role === "developer" || role === "system") break // model instructions, not owner prompts
              const encrypted = content.some((body) => body.type === "encrypted_content")
              for (const body of content) {
                if (body.type === "input_text" || body.type === "output_text") {
                  const text = string(body.text)
                  if (!encrypted) emit(role === "user" ? "prompt" : "assistant", text)
                } else if (body.type === "input_image") {
                  const url = string(body.image_url)
                  if (!encrypted) emit("attachment", url)
                } else if (body.type === "encrypted_content") string(body.encrypted_content)
                else unsupported(`Codex content: ${String(body.type)}`)
              }
              if (encrypted) emit(role === "user" ? "prompt" : "assistant", "Encrypted by Codex")
              break
            }
            case "reasoning":
              for (const item of array(p.summary)) {
                const body = record(item)
                if (body.type !== "summary_text") unsupported(`Codex summary: ${String(body.type)}`)
                emit("thinking", string(body.text))
              }
              if (p.content != null) {
                for (const item of array(p.content)) {
                  const body = record(item)
                  if (body.type !== "reasoning_text") unsupported(`Codex reasoning: ${String(body.type)}`)
                  emit("thinking", string(body.text))
                }
              }
              if (p.encrypted_content != null) {
                string(p.encrypted_content)
                emit("thinking", "Encrypted by Codex")
              }
              break
            case "agent_message": {
              const content = array(p.content).map(record)
              for (const body of content) {
                if (body.type === "encrypted_content") string(body.encrypted_content)
                else if (body.type === "input_text") string(body.text)
                else unsupported(`Codex agent content: ${String(body.type)}`)
              }
              if (content.some((body) => body.type === "encrypted_content")) emit("assistant", "Encrypted by Codex")
              else for (const body of content) emit("assistant", body.text)
              break
            }
            case "function_call":
              request(p.call_id, p.name, string(p.arguments))
              break
            case "custom_tool_call":
              request(p.call_id, p.name, string(p.input))
              break
            case "function_call_output":
            case "custom_tool_call_output": {
              const output = p.output
              if (typeof output !== "string") {
                for (const item of array(output)) {
                  const body = record(item)
                  if (body.type === "input_text") string(body.text)
                  else if (body.type === "input_image") string(body.image_url)
                  else unsupported(`Codex tool output: ${String(body.type)}`)
                }
              }
              const report = typeof output === "string" ? output : array(output).map((item) => {
                const body = record(item)
                return body.type === "input_text" ? string(body.text) : ""
              }).join("\n")
              result(p.call_id, output, /(?:Process exited with code [1-9]|Error:|Failed to)/.test(report))
              break
            }
            default:
              unsupported(`Codex item: ${String(p.type)}`)
          }
        } else unsupported(`Codex record: ${type}`)
      }
    } catch (error) {
      return fail(
        error instanceof Unsupported ? "UnsupportedRecord" : "MalformedRecord",
        (error as Error).message,
        offset
      )
    }
    offset += bytes(line + "\n")
  }
  return Result.succeed({
    entries,
    state: { profile, context: { ...context }, pending, offset, calls },
    needs_more: pending.length > 0
  })
}
/** Decode Claude Code JSONL chunks using an explicit release profile and checkpoint.
 * @since 1.0.0-rc.1
 */
export const decodeClaudeCode = (
  version: string | undefined,
  context: Context,
  chunk: string,
  state?: State
): Result.Result<Decoded, DecodeError> => decode("claude-code", version, context, chunk, state)
/** Decode Codex rollout JSONL chunks using an explicit release profile and checkpoint.
 * @since 1.0.0-rc.1
 */
export const decodeCodex = (
  version: string | undefined,
  context: Context,
  chunk: string,
  state?: State
): Result.Result<Decoded, DecodeError> => decode("codex", version, context, chunk, state)
