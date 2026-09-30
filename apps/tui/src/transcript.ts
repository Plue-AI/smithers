/**
 * The transcript: a pure fold of harness events into what the screen shows.
 *
 * A cell appears the moment the model starts writing its fence, and its code
 * grows with every text delta. `cell-produced` replaces the streamed text with
 * the program the harness actually runs; calls, printed output and the
 * settlement attach to that same cell.
 */
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Activity from "./activity.ts"
import * as Approvals from "./approvals.ts"
import * as Changes from "./changes.ts"
import type * as Panels from "./panels.ts"
import * as Shell from "./shell.ts"

export type CellStatus = "writing" | "running" | "done" | "failed" | "rejected"

/** A captured change; `undone` once the user reversed it. */
export type Patch = Changes.Patch & { readonly undone?: true }

export interface Call {
  readonly identity?: string
  readonly patches?: ReadonlyArray<Patch>
  readonly flow: string
  readonly subject: string
  readonly status: "running" | "ok" | "failed"
  readonly message?: string
  /** A command's exit status; a nonzero one is a failed command even though the call succeeded. */
  readonly exit?: number
  /** The flow's own words for the call: `reading`, `read`, `failed to read`. */
  readonly verb?: { readonly pending: string; readonly success: string; readonly failure: string }
  /** What an `edit` or `write` changes, for the screen to draw as a diff. */
  readonly change?: Change
  readonly startedAt: number
  readonly endedAt?: number
  /** Authorization refused before the writer could execute. */
  readonly denied?: true
}

export interface Change {
  readonly path: string
  readonly removed: string
  readonly added: string
  /** First line of the change, once the flow reports it. */
  readonly line?: number
}

export type Item =
  & (
    | {
      readonly kind: "user"
      readonly id: string
      readonly text: string
      /** Sent mid-turn; true until the harness drains it at a cell boundary. */
      readonly queued?: boolean
    }
    | {
      readonly kind: "shell"
      readonly id: string
      readonly command: string
      /** `!!`: shown, but kept out of the agent's context. */
      readonly excluded: boolean
      readonly output: string
      readonly result?: Shell.Result
    }
    | {
      readonly kind: "cell"
      readonly id: string
      /** One-based, counted across the whole session. */
      readonly index: number
      /** The prose the model wrote outside its fences, if any. */
      readonly prose: string
      readonly source: string
      readonly status: CellStatus
      readonly calls: ReadonlyArray<Call>
      readonly printed: string
      readonly error?: string
      readonly startedAt: number
      readonly endedAt?: number
      /** The turn whose journal holds this cell: an index into `past`, or `past.length` for the current one. */
      readonly turn?: number
      /** The 1-based frame of that journal the cell was written in. */
      readonly frame?: number
    }
    | { readonly kind: "answer"; readonly id: string; readonly text: string }
    | {
      readonly kind: "error"
      readonly id: string
      readonly text: string
      /** Raised by background work such as a monitor; it ends no turn. */
      readonly background?: true
      /** A person stopped the turn: it ended, and nothing failed. */
      readonly stopped?: true
    }
    | { readonly kind: "note"; readonly id: string; readonly text: string }
    /** A panel published with `placement: "card"`: one item per panel id, updated in place. */
    | { readonly kind: "card"; readonly id: string; readonly panel: Panels.Panel }
  )
  & {
    /** When the item appeared; an item without one shares the previous item's time. */
    readonly at?: number
  }

export interface Transcript {
  readonly activity?: Activity.Activity
  /** Earlier turns' journals, so their steps keep their lines and callouts. */
  readonly past?: ReadonlyArray<Activity.Activity>
  readonly items: ReadonlyArray<Item>
  /** Latest Jev reading for this run; absent when no context assessment exists. */
  readonly contextAssessment?: {
    readonly scope: string
    readonly frame: number
    readonly outdated: boolean
    readonly irrelevant: boolean
  }
  /** The reply text of the model call in flight. */
  readonly streaming: string
  /** Whether the model is reasoning before it writes. */
  readonly thinking: boolean
  /** When the model call in flight was requested; a cell's clock starts here. */
  readonly requestedAt?: number
  readonly cells: number
  readonly nextId: number
  readonly usage: Usage
  /** The last relevance reading drawn, by source and kept ids, so a repeat adds no row. */
  readonly relevance?: string
  /** Runs whose unavailable memory already has a timeline row. */
  readonly memoryUnavailable?: ReadonlyArray<string>
}

export interface Usage {
  readonly input: number
  readonly output: number
  readonly cached: number
  /** Input tokens of the latest model call: how full the context window is. */
  readonly context: number
  /** USD of the priced model calls. */
  readonly usd: number
}

