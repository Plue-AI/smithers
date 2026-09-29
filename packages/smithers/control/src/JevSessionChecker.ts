/**
 * Session activity judged by the host's existing evaluator.
 * @since 1.0.0
 */

import * as Fault from "@smthrs/flow/Fault"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Schema } from "effect"
import type { HealthChecker, ProbeReport } from "./Health.ts"

/** The configured judge could not produce a usable observation.
 * @category errors
 * @since 1.0.0
 */
export class JevProbeError extends Schema.TaggedError<JevProbeError>()("JevProbeError", {
  reason: Schema.Literals(["unconfigured", "http", "timeout", "unreachable", "malformed"]),
  status: Schema.optional(Schema.Number)
}) {}
Fault.register(
  "JevProbeError",
  {
    unconfigured: "policy",
    http: "dependency",
    timeout: "dependency",
    unreachable: "dependency",
    malformed: "dependency"
  } satisfies Fault.Rows<JevProbeError["reason"]>,
  "reason"
)
/** Maximum terminal evidence retained for one judgment.
 * @category constants
 * @since 1.0.0
 */
export const jevStateTailCharacters = 4 * 1024
/** Subscription judgments have a bounded deadline.
 * @category constants
 * @since 1.0.0
 */
export const jevRequestTimeoutMs = 45_000
/** Probe budget, longer than the request deadline.
 * @category constants
 * @since 1.0.0
 */
export const jevProbeTimeoutMs = 50_000
/** Minimum confidence for an activity report.
 * @category constants
 * @since 1.0.0
 */
export const jevConfidenceFloor = 0.7
/** The host evaluator and its bounded request deadline.
 * @category models
 * @since 1.0.0
 */
export interface JevSessionCheckerOptions {
  readonly evaluator?: Evaluator.Evaluator | undefined
  readonly timeoutMs?: number | undefined
}
const lifecycleReport: ProbeReport = { activity: "unknown", reason: "ok" }
const activityCriteria = {
  "working": "the agent is executing tools, editing files, or producing work",
  "idle": "the agent finished and is producing nothing",
  "needs-input": "the agent asked the person a question, requested approval or a credential, and is waiting"
} as const

const questions = {
  activity: {
    type: "choice",
    instructions: "Read the tail of this agent session's output. What is the agent doing right now?",
    criteria: activityCriteria
  },
  question: {
    type: "boolean",
    instructions: "Does the output end with the agent waiting for a person to answer?"
  }
} as const

/** Uses the same judge as flow completion, with no independent auth path.
 * @category constructors
 * @since 1.0.0
 */
export const makeJevSessionChecker = (options: JevSessionCheckerOptions = {}): HealthChecker => ({
  id: "jev.session",
  defaults: { timeoutMs: jevProbeTimeoutMs, ttlMs: 60_000 },
  probe: (context) =>
    Effect.gen(function*() {
      const session = context.session
      const tail = session?.outputTail
      if (session === undefined || !session.alive || tail === undefined || tail === "") return lifecycleReport
      if (options.evaluator === undefined) return yield* Effect.fail(new JevProbeError({ reason: "unconfigured" }))
      const result = yield* options.evaluator.evaluate({
        state: { alive: session.alive, exitCode: session.exitCode, outputTail: tail.slice(-jevStateTailCharacters) },
        questions
      }).pipe(
        Effect.mapError((error) =>
          new JevProbeError({
            reason: error.code === "timeout"
              ? "timeout"
              : error.code === "refused"
              ? "http"
              : error.code === "unreachable"
              ? "unreachable"
              : "malformed",
            ...(error.status === undefined ? {} : { status: error.status })
          })
        ),
        Effect.timeoutOrElse({
          duration: options.timeoutMs ?? jevRequestTimeoutMs,
          orElse: () => Effect.fail(new JevProbeError({ reason: "timeout" }))
        })
      )
      const answer = result.answers.activity
      if (answer?.type !== "choice" || !Object.hasOwn(activityCriteria, answer.choice)) {
        return yield* Effect.fail(new JevProbeError({ reason: "malformed" }))
      }
      const confidence = result.confidence?.activity ?? answer.probabilities?.[answer.choice] ?? 0
      if (!Number.isFinite(confidence) || confidence < jevConfidenceFloor || confidence > 1) return lifecycleReport
      const choice = answer.choice as keyof typeof activityCriteria
      return choice === "needs-input"
        ? { activity: choice, reason: "prompt-detected" }
        : { activity: choice, reason: "ok" }
    })
})
/** Registered but unconfigured until a host supplies its evaluator.
 * @category constants
 * @since 1.0.0
 */
export const jevSessionChecker: HealthChecker = makeJevSessionChecker()
