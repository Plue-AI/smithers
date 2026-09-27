/*
 * The registration app's reading of its run (docs/mvp/REGISTRATION.md): the
 * typed step results the `register-repository` flow journaled, the outcome,
 * and the one status word the card and the sidebar row show. Pure: every
 * value is folded from the run card's journal up to its cursor, so a replay
 * of a recorded run shows exactly what the run recorded.
 */
import { Option, Schema } from "effect"
import {
  AgentShare,
  Checks,
  CiEstimate,
  Cleanup,
  Clone,
  Commits,
  Contributors,
  Intake,
  Languages,
  License,
  Outcome,
  Readiness,
  Theme,
  Unavailable,
  Workflows
} from "../../../../../flows/register-repository/schema"
import { canonicalRepo } from "../../../../../flows/register-repository/link"
import type { Card } from "../state/AppState"
import { projectRuntimeCard, type RuntimeRun } from "../state/RuntimeProjection"
import { engineRunEvidence } from "./EngineTrace"

export { canonicalRepo }
export const REGISTER_FLOW = "register-repository"

type RunCard = Extract<Card, { kind: "run-trace" }>
type RegistrationCard = Extract<Card, { kind: "registration" }>

const StepResult = Schema.Union([
  Clone, Theme, License, Checks, Readiness, Cleanup, AgentShare, Commits, Contributors, Intake, Workflows, CiEstimate,
  Languages, Unavailable
])
type StepResult = typeof StepResult.Type
const decodeStep = Schema.decodeUnknownOption(StepResult)
const decodeOutcome = Schema.decodeUnknownOption(Outcome)

/** Every step result the run recorded, keyed by its tag (an unavailable one by its step), in record order. */
export interface Report {
  readonly clone?: typeof Clone.Type
  readonly theme?: typeof Theme.Type
  readonly license?: typeof License.Type
  readonly checks?: typeof Checks.Type
  readonly readiness?: typeof Readiness.Type
  readonly cleanup?: typeof Cleanup.Type
  readonly "agent-share"?: typeof AgentShare.Type
  readonly commits?: typeof Commits.Type
  readonly contributors?: typeof Contributors.Type
  readonly intake?: typeof Intake.Type
  readonly workflows?: typeof Workflows.Type
  readonly ci?: typeof CiEstimate.Type
  readonly languages?: typeof Languages.Type
  /** Steps that answered `unavailable`: known, and hidden. */
  readonly unavailable: ReadonlyArray<string>
  /** The journal sequence of each recorded result, for the replay cursor. */
  readonly sequences: ReadonlyArray<number>
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * The step results the engine recorded at or before `cursor` (the whole run when undefined). Each
 * settled step journals a bounded preview of its value; an untruncated preview is the value itself.
 * A finished run's outcome carries the whole report, which then wins.
 */
export const reportOf = (card: RunCard, cursor?: number): Report => {
  const found: Record<string, StepResult> = {}
  const unavailable: Array<string> = []
  const sequences: Array<number> = []
  const record = (value: StepResult, sequence: number) => {
    const key = value._tag === "unavailable" ? value.step : value._tag
    if (key in found || unavailable.includes(key)) return
    if (value._tag === "unavailable") unavailable.push(key)
    else found[key] = value
    sequences.push(sequence)
  }
  for (const row of card.payload.events ?? []) {
    if (cursor !== undefined && Number(row.sequence) > cursor) continue
    const envelope = object(row.payload)
    if (row.kind !== "control.engine.event" || envelope.eventType !== "flows.engine.node-settled") continue
    const settled = object(envelope.payload), result = object(settled.result)
    if (typeof settled.action !== "string" || !settled.action.startsWith(`${REGISTER_FLOW}/`)) continue
    if (result.truncated !== false || typeof result.preview !== "string") continue
    try {
      const value = decodeStep(JSON.parse(result.preview))
      if (Option.isSome(value)) record(value.value, Number(row.sequence))
    } catch {
      continue
    }
  }
  const outcome = cursor === undefined ? outcomeOf(card) : undefined
  if (outcome !== undefined) {
    const { repo: _repo, ...steps } = outcome.report
    for (const value of Object.values(steps)) record(value as StepResult, Number.MAX_SAFE_INTEGER)
  }
  return { ...(found as Omit<Report, "unavailable" | "sequences">), unavailable, sequences }
}

/** The finished run's outcome: the report, the review and setup. */
export const outcomeOf = (card: RunCard): typeof Outcome.Type | undefined => {
  const { completed } = engineRunEvidence(card.payload.events ?? [], card.payload.runId, card.payload.cursorSeq)
  for (const execution of [...completed].reverse()) {
    if (execution.flowName !== REGISTER_FLOW || execution.result === undefined) continue
    const outcome = decodeOutcome(execution.result.value)
    if (Option.isSome(outcome)) return outcome.value
  }
  return undefined
}

export type RegistrationStatus = "Analyzing" | "In review" | "Setting up" | "Ready" | "Declined" | "Failed"

/** The newest run of the registration flow for one canonical repository, with its observed journal. */
export const registrationRun = (cards: Iterable<Card>, repo: string, runs: ReadonlyArray<RuntimeRun>): RunCard | undefined => {
  let newest: RunCard | undefined
  for (const card of cards) {
    if (card.kind !== "run-trace" || card.payload.workflow !== REGISTER_FLOW) continue
    const link = (card.payload.input as { link?: unknown } | undefined)?.link
    if (typeof link !== "string" || canonicalRepo(link) !== repo) continue
    if (newest === undefined || card.createdAt > newest.createdAt) newest = card
  }
  if (newest === undefined) return undefined
  const projected = projectRuntimeCard(newest, runs, [])
  return projected.kind === "run-trace" ? projected : newest
}

/** Whether approval has started the setup child flow. */
const setupStarted = (run: RunCard): boolean =>
  engineRunEvidence(run.payload.events ?? [], run.payload.runId, run.payload.cursorSeq).executions
    .some((execution) => execution.flowName === `${REGISTER_FLOW}/setup`)

/** One status word. A run recorded before this attempt started belongs to an earlier attempt. */
export const statusOf = (registration: RegistrationCard, run: RunCard | undefined): RegistrationStatus => {
  if (registration.payload.phase === "failed") return "Failed"
  if (run === undefined || run.createdAt < registration.payload.startedAt) return "Analyzing"
  switch (run.payload.phase) {
    case "completed": {
      const outcome = outcomeOf(run)
      return outcome === undefined ? "Failed" : outcome.review.decision === "approve" ? "Ready" : "Declined"
    }
    case "failed":
    case "cancelled":
    case "no-capacity":
      return "Failed"
    default:
      return setupStarted(run) ? "Setting up" : run.payload.phase === "waiting-approval" ? "In review" : "Analyzing"
  }
}

/** Unfinished registrations hold the one-at-a-time slot. */
export const unfinished = (status: RegistrationStatus): boolean =>
  status === "Analyzing" || status === "In review" || status === "Setting up"