export const empty: Transcript = {
  items: [],
  streaming: "",
  thinking: false,
  cells: 0,
  nextId: 0,
  usage: { input: 0, output: 0, cached: 0, context: 0, usd: 0 }
}

type CellItem = Extract<Item, { kind: "cell" }>

type Unsaved = Item extends infer Each ? Each extends Item ? Omit<Each, "id"> : never : never

const withId = (transcript: Transcript, item: Unsaved, at?: number): Transcript => ({
  ...transcript,
  items: [...transcript.items, { ...item, id: String(transcript.nextId), ...(at === undefined ? {} : { at }) }],
  nextId: transcript.nextId + 1
})

export const user = (transcript: Transcript, text: string, queued = false, at?: number): Transcript =>
  withId(
    queued ? transcript : {
      ...transcript,
      past: [...transcript.past ?? [], transcript.activity ?? Activity.empty],
      activity: Activity.empty
    },
    queued ? { kind: "user", text, queued } : { kind: "user", text },
    at
  )

/** The id the next added item will get. */
export const nextId = (transcript: Transcript): string => String(transcript.nextId)

export const shellStart = (transcript: Transcript, command: string, excluded: boolean, at?: number): Transcript =>
  withId(transcript, { kind: "shell", command, excluded, output: "" }, at)

const updateItem = <K extends Item["kind"]>(
  transcript: Transcript,
  id: string,
  kind: K,
  update: (item: Extract<Item, { kind: K }>) => Item
): Transcript => ({
  ...transcript,
  items: transcript.items.map((
    item
  ) => (item.id === id && item.kind === kind ? update(item as Extract<Item, { kind: K }>) : item))
})

/** A running command's live output, held to the tail its result will keep. */
export const shellOutput = (transcript: Transcript, id: string, text: string): Transcript =>
  updateItem(transcript, id, "shell", (item) => ({ ...item, output: Shell.tail(item.output + text).text }))

export const shellDone = (transcript: Transcript, id: string, result: Shell.Result): Transcript =>
  updateItem(transcript, id, "shell", (item) => ({ ...item, output: result.output, result }))

/** A finished shell command, as a session file stores it. */
export const shell = (transcript: Transcript, result: Shell.Result, excluded: boolean, at?: number): Transcript => {
  const id = nextId(transcript)
  return shellDone(shellStart(transcript, result.command, excluded, at), id, result)
}

export const note = (transcript: Transcript, text: string, at?: number): Transcript =>
  withId(transcript, { kind: "note", text }, at)

/** An error row that settles nothing: a background failure the person must see. */
export const alert = (transcript: Transcript, text: string, at?: number): Transcript =>
  withId(transcript, { kind: "error", text, background: true }, at)

/** Adds a card, or updates the card already showing this panel id where it stands. */
export const card = (transcript: Transcript, panel: Panels.Panel, at?: number): Transcript => {
  const index = transcript.items.findIndex((item) => item.kind === "card" && item.panel.id === panel.id)
  if (index < 0) return withId(transcript, { kind: "card", panel }, at)
  const items = [...transcript.items]
  items[index] = { ...items[index]!, panel } as Item
  return { ...transcript, items }
}

/** Ends the turn: nothing streams or waits on a model after it. */
const end = (transcript: Transcript, status: "failed" | "cancelled", text: string, at: number): Transcript => ({
  ...settleOpen(transcript, at, "failed"),
  streaming: "",
  thinking: false,
  requestedAt: undefined,
  activity: Activity.finish(transcript.activity ?? Activity.empty, status, at, text)
})

/** The turn failed; `text` is its cause. */
export const failure = (transcript: Transcript, text: string, at: number): Transcript =>
  withId(end(transcript, "failed", text, at), { kind: "error", text }, at)

/** A person stopped the turn. */
export const stopped = (transcript: Transcript, at: number): Transcript =>
  withId(end(transcript, "cancelled", "Stopped", at), { kind: "error", text: "stopped", stopped: true }, at)

/**
 * The turn finished with `answer`, but no judge could check it: done, never
 * failed. The answer stands as a finished turn's does.
 */
export const unchecked = (transcript: Transcript, answer: string, at: number): Transcript =>
  withId(
    {
      ...settleOpen(transcript, at, "done"),
      streaming: "",
      thinking: false,
      requestedAt: undefined,
      activity: Activity.finish(transcript.activity ?? Activity.empty, "completed", at, "")
    },
    { kind: "answer", text: answer },
    at
  )

