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
 * Claude Code: `<session>.jsonl` files under `~/.claude/projects/<project>`, profile `claude-code/<major.minor>`
 * from the `version` every conversation record carries. A tool call becomes one entry when its result arrives;
 * rows outside the conversation chain (no `uuid`) are session metadata and are skipped.
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
  /**
   * The record this entry came from: `<session>:<line>`. A Claude Code record that yields several entries numbers
   * the later ones `<session>:<line>#<n>`.
   */
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
export interface Decoded<State = CodexState> {
  readonly state: State
  readonly entries: ReadonlyArray<Entry>
}

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {}
const text = (value: unknown): string => typeof value === "string" ? value : ""
const list = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []
const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path
/** One complete line as a JSON record, or `undefined` when it is not one. */
const parseRow = (raw: string): Json | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Json : undefined
  } catch {
    return undefined
  }
}
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

/** Lines of an edit string, without the newline that ends the last one. */
const linesOf = (value: string): ReadonlyArray<string> => value === "" ? [] : value.replace(/\n$/, "").split("\n")

/** An added or deleted file reports its content, not a diff: one hunk of the whole file, all `+` or all `-`. */
const wholeFile = (content: string, op: "+" | "-"): string => {
  const lines = linesOf(content)
  if (lines.length === 0) return ""
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

/** The adapter profile `<profile>/<major.minor>` for a supported release, or `undefined`. */
const profileOf = (profile: string, releases: ReadonlyArray<string>, release: string): string | undefined => {
  const minor = /^(\d+\.\d+)\./.exec(release)?.[1]
  return minor !== undefined && releases.includes(minor) ? `${profile}/${minor}` : undefined
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
    const row = parseRow(raw)
    if (row === undefined) {
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
      const format_version = profileOf("codex-rollout", codexReleases, release)
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

/**
 * The Claude Code release lines whose transcript shape this module reads, by `major.minor`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const claudeReleases: ReadonlyArray<string> = ["2.1"]

/**
 * A Claude Code tool call waiting for its result: the tool's name, its input and when the agent asked.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface ClaudeCall {
  readonly name: string
  readonly input: unknown
  /** Milliseconds since the epoch, from the `tool_use` record. */
  readonly at: number
}

/**
 * What a Claude Code decode remembers between chunks.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface ClaudeState {
  /** Bytes after the last newline: a line the agent is still writing. */
  readonly pending: string
  /** Complete lines read so far. */
  readonly line: number
  /** Entries emitted so far. */
  readonly seq: number
  /** The session the first conversation record named. */
  readonly session?: string | undefined
  /** The `promptId` of the latest user record: the turn later entries belong to. */
  readonly turn?: string | undefined
  /** Tool calls whose result has not arrived, by `tool_use` id. */
  readonly calls: Readonly<Record<string, ClaudeCall>>
}

/**
 * The state before the first byte.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const claudeStart: ClaudeState = { pending: "", line: 0, seq: 0, calls: {} }

/** Content as blocks: Claude Code writes a plain prompt as a string and everything else as a block list. */
const blocksOf = (content: unknown): ReadonlyArray<Json> =>
  typeof content === "string" ? [{ type: "text", text: content }] : list(content).map(record)

const textOf = (blocks: ReadonlyArray<Json>): string =>
  blocks.filter((block) => block["type"] === "text").map((block) => text(block["text"])).join("\n")

/** A user turn is the owner's when Claude Code classified it human or did not classify it. */
const byOwner = (origin: unknown): boolean =>
  origin === undefined || origin === null || record(origin)["kind"] === "human"

/**
 * A requested replacement as one hunk. Claude Code reports no position for a replacement it did not apply, so the
 * hunk starts at line 1.
 */
const replacement = (before: string, after: string): string => {
  const removed = linesOf(before), added = linesOf(after)
  if (removed.length + added.length === 0) return ""
  return `@@ -1,${removed.length} +1,${added.length} @@\n${
    [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n")
  }\n`
}

const count = (value: unknown): number => typeof value === "number" ? value : 0

/** The hunks Claude Code reported for an applied edit (`toolUseResult.structuredPatch`). */
const reportedPatch = (patch: unknown): string =>
  list(patch).map(record).map((hunk) =>
    `@@ -${count(hunk["oldStart"])},${count(hunk["oldLines"])} +${count(hunk["newStart"])},${
      count(hunk["newLines"])
    } @@\n${list(hunk["lines"]).map(text).join("\n")}\n`
  ).join("")

/** The edit the agent asked for, from the tool input, when Claude Code reported no hunks. */
const requestedPatch = (name: string, input: Json): string => {
  switch (name) {
    case "Write":
      return wholeFile(text(input["content"]), "+")
    case "NotebookEdit":
      return wholeFile(text(input["new_source"]), "+")
    case "MultiEdit":
      return list(input["edits"]).map(record).map((edit) =>
        replacement(text(edit["old_string"]), text(edit["new_string"]))
      ).join("")
    default:
      return replacement(text(input["old_string"]), text(input["new_string"]))
  }
}

/** The reads label of a tool that only reads, searches or lists, or none. */
const claudeReads = (name: string, input: Json): ReadonlyArray<string> => {
  const path = text(input["path"])
  switch (name) {
    case "Read":
      return [`Read ${basename(text(input["file_path"]))}`]
    case "Grep":
    case "Glob":
      return [`Searched ${JSON.stringify(text(input["pattern"]))}${path ? ` in ${basename(path)}` : ""}`]
    case "LS":
      return [`Listed ${basename(path) || "files"}`]
    default:
      return []
  }
}

/** One finished tool call: its `tool_use` (when this transcript holds it) and the `tool_result` that ended it. */
const claudeToolPart = (
  id: string,
  call: ClaudeCall | undefined,
  result: { readonly failed: boolean; readonly output: string; readonly report: Json; readonly took: number }
): Part => {
  const name = call?.name ?? ""
  const input = record(call?.input)
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        type: "edit",
        call_id: id,
        files: [{
          path: text(input["file_path"]) || text(input["notebook_path"]),
          change: name === "Write" && result.report["type"] === "create" ? "added" : "modified",
          diff: reportedPatch(result.report["structuredPatch"]) || requestedPatch(name, input)
        }],
        outcome: result.failed ? "failed" : "applied"
      }
    case "WebSearch":
      return { type: "search", call_id: id, query: text(input["query"]) }
    case "WebFetch":
      return { type: "search", call_id: id, query: text(input["url"]) }
    case "Task":
    case "Agent":
      return {
        type: "helper",
        call_id: id,
        agent: text(input["subagent_type"]) || "general-purpose",
        activity: text(input["description"])
      }
  }
  const exit = result.failed ? /^Exit code (\d+)/.exec(result.output)?.[1] : undefined
  return {
    type: "tool",
    call_id: id,
    command: name === "Bash"
      ? text(input["command"])
      : Object.keys(input).length === 0
      ? name
      : `${name} ${JSON.stringify(input)}`,
    reads: claudeReads(name, input),
    status: result.failed ? "error" : "ok",
    ...(exit === undefined ? {} : { exit_code: Number(exit) }),
    output: result.output,
    duration_ms: result.took
  }
}

