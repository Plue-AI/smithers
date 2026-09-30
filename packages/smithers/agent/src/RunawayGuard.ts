/**
 * The facts a guard parks a run on, and the failure Stop settles it with.
 *
 * Two kinds of guard park a run for an operator's Continue or Stop. A
 * {@link module:Budget.BudgetExceeded} is a `Runaway` run: it would spend past
 * an approved token or latency ceiling. A {@link Timeout} is a `Stuck` run:
 * one model call, tool call, or cell ran past its time limit. Both park
 * through {@link module:Budget.Parking}, on one control approval request whose
 * {@link incident} facts are frozen when the guard trips, so a restarted host
 * presents and decides the incident it was made on instead of measuring it
 * again. Approve is Continue with the recorded allowance; deny is Stop.
 *
 * @since 1.0.0-rc.1
 */

import type { ControlFacts } from "@smthrs/control"
import * as Fault from "@smthrs/flow/Fault"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Schema from "effect/Schema"
import type * as Budget from "./Budget.ts"

/**
 * The operation a {@link Timeout} interrupted: a model call past its call
 * limit, a tool call past its call limit (including a command's own timeout
 * and a child await still running), or a cell past its wall-clock limit.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const TimeoutSource = Schema.Literals(["model-call", "tool-call", "cell"])

/**
 * One operation that ran past its time limit.
 *
 * `subject` is the operation's replay-stable identity, so Continue and Stop
 * answer the same operation on every re-drive. `limitMillis` is absent when
 * the operation reported its own timeout without saying its limit.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class Timeout extends Schema.TaggedError<Timeout>()("flows/agent/Timeout", {
  source: TimeoutSource,
  subject: Schema.String,
  limitMillis: Schema.optional(Schema.Number),
  message: Schema.String
}) {}
// A time limit is a cap, like a latency budget: policy.
Fault.register("flows/agent/Timeout", "policy")

/**
 * The decoded form of {@link ControlFacts.GuardIncident}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Incident = typeof ControlFacts.GuardIncident.Type

/**
 * The facts one tripped guard parks its run on. `allowance` is what Continue
 * authorizes: for a budget, the raised ceiling `raised` proposes; for a
 * timeout, one more run of the operation under its limit.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const incident = (tripped: Budget.BudgetExceeded | Timeout, raised?: number): Incident =>
  tripped._tag === "flows/agent/Timeout"
    ? {
      classification: "Stuck",
      source: tripped.source,
      message: tripped.message,
      subject: tripped.subject,
      ...(tripped.limitMillis === undefined ? {} : { max: tripped.limitMillis, allowance: tripped.limitMillis })
    }
    : {
      classification: "Runaway",
      // A daily cap and a USD ceiling never park; if one is folded in, it reads as tokens.
      source: tripped.scope === "latency" ? "latency" : "tokens",
      message: tripped.message,
      used: tripped.used,
      ...(tripped.reserved === undefined ? {} : { reserved: tripped.reserved }),
      max: tripped.max,
      next: tripped.next,
      ...(raised === undefined ? {} : { allowance: raised })
    }

/**
 * The failure a Stop settles a parked run with: the incident it stopped, as a
 * model failure the run cannot retry past.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const stopped = (facts: Incident): HarnessError.HarnessError =>
  new HarnessError.HarnessError({
    code: "model_failed",
    message: `Stopped by the operator: ${facts.message}`,
    cause: { _tag: stoppedTag, ...facts }
  })

/**
 * The tag a Stop's cause carries, so the run's fault reads as a person's
 * stop rather than as the model wrapper around it.
 *
 * @category constants
 * @since 1.0.0
 */
export const stoppedTag = "flows/agent/RunawayGuard/Stopped"
// A person stopped it: nothing retries, replans or backs up past that.
Fault.register(stoppedTag, "policy")
