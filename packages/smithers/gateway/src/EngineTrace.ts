/**
 * Recorded native evidence, decoded through the contracts that wrote it.
 *
 * @since 1.0.0
 */

import { RunState } from "@smthrs/engine-store/RunState"
import { ResultEncoded } from "@smthrs/flow/Flow"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Option, Schema } from "effect"
import type { JournalRecord, SpanDetail, TraceBuilder } from "./RunTrace.js"

// This is the private control bridge's envelope, not another engine contract.
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  executionId: JournalEvent.RunId,
  generation: JournalEvent.NonNegativeQuantity,
  sequence: JournalEvent.Seq,
  eventId: Schema.String,
  sourceId: JournalEvent.SourceId,
  sourceSequence: JournalEvent.SourceSeq,
  emittedAtMs: JournalEvent.TimestampMs,
  eventType: Schema.NonEmptyString,
  payload: Schema.Json,
  meta: Schema.Json
})
type Envelope = typeof Envelope.Type

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeAttempt = Schema.decodeUnknownOption(EngineEvent.AttemptPayload, { onExcessProperty: "error" })
const decodeState = Schema.decodeUnknownOption(EngineEvent.StatePayload, { onExcessProperty: "error" })
const decodeMarker = Schema.decodeUnknownOption(EngineEvent.CurrentAttempt)
const stateDecisions = [
  "created",
  "resumed",
  "transitioned",
  "handed-off",
  "lineage-exhausted",
  "round-invalid",
  "quarantined",
  "interrupt-released"
] as const
const decodeDecision = Schema.decodeUnknownOption(Schema.Struct({
  decision: Schema.Literals(stateDecisions),
  status: Schema.optionalKey(Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"])),
  state: RunState
}))
// RunDriver's durable cancellation record has no run-decision counterpart.
const decodeCancellation = Schema.decodeUnknownOption(Schema.Struct({
  outcome: Schema.Literal("cancelled"),
  interruptedAtMs: JournalEvent.TimestampMs,
  owner: Schema.String,
  cascadedTo: Schema.optionalKey(Schema.Array(JournalEvent.RunId))
}))
const decodeResult = Schema.decodeUnknownOption(ResultEncoded, { onExcessProperty: "error" })

const json = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value)
const identity = (...parts: ReadonlyArray<string | number>) =>
  parts.map((part) => encodeURIComponent(String(part))).join(":")
const span = (id: string, kind: TraceBuilder["kind"], label: string, at: number, detail: SpanDetail): TraceBuilder => ({
  id,
  kind,
  label,
  status: "recorded",
  startedAt: at,
  children: [],
  detail
})
const detail = (row: JournalRecord, envelope: Envelope): SpanDetail => ({
  sequence: row.sequence,
  event: envelope.eventType,
  fields: { ...envelope }
})
interface Execution {
  readonly envelope: Envelope
  readonly span: TraceBuilder
  parentId?: string | undefined
  parentExecutionId?: string | undefined
  parentKnown?: boolean | undefined
  flowName?: string | undefined
  coherent: boolean
  result?: { readonly value: unknown; readonly sequence: number } | undefined
  failure?: EngineExecutionEvidence["failure"] | undefined
}

/**
 * A render-only view of the same decoded execution facts; never persisted.
 *
 * @category models
 * @since 1.0.0
 */
export interface EngineExecutionEvidence {
  readonly executionId: string
  readonly generation: number
  readonly spanId: string
  readonly parentExecutionId?: string | undefined
  readonly parentKnown: boolean
  readonly flowName?: string | undefined
  readonly input?: unknown | undefined
  readonly coherent: boolean
  readonly status: string
  readonly result?: { readonly value: unknown; readonly sequence: number } | undefined
  /** Original classified failure bytes, never parsed from rendered detail. */
  readonly failure?: {
    readonly kind: "cause" | "error" | "defect" | "interrupted" | "encoding"
    readonly value: unknown
    readonly sequence: number
  } | undefined
}
const decodeProjection = Schema.decodeUnknownOption(Schema.Struct({
  version: Schema.Literal(1),
  executionId: JournalEvent.RunId,
  generation: JournalEvent.NonNegativeQuantity
}))

