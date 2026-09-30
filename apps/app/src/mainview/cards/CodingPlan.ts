import { Cause, Option, Schema } from "effect"
import * as Digest from "@smthrs/core/Digest"
import { CorrectionResult, Plan, RequestResult, validatePlan } from "../../../../../flows/coding/schema.ts"
import { EarlyFeedback } from "../../../../../flows/coding/feedback-schema.ts"
import type { Card } from "../state/AppState"
import { engineRunEvidence, type EngineExecutionEvidence } from "./EngineTrace"

/** The repository recipe owns this contract; the UI does not maintain a second plan schema. */
const planOf = (value: unknown): Plan | undefined => {
  const decoded = Schema.decodeUnknownOption(Plan)(value)
  if (Option.isNone(decoded)) return undefined
  try {
    validatePlan(decoded.value)
    return decoded.value
  } catch {
    return undefined
  }
}

const decodeCorrection = Schema.decodeUnknownOption(CorrectionResult)
const decodeRequest = Schema.decodeUnknownOption(RequestResult)
const decodeFeedback = Schema.decodeUnknownOption(EarlyFeedback)
const decodeCause = Schema.decodeUnknownOption(Schema.toCodecJson(Schema.Cause(Schema.Unknown, Schema.Defect())))
const feedbackOf = (failure: EngineExecutionEvidence["failure"]): EarlyFeedback | undefined => {
  if (failure === undefined) return undefined
  let value: unknown
  if (failure.kind === "error") value = failure.value
  else if (failure.kind === "cause") {
    const cause = decodeCause(failure.value)
    if (Option.isNone(cause) || cause.value.reasons.length !== 1) return undefined
    const reason = cause.value.reasons[0]!
    if (!Cause.isFailReason(reason)) return undefined
    value = reason.error
  } else return undefined
  const decoded = decodeFeedback(value)
  return Option.isSome(decoded) && decoded.value.result.status === "changes-requested" && decoded.value.result.findings.length > 0
    ? decoded.value : undefined
}
const correctionOf = (value: unknown): typeof CorrectionResult.Type | undefined => {
  const decoded = decodeCorrection(value)
  if (Option.isNone(decoded)) return undefined
  const result = decoded.value
  if (result.rounds < 1) return undefined
  if (result.status === "blocked") return result.blocked?.executionId ? result : undefined
  return result.blocked === null && result.result?.status === result.status ? result : undefined
}

/** Derived projection only. The journal and persisted cursor remain the authority. */
export interface CodingEvidence {
  readonly plan?: Plan
  readonly outcome?: typeof CorrectionResult.Type
  readonly blockedSpanId?: string
  readonly reviewFeedback?: { readonly result: EarlyFeedback["result"]; readonly spanId: string }
}

export const codingEvidenceOf = (card: Extract<Card, { kind: "run-trace" }>): CodingEvidence => {
  const manual = planOf(card.payload.input?.plan)
  const { executions, completed, belongs } = engineRunEvidence(card.payload.events ?? [], card.payload.runId, card.payload.cursorSeq)
  const plans = completed.flatMap((execution) => {
    const request = execution.flowName === "coding/Request" ? decodeRequest(execution.result!.value) : Option.none()
    const plan = execution.flowName === "coding/PreparePlan" || execution.flowName === "coding/PrepareWithWiki"
      ? planOf(execution.result!.value)
      : Option.isSome(request) ? planOf(request.value.plan) : undefined
    return plan === undefined ? [] : [{ plan, sequence: execution.result!.sequence }]
  }).sort((left, right) => right.sequence - left.sequence)
  const newest = plans[0]
  const plan = newest === undefined ? manual : plans[1]?.sequence === newest.sequence ? undefined : newest.plan
  if (plan === undefined) return {}
  const planKey = Digest.canonical(plan)
  const outcomes = completed.flatMap((execution) => {
    const request = execution.flowName === "coding/Request" ? decodeRequest(execution.result!.value) : Option.none()
    const sourcePlan = Option.isSome(request) ? planOf(request.value.plan)
      : execution.flowName === "coding/CorrectPlan" && typeof execution.input === "object" && execution.input !== null
      ? planOf((execution.input as { readonly plan?: unknown }).plan) : undefined
    const outcome = Option.isSome(request) ? correctionOf(request.value.outcome)
      : execution.flowName === "coding/CorrectPlan" ? correctionOf(execution.result!.value) : undefined
    return sourcePlan === undefined || outcome === undefined || Digest.canonical(sourcePlan) !== planKey ||
        execution.result!.sequence < (newest?.sequence ?? 0)
      ? [] : [{ execution, outcome, sequence: execution.result!.sequence }]
  }).sort((left, right) => right.sequence - left.sequence)
  const latest = outcomes[0]
  if (latest === undefined) {
    const matchesPlan = (execution: EngineExecutionEvidence) => {
      const input = execution.input
      const source = typeof input === "object" && input !== null ? planOf((input as { readonly plan?: unknown }).plan) : undefined
      return source !== undefined && Digest.canonical(source) === planKey
    }
    const active = executions.filter(execution => execution.flowName === "coding/CorrectPlan" &&
      ["pending", "running", "waiting"].includes(execution.status) && matchesPlan(execution))
    const feedback = executions.flatMap(execution => {
      if (execution.status !== "failed" || (execution.flowName !== "coding/ObservePlan" && execution.flowName !== "coding/RepairPass") ||
          execution.failure === undefined || execution.failure.sequence < (newest?.sequence ?? 0) ||
          !matchesPlan(execution) ||
          active.filter(owner => belongs(execution, owner.executionId)).length !== 1) return []
      const early = feedbackOf(execution.failure)
      return early === undefined || early.result.changes.length !== plan.changes.length ||
        early.result.changes.some((group, index) => group.implementation.change !== plan.changes[index]!.id) ||
        early.result.findings.some(finding => !plan.changes.some(change => change.id === finding.owner))
        ? [] : [{ result: early.result, spanId: execution.spanId, sequence: execution.failure.sequence }]
    }).sort((left, right) => right.sequence - left.sequence)
    const newestFeedback = feedback[0]
    return newestFeedback === undefined || feedback[1]?.sequence === newestFeedback.sequence ? { plan }
      : { plan, reviewFeedback: { result: newestFeedback.result, spanId: newestFeedback.spanId } }
  }
  if (outcomes[1]?.sequence === latest.sequence) return { plan }
  const failed = latest.outcome.blocked === null ? [] : executions.filter((execution) =>
    execution.executionId === latest.outcome.blocked!.executionId &&
    execution.status === "failed" && belongs(execution, latest.execution.executionId))
  return { plan, outcome: latest.outcome, ...(failed.length === 1 ? { blockedSpanId: failed[0]!.spanId } : {}) }
}

export const codingPlanOf = (card: Extract<Card, { kind: "run-trace" }>): Plan | undefined => codingEvidenceOf(card).plan
