/**
 * A run's recorded history as the gateway serves it: fork a run at a frame,
 * optionally with one step's result edited, and verify what a resume under the
 * current flow code would replay.
 *
 * The gateway declares the wire shapes and the one service its `Run.Fork` and
 * `Run.Verify` handlers call. The host that owns the project's stores
 * implements it (`smthrs serve` does, over the same history library
 * `smthrs runs fork` and `smthrs runs verify` use), so the CLI, the app and the
 * terminal read one report and fork one way. A gateway composed without it
 * answers both procedures `Unavailable`.
 *
 * @since 1.0.0
 */

import { Context, type Effect, Schema } from "effect"

/**
 * One recorded step, by the key its attempts are recorded under, with the
 * action and graph node that recorded it when the record names them.
 *
 * @since 1.0.0
 * @category models
 */
export const Step = Schema.Struct({
  stepKeyDigest: Schema.String,
  action: Schema.optional(Schema.String),
  node: Schema.optional(Schema.String)
})

/**
 * One recorded step.
 *
 * @since 1.0.0
 * @category models
 */
export type Step = typeof Step.Type

/**
 * Which run to verify.
 *
 * @since 1.0.0
 * @category models
 */
export const VerifyInput = Schema.Struct({ runId: Schema.NonEmptyString })

/**
 * Which run to verify.
 *
 * @since 1.0.0
 * @category models
 */
export type VerifyInput = typeof VerifyInput.Type

/**
 * What resuming the run under the current flow code would do: the steps it
 * replays from their records, the unfinished step it re-enters, the first step
 * it would execute again, and the recorded steps it would not replay. A run is
 * `divergent` when a recorded step goes unreplayed while the resume executes.
 *
 * @since 1.0.0
 * @category models
 */
export const VerifyReport = Schema.Struct({
  runId: Schema.String,
  verdict: Schema.Literals(["consistent", "divergent"]),
  replayed: Schema.Array(Step),
  resumes: Schema.optional(Step),
  executes: Schema.optional(Step),
  notReplayed: Schema.Array(Step)
})

/**
 * What resuming the run under the current flow code would do.
 *
 * @since 1.0.0
 * @category models
 */
export type VerifyReport = typeof VerifyReport.Type

/**
 * One recorded step whose result the fork replaces with `result`.
 *
 * @since 1.0.0
 * @category models
 */
export const StepEdit = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  result: Schema.Json
})

/**
 * One recorded step whose result the fork replaces.
 *
 * @since 1.0.0
 * @category models
 */
export type StepEdit = typeof StepEdit.Type

/**
 * Where to fork a run: the exact journal sequence `at`, the lineage (the one
 * recorded at that frame when absent), and optionally one step's result
 * edited on the child.
 *
 * @since 1.0.0
 * @category models
 */
export const ForkInput = Schema.Struct({
  runId: Schema.NonEmptyString,
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lineage: Schema.optional(Schema.NonEmptyString),
  step: Schema.optional(StepEdit)
})

/**
 * Where to fork a run.
 *
 * @since 1.0.0
 * @category models
 */
export type ForkInput = typeof ForkInput.Type

/**
 * The fork: a parked child run of `parentRunId`, resumed like any parked run.
 *
 * @since 1.0.0
 * @category models
 */
export const ForkOutput = Schema.Struct({
  runId: Schema.String,
  parentRunId: Schema.String,
  status: Schema.Literal("parked")
})

/**
 * The fork.
 *
 * @since 1.0.0
 * @category models
 */
export type ForkOutput = typeof ForkOutput.Type

/**
 * The host refused the history request, with the same stable code and
 * sentence `smthrs runs fork` and `smthrs runs verify` print: an unknown run,
 * a run with no recorded history, a frame outside it, a step that cannot be
 * edited.
 *
 * @since 1.0.0
 * @category errors
 */
export class HistoryRefused extends Schema.TaggedError<HistoryRefused>()("@smthrs/gateway/HistoryRefused", {
  code: Schema.String,
  message: Schema.String
}) {}

/**
 * Fork and verify over the project's recorded history.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly fork: (input: ForkInput) => Effect.Effect<ForkOutput, HistoryRefused>
  readonly verify: (input: VerifyInput) => Effect.Effect<VerifyReport, HistoryRefused>
}

/**
 * The project's history, as the host that owns its stores serves it.
 *
 * @since 1.0.0
 * @category services
 */
export class RunHistory extends Context.Service<RunHistory, Service>()("@smthrs/gateway/RunHistory") {}
