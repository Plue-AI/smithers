/** The terminal reads the same evidence and phase rules as the app. */
import { trace } from "@smthrs/agent/AgentSession"
import {
  type JournalRecord,
  type TraceFold,
  traceFoldModel,
  traceFoldSync,
  type TraceModel
} from "@smthrs/gateway/RunTrace"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"
import { CallIdentity, displayDescriptor } from "@smthrs/harness/Cell"
import { Schema } from "effect"

/** Stored model calls keep timing and identity without the growing request. */
export type Unrequested = Omit<Extract<AgentEvent, { _tag: "model-requested" }>, "request"> & {
  readonly request?: undefined
}
export type Observed = AgentEvent | Unrequested
const unrequested = (event: Observed): event is Unrequested =>
  event._tag === "model-requested" && event.request === undefined

export interface Activity {
  readonly records: ReadonlyArray<JournalRecord>
  readonly status: "running" | "completed" | "failed" | "cancelled"
}
export const empty: Activity = { records: [], status: "running" }
const hasIdentity = Schema.is(CallIdentity)

export const apply = (activity: Activity, event: Observed, at: number): Activity => {
  // Older session files predate captured model requests. Keep their recorded
  // request time without manufacturing a prompt or throwing during restore.
  const record = unrequested(event)
    ? {
      eventType: "control.agent.model-requested",
      payload: { seat: event.seat, scope: event.scope, frame: event.frame }
    }
    : event._tag === "cell-call-started" && !hasIdentity(event.call.identity)
    ? {
      eventType: "control.agent.cell-call-started",
      payload: {
        flowName: event.call.flowName,
        input: event.call.input,
        descriptor: displayDescriptor(event.call)
      }
    }
    : event._tag === "cell-call-settled" && !hasIdentity(event.identity)
    ? { eventType: "control.agent.cell-call-settled", payload: { flowName: event.flowName, ...event.result } }
    : event._tag === "cell-settled" && event.outcome._tag === "settled" && event.outcome.transition === undefined
    ? { eventType: "control.agent.cell-settled", payload: { outcome: event.outcome } }
    : trace(event)
  // The journal the app reads ends with the run's verdict, which pins it.
  if (event._tag === "resolved") {
    return {
      status: "completed",
      records: [...activity.records, {
        sequence: activity.records.length + 1,
        kind: "control.run.completed",
        occurredAt: at,
        payload: {}
      }]
    }
  }
  if (record === undefined) return activity
  return {
    status: event._tag === "aborted" ? "failed" : activity.status,
    records: [...activity.records, {
      sequence: activity.records.length + 1,
      kind: record.eventType,
      occurredAt: at,
      payload: record.payload
    }]
  }
}

const opened = "control.agent.turn-opened"
/** The frame ordinal a sequence was recorded in: 1-based, 0 before the first frame. */
export const frameAt = (activity: Activity, seq: number): number =>
  activity.records.reduce((count, record) => record.kind === opened && record.sequence! <= seq ? count + 1 : count, 0)
/** How many frames the journal opened. */
export const frames = (activity: Activity): number => frameAt(activity, Infinity)
/** Where each frame opened, in order. */
export const openings = (activity: Activity): ReadonlyArray<number> =>
  activity.records.flatMap((record) => record.kind === opened ? [record.sequence!] : [])

export const finish = (
  activity: Activity,
  status: "completed" | "failed" | "cancelled",
  at: number,
  message: string
): Activity => {
  if (activity.status === status) return activity
  return {
    status,
    records: [...activity.records, {
      sequence: activity.records.length + 1,
      kind: `control.run.${status}`,
      occurredAt: at,
      payload: status === "completed" ? {} : { cause: message }
    }]
  }
}

const models = new WeakMap<Activity, TraceModel>()
/** One fold per journal, keyed by its first record: each event steps it once. */
const folds = new WeakMap<JournalRecord, TraceFold>()
const run = { runId: "terminal", flowId: "chat" }
export const model = (activity: Activity): TraceModel => {
  let value = models.get(activity)
  if (value === undefined) {
    const first = activity.records[0]
    const fold = traceFoldSync(first === undefined ? undefined : folds.get(first), run, activity.records)
    if (first !== undefined) folds.set(first, fold)
    value = traceFoldModel(fold, activity.status)
    models.set(activity, value)
  }
  return value
}

/** The owner is journal order, including ties and regressing clocks. */
export const owner = (model: TraceModel, seq: number): string =>
  model.owners.findLast((record) => record.seq <= seq)?.spanId ?? model.root.id