/**
 * Observation completion is separate from the control run's terminal verdict.
 *
 * @category utilities
 * @since 1.0.0
 */
export const engineProjectionPending = (records: ReadonlyArray<JournalRecord> = []): boolean => {
  const states = new Map<string, { generation: number; pending: boolean }>()
  for (const row of [...records].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) {
    if (row.kind === "control.engine.projection-gap") {
      // The gap is rendered as missing evidence. Stop polling rather than
      // disguising an observation failure as an indefinitely running task.
      for (const state of states.values()) state.pending = false
      continue
    }
    if (row.kind !== "control.engine.projection-started" && row.kind !== "control.engine.projection-settled") continue
    const decoded = decodeProjection(row.payload)
    if (Option.isNone(decoded)) continue
    const { executionId, generation } = decoded.value
    const current = states.get(executionId)
    if (row.kind === "control.engine.projection-started") {
      if (current === undefined || generation > current.generation) {
        states.set(executionId, { generation, pending: true })
      }
    } else if (current?.generation === generation) current.pending = false
  }
  return [...states.values()].some((state) => state.pending)
}

/**
 * Generations never share attempt identity. Native timestamps describe native
 * work; the outer control sequence still determines the historical UI cursor.
 * Only recorded parent IDs can nest executions. Ambiguous parent generations
 * remain beside the root instead of guessing which historical parent owned them.
 */
