import { digest } from "@smthrs/core/Digest"
import { ControlFacts } from "@smthrs/control"
import { Schema } from "effect"
import { canonicalEventValue } from "../state/EventValue"
/*
 * A gate that asks a QUESTION rather than for a grant.
 *
 * Most approvals are a capability the run wants allowed: Approve and Deny say
 * everything there is to say. A `HumanTask` gate is different — the run is
 * stuck on something only a person knows, and a decision answers nothing. On
 * Smithers Cloud, run-3 of `coding/request` asked "which service owns the
 * retry budget?" and parked forever, because even once the gate reached the
 * inbox there was no box to type the answer into.
 *
 * `waitRunId` is the gateway's marker for such a row: the wait is held by an
 * execution somewhere in the run's tree, and `request` carries what was asked.
 */
import type { ApprovalRow } from "../state/controller/gateway"
import type { Card } from "../state/AppState"

/** The question descriptor a card carries, as the card schema states it. */
export type ApprovalQuestion = NonNullable<
  Extract<Card, { kind: "approvals-inbox" }>["payload"]["approvals"][number]["question"]
>

/** The four shapes a person can be asked for. */
export type QuestionKind = ApprovalQuestion["kind"]

const isKind = (value: unknown): value is QuestionKind =>
  value === "ask" || value === "confirm" || value === "select" || value === "json"

/**
 * The question a gate asks, or nothing when it asks for a grant.
 *
 * The kind falls back to `ask`, because a box a person types into answers any
 * question; a missing kind would otherwise leave the row with no way to answer
 * at all, which is the state that stranded run-3.
 */
export const questionOf = (row: ApprovalRow): ApprovalQuestion | undefined => {
  if (row.waitRunId === undefined) return undefined
  const request = row.request
  const fields = typeof request === "object" && request !== null && !Array.isArray(request)
    ? request as Record<string, unknown>
    : {}
  const options = fields["options"]
  const attempt = fields["attempt"]
  const maxAttempts = fields["maxAttempts"]
  const name = fields["name"]
  return {
    kind: isKind(fields["kind"]) ? fields["kind"] : "ask",
    prompt: typeof fields["prompt"] === "string" ? fields["prompt"] : row.title,
    ...(typeof name === "string" ? { name } : {}),
    ...(Array.isArray(options) && options.every((option) => typeof option === "string")
      ? { options: [...options as ReadonlyArray<string>] }
      : {}),
    ...(typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0 ? { attempt } : {}),
    ...(typeof maxAttempts === "number" && Number.isInteger(maxAttempts) && maxAttempts > 0 ? { maxAttempts } : {})
  }
}

/**
 * How much of a re-asked question's budget is left, in words.
 *
 * A `HumanTask` re-asks when it cannot accept an answer, and each attempt is
 * its own wait point. Saying which attempt this is tells the person their last
 * answer was refused without making them read a journal.
 */
export const attemptWords = (question: ApprovalQuestion): string | undefined =>
  question.attempt === undefined || question.attempt <= 1
    ? undefined
    : question.maxAttempts === undefined
    ? `Attempt ${question.attempt}`
    : `Attempt ${question.attempt} of ${question.maxAttempts}`

/** A draft belongs to one exact human wait, including re-asks with the same title. */
export const approvalQuestionKey = (row: ApprovalRow): string | undefined => {
  const question = questionOf(row)
  return question === undefined ? undefined : digest(canonicalEventValue({
    waitRunId: row.waitRunId,
    request: row.request,
    question
  }))
}

const isGuardIncident = Schema.is(ControlFacts.GuardIncident)

/**
 * The facts a budget or time guard froze on the request it parked a run on.
 * Such a gate is decided as Continue (approve, under the allowance it
 * recorded) or Stop (deny); any other gate carries none.
 */
export const guardIncidentOf = (row: Pick<ApprovalRow, "request">): typeof ControlFacts.GuardIncident.Type | undefined => {
  const incident = typeof row.request === "object" && row.request !== null && !Array.isArray(row.request)
    ? (row.request as { readonly incident?: unknown }).incident
    : undefined
  return isGuardIncident(incident) ? incident : undefined
}
