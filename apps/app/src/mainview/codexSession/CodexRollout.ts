/*
 * A Codex session, read from its rollout file, in the app's own models: the
 * conversation's entry rows, one timeline line per entry, and the session as
 * one run for the monitor. `readRollout` keeps what the views show and drops
 * the rest (encrypted reasoning, instructions, rate limits), so a 50 MB
 * rollout becomes a few MB. `projectSession` folds that list up to one
 * position, which is how the scrubber shows the session as it was.
 */
import { PlaceholderAvatarUrl, type Actor, type PhaseTone, type Tone } from "@smthrs/rpc/CardPrimitives"
import type { EntryRowCard } from "@smthrs/rpc/EntryRowCard"
import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import type { TimelineLine } from "@smthrs/rpc/TimelineCard"

type Event<K extends string, B> = { readonly seq: number; readonly at: number; readonly kind: K } & B
type InTurn<K extends string, B = {}> = Event<K, { readonly turn: string } & B>

export type CodexEvent =
  | InTurn<"turn">
  | InTurn<"done", { readonly answer?: string }>
  | Event<"settings", { readonly model?: string; readonly effort?: string; readonly tier?: string; readonly sandbox?: string }>
  | Event<"goal", { readonly objective: string; readonly status: string }>
  | InTurn<"prompt", { readonly text: string }>
  | InTurn<"say", { readonly text: string; readonly final: boolean }>
  | InTurn<"command", { readonly command: string; readonly reads: ReadonlyArray<string>; readonly exit: number | null; readonly failed: boolean; readonly output: string; readonly ms: number }>
  | InTurn<"edit", { readonly files: ReadonlyArray<{ readonly path: string; readonly change: string; readonly diff: string }>; readonly failed: boolean }>
  | InTurn<"compact">
  | InTurn<"helper", { readonly agent: string; readonly text: string }>
  | InTurn<"search", { readonly query: string }>
  | InTurn<"tokens", { readonly total: number; readonly turn_total: number }>

export interface CodexSession {
  readonly id: string
  readonly cwd: string
  readonly cli: string
  readonly started: number
  readonly events: ReadonlyArray<CodexEvent>
}

export interface CodexSessionModel {
  readonly entries: ReadonlyArray<EntryRowCard & { readonly id: string; readonly seq: number }>
  readonly lines: ReadonlyArray<TimelineLine>
  readonly run: MonitorCard
  readonly settings: { readonly model?: string; readonly effort?: string; readonly tier?: string; readonly sandbox?: string }
  readonly at: number
  readonly last: number
  readonly clock: number
}

const OUTPUT_HEAD = 1_500
const OUTPUT_TAIL = 2_500
const DIFF_LIMIT = 6_000

/** Long output keeps its start and its end; the middle says how much it left out. */
export function clip(text: string, head = OUTPUT_HEAD, tail = OUTPUT_TAIL): string {
  if (text.length <= head + tail) return text
  const omitted = text.slice(head, text.length - tail).split("\n").length
  return `${text.slice(0, head)}\n… ${omitted} lines omitted …\n${text.slice(text.length - tail)}`
}

type Json = Record<string, unknown>
const record = (value: unknown): Json => typeof value === "object" && value !== null ? value as Json : {}
const text = (value: unknown): string => typeof value === "string" ? value : ""
const texts = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map(part => text(record(part).text)).filter(Boolean).join("\n")

function readsOf(parsed: unknown): ReadonlyArray<string> | undefined {
  const parts = (Array.isArray(parsed) ? parsed : []).map(record)
  if (parts.length === 0 || parts.some(part => !["read", "search", "list_files"].includes(text(part.type)))) return undefined
  return parts.map(part => part.type === "read" ? `Read ${text(part.name) || basename(text(part.path))}`
    : part.type === "search" ? `Searched ${JSON.stringify(text(part.query))}${part.path ? ` in ${basename(text(part.path))}` : ""}`
    : `Listed ${basename(text(part.path)) || "files"}`)
}

