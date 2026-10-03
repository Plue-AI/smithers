/** Host-owned run cards: worker and flow receipts use one projection. */
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import stringWidth from "string-width"
import type { Run } from "./flows.ts"
import * as Lifecycle from "./lifecycle.ts"
import * as Subagents from "./subagents.ts"
import { tabTitle } from "./surfaces.ts"
import * as Tabs from "./tabs.ts"
import type * as Transcript from "./transcript.ts"
import * as Undo from "./undo.ts"
import type { Tab } from "./workspace.ts"

export interface Card {
  readonly surface: string
  readonly title: string
  readonly glyph: string
  readonly tone: string
  readonly duration: string
  readonly outcome: string
  readonly failure?: string
  readonly answer?: string
  readonly result?: string
  readonly steps: ReadonlyArray<string>
  readonly receipts: ReadonlyArray<string>
  readonly diff: boolean
  readonly undo: boolean
  readonly undone: boolean
  readonly settled: boolean
}

export const duration = (startedAt: number, endedAt: number | undefined, now: number): string => {
  const ms = Math.max(0, (endedAt ?? now) - startedAt)
  return ms < 1000 ? `${Math.floor(ms)}ms` : `${Math.floor(ms / 1000)}s`
}

/** Beneath an answer whose turn ran a program: `ctrl+o program · 11s`, without a time under a second. */
export const programHint = (span: Transcript.Span): string =>
  span.endedAt - span.startedAt < 1000
    ? "ctrl+o program"
    : `ctrl+o program · ${duration(span.startedAt, span.endedAt, 0)}`

/** Two terminal lines, including wrapping; fence delimiters stay in the opened run. */
export const summary = (text: string, width: number): ReadonlyArray<string> => {
  const room = Math.max(1, width)
  const lines: Array<string> = []
  const content = text.split(/\n/).filter((line) => !/^\s*(?:`{3,}[^`]*|~{3,}[^~]*)$/.test(line)).join("\n")
  for (const paragraph of content.trim().split(/\n/)) {
    let line = ""
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      if (line !== "" && stringWidth(`${line} ${word}`) > room) {
        lines.push(line)
        line = ""
      }
      if (lines.length === 2) return [lines[0]!, SubagentCard.clip(`${lines[1]} ${word}`, room)]
      line = SubagentCard.clip(line === "" ? word : `${line} ${word}`, room)
    }
    if (line !== "") lines.push(line)
    if (lines.length >= 2) return lines.slice(0, 2)
  }
  return lines
}

const step = (call: Transcript.Call): string => {
  const glyph = call.status === "running"
    ? "◐"
    : call.status === "stopped"
    ? "■"
    : call.status === "failed" || (call.exit ?? 0) !== 0
    ? "✗"
    : "✓"
  const verbs = SubagentCard.verb(
    call.flow,
    call.verb === undefined ? undefined : { pending: call.verb.pending, done: call.verb.success }
  )
  const verb = call.flow === "bash" ? "" : call.status === "running" ? verbs.pending : verbs.done
  const patches = call.patches ?? []
  const counts = patches.reduce((total, patch) => {
    const each = SubagentCard.diffCounts(patch.patch)
    return { added: total.added + each.added, removed: total.removed + each.removed }
  }, { added: 0, removed: 0 })
  return `${glyph} ${verb === "" ? "" : `${verb} `}${Subagents.oneLine(call.subject)}${
    patches.length > 0 ? ` ${Undo.counts(counts)}` : ""
  }${call.flow === "bash" && call.status !== "running" && call.exit !== undefined ? ` exit ${call.exit}` : ""}`
}

export const worker = (
  tab: Tab,
  transcript: Transcript.Transcript,
  now: number,
  availability: { readonly undo?: boolean } = {}
): Card => {
  const cells = Undo.run(transcript)
  const calls = cells.flatMap((cell) => cell.calls)
  const files = Undo.changes(cells)
  const command = Subagents.result(transcript).check
  const settled = Lifecycle.settled(tab.status)
  const outcome = tab.status === "requested" || tab.status === "queued"
    ? tab.status
    : !settled && calls.some((call) => call.flow === "ask" && call.status === "running")
    ? "asks"
    : Tabs.outcome(tab)
  return {
    surface: `tab:${tab.id}`,
    title: tabTitle(tab),
    ...Tabs.styleOf(tab, now),
    glyph: tab.status === "done"
      ? "✓"
      : tab.status === "failed"
      ? "✗"
      : tab.status === "cancelled"
      ? "■"
      : Tabs.styleOf(tab, now).glyph,
    duration: duration(tab.startedAt, tab.endedAt, now),
    outcome,
    settled,
    ...(settled && tab.answer !== undefined ? { answer: tab.answer } : {}),
    steps: settled ? [] : calls.slice(-3).map(step),
    receipts: [
      ...files.map((file) => `${file.path} ${file.undone ? "undone" : Undo.counts(file)}`.trim()),
      ...(command?.exit === undefined ? [] : [`${command.command} exit ${command.exit}`])
    ],
    diff: settled && files.length > 0,
    undo: settled && availability.undo !== false && Undo.possible(cells),
    undone: Undo.undone(cells)
  }
}

export const flow = (run: Run, now: number, steps: ReadonlyArray<string> = []): Card => {
  const settled = Lifecycle.settled(run.status)
  const result = run.answer?.trim()
  return {
    surface: `flow:${run.id}`,
    title: run.flow,
    ...Tabs.style(run.status === "input" ? "waiting" : run.status, now),
    glyph: run.status === "done"
      ? "✓"
      : run.status === "failed"
      ? "✗"
      : run.status === "cancelled"
      ? "■"
      : Tabs.style(run.status === "input" ? "waiting" : run.status, now).glyph,
    duration: duration(run.launchedAt ?? run.startedAt, run.endedAt, now),
    outcome: run.status === "done" ? "done" : run.status === "failed" ?
      "failed"
      : run.status === "cancelled" ?
      "stopped" :
      run.status === "input" ?
      "asks"
      : run.status === "queued" || run.status === "requested"
      ? run.status
      : "working",
    ...(result === undefined || result === "" ? {} : result.includes("\n") ? { answer: result } : { result }),
    ...(run.status === "failed" && run.failure !== undefined ? { failure: run.failure } : {}),
    settled,
    steps: settled && result !== undefined && !result.includes("\n") ? [] : steps,
    receipts: [],
    diff: false,
    undo: false,
    undone: false
  }
}

/**
 * Successful requests replace their coordinator cell and acknowledgement in
 * Chat. While the `program` shows (Ctrl+O or the Cells filter), the cell stays
 * above its card.
 */
export const chat = (transcript: Transcript.Transcript, program = false): Transcript.Transcript => {
  let delegated = false
  const items = transcript.items.map((item) =>
    item.kind === "run" && item.request !== undefined
      ? { kind: "user" as const, id: item.id, at: item.at, text: item.request, queued: false } :
      item
  ).filter((item) => {
    if (item.kind === "run") return false
    if (item.kind === "user" && item.queued !== true) delegated = false
    if (item.kind === "cell") {
      delegated = item.calls.length > 0 &&
        item.calls.every((call) => ["agent.delegate", "smithers.run"].includes(call.flow) && call.status === "ok")
      if (delegated) return program
    }
    if (delegated && item.kind === "answer") return false
    return true
  })
  return {
    ...transcript,
    items,
    activity: delegated ? undefined : transcript.activity
  }
}