/** An `error` part for a record or block kind this release does not read, named so a person can report it. */
const unread = (kind: "record" | "content block", type: unknown): Part => ({
  type: "error",
  message: `Claude Code wrote a ${kind} this release does not read: ${text(type) || "unnamed"}`
})

/** The owner's words in a user record, or `undefined` for Claude Code's own output of a local command. */
const ownerText = (said: string): Part | undefined => {
  if (/^\[Request interrupted by user[^\]]*\]$/.test(said)) return { type: "error", message: said }
  if (/^<(?:local-command-std(?:out|err)|bash-std(?:out|err))>/.test(said)) return undefined
  // Claude Code writes a slash command as tags that open the record; a prompt that mentions them stays as typed.
  const command = /^<command-(?:name|message)>/.test(said)
    ? /<command-name>([^<]*)<\/command-name>/.exec(said)?.[1]
    : undefined
  if (command !== undefined) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(said)?.[1]?.trim()
    return { type: "prompt", text: args ? `${command} ${args}` : command }
  }
  const shell = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(said)?.[1]
  return { type: "prompt", text: shell === undefined ? said : `!${shell.trim()}` }
}

/**
 * Decode the next chunk of a Claude Code session transcript. Pass `claudeStart` with the first chunk and the
 * returned state with each following one; any partition of the same bytes yields the same entries.
 *
 * Entries follow the order of the records that complete them. A tool call is held in `state.calls` from its
 * `tool_use` record until the `tool_result` with the same id arrives, and becomes one entry at the result's line;
 * a call whose result never arrives emits nothing.
 *
 * @category decoding
 * @since 1.0.0-rc.1
 */