function itemEvent(item: Json, turn: string, seq: number, at: number, ms: number): CodexEvent | undefined {
  switch (item.type) {
    case "UserMessage": return { seq, at, kind: "prompt", turn, text: texts(item.content) }
    case "AgentMessage": return { seq, at, kind: "say", turn, text: texts(item.content), final: item.phase === "final_answer" }
    case "CommandExecution": {
      const argv = Array.isArray(item.command) ? item.command.map(text) : [text(item.command)]
      const exit = typeof item.exit_code === "number" ? item.exit_code : null
      const reads = readsOf(item.parsed_cmd) ?? []
      return { seq, at, kind: "command", turn, command: argv.at(-1) ?? "", reads, exit, failed: item.status === "failed" || (exit ?? 0) !== 0,
        output: clip(text(item.aggregated_output) || text(item.formatted_output)), ms }
    }
    case "FileChange": return { seq, at, kind: "edit", turn, failed: item.status === "failed",
      files: Object.entries(record(item.changes)).map(([path, change]) => ({ path, change: text(record(change).type), diff: clip(text(record(change).unified_diff), DIFF_LIMIT, 0) })) }
    case "ContextCompaction": return { seq, at, kind: "compact", turn }
    case "SubAgentActivity": return { seq, at, kind: "helper", turn, agent: helperName(item.agent_path), text: `${helperName(item.agent_path)} ${text(item.kind)}` }
    case "CollabAgentToolCall": {
      const agents = (Array.isArray(item.receiver_agents) ? item.receiver_agents : []).map(each => helperName(record(each).agent_path ?? each))
      return { seq, at, kind: "helper", turn, agent: agents[0] ?? "helpers", text: `${text(item.tool)}${agents.length ? ` ${agents.join(", ")}` : ""}` }
    }
    case "Extension": {
      const action = record(item.action)
      const query = text(item.query) || text(action.query) || text(action.pattern) || text(action.url)
      return query === "" ? undefined : { seq, at, kind: "search", turn, query }
    }
    default: return undefined
  }
}

const helperName = (path: unknown): string => text(path).split("/").filter(Boolean).at(-1) ?? "helper"
const basename = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path

/** Read a rollout's JSONL into the events the views show. Unknown or malformed lines are skipped. */
export function readRollout(jsonl: string): CodexSession {
  const events: CodexEvent[] = []
  let id = "", cwd = "", cli = "", started = 0
  const push = (event: Omit<CodexEvent, "seq"> | undefined) => { if (event) events.push({ ...event, seq: events.length } as CodexEvent) }
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue
    let row: Json
    try { row = record(JSON.parse(line)) } catch { continue }
    const payload = record(row.payload)
    const at = Date.parse(text(row.timestamp)) || 0
    if (row.type === "session_meta") {
      id = text(payload.id) || text(payload.session_id); cwd = text(payload.cwd); cli = text(payload.cli_version)
      started = Date.parse(text(payload.timestamp)) || at
      continue
    }
    if (row.type === "turn_context") {
      const sandbox = text(record(payload.sandbox_policy).type)
      const effort = text(record(record(payload.collaboration_mode).settings).reasoning_effort)
      push({ at, kind: "settings", model: text(payload.model) || undefined, effort: effort || undefined, sandbox: sandbox || undefined } as Omit<CodexEvent, "seq">)
      continue
    }
    if (row.type === "token_usage_record") {
      push({ at, kind: "tokens", turn: text(payload.turn_id), total: Number(record(payload.thread_token_usage).total_tokens ?? 0),
        turn_total: Number(record(payload.turn_token_usage).total_tokens ?? 0) } as Omit<CodexEvent, "seq">)
      continue
    }
    if (row.type !== "event_msg") continue
    switch (payload.type) {
      case "task_started": push({ at, kind: "turn", turn: text(payload.turn_id) } as Omit<CodexEvent, "seq">); break
      case "task_complete": push({ at, kind: "done", turn: text(payload.turn_id), answer: text(payload.last_agent_message) || undefined } as Omit<CodexEvent, "seq">); break
      case "thread_goal_updated": {
        const goal = record(payload.goal)
        push({ at, kind: "goal", objective: text(goal.objective), status: text(goal.status) } as Omit<CodexEvent, "seq">)
        break
      }
      case "thread_settings_applied": {
        const settings = record(payload.thread_settings)
        push({ at, kind: "settings", model: text(settings.model) || undefined, tier: text(settings.service_tier) || undefined,
          effort: text(record(record(settings.collaboration_mode).settings).reasoning_effort) || undefined } as Omit<CodexEvent, "seq">)
        break
      }
      case "item_completed": {
        const ms = Number(payload.completed_at_ms ?? 0) - Number(payload.started_at_ms ?? 0)
        push(itemEvent(record(payload.item), text(payload.turn_id), 0, at, Math.max(0, ms)))
        break
      }
    }
  }
  return { id, cwd, cli, started: started || events[0]?.at || 0, events }
}

