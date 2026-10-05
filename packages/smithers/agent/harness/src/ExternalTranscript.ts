/**
 * The conversations of agents a person runs beside Smithers, decoded from the agent's own transcript file
 * into ordered, read-only entries (mvp.md M-38, ui-components.md T-UI-07 S2).
 *
 * Every entry carries its origin, agent kind, format version, session, source record identity and
 * `read_only: true`; who the owner and the agent participant are is the caller's to say, never the
 * transcript's. Decoding is pure: the caller supplies bytes in any chunking and keeps the returned state,
 * so a growing file is tailed by decoding only what was appended. An incomplete last line waits for more
 * bytes; a complete line that is not a record, a transcript without a version, and a version this module
 * does not support are tagged errors, never a guess.
 *
 * Codex: `rollout-*.jsonl` files under `$CODEX_HOME/sessions`, profile `codex-rollout/<major.minor>` from
 * the CLI release in `session_meta`. Items come from `event_msg` `item_completed` rows; `response_item` rows
 * repeat them for the model and are skipped, as are usage, rate-limit, settings and context rows.
 *
 * @since 1.0.0-rc.1
 */

import * as Fault from "@smthrs/flow/Fault"
import { Result, Schema } from "effect"

/**
 * The agents whose transcripts decode here.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const AgentKind = Schema.Literals(["codex", "claude-code"])

/**
 * The value decoded by {@link AgentKind}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type AgentKind = typeof AgentKind.Type

/**
 * One edited file as the agent reported it: its path, the kind of change and the unified diff.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const EditedFile = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  renamed_to: Schema.optional(Schema.String),
  diff: Schema.String
})

/**
 * What one entry says. Tool parts keep the agent's correlation id; edits keep the path and the reported
 * outcome; a body the agent encrypted is a placeholder in its place, never dropped.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("prompt"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("goal"), objective: Schema.String, status: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, final: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("encrypted") }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    call_id: Schema.String,
    command: Schema.String,
    /** Set when every part of the command only reads, searches or lists: "Read mvp.md". */
    reads: Schema.Array(Schema.String),
    status: Schema.Literals(["ok", "error", "running"]),
    exit_code: Schema.optional(Schema.Number),
    output: Schema.String,
    duration_ms: Schema.Number
  }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    call_id: Schema.String,
    files: Schema.Array(EditedFile),
    outcome: Schema.Literals(["applied", "failed"])
  }),
  Schema.Struct({ type: Schema.Literal("search"), call_id: Schema.String, query: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("helper"),
    call_id: Schema.String,
    agent: Schema.String,
    activity: Schema.String
  }),
  Schema.Struct({ type: Schema.Literal("compaction") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String })
])

/**
 * The value decoded by {@link Part}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Part = typeof Part.Type

/**
 * One read-only entry of an external conversation, in source order.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const Entry = Schema.Struct({
  origin: Schema.Literal("external"),
  agent_kind: AgentKind,
  format_version: Schema.String,
  session_id: Schema.String,
  /** The record this entry came from: `<session>:<line>`. */
  source_id: Schema.String,
  read_only: Schema.Literal(true),
  seq: Schema.Number,
  /** Milliseconds since the epoch, from the record. */
  at: Schema.Number,
  turn_id: Schema.optional(Schema.String),
  /** `user` entries are the owner's; `assistant` entries are the agent's. */
  role: Schema.Literals(["user", "assistant"]),
  part: Part
})

/**
 * The value decoded by {@link Entry}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Entry = typeof Entry.Type

/**
 * Why a transcript did not decode.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export const ExternalTranscriptErrorCode = Schema.Literals([
  "missing_version",
  "unsupported_version",
  "malformed_record"
])

/**
 * The value decoded by {@link ExternalTranscriptErrorCode}.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export type ExternalTranscriptErrorCode = typeof ExternalTranscriptErrorCode.Type

/**
 * A transcript this module refuses to read, with the line it stopped at.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ExternalTranscriptError
  extends Schema.TaggedError<ExternalTranscriptError>()("harness/ExternalTranscriptError", {
    code: ExternalTranscriptErrorCode,
    message: Schema.String,
    line: Schema.Number
  })
{}
Fault.register(
  "harness/ExternalTranscriptError",
  {
    // The agent wrote a transcript this release cannot read: a format change outside Smithers.
    missing_version: "dependency",
    unsupported_version: "dependency",
    malformed_record: "dependency"
  } satisfies Fault.Rows<ExternalTranscriptErrorCode>
)

/**
 * The Codex CLI releases whose rollout shape this module reads, by `major.minor`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const codexReleases: ReadonlyArray<string> = ["0.159", "0.160"]

/**
 * What a Codex decode remembers between chunks.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface CodexState {
  /** Bytes after the last newline: a line the agent is still writing. */
  readonly pending: string
  /** Complete lines read so far. */
  readonly line: number
  /** Entries emitted so far. */
  readonly seq: number
  readonly session?: { readonly id: string; readonly format_version: string; readonly cwd: string } | undefined
  readonly goal?: string | undefined
}