/**
 * Splits a reply into the prose around its fences and the program inside
 * them. Fences may be unterminated while the reply streams.
 */
export const split = (reply: string): { readonly prose: string; readonly code: string } => {
  const prose: Array<string> = []
  const code: Array<string> = []
  let rest = reply
  while (rest.length > 0) {
    const open = rest.indexOf("```")
    if (open < 0) {
      prose.push(rest)
      break
    }
    prose.push(rest.slice(0, open))
    const newline = rest.indexOf("\n", open)
    // The info string is still arriving: nothing of the body yet.
    if (newline < 0) break
    const body = rest.slice(newline + 1)
    const close = body.search(/(^|\n)```/)
    if (close < 0) {
      code.push(body)
      break
    }
    code.push(body.slice(0, close))
    rest = body.slice(close).replace(/^\n?```[^\n]*/, "")
  }
  return { prose: prose.map((part) => part.trim()).filter((part) => part !== "").join("\n"), code: code.join("\n") }
}

const lastCell = (transcript: Transcript): CellItem | undefined => {
  for (let at = transcript.items.length - 1; at >= 0; at--) {
    const item = transcript.items[at]!
    if (item.kind === "cell") return item
    if (item.kind === "user" && item.queued === undefined) return undefined
  }
  return undefined
}

const updateCell = (transcript: Transcript, update: (cell: CellItem) => CellItem): Transcript => {
  const cell = lastCell(transcript)
  if (cell === undefined) return transcript
  return { ...transcript, items: transcript.items.map((item) => (item === cell ? update(cell) : item)) }
}

const settleOpen = (transcript: Transcript, at: number, status: "failed" | "done"): Transcript =>
  updateCell(transcript, (cell) =>
    cell.status === "writing" || cell.status === "running"
      ? {
        ...cell,
        status,
        endedAt: at,
        calls: cell.calls.map((call) => (call.status === "running" ? { ...call, status: "failed" } : call))
      }
      : cell)

const streamInto = (transcript: Transcript, text: string, at: number): Transcript => {
  const streaming = transcript.streaming + text
  const { prose, code } = split(streaming)
  const open = lastCell(transcript)
  const next = { ...transcript, streaming, thinking: false }
  if (open !== undefined && open.status === "writing") {
    return updateCell(next, (cell) => ({ ...cell, prose, source: code }))
  }
  const index = transcript.cells + 1
  return {
    ...withId(next, {
      kind: "cell",
      index,
      prose,
      source: code,
      status: "writing",
      calls: [],
      printed: "",
      startedAt: transcript.requestedAt ?? at,
      turn: transcript.past?.length ?? 0,
      frame: Activity.frames(transcript.activity ?? Activity.empty)
    }, transcript.requestedAt ?? at),
    cells: index
  }
}

/** A short, human subject for a flow call: its path, command or pattern. */
export const subject = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return input === undefined ? "" : JSON.stringify(input)
  const record = input as Record<string, unknown>
  for (const key of ["command", "path", "pattern", "file", "query", "url", "name", "title"]) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

const text = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined

/** The change an `edit` (`oldString` → `newString`) or `write` (`content`) call makes. */
export const change = (flow: string, input: unknown): Change | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  const path = text(record, "path")
  if (path === undefined) return undefined
  if (flow === "edit") {
    const removed = text(record, "oldString")
    const added = text(record, "newString")
    return removed === undefined || added === undefined ? undefined : { path, removed, added }
  }
  if (flow === "write") {
    const added = text(record, "content")
    return added === undefined ? undefined : { path, removed: "", added, line: 1 }
  }
  return undefined
}

/**
 * A unified diff of one change, for opentui's `<diff>`. The hunk header uses
 * the reported start line, or 1 before the flow has reported it.
 */
export const unified = (change: Change): string => {
  const lines = (value: string) => (value === "" ? [] : value.replace(/\n$/, "").split("\n"))
  const removed = lines(change.removed)
  const added = lines(change.added)
  const line = change.line ?? 1
  return [
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    `@@ -${removed.length === 0 ? 0 : line},${removed.length} +${line},${added.length} @@`,
    ...removed.map((each) => `-${each}`),
    ...added.map((each) => `+${each}`)
  ].join("\n")
}

const startLine = (value: unknown): number | undefined =>
  typeof value === "object" && value !== null && "startLine" in value && typeof value.startLine === "number"
    ? value.startLine
    : undefined

const exitCode = (value: unknown): number | undefined =>
  typeof value === "object" && value !== null && "exitCode" in value && typeof value.exitCode === "number"
    ? value.exitCode
    : undefined