export const decodeClaude = (
  state: ClaudeState,
  chunk: string
): Result.Result<Decoded<ClaudeState>, ExternalTranscriptError> => {
  const lines = (state.pending + chunk).split("\n")
  const pending = lines.pop()!
  let { line, seq, session, turn } = state
  const calls = new Map(Object.entries(state.calls))
  const entries: Array<Entry> = []
  const fail = (code: ExternalTranscriptErrorCode, message: string) =>
    Result.fail(new ExternalTranscriptError({ code, message, line }))
  for (const raw of lines) {
    line++
    if (raw.trim() === "") continue
    const row = parseRow(raw)
    if (row === undefined) return fail("malformed_record", `Claude Code transcript line ${line} is not a JSON record.`)
    // Conversation records chain by uuid; queue, mode, title, cost and file-history rows do not.
    if (typeof row["uuid"] !== "string") continue
    const release = text(row["version"])
    if (release === "") return fail("missing_version", `Claude Code transcript line ${line} names no release.`)
    const format_version = profileOf("claude-code", claudeReleases, release)
    if (format_version === undefined) {
      return fail(
        "unsupported_version",
        `Claude Code ${release} wrote this transcript; supported: ${claudeReleases.join(", ")}.`
      )
    }
    session ??= text(row["sessionId"]) || undefined
    if (session === undefined) {
      return fail("malformed_record", `Claude Code transcript line ${line} names no session.`)
    }
    const sessionId = session
    // A subagent's records belong to its own transcript; the main one shows the call as a helper.
    if (row["isSidechain"] === true) continue
    const at = Date.parse(text(row["timestamp"])) || 0
    if (row["type"] === "user" && typeof row["promptId"] === "string" && row["promptId"] !== "") {
      turn = row["promptId"]
    }
    const found: Array<{ readonly role: Entry["role"]; readonly part: Part }> = []
    const said = (part: Part) => found.push({ role: "assistant", part })
    const message = record(row["message"])
    switch (row["type"]) {
      case "user": {
        const blocks = blocksOf(message["content"])
        for (const block of blocks) {
          if (block["type"] === "tool_result") {
            const callId = text(block["tool_use_id"])
            const call = calls.get(callId)
            calls.delete(callId)
            const content = block["content"]
            said(claudeToolPart(callId, call, {
              failed: block["is_error"] === true,
              output: typeof content === "string" ? content : textOf(list(content).map(record)),
              report: record(row["toolUseResult"]),
              took: call !== undefined && call.at > 0 && at > call.at ? at - call.at : 0
            }))
          } else if (block["type"] !== "text" && block["type"] !== "image") {
            said(unread("content block", block["type"]))
          }
        }
        const words = textOf(blocks)
        // Skill bodies, caveats and summaries Claude Code injects are not the owner's; nor are task notifications
        // or messages from other sessions.
        if (words === "" || row["isMeta"] === true || row["isCompactSummary"] === true || !byOwner(row["origin"])) break
        const part = ownerText(words)
        if (part !== undefined) found.push({ role: part.type === "prompt" ? "user" : "assistant", part })
        break
      }
      case "assistant": {
        const blocks = blocksOf(message["content"])
        if (row["isApiErrorMessage"] === true) {
          said({ type: "error", message: textOf(blocks) || text(row["error"]) })
          break
        }
        for (const block of blocks) {
          switch (block["type"]) {
            case "text":
              if (text(block["text"]) !== "") {
                said({ type: "text", text: text(block["text"]), final: message["stop_reason"] === "end_turn" })
              }
              break
            case "thinking":
              // Claude Code keeps only the signature of most thinking; an empty body has nothing to show.
              if (text(block["thinking"]) !== "") said({ type: "reasoning", text: text(block["thinking"]) })
              break
            case "redacted_thinking":
              break
            case "tool_use":
              calls.set(text(block["id"]), { name: text(block["name"]), input: block["input"] ?? {}, at })
              break
            default:
              said(unread("content block", block["type"]))
          }
        }
        break
      }
      case "system":
        // Every other subtype is a status line: turn timing, hook summaries, retries, usage-limit notices.
        if (row["subtype"] === "compact_boundary") said({ type: "compaction" })
        break
      case "attachment": {
        // Context Claude Code attaches for the model, except a prompt the owner queued while the agent worked.
        const attachment = record(row["attachment"])
        if (
          attachment["type"] === "queued_command" && attachment["commandMode"] === "prompt" &&
          attachment["isMeta"] !== true && byOwner(attachment["origin"])
        ) {
          const words = textOf(blocksOf(attachment["prompt"]))
          if (words !== "") found.push({ role: "user", part: { type: "prompt", text: words } })
        }
        break
      }
      default:
        said(unread("record", row["type"]))
    }
    found.forEach(({ part, role }, index) => {
      entries.push({
        origin: "external",
        agent_kind: "claude-code",
        format_version,
        session_id: sessionId,
        source_id: index === 0 ? `${sessionId}:${line}` : `${sessionId}:${line}#${index}`,
        read_only: true,
        seq: seq++,
        at,
        ...(turn === undefined ? {} : { turn_id: turn }),
        role,
        part
      })
    })
  }
  return Result.succeed({
    state: { pending, line, seq, session, turn, calls: Object.fromEntries(calls) },
    entries
  })
}
