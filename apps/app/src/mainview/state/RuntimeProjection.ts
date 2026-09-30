import { questionOf, approvalQuestionKey } from "../cards/ApprovalQuestion"
import { z } from "zod"
import { Data, Schema } from "effect"
import { ApprovalRow, RunSummaryRow, TranscriptRow } from "@smthrs/gateway/GatewayProjection"
import { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import { ControlEvent } from "@smthrs/control/ControlSchema"
import type { Card } from "./AppState"
import { canonicalEventValue, canonicalStoredJsonValue } from "./EventValue"
import { expireStatus } from "./HealthStatus"
import { stampOf } from "./RunFailure"

export const RuntimeScopeSchema = z.object({ repo: z.string().min(1), workspaceId: z.string().optional(), runId: z.string().min(1) }).strict()
export type RuntimeScope = z.infer<typeof RuntimeScopeSchema>
export const runtimeRunKey = (scope: RuntimeScope): string => JSON.stringify([scope.repo, scope.workspaceId ?? null, scope.runId])
export const runtimeApprovalKey = (scope: RuntimeScope, requestId: string, digest: string): string => JSON.stringify([scope.repo, scope.workspaceId ?? null, scope.runId, requestId, digest])
const SummarySchema = z.custom<RunSummaryRow>(Schema.is(RunSummaryRow))
const ApprovalSchema = z.custom<ApprovalRow>(Schema.is(ApprovalRow))
const TranscriptSchema = z.custom<TranscriptRow>(Schema.is(TranscriptRow))
const EventSchema = z.custom<ControlEvent>(Schema.is(ControlEvent))
export const RuntimeCursorSchema = z.custom<ProjectionCursor>(Schema.is(ProjectionCursor))
export const RuntimeObserverSchema = z.object({ state: z.enum(["connected", "reconnecting", "quiet", "stopped"]), action: z.literal("retry").optional(), error: z.string().optional(), quietForMs: z.number().nonnegative().optional() }).strict()
export const RuntimeRunSchema = z.object({
  id: z.string(), scope: RuntimeScopeSchema,
  summary: SummarySchema.optional(), summaryCursor: RuntimeCursorSchema.optional(),
  events: z.array(EventSchema), cursor: RuntimeCursorSchema.optional(),
  /** The last journal read stopped before its suffix was exhausted. */
  journalPending: z.boolean().optional(),
  transcript: z.array(TranscriptSchema).optional(), transcriptCursor: RuntimeCursorSchema.optional(),
  observer: RuntimeObserverSchema.optional(), steps: z.array(z.string()),
  /** A recorded old card is evidence, never manufactured lifecycle history. */
  baseline: z.record(z.string(), z.unknown()).optional(),
  observedAt: z.number(), revision: z.number().int().nonnegative()
}).strict().refine(row => row.id === runtimeRunKey(row.scope) &&
  (row.summary === undefined || row.summary.runId === row.scope.runId) &&
  cursorInScope(row.summaryCursor, row.scope, "run-summary") && cursorInScope(row.transcriptCursor, row.scope, "transcript") &&
  row.transcript?.every(line => line.runId === row.scope.runId) !== false &&
  row.events.every((event, index) => (event.runId === undefined || event.runId === row.scope.runId) && Number.isSafeInteger(event.sequence) && event.sequence >= 0 &&
    (index === 0 || event.sequence >= row.events[index - 1]!.sequence)) && equal(row.cursor, eventCursor(row.scope.runId, row.events)),
  "Runtime run evidence must match its scope and applied prefix")
export type RuntimeRun = z.infer<typeof RuntimeRunSchema>
export const RuntimeApprovalSchema = z.object({
  id: z.string(), scope: RuntimeScopeSchema, row: ApprovalSchema,
  pending: z.boolean().optional(), error: z.string().optional(),
  answerDraft: z.object({ question: z.string().regex(/^[0-9a-f]{64}$/), text: z.string() }).strict().optional(),
  /** Local submission receipt time; never presented as the server's decision time. */
  decidedAt: z.number().optional(), submissionId: z.string().optional(),
  observedAt: z.number(), revision: z.number().int().nonnegative()
}).strict().refine(value => value.row.payload.target._tag === "Node" && value.row.runId === value.scope.runId &&
  value.row.payload.target.runId === value.scope.runId && value.row.payload.target.requestId === value.row.requestId &&
  value.id === runtimeApprovalKey(value.scope, value.row.requestId, value.row.payload.target.digest) &&
  (value.answerDraft === undefined || value.row.status === "pending" && value.answerDraft.question === approvalQuestionKey(value.row)),
  "Runtime approval and its answer draft must match the exact pending gate")
export type RuntimeApproval = z.infer<typeof RuntimeApprovalSchema>

export const RuntimeRunObservationSchema = z.object({
  scope: RuntimeScopeSchema, summary: SummarySchema.optional(), summaryCursor: RuntimeCursorSchema.optional(),
  transcript: z.array(TranscriptSchema).optional(), transcriptCursor: RuntimeCursorSchema.optional(),
  /** Absent means a full snapshot; present anchors an appended transcript suffix. */
  transcriptAfter: z.object({ length: z.number().int().nonnegative(), cursor: RuntimeCursorSchema.optional() }).strict().optional(),
  journal: z.object({ mode: z.enum(["full", "suffix"]), after: RuntimeCursorSchema.optional(), events: z.array(EventSchema) }).strict().optional(),
  journalComplete: z.boolean().optional()
}).strict().refine(value => value.summary !== undefined || value.transcript !== undefined || value.journal !== undefined, "An observation needs recorded evidence")
  .refine(value => value.transcriptAfter === undefined || value.transcript !== undefined, "A transcript suffix needs its rows")
export type RuntimeRunObservation = z.infer<typeof RuntimeRunObservationSchema>
export const RuntimeApprovalObservationSchema = z.object({ scope: RuntimeScopeSchema, rows: z.array(ApprovalSchema) }).strict()
export const RuntimeApprovalSubmissionSchema = z.object({
  id: z.string(), submissionId: z.string().min(1), state: z.enum(["pending", "failed", "approved", "denied"]),
  error: z.string().optional(), decidedAt: z.number().optional()
}).strict()
export type RuntimeApprovalSubmission = z.infer<typeof RuntimeApprovalSubmissionSchema>
export class RuntimeProjectionIntegrityError extends Data.TaggedError("RuntimeProjectionIntegrityError")<{ readonly message: string }> {
  constructor(message = "The runtime projection failed verification.") { super({ message }) }
}
const equal = (a: unknown, b: unknown): boolean => canonicalEventValue(a) === canonicalEventValue(b)
const cursorPosition = (cursor: ProjectionCursor | undefined) => cursor === undefined ? undefined : [cursor.value, cursor.offset]
const compareCursors = (left: ProjectionCursor, right: ProjectionCursor): number => left.value - right.value || left.offset - right.offset
const summaryFacts = (row: RunSummaryRow) => { const { statusRollup: _health, ...facts } = row; return facts }
const executionAdvanced = (previous: RunSummaryRow, next: RunSummaryRow): boolean => {
  const a = previous.executionProvenance, b = next.executionProvenance
  if (a === undefined || b === undefined || a.rootExecutionId !== b.rootExecutionId) return false
  return typeof a.generation === "number" && typeof b.generation === "number" && b.generation > a.generation ||
    a.currentExecutionId === b.currentExecutionId && a.generation === b.generation &&
    typeof a.throughSequence === "number" && typeof b.throughSequence === "number" && b.throughSequence > a.throughSequence
}
const eventCursor = (runId: string, events: ReadonlyArray<ControlEvent>): ProjectionCursor | undefined => {
  const last = events.at(-1)
  if (last === undefined) return undefined
  let offset = 0
  for (let i = events.length - 2; i >= 0 && events[i]?.sequence === last.sequence; i--) offset++
  return { selector: { _tag: "run-events", runId }, projection: "run-events", runId, value: last.sequence, offset }
}
const cursorInScope = (cursor: ProjectionCursor | undefined, scope: RuntimeScope, projection: string): boolean => cursor === undefined ||
  cursor.runId === scope.runId && cursor.projection === projection && cursor.selector._tag === projection && "runId" in cursor.selector && cursor.selector.runId === scope.runId

/** A complete semantic observation is validated before any normalized row is changed. */
export const observeRuntimeRun = (previous: RuntimeRun | undefined, observation: RuntimeRunObservation, at: number, revision: number): RuntimeRun => {
  const { scope, summary, journal, transcriptAfter } = observation
  let transcript = observation.transcript
  const fail = (message: string): never => { throw new RuntimeProjectionIntegrityError(message) }
  if (previous !== undefined && (previous.id !== runtimeRunKey(scope) || runtimeRunKey(previous.scope) !== previous.id)) fail("Wrong runtime run scope")
  if (summary !== undefined && summary.runId !== scope.runId || transcript?.some(row => row.runId !== scope.runId)) fail("Foreign runtime observation")
  if (!cursorInScope(observation.summaryCursor, scope, "run-summary") || !cursorInScope(observation.transcriptCursor, scope, "transcript")) fail("Foreign runtime projection cursor")
  if (transcriptAfter !== undefined) {
    if (transcript === undefined || !cursorInScope(transcriptAfter.cursor, scope, "transcript") ||
      transcriptAfter.length !== (previous?.transcript?.length ?? 0) || !equal(transcriptAfter.cursor, previous?.transcriptCursor)) {
      fail("Runtime transcript suffix does not follow the applied prefix")
    }
    transcript = [...(previous?.transcript ?? []), ...transcript!]
  }
  if (summary !== undefined && previous?.summary !== undefined && summary.updatedAt < previous.summary.updatedAt) fail("Runtime summary moved backwards")
  if (summary !== undefined && previous?.summary !== undefined) {
    const before = previous.summaryCursor, after = observation.summaryCursor
    if (before !== undefined && after !== undefined && compareCursors(after, before) < 0) fail("Runtime summary cursor moved backwards")
    if (before !== undefined && (after === undefined || compareCursors(after, before) === 0) &&
      !equal(summaryFacts(previous.summary), summaryFacts(summary)) && summary.updatedAt <= previous.summary.updatedAt && !executionAdvanced(previous.summary, summary)) {
      fail("Runtime summary changed without newer lifecycle evidence")
    }
  }
  if (transcript !== undefined && previous?.transcript !== undefined) {
    const before = previous.transcriptCursor, after = observation.transcriptCursor
    if (before !== undefined && after !== undefined && compareCursors(after, before) < 0) fail("Runtime transcript cursor moved backwards")
    const prefixChanged = transcript.length < previous.transcript.length || previous.transcript.some((row, index) => !equal(row, transcript[index]))
    // A newer gateway snapshot may upgrade old telemetry with committed native
    // call evidence. Equal or missing cursors cannot authorize such a rewrite.
    if (prefixChanged && (before === undefined || after === undefined || compareCursors(after, before) <= 0)) fail("Runtime transcript changed without newer projection evidence")
  }
  let events = previous?.events ?? []
  if (journal !== undefined) {
    if (!cursorInScope(journal.after, scope, "run-events") || journal.events.some(event => event.runId !== undefined && event.runId !== scope.runId)) fail("Foreign runtime event prefix")
    for (let i = 1; i < journal.events.length; i++) if (journal.events[i]!.sequence < journal.events[i - 1]!.sequence) fail("Runtime event order moved backwards")
    if (journal.mode === "full") {
      if (journal.after !== undefined || journal.events.length < events.length || events.some((event, index) => !equal(event, journal.events[index]))) fail("Runtime full prefix was shortened or rewritten")
      events = [...journal.events]
    } else {
      if (!equal(cursorPosition(journal.after), cursorPosition(previous?.cursor)) ||
        (events.length > 0 && journal.events.length > 0 && journal.events[0]!.sequence < events.at(-1)!.sequence)) fail("Runtime suffix does not follow the applied cursor")
      events = [...events, ...journal.events]
    }
  }
  const words = summary === undefined || summary.calls === 0 && summary.turns === 0 ? undefined :
    `${summary.turns} ${summary.turns === 1 ? "turn" : "turns"} · ${summary.calls} ${summary.calls === 1 ? "call" : "calls"}${summary.callsFailed > 0 ? ` (${summary.callsFailed} refused)` : ""}`
  const steps = previous?.steps ?? []
  const next: RuntimeRun = {
    ...(previous ?? { id: runtimeRunKey(scope), scope, events: [], steps: [] }),
    ...(summary === undefined ? {} : { summary, summaryCursor: observation.summaryCursor ?? previous?.summaryCursor }),
    ...(transcript === undefined ? {} : { transcript: [...transcript], transcriptCursor: observation.transcriptCursor ?? previous?.transcriptCursor }),
    ...(journal === undefined ? {} : { events, cursor: eventCursor(scope.runId, events) }),
    ...(observation.journalComplete === undefined ? {} : { journalPending: !observation.journalComplete }),
    steps: words === undefined || steps.includes(words) ? steps : [...steps, words].slice(-8),
    // A summary read is not a watch restart; only the pump or retry can re-arm a stopped observer.
    observer: previous?.observer?.state === "quiet" || previous?.observer?.state === "stopped"
      ? previous.observer : { state: "connected" }, observedAt: at, revision
  }
  // Time alone is not movement. Record the instant when the same health
  // evidence changes its derived freshness, once, so replay sees that boundary.
  const health = next.summary?.statusRollup
  const healthChanged = previous !== undefined && health !== undefined && health.subjectId === `run:${next.scope.runId}` && health.state === next.summary?.status &&
    !equal(expireStatus(health, previous.observedAt), expireStatus(health, at))
  return previous !== undefined && !healthChanged && canonicalStoredJsonValue({ ...previous, observedAt: at, revision }) === canonicalStoredJsonValue(next) ? previous : next
}

/** Validate the complete read before omitting repeated evidence from a new fact. */
export const changedRuntimeRunObservation = (previous: RuntimeRun | undefined, observation: RuntimeRunObservation, at: number): RuntimeRunObservation | undefined => {
  const next = observeRuntimeRun(previous, observation, at, (previous?.revision ?? 0) + 1)
  if (next === previous) return undefined
  const reduced: RuntimeRunObservation = { scope: observation.scope,
    ...(observation.summary === undefined ? {} : { summary: observation.summary, summaryCursor: observation.summaryCursor }),
    ...(observation.journalComplete === undefined ? {} : { journalComplete: observation.journalComplete }) }
  if (observation.transcript !== undefined) {
    const before = previous?.transcript
    const after = next.transcript!
    const samePrefix = before !== undefined && before.length <= after.length && before.every((row, index) => equal(row, after[index]))
    if (!samePrefix) {
      reduced.transcript = after
      reduced.transcriptCursor = next.transcriptCursor
    } else if (after.length !== before.length || !equal(previous?.transcriptCursor, next.transcriptCursor)) {
      reduced.transcript = after.slice(before.length)
      reduced.transcriptAfter = { length: before.length, cursor: previous?.transcriptCursor }
      reduced.transcriptCursor = next.transcriptCursor
    }
  }
  if (observation.journal !== undefined && next.events.length !== (previous?.events.length ?? 0)) {
    reduced.journal = previous === undefined ? { mode: "full", events: next.events } :
      { mode: "suffix", after: previous.cursor, events: next.events.slice(previous.events.length) }
  }
  // Reconnecting and health expiry can change without new content. Preserve a
  // truthful empty read receipt from the channel actually observed.
  if (reduced.summary === undefined && reduced.transcript === undefined && reduced.journal === undefined) {
    if (observation.transcript !== undefined) {
      reduced.transcript = []
      reduced.transcriptAfter = { length: previous?.transcript?.length ?? 0, cursor: previous?.transcriptCursor }
      reduced.transcriptCursor = next.transcriptCursor
    } else if (observation.journal !== undefined) reduced.journal = { mode: "suffix", after: previous?.cursor, events: [] }
  }
  return reduced
}

/** Request authority is the exact run/request/digest tuple, never wording or a card id. */
export const observedRuntimeApproval = (previous: RuntimeApproval | undefined, scope: RuntimeScope, row: ApprovalRow, at: number, revision: number): RuntimeApproval => {
  const target = row.payload.target
  if (row.runId !== scope.runId || target._tag !== "Node" || target.runId !== row.runId || target.requestId !== row.requestId) throw new RuntimeProjectionIntegrityError("Approval observation has a different gate")
  const id = runtimeApprovalKey(scope, row.requestId, target.digest)
  if (previous !== undefined && (previous.id !== id || runtimeRunKey(previous.scope) !== runtimeRunKey(scope) || !equal(previous.row.payload, row.payload))) throw new RuntimeProjectionIntegrityError("Approval request authority changed")
  // A delayed pending snapshot cannot reopen a gate whose decision is recorded.
  if (previous !== undefined && previous.row.status !== "pending") {
    if (row.status !== "pending" && row.status !== previous.row.status) throw new RuntimeProjectionIntegrityError("Approval decisions conflict")
    return previous
  }
  const questionChanged = previous !== undefined && approvalQuestionKey(previous.row) !== approvalQuestionKey(row)
  const next: RuntimeApproval = { ...(previous ?? {}), id, scope, row,
    ...(questionChanged ? { pending: undefined, error: undefined, submissionId: undefined, decidedAt: undefined } : {}),
    answerDraft: row.status === "pending" && previous?.answerDraft !== undefined && previous.answerDraft.question === approvalQuestionKey(row) ? previous.answerDraft : undefined,
    ...(row.status === "pending" ? {} : { pending: undefined, error: undefined, decidedAt: undefined, submissionId: undefined }), observedAt: at, revision }
  return previous !== undefined && canonicalStoredJsonValue({ ...previous, observedAt: at, revision }) === canonicalStoredJsonValue(next) ? previous : next
}

export const submitRuntimeApproval = (previous: RuntimeApproval, input: RuntimeApprovalSubmission, at: number, revision: number): RuntimeApproval => {
  if (previous.row.status !== "pending") return previous
  if (input.state === "pending") {
    if (previous.pending) return previous
    return { ...previous, pending: true, error: undefined, submissionId: input.submissionId, observedAt: at, revision }
  }
  if (!previous.pending || previous.submissionId !== input.submissionId) return previous
  return { ...previous, row: input.state === "failed" ? previous.row : { ...previous.row, status: input.state },
    pending: undefined, submissionId: undefined, error: input.state === "failed" ? input.error : undefined,
    answerDraft: input.state === "failed" ? previous.answerDraft : undefined,
    decidedAt: input.state === "failed" ? undefined : input.decidedAt, observedAt: at, revision }
}

export const runtimeScopeOf = (card: Card, runId?: string): RuntimeScope | undefined => {
  if (!("repo" in card.payload) || typeof card.payload.repo !== "string") return undefined
  const id = runId ?? ("runId" in card.payload && typeof card.payload.runId === "string" ? card.payload.runId : undefined)
  if (id === undefined) return undefined
  return { repo: card.payload.repo, runId: id, ...("workspaceId" in card.payload && typeof card.payload.workspaceId === "string" ? { workspaceId: card.payload.workspaceId } : {}) }
}
export const runtimeApprovalIdOf = (card: Card): string | undefined => {
  if (card.kind !== "approval" || card.payload.chain === true || card.payload.requestId === undefined) return undefined
  const scope = runtimeScopeOf(card), target = card.payload.approval?.target as { digest?: unknown } | undefined
  return scope === undefined || typeof target?.digest !== "string" ? undefined : runtimeApprovalKey(scope, card.payload.requestId, target.digest)
}
const phaseOf = (status: RunSummaryRow["status"]): Extract<Card, { kind: "run-trace" }>["payload"]["phase"] =>
  status === "accepted" || status === "parked" ? "running" : status
const waitingOf = (row: RunSummaryRow): string | undefined => row.status === "accepted" ? "executor" : row.status === "parked" ? row.waitingReason ?? "parked" : undefined

/** Empty text still carries the question identity the visible form is editing. */
const projectedApprovalAnswer = (state: RuntimeApproval): { question: string; text: string } | undefined => {
  const question = approvalQuestionKey(state.row)
  return question === undefined || state.row.status !== "pending" ? undefined : {
    question, text: state.answerDraft?.question === question ? state.answerDraft.text : ""
  }
}

/** One read projector serves the visible card and every controller decision. */
export const projectRuntimeCard = (card: Card, runs: ReadonlyArray<RuntimeRun>, approvals: ReadonlyArray<RuntimeApproval>): Card => {
  if (card.runtimeView?.revision !== undefined) return card
  if (card.kind === "run-trace") {
    const run = runs.find(row => row.id === runtimeRunKey(card.payload))
    if (run === undefined) return card
    const row = run.summary
    const phase = row === undefined ? card.payload.phase : row.status === "parked" && row.waitingReason === "approval" ? "waiting-approval" : phaseOf(row.status)
    const terminal = phase === "completed" || phase === "failed" || phase === "cancelled"
    const observation = run.observer?.state
    return { ...card, runtimeView: { version: 1 }, status: terminal ? phase === "failed" ? "error" : "acted" : row === undefined ? card.status : "active",
      payload: { ...card.payload, phase: terminal || observation === undefined || observation === "connected" ? phase : observation,
        ...(row === undefined ? {} : { workflow: row.flowId, lastSeq: row.updatedAt, waiting: waitingOf(row), steeringPending: (row.steeringPending ?? 0) > 0, deadlineAt: row.deadlineAt,
          result: row.status === "completed" ? row.finalOutput ?? row.verdict : null, error: row.status === "failed" ? row.verdict : undefined,
          failure: stampOf(row),
          statusRollup: row.statusRollup?.subjectId === `run:${row.runId}` && row.statusRollup.state === row.status ? expireStatus(row.statusRollup, run.observedAt) : undefined }),
        steps: phase === "cancelled" ? [...(run.steps.length === 0 ? card.payload.steps : run.steps).filter(step => step !== "Cancelled this run."), "Cancelled this run."].slice(-8) : run.steps.length === 0 ? card.payload.steps : run.steps,
        ...(run.cursor === undefined ? {} : { events: run.events }),
        ...(run.transcript === undefined || card.payload.transcriptAtRevision !== undefined && card.payload.follow !== true ? {} : { transcriptRows: run.transcript.map(line => ({ ...line })) }),
        observationError: run.observer?.error, quietForMs: run.observer?.quietForMs } }
  }
  if (card.kind === "approval") {
    const state = approvals.find(row => row.id === runtimeApprovalIdOf(card))
    if (state === undefined) return card
    return { ...card, runtimeView: { version: 1 }, title: state.row.title,
      status: state.row.status === "pending" ? state.error === undefined ? "active" : "error" : "acted",
      payload: { ...card.payload, capability: state.row.title, question: questionOf(state.row), answerDraft: projectedApprovalAnswer(state), approval: state.row.payload as Record<string, unknown>,
        decision: state.row.status === "pending" ? undefined : state.row.status, pending: state.pending, error: state.error, decidedAt: state.decidedAt } }
  }
  if (card.kind === "approvals-inbox") {
    const rows = card.payload.approvals.map(row => {
      const scope = runtimeScopeOf(card, row.runId), target = row.approval.target as { digest?: unknown } | undefined
      const observed = scope === undefined || typeof target?.digest !== "string" ? undefined : approvals.find(value => value.id === runtimeApprovalKey(scope, row.requestId, target.digest as string))
      return observed === undefined ? row : { ...row, title: observed.row.title, question: questionOf(observed.row), answerDraft: projectedApprovalAnswer(observed), approval: observed.row.payload as Record<string, unknown>,
        decision: observed.row.status === "pending" ? undefined : observed.row.status, decidedAt: observed.decidedAt, pending: observed.pending, decisionError: observed.error }
    })
    return { ...card, runtimeView: { version: 1 }, status: rows.every(row => row.decision !== undefined) ? "acted" : "active", payload: { ...card.payload, approvals: rows } }
  }
  if (card.kind === "run-list") return { ...card, runtimeView: { version: 1 }, payload: { ...card.payload, runs: card.payload.runs.map(row => {
    const scope = runtimeScopeOf(card, row.runId), observed = scope === undefined ? undefined : runs.find(value => value.id === runtimeRunKey(scope))?.summary
    return observed === undefined ? row : { ...row, flowId: observed.flowId, status: observed.status, waiting: waitingOf(observed),
      createdAt: observed.createdAt, turns: observed.turns, calls: observed.calls, statusRollup: observed.statusRollup }
  }) } }
  return card
}

export const snapshotRuntimeCard = (card: Card, runs: ReadonlyArray<RuntimeRun>, approvals: ReadonlyArray<RuntimeApproval>, revision: number): Card => {
  if (!["run-trace", "run-list", "approval", "approvals-inbox"].includes(card.kind) || card.runtimeView?.revision !== undefined) return card
  return { ...projectRuntimeCard(card, runs, approvals), runtimeView: { version: 1, revision } }
}
