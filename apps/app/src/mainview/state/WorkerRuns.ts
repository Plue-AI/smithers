import { type Status } from "@smthrs/rpc/WorkerControls"
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

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

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
