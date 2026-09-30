/**
 * Defect recorded when an execution runs past its flow's declared deadline.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * An execution was still unsettled when its flow's `deadline` elapsed.
 *
 * The deadline counts from the execution's first start, which the engine
 * journals, so a resume after a restart honors the original deadline rather
 * than starting a new one. Expiry is terminal: the execution settles with this
 * defect whether it was running or parked, and its attached children are
 * cancelled with it. It is not a typed `execute` failure.
 *
 * `startedAtMs` is the journaled start and `deadlineMs` the declared bound, so
 * `startedAtMs + deadlineMs` is when the execution expired.
 *
 * @category errors
 * @since 1.0.0
 */
export class DeadlineExceeded extends Schema.TaggedError<DeadlineExceeded>()(
  "@smthrs/flow/DeadlineExceeded",
  {
    code: Schema.Literal("deadline_exceeded").pipe(
      Schema.withConstructorDefault(Effect.succeed("deadline_exceeded"))
    ),
    flowName: Schema.String,
    executionId: Schema.String,
    deadlineMs: Schema.Number,
    startedAtMs: Schema.Number,
    message: Schema.String
  }
) {}
