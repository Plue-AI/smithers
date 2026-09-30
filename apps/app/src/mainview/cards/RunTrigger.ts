import type { Card } from "../state/AppState"
import { WorkflowLaunchSchema } from "../state/WorkflowLaunch"

/*
 * What started a run, as it was recorded (#2115; smithers-ui-DESIGN.md §3.4):
 * the Steps view leads with one row per recorded trigger, and nothing is
 * inferred. The sources today are the ones the app and the control plane
 * write:
 *
 * - `push`: the pushed ref a change request started from, once preparation
 *   pinned it (`_workflowLaunch.source`, state/WorkflowLaunch.ts).
 * - `schedule`: the registered schedule a dispatch fired or resumed
 *   (`_workflowLaunch.triggerDispatch.slug`), with the cron preparation
 *   pinned into the input.
 * - `approval`: every approval decision in the run's journal
 *   (`control.approval.approved` / `.denied`), with the principal the control
 *   plane stamped on it.
 *
 * - `message`: the chat message a dispatched turn answers, as the backend's
 *   message admission authenticated it (`coding/dispatch` input `trigger`:
 *   author, conversation, exact text) and the control plane carried it onto
 *   the run's `control.run.accepted` journal record. Only an admitted
 *   `coding/dispatch` input carries it; a turn with no recorded message has
 *   no row rather than one guessed from the prompt.
 */

export type RunTrigger =
  | { readonly kind: "message"; readonly author: string; readonly conversationId: string; readonly messageId: string; readonly text: string }
  | { readonly kind: "push"; readonly ref: string }
  | { readonly kind: "schedule"; readonly slug: string; readonly cron?: string }
  | { readonly kind: "approval"; readonly decision: "approved" | "denied"; readonly principal?: string; readonly at?: number }

type RunCard = Extract<Card, { kind: "run-trace" }>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/**
 * The message a dispatched turn's admission recorded (flows/coding/dispatch.ts
 * `MessageTrigger`), as the run's `control.run.accepted` journal record
 * carries it. A run is admitted once, so the first accepted record is the
 * only one read; a replayed admission re-serves the same record, never a
 * second row.
 */
const messageTrigger = (card: RunCard): ReadonlyArray<RunTrigger> => {
  if (card.payload.workflow !== "coding/dispatch") return []
  for (const record of card.payload.events ?? []) {
    if (!isRecord(record) || record.kind !== "control.run.accepted") continue
    const held = isRecord(record.payload) ? record.payload.trigger : undefined
    if (!isRecord(held) || held.kind !== "message" || held.origin !== "chat") return []
    const { author, conversationId, messageId, text } = held
    return filled(author) && filled(conversationId) && filled(messageId) && filled(text)
      ? [{ kind: "message", author, conversationId, messageId, text }]
      : []
  }
  return []
}

/** The principal a control record names: the id as stamped, or the login/id/name of a structured one. */
const principalOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim() !== "") return value
  if (!isRecord(value)) return undefined
  for (const key of ["login", "id", "name"]) {
    const held = value[key]
    if (typeof held === "string" && held.trim() !== "") return held
  }
  return undefined
}

/** The launch's triggers: the pinned pushed ref, then the schedule the dispatch named. */
const launchTriggers = (card: RunCard): ReadonlyArray<RunTrigger> => {
  const held = card.payload.input?._workflowLaunch
  if (!isRecord(held)) return []
  const rows: Array<RunTrigger> = []
  const source = WorkflowLaunchSchema.shape.source.safeParse(held.source)
  if (source.success && typeof source.data?.commitId === "string") rows.push({ kind: "push", ref: source.data.name })
  const dispatch = WorkflowLaunchSchema.shape.triggerDispatch.safeParse(held.triggerDispatch)
  if (dispatch.success && dispatch.data !== undefined) {
    const cron = card.payload.input?.schedule
    rows.push({ kind: "schedule", slug: dispatch.data.slug, ...(typeof cron === "string" && cron !== "" ? { cron } : {}) })
  }
  return rows
}

/** Every approval decision the journal records, in sequence, with who decided. */
const decisionTriggers = (card: RunCard): ReadonlyArray<RunTrigger> =>
  (card.payload.events ?? []).flatMap((record): ReadonlyArray<RunTrigger> => {
    if (!isRecord(record) || (record.kind !== "control.approval.approved" && record.kind !== "control.approval.denied")) return []
    const payload = isRecord(record.payload) ? record.payload : {}
    const stamped = typeof payload.at === "number" ? payload.at : typeof record.occurredAt === "number" ? record.occurredAt : undefined
    const principal = principalOf(payload.principal)
    return [{ kind: "approval", decision: record.kind === "control.approval.approved" ? "approved" : "denied", ...(principal === undefined ? {} : { principal }), ...(stamped === undefined ? {} : { at: stamped }) }]
  })

/** The run's recorded triggers: the message or launch, then each approval decision in journal order. */
export const runTriggersOf = (card: Card | undefined): ReadonlyArray<RunTrigger> => {
  if (card?.kind !== "run-trace") return []
  return [...messageTrigger(card), ...launchTriggers(card), ...decisionTriggers(card)]
}

/** A trigger's words beside its mark: the fewest that name the recorded source. */
export const runTriggerWords = (trigger: RunTrigger, workflow: string): string => {
  switch (trigger.kind) {
    case "message": return trigger.text
    case "push": return `from ${trigger.ref} · ${workflow}`
    case "schedule": return trigger.cron === undefined ? `schedule ${trigger.slug}` : `schedule ${trigger.slug} · ${trigger.cron}`
    case "approval": return trigger.principal === undefined ? trigger.decision : `${trigger.decision} by`
  }
}
