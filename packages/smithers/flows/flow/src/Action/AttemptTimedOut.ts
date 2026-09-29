/**
 * Defines the defect an action attempt settles with when it outlives its
 * declared `attemptTimeoutMs` or misses its `heartbeatTimeoutMs`.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * One attempt of an action ran past a declared time bound and was
 * interrupted.
 *
 * It is a defect rather than a typed failure because the bound belongs to the
 * dispatch, not to the action's declared error channel. The engine's retry
 * decision point still counts it as a retryable attempt failure under the
 * action's `retryPolicy`, and a policy can refuse it by listing this tag in
 * `nonRetryable`.
 *
 * @category errors
 * @since 1.0.0
 */
export class AttemptTimedOut extends Schema.TaggedError<AttemptTimedOut>()(
  "@smthrs/flow/AttemptTimedOut",
  {
    code: Schema.Literal("attempt_timed_out").pipe(
      Schema.withConstructorDefault(Effect.succeed("attempt_timed_out"))
    ),
    actionName: Schema.String,
    attempt: Schema.Number,
    /** Which bound expired: the whole attempt, or the gap between heartbeats. */
    bound: Schema.Literals(["attempt", "heartbeat"]),
    timeoutMs: Schema.Number,
    message: Schema.String
  }
) {}

