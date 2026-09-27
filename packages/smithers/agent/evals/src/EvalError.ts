/**
 * The typed failures evaluation raises, with the stable codes a gate or a
 * report branches on.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable evaluation failure codes.
 *
 * Each code names one thing a caller can do about it, so a gate that branches
 * on the code routes the failure to the right owner:
 *
 * - `invalid_suite`: the suite declaration is wrong. Fix the suite.
 * - `invalid_run_options`: `Runner.run`'s own options are wrong, not the suite.
 * - `invalid_baseline`: the committed baseline is unreadable, belongs to
 *   another suite, or holds a record the schema rejects. Regenerate it.
 * - `invalid_tolerance`: the caller passed a tolerance that is not a finite
 *   non-negative number. Fix the call, not the baseline.
 * - `invalid_trials`: the caller passed run, pass, or `k` counts to `Trials`
 *   outside their bounds. Fix the call.
 * - `executor`: the target flow failed for a case.
 * - `ambiguous_score_job`: two score jobs shared a step key and a scorer, so
 *   an order-only batch runner's results cannot be attributed to a case. Give
 *   each case its own step key, or use a runner that implements
 *   `runBatchCorrelated`.
 * - `scorer_protocol`: a batch runner broke the `runBatch` contract by returning
 *   the wrong number of observations, or observations that identify jobs other
 *   than the ones it was given. Nothing it returned can be trusted.
 * - `scorer_unavailable`: no batch runner was available to score with.
 *
 * @category models
 * @since 0.1.0
 */
export const EvalErrorCode = Schema.Literals([
  "invalid_suite",
  "invalid_run_options",
  "invalid_baseline",
  "invalid_tolerance",
  "invalid_trials",
  "executor",
  "ambiguous_score_job",
  "scorer_protocol",
  "scorer_unavailable"
])

/**
 * Stable evaluation failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type EvalErrorCode = typeof EvalErrorCode.Type

/**
 * A typed failure raised while loading or executing an evaluation.
 *
 * `code` is the stable branch point, `message` is the sentence a CI log shows,
 * and `path` locates the offending value inside the input the caller supplied
 * (`records[3].score`, `cases[1].input`, `options.at`). `cause` retains the
 * original failure; it is never rendered on its own, so a message that matters
 * to an operator has to say so itself.
 *
 * @category errors
 * @since 0.1.0
 */
export class EvalError extends Schema.TaggedError<EvalError>()("flows/evals/EvalError", {
  code: EvalErrorCode,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}) {}