const outcomeError = (outcome: AgentEvent.CellSettled["outcome"]): string | undefined => {
  switch (outcome._tag) {
    case "settled":
      return undefined
    case "raised":
      return `${outcome.name}: ${outcome.message}`
    case "rejected":
      // The message instructs the model; the user sees the stable code.
      return outcome.code
  }
}

const started = (call: AgentEvent.CellCallStarted["call"], at: number): Call => {
  const verb = call.presentation?.verb
  const changed = change(call.flowName, call.input)
  return {
    ...(call.identity === undefined ? {} : { identity: Changes.identity(call.identity) }),
    flow: call.flowName,
    subject: subject(call.input),
    status: "running",
    ...(verb === undefined ? {} : { verb }),
    ...(changed === undefined ? {} : { change: changed }),
    startedAt: at
  }
}

const onlyDone = (cell: CellItem): boolean =>
  cell.calls.length === 0 && cell.printed === "" && cell.error === undefined &&
  /^(?:return\s+)?(?:await\s+)?ctx\.done\([\s\S]*\)\s*;?$/.test(cell.source.trim())

/** Folds one harness event, observed at `at` milliseconds, into the transcript. */
export const apply = (transcript: Transcript, event: Activity.Observed, at: number): Transcript => {
  if (event._tag === "seat-failed-over") {
    return note(transcript, `↪ switched to ${event.to}`, at)
  }
  if (
    event._tag === "supervisor-settled" && transcript.contextAssessment?.scope === event.scope &&
    transcript.contextAssessment.frame > event.frame
  ) return transcript
  const activity = Activity.apply(transcript.activity ?? Activity.empty, event, at)
  return applyEvent(activity === transcript.activity ? transcript : { ...transcript, activity }, event, at)
}