const foldEngineJournal = (records: ReadonlyArray<JournalRecord>) => {
  const executions = new Map<string, Execution>()
  const attempts = new Map<string, TraceBuilder>()
  const notices: Array<TraceBuilder> = []
  const seen = new Map<string, string>()
  for (const row of records) {
    if (row.kind === "control.engine.projection-gap") {
      const notice = span(
        `engine-gap:${row.sequence ?? notices.length}`,
        "event",
        "Engine evidence gap",
        row.occurredAt ?? 0,
        {
          sequence: row.sequence,
          event: row.kind,
          fields: { evidence: row.payload }
        }
      )
      notice.status = "unknown"
      notice.endedAt = notice.startedAt
      notices.push(notice)
      continue
    }
    if (row.kind !== "control.engine.event") continue
    const decoded = decodeEnvelope(row.payload)
    if (Option.isNone(decoded)) {
      const notice = span(
        `engine-invalid:${row.sequence ?? notices.length}`,
        "event",
        "Unreadable engine evidence",
        row.occurredAt ?? 0,
        {
          sequence: row.sequence,
          event: row.kind,
          fields: { evidence: row.payload }
        }
      )
      notice.status = "unknown"
      notice.endedAt = notice.startedAt
      notices.push(notice)
      continue
    }
    const envelope = decoded.value
    const key = identity(envelope.executionId, envelope.generation)
    const eventKey = identity(key, envelope.sequence)
    const previous = seen.get(eventKey)
    if (previous !== undefined) {
      if (previous !== JSON.stringify(envelope)) {
        const conflict = executions.get(key)
        conflict!.coherent = false
      }
      continue
    }
    seen.set(eventKey, JSON.stringify(envelope))
    let execution = executions.get(key)
    if (execution === undefined) {
      execution = {
        envelope,
        coherent: true,
        span: span(`engine:${key}`, "execution", envelope.executionId, envelope.emittedAtMs, detail(row, envelope))
      }
      executions.set(key, execution)
    }
    const parent = (parentId: string | undefined) => {
      if (execution.parentKnown && execution.parentExecutionId !== parentId) execution.coherent = false
      execution.parentKnown = true
      execution.parentExecutionId = parentId
      execution.parentId = parentId
    }
    const result = (value: unknown) => {
      if (Number.isSafeInteger(row.sequence) && row.sequence! >= 0) {
        execution.result = { value, sequence: row.sequence! }
      }
    }
    const failure = (kind: NonNullable<EngineExecutionEvidence["failure"]>["kind"], value: unknown) => {
      if (Number.isSafeInteger(row.sequence) && row.sequence! >= 0) {
        execution.failure = { kind, value, sequence: row.sequence! }
      }
    }
    const generic = () => {
      const event = span(
        `engine-event:${eventKey}`,
        "event",
        envelope.eventType,
        envelope.emittedAtMs,
        detail(row, envelope)
      )
      event.endedAt = event.startedAt
      execution.span.children.push(event)
    }
    const attempt = (step: string, number: number) => {
      const attemptKey = identity(key, step, number)
      let current = attempts.get(attemptKey)
      if (current === undefined) {
        current = span(
          `engine-attempt:${attemptKey}`,
          "attempt",
          `attempt ${number} · ${step.slice(0, 12)}`,
          envelope.emittedAtMs,
          detail(row, envelope)
        )
        attempts.set(attemptKey, current)
        execution.span.children.push(current)
      }
      return current
    }
    if (
      envelope.eventType === "flows.engine.attempt-started" || envelope.eventType === "flows.engine.attempt-finished"
    ) {
      const marker = decodeMarker({ eventType: envelope.eventType, payload: envelope.payload })
      if (Option.isNone(marker) || marker.value.payload.runId !== envelope.executionId) {
        generic()
        continue
      }
      const current = attempt(marker.value.payload.stepKeyDigest, marker.value.payload.attempt)
      if (marker.value.eventType === "flows.engine.attempt-started") current.status = "running"
      else {
        current.status = marker.value.payload.state === "succeeded" ? "completed" : "failed"
        current.endedAt = envelope.emittedAtMs
      }
      current.detail = { ...current.detail, fields: { ...envelope } }
      continue
    }
    if (envelope.eventType === EngineEvent.attemptEventType) {
      const recorded = decodeAttempt(envelope.payload)
      if (Option.isNone(recorded) || recorded.value.executionId !== envelope.executionId) {
        execution.coherent = false
        generic()
        continue
      }
      const { lifecycle, lineage, stepKeyDigest, attempt: number } = recorded.value
      // Lineage may describe a trampoline predecessor, not a spawned parent.
      // Product ancestry comes only from RunState.parentExecutionId below.
      execution.parentId = lineage.parentRunId ?? undefined
      const current = attempt(stepKeyDigest, number)
      current.startedAt = lifecycle.startedAtMs
      current.status = lifecycle.state === "succeeded"
        ? "completed"
        : lifecycle.state === "suspended"
        ? "waiting"
        : lifecycle.state
      current.detail = { ...detail(row, envelope), sequence: current.detail.sequence }
      if (lifecycle.state === "succeeded" || lifecycle.state === "failed") {
        current.endedAt = lifecycle.finishedAtMs
        current.detail = {
          ...current.detail,
          ...(lifecycle.result._tag === "Success"
            ? { output: json(lifecycle.result.value) }
            : { message: json(lifecycle.result.detail) })
        }
      }
      continue
    }
    if (envelope.eventType === EngineEvent.stateEventType) {
      const recorded = decodeState(envelope.payload)
      if (Option.isNone(recorded) || recorded.value.executionId !== envelope.executionId) {
        execution.coherent = false
        generic()
        continue
      }
      execution.parentId = recorded.value.lineage.parentRunId ?? undefined
      if (recorded.value.event._tag !== "Execution") {
        generic()
        continue
      }
      const { lifecycle } = recorded.value.event
      execution.result = undefined
      execution.failure = undefined
      execution.span.detail = {
        ...detail(row, envelope),
        sequence: execution.span.detail.sequence,
        input: execution.span.detail.input
      }
      if (lifecycle.state === "completed") {
        execution.span.status = lifecycle.result._tag === "Success" ? "completed" : "failed"
        execution.span.endedAt = envelope.emittedAtMs
        execution.span.detail = {
          ...execution.span.detail,
          ...(lifecycle.result._tag === "Success"
            ? { output: json(lifecycle.result.value) }
            : { message: json(lifecycle.result.detail) })
        }
        if (lifecycle.result._tag === "Success") result(lifecycle.result.value)
        else failure(lifecycle.result.reason, lifecycle.result.detail)
      } else execution.span.status = lifecycle.state === "suspended" ? "waiting" : "running"
      continue
    }
    if (envelope.eventType === "flows.engine.interrupted") {
      const cancelled = decodeCancellation(envelope.payload)
      if (Option.isNone(cancelled)) {
        generic()
        continue
      }
      execution.result = undefined
      execution.failure = undefined
      execution.span.status = "cancelled"
      execution.span.endedAt = cancelled.value.interruptedAtMs
      execution.span.detail = {
        ...detail(row, envelope),
        sequence: execution.span.detail.sequence,
        input: execution.span.detail.input
      }
      continue
    }
    if (envelope.eventType === "flows.engine.run-decision") {
      const decision = decodeDecision(envelope.payload)
      if (Option.isNone(decision)) {
        const payload = envelope.payload
        // Claim, owner-fence, wake and child-policy decisions deliberately do
        // not carry RunState. Keep them visible without losing valid state
        // evidence; malformed state-bearing decisions still refuse claims.
        if (
          typeof payload === "object" && payload !== null &&
          ("state" in payload || ("decision" in payload && stateDecisions.some((name) => name === payload.decision)))
        ) {
          execution.coherent = false
        }
        generic()
        continue
      }
      const { state, status } = decision.value
      if (execution.flowName !== undefined && execution.flowName !== state.flowName) execution.coherent = false
      execution.flowName = state.flowName
      execution.span.label = state.flowName
      parent(state.parentExecutionId)
      execution.result = undefined
      execution.failure = undefined
      execution.span.detail = {
        ...detail(row, envelope),
        sequence: execution.span.detail.sequence,
        input: state.payload
      }
      if (decision.value.decision === "created") execution.span.status = "pending"
      // RunDriver commits this decision with suspended even when its payload
      // omits status/result (a released host scope can retain no suspension).
      else if (decision.value.decision === "interrupt-released") execution.span.status = "waiting"
      else if (status === "running" || status === "pending" || status === "suspended") {
        execution.span.status = status === "suspended" ? "waiting" : status
      } else if (status !== undefined) {
        const decodedResult = decodeResult(state.result)
        if (
          Option.isSome(decodedResult) && decodedResult.value._tag === "Handoff" && status === "completed" &&
          decision.value.decision === "handed-off"
        ) {
          // A round handed off; its raw result describes the successor, not an output.
          execution.span.status = "completed"
          execution.span.endedAt = envelope.emittedAtMs
          continue
        }
        if (
          Option.isNone(decodedResult) || decodedResult.value._tag !== "Complete" ||
          (status === "completed") !== (decodedResult.value.exit._tag === "Success")
        ) {
          execution.coherent = false
          execution.span.status = "unknown"
          generic()
          continue
        }
        execution.span.status = status
        execution.span.endedAt = envelope.emittedAtMs
        execution.span.detail = {
          ...execution.span.detail,
          ...(decodedResult.value.exit._tag === "Success"
            ? { output: json(decodedResult.value.exit.value) }
            : { message: json(decodedResult.value.exit.cause) })
        }
        if (decodedResult.value.exit._tag === "Success") result(decodedResult.value.exit.value)
        else failure("cause", decodedResult.value.exit.cause)
      }
      continue
    }
    generic()
  }
  const byExecution = new Map<string, Array<Execution>>()
  for (const current of executions.values()) {
    const generations = byExecution.get(current.envelope.executionId) ?? []
    generations.push(current)
    byExecution.set(current.envelope.executionId, generations)
  }
  const roots: Array<TraceBuilder> = []
  for (const current of executions.values()) {
    const parents = current.parentId === undefined ? [] : byExecution.get(current.parentId) ?? []
    // Build only a forest. Malformed cycles remain separate evidence rows.
    const ancestors = new Set<string>([current.envelope.executionId])
    let parent = parents.length === 1 ? parents[0] : undefined
    let cursor = parent
    while (cursor !== undefined) {
      if (ancestors.has(cursor.envelope.executionId)) {
        parent = undefined
        break
      }
      ancestors.add(cursor.envelope.executionId)
      const next = cursor.parentId === undefined ? [] : byExecution.get(cursor.parentId) ?? []
      cursor = next.length === 1 ? next[0] : undefined
    }
    if (parent === undefined) roots.push(current.span)
    else parent.span.children.push(current.span)
  }
  const evidence: Array<EngineExecutionEvidence> = [...executions.values()].map((current) => ({
    executionId: current.envelope.executionId,
    generation: current.envelope.generation,
    spanId: current.span.id,
    parentExecutionId: current.parentExecutionId,
    parentKnown: current.parentKnown === true,
    flowName: current.flowName,
    input: current.span.detail.input,
    coherent: current.coherent,
    status: current.span.status,
    result: current.result,
    failure: current.failure
  }))
  return { trace: [...roots, ...notices], evidence }
}

