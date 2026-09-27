/**
 * Non-blocking and blocking scorer runner contract.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Text from "./internal/text.ts"
import type { Result as ScorerResult } from "./Scorer.ts"
import { ScorerError } from "./ScorerError.ts"
import { maxReasonBytes, type Observation, type ObservationBase } from "./ScoreStore.ts"

/**
 * One scorer execution request.
 *
 * `submit` copies scalar fields and observation keys synchronously when called,
 * before its returned Effect is run. Only the score Effect and its captured
 * values stay shared. Batch methods snapshot each job when its execution starts,
 * so batch inputs must remain stable until then.
 *
 * `identity` is the durable idempotency key: build it with {@link jobIdentity}
 * rather than by joining strings, so two different tuples cannot produce one
 * identity. It must also be
 * stable across a restart, or the retry after a crash records a second
 * observation for work that already happened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Job {
  readonly identity: string
  readonly observation: Pick<ObservationBase, "targetStepKey" | "scorerKey">
  readonly score: Effect.Effect<ScorerResult, unknown>
  readonly at: number
}

/**
 * Batch execution options.
 *
 * @category models
 * @since 0.1.0
 */
export interface BatchOptions {
  readonly concurrency?: number | undefined
}

/**
 * Whether a batch job's observation reached the durable store.
 *
 * @category models
 * @since 0.1.0
 */
export type Recorded = "persisted" | "duplicate" | "failed"

/**
 * One batch result tagged with the job it came from and what the store did with it.
 *
 * The method is named `runBatchCorrelated` because `@smthrs/evals` already
 * declares that optional method on its structural `ScoreBatchRunner` in
 * `packages/smithers/agent/evals/src/Runner.ts`. Its results carry job identities, so this
 * service lets that consumer correlate by identity instead of by position
 * without a change in `@smthrs/evals`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Outcome {
  readonly identity: string
  readonly observation: Observation
  readonly recorded: Recorded
}

/**
 * Runtime scorer runner implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly submit: (job: Job) => Effect.Effect<void>
  readonly runBatch: (
    jobs: ReadonlyArray<Job>,
    options?: BatchOptions | undefined
  ) => Effect.Effect<ReadonlyArray<Observation>>
  readonly runBatchCorrelated: (
    jobs: ReadonlyArray<Job>,
    options?: BatchOptions | undefined
  ) => Effect.Effect<ReadonlyArray<Outcome>>
}

/**
 * Context service for live and batch scorer execution.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, Service>()("flows/scorers/Runner") {}

/**
 * Constructs an inoperative scorer runner.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  Runner.of({
    submit: () => Effect.void,
    runBatch: () => Effect.succeed([]),
    runBatchCorrelated: () => Effect.succeed([])
  })

/**
 * Provides the inoperative scorer runner.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Runner> = Layer.succeed(Runner)(makeNoop())

/**
 * Builds a {@link Job.identity} from its components.
 *
 * Each component is length-prefixed, so no choice of separator inside a
 * component can make two different tuples collide. Joining components with a
 * delimiter cannot promise that: the only consumer of this package built its
 * identity by `NUL`-joining five unconstrained strings.
 *
 * @category constructors
 * @since 0.1.0
 */
export const jobIdentity = (parts: ReadonlyArray<string>): string =>
  `v1${parts.map((part) => `:${part.length}:${part}`).join("")}`

interface Failure {
  readonly code: ScorerError["code"]
  readonly text: string
}

const failureOf = (cause: unknown): Failure => {
  try {
    const squashed = Cause.isCause(cause) ? Cause.squash(cause) : cause
    return {
      code: squashed instanceof ScorerError ? squashed.code : "inconclusive",
      text: String(squashed)
    }
  } catch {
    return { code: "inconclusive", text: "<uncoercible cause>" }
  }
}

/**
 * Converts a scorer failure into a typed inconclusive observation.
 *
 * The reason names the cause. It is the only prose field that reaches a
 * report, so a fixed sentence made a scorer that threw a `TypeError`, which is
 * a bug to fix, indistinguishable from an unreachable judge, which is an outage
 * to wait out. Three bounds keep naming it safe:
 *
 * - `code` carries the classification, so the distinction survives without
 *   parsing prose.
 * - Coercion is guarded. A cause whose `toString` or `Symbol.toPrimitive`
 *   throws used to raise synchronously inside the runner's `catchCause`
 *   handler and escape as a defect, killing the batch this function exists to
 *   keep alive.
 * - The reason is truncated to `maxReasonBytes`, because the squashed cause is
 *   an arbitrary host-formatted string that can carry a whole response body.
 *
 * @category converting
 * @since 0.1.0
 */
export const inconclusive = (job: Job, cause: unknown): Observation => {
  const failure = failureOf(cause)
  return {
    targetStepKey: job.observation.targetStepKey,
    scorerKey: job.observation.scorerKey,
    kind: "inconclusive",
    code: failure.code,
    reason: Text.truncate(`Scorer execution was inconclusive: ${failure.text}`, maxReasonBytes),
    at: job.at
  }
}
