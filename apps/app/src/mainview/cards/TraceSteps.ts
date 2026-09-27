/*
 * The run as steps: one row per recorded span that did something —
 * `time · type · description · duration · tokens`.
 *
 * Every field is read off the trace model the run card already folds; the
 * description is the same verb and subject the frame lines print
 * (`callSemantics` / `callSubject`), so a step never says something the run's
 * own narrative does not. Frames and cells are the containers the journal
 * records around calls, so they are not steps; a frame that called nothing
 * has no step, the way it has no line. Bare journal events (a printed line)
 * stay in the Details view.
 */
import { callSemantics, callSubject, type TraceModel, type TraceSpan } from "./RunTrace"

/** The type word a step wears: a call's recorded activity, else its span kind. */
export type StepType = "model" | "read" | "write" | "check" | "test" | "call" | "approval" | "execution" | "attempt" | "resolved"

export interface TraceStep {
  readonly id: string
  readonly at: number
  readonly type: StepType
  readonly description: string
  /** Absent while the span is open and the run has no later record. */
  readonly durationMs?: number | undefined
  /** Input plus output tokens, when the record carried usage. */
  readonly tokens?: number | undefined
  readonly status: string
  readonly span: TraceSpan
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const ACTIVITY_TYPE: Readonly<Record<string, StepType>> = { reads: "read", writes: "write", checks: "check", tests: "test" }

const capital = (words: string): string => words === "" ? words : `${words.charAt(0).toUpperCase()}${words.slice(1)}`

/** The call's verb and subject, in the words its declaration chose. */
const callStep = (span: TraceSpan): { readonly type: StepType; readonly description: string } => {
  const payload = { ...(span.detail.fields ?? {}), input: span.detail.input }
  const semantics = callSemantics(span.label, payload)
  const outcome = span.status === "failed" || span.status === "denied" ? "failure" : span.endedAt === undefined ? "pending" : "success"
  // A flow without a presentation is named, not described: its own name, as
  // written, with no capital it never had.
  const verb = semantics.presentation?.verb[outcome] !== undefined ? capital(semantics.presentation.verb[outcome])
    : outcome === "pending" ? `Running ${span.label}` : outcome === "failure" ? `Failed ${span.label}` : span.label
  const subject = callSubject(span.detail.input, semantics.presentation?.subject)
  return {
    type: semantics.activity === undefined ? "call" : ACTIVITY_TYPE[semantics.activity] ?? "call",
    description: `${verb}${subject === "" ? "" : ` ${subject}`}`
  }
}

/** The steps of a run, in journal order. */
export const traceSteps = (model: TraceModel): ReadonlyArray<TraceStep> =>
  model.rows.flatMap((span): ReadonlyArray<TraceStep> => {
    // Frames and cells contain steps; a bare journal event (a printed line, a
    // steering note) is evidence under a step, not a step of its own.
    if (span.kind === "run" || span.kind === "frame" || span.kind === "cell" || span.kind === "fork" || span.kind === "event") return []
    const end = span.endedAt ?? (span.status === "running" || span.status === "waiting" ? model.extent.end : undefined)
    const durationMs = end === undefined ? undefined : Math.max(end - span.startedAt, 0)
    const usage = span.detail.usage
    const tokens = usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)
      ? undefined
      : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    const named = span.kind === "call" ? callStep(span)
      : span.kind === "model" ? { type: "model" as const, description: span.detail.seat === undefined ? "Model turn" : `Model turn · ${span.detail.seat}` }
      : { type: span.kind as StepType, description: span.label }
    return [{ id: span.id, at: span.startedAt, ...named, durationMs, tokens, status: span.status, span }]
  })

/** Tokens in the mono column: `812`, `2.1k`, `1.3M`. */
export const tokenWords = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}k`
    : String(tokens)

/** The sum of every step's recorded tokens; undefined when none recorded any. */
export const totalTokens = (steps: ReadonlyArray<TraceStep>): number | undefined => {
  let total: number | undefined
  for (const step of steps) if (step.tokens !== undefined) total = (total ?? 0) + step.tokens
  return total
}

/** What the record says about the span's payload, for a type word the fold did not name. */
export const stepRecordKind = (step: TraceStep): string | undefined => record(step.span.detail.fields).eventType as string | undefined
