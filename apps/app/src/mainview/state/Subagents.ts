import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { live, type Status } from "@smthrs/rpc/WorkerControls"
import type { Card } from "./AppState"
import { traceFromJournal, type TraceSpan } from "../cards/RunTrace"
type RunCard = Extract<Card, { kind: "run-trace" }>

/** A run card's worker status, the one mapping the toasts and the cards share. */
export const runStatus = (card: RunCard): Status => {
  const { phase, waiting } = card.payload
  return phase === "launching" ? "requested"
    : phase === "completed" ? "done"
    : phase === "failed" || phase === "no-capacity" ? "failed"
    : phase === "cancelled" ? "cancelled"
    : phase === "waiting-approval" || waiting === "approval" ? "waiting"
    : waiting ? "parked" : "running"
}

const SETTLED_ROLLUPS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "exited"])

/** When a settled worker stopped: its settled status rollup, else its last dated row. */
const endedAt = (card: RunCard, status: Status, lastRowAt: number | undefined): number | undefined => {
  if (live(status)) return undefined
  const rollup = card.payload.statusRollup
  if (rollup !== undefined && SETTLED_ROLLUPS.has(rollup.state)) return rollup.updatedAt
  return lastRowAt
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const lastDated = (rows: ReadonlyArray<number | undefined>): number | undefined =>
  rows.reduce<number | undefined>((last, at) => at !== undefined && Number.isFinite(at) ? Math.max(last ?? at, at) : last, undefined)

/** A run card as the card it draws; its transcript rows are its activity. */
export const runSubagent = (card: RunCard, title = card.title): SubagentCard.Subagent => {
  const status = runStatus(card)
  const rows = [...(card.payload.transcriptRows ?? [])].sort((a, b) => a.sequence - b.sequence)
  const ended = endedAt(card, status, lastDated(rows.map((row) => row.at)))
  return {
    title,
    status,
    startedAt: card.createdAt,
    ...(ended === undefined ? {} : { endedAt: ended }),
    entries: rows.filter((row) => row.text.trim() !== "").map((row) => ({ kind: "text", text: row.text }))
  }
}

/** Any worker card's subagent, or undefined for a card that is not one. */
export const subagentOf = (card: Card | undefined): SubagentCard.Subagent | undefined =>
  card?.kind === "run-trace" ? runSubagent(card) : undefined

/**
 * The footer at `now`. A settled worker whose end was never recorded says
 * how it settled and no duration, rather than a clock that keeps running.
 */
export const footerOf = (subagent: SubagentCard.Subagent, now: number): SubagentCard.Footer => {
  const footer = SubagentCard.footer(subagent, now)
  if (live(subagent.status) || subagent.endedAt !== undefined) return footer
  const clock = SubagentCard.footer({ status: subagent.status, startedAt: 0, endedAt: 0 }, 0).clock.replace(/ 0s$/, "")
  return { ...footer, clock, text: subagent.model === undefined ? clock : `${clock} · ${subagent.model}` }
}

/** A toast's words at `now`, with the same held clock as the card's footer. */
export const toastOf = (subagent: SubagentCard.Subagent, now: number): ReturnType<typeof SubagentCard.toast> => {
  const toast = SubagentCard.toast(subagent, now)
  const text = `${subagent.title} · ${footerOf(subagent, now).clock}`
  return { ...toast, text, line: `${toast.glyph} ${text}` }
}

/** One detached child a run's journal recorded, in spawn order. */
export interface ChildRun {
  readonly runId: string
  readonly title: string
  readonly span: TraceSpan
}

/** The flow a spawn asked for, else the recorded child id. */
const childTitle = (span: TraceSpan, runId: string): string => {
  const flow = record(span.detail.input).flow
  return typeof flow === "string" && flow !== "" ? flow : runId
}

/**
 * A run's detached child runs: only a successful agent/spawn records one.
 * At a scrub cursor, only the children spawned by then; `whole` reads past it.
 */
export const childRuns = (card: RunCard, whole = false): ReadonlyArray<ChildRun> => {
  const { cursorSeq, events = [] } = card.payload
  const journal = whole || cursorSeq === undefined ? events
    : events.filter((record) => typeof record.sequence !== "number" || record.sequence <= cursorSeq)
  return traceFromJournal({ runId: card.payload.runId, flowId: card.payload.workflow, status: card.payload.phase }, journal)
    .rows.flatMap((span) => {
      const runId = span.detail.childRunId
      return runId === undefined || runId === "" || /\s/.test(runId) ? [] : [{ runId, title: childTitle(span, runId), span }]
    })
}

/** The run card this client holds for a child, in the parent's repository. */
export const childCardOf = (cards: ReadonlyArray<Card>, parent: RunCard, runId: string): RunCard | undefined =>
  cards.find((card): card is RunCard => card.kind === "run-trace" && card.payload.runId === runId &&
    card.payload.repo === parent.payload.repo && card.payload.workspaceId === parent.payload.workspaceId)

/**
 * A child run's card. Its own run card, once opened, carries its status and
 * rows; until then this client has only the spawn, so it is `requested`.
 */
export const childSubagent = (child: ChildRun, card: RunCard | undefined): SubagentCard.Subagent =>
  card !== undefined ? runSubagent(card, child.title) : {
    title: child.title,
    status: "requested",
    startedAt: child.span.endedAt ?? child.span.startedAt,
    entries: []
  }

/** The run that spawned `card`'s run, and the child's place among its children. */
export const parentRunOf = (cards: ReadonlyArray<Card>, card: RunCard): { readonly parent: RunCard; readonly index: number; readonly child: ChildRun } | undefined => {
  for (const parent of cards) {
    if (parent.kind !== "run-trace" || parent.id === card.id || parent.payload.repo !== card.payload.repo ||
      parent.payload.workspaceId !== card.payload.workspaceId) continue
    const children = childRuns(parent, true)
    const index = children.findIndex((child) => child.runId === card.payload.runId)
    if (index >= 0) return { parent, index, child: children[index]! }
  }
  return undefined
}