/** Markdown answer → one plain line for titles. */
export function plain(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, "")
    .replace(/^\s*[-+]\s+/gm, "").replace(/\s+/g, " ").trim()
}
export function sentence(markdown: string, limit = 140): string {
  const flat = plain(markdown)
  const end = flat.search(/[.!?](\s|$)/)
  const first = end >= 0 ? flat.slice(0, end + 1) : flat
  return first.length > limit ? `${first.slice(0, limit - 1).trimEnd()}…` : first
}
const short = (value: string, limit: number): string => value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`
const clockOf = (ms: number): string => new Date(ms).toTimeString().slice(0, 8)

interface Turn {
  readonly id: string
  readonly n: number
  readonly start: CodexEvent
  readonly events: CodexEvent[]
  done?: Extract<CodexEvent, { kind: "done" }>
  prompt?: Extract<CodexEvent, { kind: "prompt" }>
  segment: string
  tokens: number
}

/** Who acted: the person at the keyboard, and Codex. */
export interface Participants { readonly person: Actor; readonly agent: Actor }
export const defaultParticipants = (session: Pick<CodexSession, "id">, name = "You", login = "you"): Participants => ({
  person: { kind: "person", login, name, avatar_url: PlaceholderAvatarUrl, color_index: 0 },
  agent: { kind: "agent", id: `codex:${session.id}`, agent: "codex", avatar_url: PlaceholderAvatarUrl, session_id: session.id, color_index: 6 }
})

/** A run of the same failing command, three times, with no edit between: the spec's Thrashing rule (mvp.md §6.6). */
function thrashed(events: ReadonlyArray<CodexEvent>): string | undefined {
  const failures = new Map<string, number>()
  for (const event of events) {
    if (event.kind === "edit") failures.clear()
    if (event.kind !== "command") continue
    if (!event.failed) { failures.delete(event.command); continue }
    const count = (failures.get(event.command) ?? 0) + 1
    failures.set(event.command, count)
    if (count >= 3) return `Same command failed ${count}× with no edit`
  }
  return undefined
}

function phaseTitle(events: ReadonlyArray<CodexEvent>): string {
  let runs = 0, reads = 0, edits = 0, failed = 0, helpers = 0
  for (const event of events) {
    if (event.kind === "command") { if (event.reads.length > 0) reads++; else runs++; if (event.failed) failed++ }
    if (event.kind === "edit") edits += event.files.length
    if (event.kind === "helper") helpers++
  }
  const parts = [runs ? plural(runs, "run") : "", reads ? plural(reads, "read") : "", edits ? plural(edits, "edit") : "",
    failed ? `${failed} failed` : "", helpers ? plural(helpers, "helper step") : ""].filter(Boolean)
  return parts.length === 0 ? "Answered" : parts.join(" · ")
}

/**
 * Fold the session up to and including position `at` (an event `seq`). Without `at`, the latest position.
 * Turns open at `at` are live; the session waits for a person once its last turn is done.
 */
export function projectSession(session: CodexSession, at?: number, who: Participants = defaultParticipants(session)): CodexSessionModel {
  const last = Math.max(0, session.events.length - 1)
  const position = Math.min(Math.max(0, at ?? last), last)
  const events = session.events.slice(0, position + 1)
  const clock = events.at(-1)?.at ?? session.started
  const turns: Turn[] = []
  const byId = new Map<string, Turn>()
  const settings: { model?: string; effort?: string; tier?: string; sandbox?: string } = {}
  let goal: string | undefined
  let tokens = 0
  let asks = 0
  const segments: Array<{ id: string; label: string }> = []
  const entries: Array<CodexSessionModel["entries"][number]> = []
  for (const event of events) {
    if (event.kind === "settings") {
      for (const key of ["model", "effort", "tier", "sandbox"] as const) if (event[key] !== undefined) settings[key] = event[key]
      continue
    }
    if (event.kind === "goal") {
      if (event.status === "active" && event.objective !== goal) {
        goal = event.objective
        entries.push({ id: `goal-${event.seq}`, seq: event.seq, kind: "prompt", author: who.person, title: `Goal: ${event.objective}`, tone: "quiet" })
      }
      if (event.status !== "active") goal = undefined
      continue
    }
    if (event.kind === "turn") {
      const previous = turns.at(-1)?.segment
      const turn: Turn = { id: event.turn, n: turns.length + 1, start: event, events: [], segment: goal !== undefined ? "goal" : previous ?? "start", tokens: 0 }
      turns.push(turn); byId.set(event.turn, turn)
      continue
    }
    const turn = byId.get(event.turn)
    if (turn === undefined) continue
    if (event.kind === "tokens") { tokens = event.total; turn.tokens = event.turn_total; continue }
    if (event.kind === "done") { turn.done = event; continue }
    if (event.kind === "prompt") {
      turn.prompt ??= event
      if (turn.prompt === event) { asks++; turn.segment = `ask-${asks}` ; segments.push({ id: turn.segment, label: short(plain(event.text), 16) }) }
      entries.push({ id: `prompt-${event.seq}`, seq: event.seq, kind: "prompt", author: who.person, title: short(plain(event.text), 160), tone: "quiet" })
    }
    turn.events.push(event)
  }
  // A turn ends with its answer, or when the next turn starts without one (Codex interrupted it).
  const endOf = (turn: Turn): number | undefined => turn.done?.at ?? turns[turn.n]?.start.at
  const interrupted = (turn: Turn): boolean => turn.done === undefined && turns[turn.n] !== undefined
  // Answers follow their turn's prompt; a turn that is still working shows its latest note.
  for (const turn of turns) {
    const said = turn.events.filter((event): event is Extract<CodexEvent, { kind: "say" }> => event.kind === "say")
    const answer = turn.done?.answer ?? said.filter(event => event.final).at(-1)?.text
    const live = endOf(turn) === undefined
    const note = answer ?? said.at(-1)?.text
    if (note === undefined && !live) continue
    // After the turn's prompt even when nothing is said yet: the half step keeps it between whole positions.
    const anchor = turn.events.find(event => event.kind === "say")?.seq ?? (turn.prompt?.seq ?? turn.start.seq) + 0.5
    const title = note === undefined ? "Working" : sentence(note, 200)
    const rest = note === undefined ? "" : plain(note).slice(plain(title.replace(/…$/, "")).length).trim()
    entries.push({ id: `turn-${turn.n}`, seq: anchor, kind: "answer", author: who.agent, title, ...(rest === "" ? {} : { summary: short(rest, 900) }),
      tone: live ? "live" : interrupted(turn) ? "attention" : "done", ...(live ? { state: "working" as const } : {}) })
  }
  entries.sort((left, right) => left.seq - right.seq)

  const lines: TimelineLine[] = entries.map(entry => {
    const turn = entry.kind === "answer" ? turns[Number(entry.id.slice("turn-".length)) - 1] : undefined
    const tone: Tone = entry.tone
    return {
      entry_id: entry.id, kind: entry.kind, tone,
      title: turn === undefined ? short(entry.title, 60) : `Turn ${turn.n} · ${phaseTitle(turn.events)}`,
      ...(turn === undefined ? {} : { summary: entry.title }),
      glyph: turn === undefined ? { actor: entry.author } : endOf(turn) === undefined ? { event: "running" as const }
        : interrupted(turn) || thrashed(turn.events) !== undefined ? { event: "attention" as const } : { actor: entry.author }
    }
  })

  const segmentLabel = (id: string): string => id === "goal" ? "Goal" : id === "start" ? "Start" : segments.find(each => each.id === id)?.label ?? id
  const order: string[] = []
  const occurrences = new Map<string, number>()
  const phaseStep = new Map<Turn, string>()
  const steps: MonitorCard["attempts"][number]["steps"] = []
  for (const turn of turns) {
    const previous = steps.at(-1)
    if (previous === undefined || previous.id !== turn.segment) {
      const k = (occurrences.get(turn.segment) ?? 0) + 1
      occurrences.set(turn.segment, k)
      if (!order.includes(turn.segment)) order.push(turn.segment)
      steps.push({ key: `${turn.segment}#${k}`, id: turn.segment, k, label: segmentLabel(turn.segment), state: "done", started_at: clockOf(turn.start.at) })
    }
    phaseStep.set(turn, steps.at(-1)!.key)
  }
  const current = turns.filter(turn => endOf(turn) === undefined).at(-1)
  const state: MonitorCard["state"] = current !== undefined ? "running" : "waiting"
  const phases = turns.map(turn => {
    const indicator = interrupted(turn) ? "Interrupted" : thrashed(turn.events)
    const ended = endOf(turn) ?? clock
    const answer = turn.done?.answer
    const tone: PhaseTone = endOf(turn) === undefined ? "live" : interrupted(turn) ? "fail" : indicator !== undefined ? "thrash" : "ok"
    return {
      id: turn.id, step: phaseStep.get(turn)!, title: phaseTitle(turn.events),
      ...(answer === undefined ? {} : { summary: sentence(answer) }),
      took_s: Math.max(0, Math.round((ended - turn.start.at) / 1000)), tone, ...(indicator === undefined ? {} : { indicator }),
      cells: turn.events.flatMap((event): MonitorCard["attempts"][number]["phases"][number]["cells"] => {
        const id = `c${event.seq}`
        switch (event.kind) {
          case "prompt": return [{ id, kind: "steer", label: short(plain(event.text), 140), quote: event.text, actor: who.person }]
          case "say": return event.final
            ? [{ id, kind: "answer", label: sentence(event.text), quote: event.text, actor: who.agent, ...(turn.tokens > 0 ? { tokens: turn.tokens } : {}) }]
            : [{ id, kind: "think", label: short(plain(event.text), 160), ...(event.text.length > 160 ? { quote: event.text } : {}) }]
          case "command": return [{ id, kind: event.reads.length > 0 ? "read" : "run",
            label: event.reads.length > 0 ? short(event.reads.join(" · "), 120) : `Ran ${short(event.command.split("\n")[0]!.trim(), 100)}${event.failed ? ` · exit ${event.exit ?? "?"}` : ""}`,
            code: event.command, ...(event.output === "" ? {} : { output: event.output }), ...(event.failed ? { tone: "fail" as const } : {}),
            ...(event.ms > 0 ? { took_s: Math.round(event.ms / 100) / 10 } : {}) }]
          case "edit": return [{ id, kind: "edit", label: `Edited ${short(event.files.map(file => basename(file.path)).join(", "), 120)}`,
            code: event.files.map(file => `${file.change} ${file.path}\n${file.diff}`).join("\n"), ...(event.failed ? { tone: "fail" as const } : {}) }]
          case "compact": return [{ id, kind: "context", label: "Compacted the context" }]
          case "helper": return [{ id, kind: "think", label: event.text,
            actor: { kind: "agent", id: `codex:${event.agent}`, agent: "codex", name: event.agent, avatar_url: PlaceholderAvatarUrl, color_index: 6 } }]
          case "search": return [{ id, kind: "read", label: `Searched the web: ${short(event.query, 100)}` }]
          default: return []
        }
      })
    }
  })
  const graph = order.map((id, index) => ({
    id, label: segmentLabel(id), deps: index === 0 ? [] : [order[index - 1]!],
    state: current !== undefined && current.segment === id ? "current" as const : "done" as const
  }))
  // The whole journal: rows after the position stay, dimmed by the monitor, so a scrub shows what comes next.
  const journal = session.events.flatMap(event => {
    const line = journalText(event)
    return line === undefined ? [] : [{ seq: event.seq, at: clockOf(event.at), type: event.kind, text: line,
      ...("turn" in event && byId.has(event.turn) ? { step: phaseStep.get(byId.get(event.turn)!) } : {}) }]
  })
  const model = settings.model ?? "Codex"
  const run: MonitorCard = {
    id: session.id, flow: "codex", version: session.cli, title: `Codex · ${model}`, state,
    attempts: [{ n: 1, run_id: session.id, state, graph, steps, phases }],
    waits: [], tokens, time_s: Math.max(0, Math.round((clock - session.started) / 1000)), cost_usd: 0, engine: [],
    journal, replay: { at: position, last }
  }
  return { entries, lines, run, settings, at: position, last, clock }
}

function journalText(event: CodexEvent): string | undefined {
  switch (event.kind) {
    case "turn": return "Turn started"
    case "done": return event.answer === undefined ? "Turn finished" : `Answered: ${sentence(event.answer, 160)}`
    case "goal": return `Goal ${event.status}: ${event.objective}`
    case "settings": return [event.model, event.effort, event.tier, event.sandbox].filter(Boolean).join(" · ") || undefined
    case "prompt": return short(plain(event.text), 200)
    case "say": return short(plain(event.text), 200)
    case "command": return `${event.failed ? "✗" : "✓"} ${short(event.command.split("\n")[0]!.trim(), 180)}`
    case "edit": return `Edited ${event.files.map(file => file.path).join(", ")}`
    case "compact": return "Compacted the context"
    case "helper": return event.text
    case "search": return `Searched the web: ${event.query}`
    case "tokens": return undefined
  }
}