const applyEvent = (transcript: Transcript, event: Activity.Observed, at: number): Transcript => {
  switch (event._tag) {
    case "decision-unjudged":
    case "supervisor-memory-failed": {
      const unavailable = event._tag === "decision-unjudged"
        ? event.classifier.startsWith("memory/")
        : event.operation === "recall"
      if (event.frame !== 0 || !unavailable || transcript.memoryUnavailable?.includes(event.scope)) return transcript
      return {
        ...note(transcript, "→ memory unavailable", at),
        memoryUnavailable: [...transcript.memoryUnavailable ?? [], event.scope]
      }
    }
    case "supervisor-settled":
      if (event.outdatedContext === undefined && event.irrelevantContext === undefined) return transcript
      return {
        ...transcript,
        contextAssessment: {
          scope: event.scope,
          frame: event.frame,
          outdated: (event.outdatedContext ?? 0) >= 0.5,
          irrelevant: (event.irrelevantContext ?? 0) >= 0.5
        }
      }
    case "relevance-settled": {
      // What entered the model's window: the task's context at run start, else recalled memory. A
      // reading that let nothing in, or the same set again, adds no row.
      const seen = `${event.source}:${event.kept.map((item) => item.id).join(",")}`
      if ((event.source !== "run" && event.kept.length === 0) || transcript.relevance === seen) return transcript
      const what = event.source === "run" ? "context" : "memory"
      return {
        ...note(transcript, `→ ${what} ${event.kept.length} in · ${event.withheld.length} withheld`, at),
        relevance: seen
      }
    }
    case "model-requested":
      return { ...transcript, streaming: "", thinking: false, requestedAt: at }
    case "model-delta": {
      const delta = event.delta
      if (delta.type === "thinking-start" || delta.type === "thinking-delta") return { ...transcript, thinking: true }
      if (delta.type === "text-delta") return streamInto(transcript, delta.text, at)
      return transcript
    }
    case "model-settled": {
      const usage = event.usage
      return {
        ...transcript,
        usage: {
          input: transcript.usage.input + (usage.inputTokens ?? 0),
          output: transcript.usage.output + (usage.outputTokens ?? 0),
          cached: transcript.usage.cached + (usage.cachedInputTokens ?? 0),
          context: usage.inputTokens ?? transcript.usage.context,
          usd: transcript.usage.usd + (event.costUsd ?? 0)
        }
      }
    }
    case "steering-drained":
      if (event.messages.length === 0) return transcript
      return {
        ...transcript,
        items: transcript.items.map((item) =>
          item.kind === "user" && item.queued === true ? { ...item, queued: false } : item
        )
      }
    case "model-retried": {
      const open = lastCell(transcript)
      const cleared = open?.status === "writing"
        ? { ...transcript, items: transcript.items.filter((item) => item !== open), cells: open.index - 1 }
        : transcript
      return note({ ...cleared, streaming: "", thinking: false, requestedAt: at }, `retrying · ${event.code}`, at)
    }
    case "cell-produced": {
      const open = lastCell(transcript)
      const produced = (cell: CellItem): CellItem => ({ ...cell, source: event.cell.text, status: "running" })
      if (open !== undefined && open.status === "writing") return updateCell(transcript, produced)
      // A recorded reply replays without deltas: the cell starts here.
      return updateCell(streamInto(transcript, "", at), produced)
    }
    case "cell-rejected-in-frame": {
      // The harness re-asks inside this frame; the refused attempt and the
      // instruction it sends back are for the model, not the user.
      const open = lastCell(transcript)
      if (open === undefined || (open.status !== "writing" && open.status !== "running")) return transcript
      return { ...transcript, items: transcript.items.filter((item) => item !== open), cells: open.index - 1 }
    }
    case "cell-call-started":
      return updateCell(transcript, (cell) => ({
        ...cell,
        calls: [...cell.calls, started(event.call, at)]
      }))
    case "cell-call-settled":
      return updateCell(transcript, (cell) => {
        const at_ = cell.calls.findLastIndex((call) =>
          (call.identity === undefined
            ? call.flow === event.flowName
            : call.identity === Changes.identity(event.identity)) && call.status === "running"
        )
        if (at_ < 0) return cell
        const ok = event.result.outcome === "success"
        const exit = exitCode(event.result.value)
        const calls = [...cell.calls]
        calls[at_] = {
          ...calls[at_]!,
          status: ok ? "ok" : "failed",
          ...(Approvals.denied(event.result) ? { denied: true as const } : {}),
          ...(ok || event.result.message === undefined ? {} : { message: event.result.message }),
          ...(exit === undefined ? {} : { exit }),
          ...(calls[at_]!.change === undefined || startLine(event.result.value) === undefined
            ? {}
            : { change: { ...calls[at_]!.change, line: startLine(event.result.value)! } }),
          endedAt: at
        }
        return { ...cell, calls }
      })
    case "cell-printed":
      return updateCell(transcript, (cell) => ({ ...cell, printed: cell.printed + event.text }))
    case "cell-settled": {
      const error = outcomeError(event.outcome)
      return updateCell(transcript, (cell) => ({
        ...cell,
        status: error === undefined ? "done" : event.outcome._tag === "rejected" ? "rejected" : "failed",
        ...(error === undefined ? {} : { error }),
        endedAt: at
      }))
    }
    case "resolved": {
      const text = event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      const settled = settleOpen(transcript, at, "done")
      // A cell that only calls `ctx.done` restates the answer twice; the answer alone says it.
      const finishing = lastCell(settled)
      const items = finishing !== undefined && onlyDone(finishing)
        ? settled.items.filter((item) => item !== finishing)
        : settled.items
      return withId({ ...settled, items, streaming: "", thinking: false }, { kind: "answer", text }, at)
    }
    case "aborted":
      return failure(transcript, event.reason, at)
    default:
      return transcript
  }
}

/** Milliseconds as `820ms`, `1.2s` or `1m05s`. */
export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}

/** File receipts attach to the actual call identity, including parallel calls of the same flow. */
export const patched = (transcript: Transcript, receipt: Changes.Receipt): Transcript => ({
  ...transcript,
  items: transcript.items.map((item) =>
    item.kind !== "cell"
      ? item
      : ({
        ...item,
        calls: item.calls.map((call) => call.identity !== receipt.call ? call : ({ ...call, patches: receipt.patches }))
      })
  )
})

/**
 * Marks the patches these calls made to `paths` undone, by call identity
 * (stable across live and restored folds), and notes the undo.
 */
export const undone = (
  transcript: Transcript,
  calls: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  at: number
): Transcript => {
  const reversed = (call: Call) => call.identity !== undefined && calls.includes(call.identity)
  return note(
    {
      ...transcript,
      items: transcript.items.map((item) =>
        item.kind !== "cell" || !item.calls.some(reversed)
          ? item
          : ({
            ...item,
            calls: item.calls.map((call) =>
              !reversed(call) || call.patches === undefined ? call : {
                ...call,
                patches: call.patches.map((patch) =>
                  Changes.ends(patch).some((path) => paths.includes(path)) ? { ...patch, undone: true as const } : patch
                )
              }
            )
          })
      )
    },
    `Undid ${paths.join(", ")}`,
    at
  )
}

export const caption = (transcript: Transcript, prose: string): Transcript =>
  updateCell(transcript, (cell) => ({ ...cell, prose }))