/**
 * Folds native executions and attempts into trace spans with recorded ancestry.
 *
 * @category utilities
 * @since 1.0.0
 */
export const engineTraceFromJournal = (records: ReadonlyArray<JournalRecord>): Array<TraceBuilder> =>
  foldEngineJournal(records).trace

/**
 * Product claims use these typed facts, never text rendered into trace details.
 *
 * @category utilities
 * @since 1.0.0
 */
export const engineExecutionEvidence = (
  records: ReadonlyArray<JournalRecord>
): ReadonlyArray<EngineExecutionEvidence> => foldEngineJournal(records).evidence

/**
 * Same recorded native ancestry and historical cursor for every product result projection.
 *
 * @category utilities
 * @since 1.0.0
 */
export const engineRunEvidence = (records: ReadonlyArray<JournalRecord>, rootId: string, cursorSeq?: number) => {
  const visible: ReadonlyArray<JournalRecord> = records
    .filter((row) =>
      Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0 &&
      (cursorSeq === undefined || Number(row.sequence) <= cursorSeq)
    )
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
  const executions = engineExecutionEvidence(visible)
  const generations = new Map<string, Array<EngineExecutionEvidence>>()
  for (const execution of executions) {
    const found = generations.get(execution.executionId) ?? []
    found.push(execution)
    generations.set(execution.executionId, found)
  }
  const current = (execution: EngineExecutionEvidence) =>
    execution.coherent &&
    execution.generation === Math.max(...generations.get(execution.executionId)!.map((row) => row.generation))
  const belongs = (execution: EngineExecutionEvidence, ownerId = rootId): boolean => {
    const visited = new Set<string>()
    let candidate: EngineExecutionEvidence = execution
    while (true) {
      if (!candidate.coherent || !candidate.parentKnown || visited.has(candidate.executionId)) return false
      visited.add(candidate.executionId)
      if (candidate.executionId === ownerId) return ownerId !== rootId || candidate.parentExecutionId === undefined
      if (candidate.parentExecutionId === undefined) return false
      const parents: ReadonlyArray<EngineExecutionEvidence> = generations.get(candidate.parentExecutionId) ?? []
      // A child names a native parent ID, not its generation. Never infer a
      // parent generation from arrival time after a rewind.
      if (parents.length !== 1) return false
      candidate = parents[0]!
    }
  }
  const owned = executions.filter((row) => current(row) && belongs(row))
  const completed = owned.filter((row) => row.status === "completed" && row.result !== undefined)
  return { executions: owned, completed, belongs }
}