/**
 * The state before the first byte.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const codexStart: CodexState = { pending: "", line: 0, seq: 0 }

/**
 * A decoded chunk: the entries it completed and the state to pass with the next chunk.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Decoded {
  readonly state: CodexState
  readonly entries: ReadonlyArray<Entry>
}

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {}
const text = (value: unknown): string => typeof value === "string" ? value : ""
const list = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []
const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path
const helperName = (path: unknown): string => basename(text(path)) || "helper"

const reads = (parsed: unknown): ReadonlyArray<string> => {
  const parts = list(parsed).map(record)
  if (parts.length === 0 || parts.some((part) => !["read", "search", "list_files"].includes(text(part["type"])))) {
    return []
  }
  return parts.map((part) =>
    part["type"] === "read"
      ? `Read ${text(part["name"]) || basename(text(part["path"]))}`
      : part["type"] === "search"
      ? `Searched ${JSON.stringify(text(part["query"]))}${part["path"] ? ` in ${basename(text(part["path"]))}` : ""}`
      : `Listed ${basename(text(part["path"])) || "files"}`
  )
}

/** An added or deleted file reports its content, not a diff: one hunk of the whole file, all `+` or all `-`. */
const wholeFile = (content: string, op: "+" | "-"): string => {
  if (content === "") return ""
  const lines = content.replace(/\n$/, "").split("\n")
  return `@@ ${op === "+" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`} @@\n${
    lines.map((line) => `${op}${line}`).join("\n")
  }\n`
}

const changeOf = (change: Json): Schema.Schema.Type<typeof EditedFile>["change"] =>
  typeof change["move_path"] === "string"
    ? "renamed"
    : change["type"] === "add"
    ? "added"
    : change["type"] === "delete"
    ? "deleted"
    : "modified"

/**
 * One completed Codex item as the part it reports, or `undefined` for items with nothing to show. `took` is the
 * wall time Codex recorded around the item (`completed_at_ms - started_at_ms`).
 */
const itemPart = (item: Json, took: number): { readonly role: Entry["role"]; readonly part: Part } | undefined => {
  switch (item["type"]) {
    case "UserMessage":
      return {
        role: "user",
        part: { type: "prompt", text: list(item["content"]).map((each) => text(record(each)["text"])).join("\n") }
      }
    case "AgentMessage": {
      const content = list(item["content"]).map(record)
      const said = content.map((each) => text(each["text"])).filter(Boolean).join("\n")
      if (said === "" && content.some((each) => each["type"] === "encrypted_content")) {
        return { role: "assistant", part: { type: "encrypted" } }
      }
      return { role: "assistant", part: { type: "text", text: said, final: item["phase"] === "final_answer" } }
    }
    case "Reasoning": {
      // Codex keeps reasoning encrypted; only a summary it chose to write is readable.
      const summary = list(item["summary_text"]).map(text).filter(Boolean).join("\n")
      return summary === "" ? undefined : { role: "assistant", part: { type: "reasoning", text: summary } }
    }
    case "CommandExecution": {
      const exit = typeof item["exit_code"] === "number" ? item["exit_code"] : undefined
      // Codex reports in_progress, completed, failed and declined; only a clean completion is ok.
      const status = item["status"] === "in_progress"
        ? "running"
        : item["status"] === "completed" && (exit ?? 0) === 0
        ? "ok"
        : "error"
      return {
        role: "assistant",
        part: {
          type: "tool",
          call_id: text(item["id"]),
          command: list(item["command"]).map(text).at(-1) ?? "",
          reads: reads(item["parsed_cmd"]),
          status,
          ...(exit === undefined ? {} : { exit_code: exit }),
          output: text(item["aggregated_output"]) || text(item["formatted_output"]),
          duration_ms: took
        }
      }
    }
    case "FileChange":
      return {
        role: "assistant",
        part: {
          type: "edit",
          call_id: text(item["id"]),
          outcome: item["status"] === "completed" ? "applied" : "failed",
          files: Object.entries(record(item["changes"])).map(([path, value]) => {
            const change = record(value)
            return {
              path,
              change: changeOf(change),
              ...(typeof change["move_path"] === "string" ? { renamed_to: change["move_path"] } : {}),
              diff: text(change["unified_diff"]) ||
                wholeFile(text(change["content"]), change["type"] === "delete" ? "-" : "+")
            }
          })
        }
      }
    case "ContextCompaction":
      return { role: "assistant", part: { type: "compaction" } }
    case "SubAgentActivity":
      return {
        role: "assistant",
        part: {
          type: "helper",
          call_id: text(item["id"]),
          agent: helperName(item["agent_path"]),
          activity: text(item["kind"])
        }
      }
    case "CollabAgentToolCall": {
      const agents = list(item["receiver_agents"]).map((each) => helperName(record(each)["agent_path"] ?? each))
      return {
        role: "assistant",
        part: {
          type: "helper",
          call_id: text(item["id"]),
          agent: agents.join(", ") || "helpers",
          activity: text(item["tool"])
        }
      }
    }
    case "Extension": {
      const action = record(item["action"])
      const query = text(item["query"]) || text(action["query"]) || text(action["pattern"]) || text(action["url"])
      return { role: "assistant", part: { type: "search", call_id: text(item["id"]), query } }
    }
    default:
      return {
        role: "assistant",
        part: {
          type: "error",
          message: `Codex reported an item this release does not read: ${text(item["type"]) || "unnamed"}`
        }
      }
  }
}

const versionOf = (release: string): string | undefined => {
  const minor = /^(\d+\.\d+)\./.exec(release)?.[1]
  return minor !== undefined && codexReleases.includes(minor) ? `codex-rollout/${minor}` : undefined
}

/**
 * Decode the next chunk of a Codex rollout. Pass `codexStart` with the first chunk and the returned state
 * with each following one; any partition of the same bytes yields the same entries.
 *
 * @category decoding
 * @since 1.0.0-rc.1
 */
export const decodeCodex = (state: CodexState, chunk: string): Result.Result<Decoded, ExternalTranscriptError> => {
  const lines = (state.pending + chunk).split("\n")
  const pending = lines.pop()!
  let { line, seq, session, goal } = state
  const entries: Array<Entry> = []
  for (const raw of lines) {
    line++
    if (raw.trim() === "") continue
    let row: Json
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("not a record")
      row = parsed as Json
    } catch {
      return Result.fail(
        new ExternalTranscriptError({
          code: "malformed_record",
          message: `Codex rollout line ${line} is not a JSON record.`,
          line
        })
      )
    }
    const payload = record(row["payload"])
    if (row["type"] === "session_meta") {
      const release = text(payload["cli_version"])
      const format_version = versionOf(release)
      if (format_version === undefined) {
        return Result.fail(
          new ExternalTranscriptError({
            code: "unsupported_version",
            message: `Codex ${release || "(no release)"} wrote this rollout; supported: ${codexReleases.join(", ")}.`,
            line
          })
        )
      }
      session = { id: text(payload["id"]) || text(payload["session_id"]), format_version, cwd: text(payload["cwd"]) }
      continue
    }
    if (session === undefined) {
      return Result.fail(
        new ExternalTranscriptError({
          code: "missing_version",
          message: `Codex rollout line ${line} comes before its session record.`,
          line
        })
      )
    }
    if (row["type"] !== "event_msg") continue
    let found: { readonly role: Entry["role"]; readonly part: Part; readonly turn?: string } | undefined
    if (payload["type"] === "item_completed") {
      const started = payload["started_at_ms"], completed = payload["completed_at_ms"]
      const took = typeof started === "number" && typeof completed === "number" ? completed - started : 0
      const part = itemPart(record(payload["item"]), Number.isFinite(took) && took > 0 ? took : 0)
      found = part === undefined ? undefined : { ...part, turn: text(payload["turn_id"]) }
    } else if (payload["type"] === "thread_goal_updated") {
      const update = record(payload["goal"])
      const key = `${text(update["status"])}:${text(update["objective"])}`
      // Codex repeats a goal on every usage update; only a new objective or status is news.
      if (key !== goal) {
        found = {
          role: "user",
          part: { type: "goal", objective: text(update["objective"]), status: text(update["status"]) }
        }
      }
      goal = key
    }
    if (found === undefined) continue
    entries.push({
      origin: "external",
      agent_kind: "codex",
      format_version: session.format_version,
      session_id: session.id,
      source_id: `${session.id}:${line}`,
      read_only: true,
      seq: seq++,
      at: Date.parse(text(row["timestamp"])) || 0,
      ...(found.turn ? { turn_id: found.turn } : {}),
      role: found.role,
      part: found.part
    })
  }
  return Result.succeed({ state: { pending, line, seq, session, goal }, entries })
}
