/**
 * Durable score observation service.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ScorerError, ScorerErrorCode } from "./ScorerError.ts"

/**
 * Maximum stored size of an observation `reason`, in UTF-8 bytes.
 *
 * A judge that fails with a model response body or a stack-laden host error
 * would otherwise write the whole payload, secrets included, into an unbounded
 * `TEXT` column. Producers inside this package truncate to this bound;
 * `record` and `recordOnce` reject anything longer so a direct caller is told
 * rather than silently trimmed.
 *
 * The bound limits size and does not remove a credential: a bearer token or a
 * URL with embedded credentials fits inside a kilobyte. `SqlScoreStore`
 * therefore scrubs every stored `reason` and `meta` with the journal's
 * redaction rules before the insert.
 *
 * @category models
 * @since 0.1.0
 */
export const maxReasonBytes = 1_024

/**
 * Maximum stored size of an observation `meta`, encoded, in UTF-8 bytes.
 *
 * @category models
 * @since 0.1.0
 */
export const maxMetadataBytes = 65_536

/**
 * Maximum size of a `recordOnce` job identity, in UTF-8 bytes.
 *
 * @category models
 * @since 0.1.0
 */
export const maxIdentityBytes = 512

/**
 * Largest page {@link Service.observations} will return, and its default.
 *
 * @category models
 * @since 0.1.0
 */
export const maxObservations = 1_000

/**
 * Fields shared by successful and inconclusive observations.
 *
 * @category models
 * @since 0.1.0
 */
export interface ObservationBase {
  readonly targetStepKey: string
  readonly scorerKey: string
  readonly at: number
}

/**
 * A successful score retained by the store.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScoreObservation extends ObservationBase {
  readonly kind: "score"
  readonly score: number
  readonly reason?: string | undefined
  readonly meta?: unknown
}

/**
 * A scorer failure retained without failing its target.
 *
 * `code` classifies the failure so a scorer bug and an unreachable judge are
 * distinguishable without parsing `reason` prose. Migration 0004 backfills
 * rows written before the classification existed as `inconclusive`, so every
 * value read or written through the service carries a code.
 *
 * @category models
 * @since 0.1.0
 */
export interface InconclusiveObservation extends ObservationBase {
  readonly kind: "inconclusive"
  readonly reason: string
  readonly code: ScorerErrorCode
}

/**
 * Durable scorer observation.
 *
 * @category models
 * @since 0.1.0
 */
export type Observation = ScoreObservation | InconclusiveObservation

const Timestamp = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Key = Schema.String.check(Schema.isMinLength(1))

/**
 * Runtime contract every persisted observation is decoded against.
 *
 * The store used to persist whatever it was handed. An inconclusive
 * observation with no reason then wrote a `NULL` the read path rejects, so one
 * accepted write made every later `observations()` call for that target fail,
 * and a non-integral `at` round-tripped through SQLite's REAL affinity.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Observation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("score"),
    targetStepKey: Key,
    scorerKey: Key,
    score: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    reason: Schema.optional(Schema.String),
    meta: Schema.optionalKey(Schema.Unknown),
    at: Timestamp
  }),
  Schema.Struct({
    kind: Schema.Literal("inconclusive"),
    targetStepKey: Key,
    scorerKey: Key,
    reason: Schema.String.check(Schema.isMinLength(1)),
    code: ScorerErrorCode,
    at: Timestamp
  })
])

/**
 * Aggregate over one target's observations.
 *
 * `count`, `mean`, and `min` describe successful scores only, and
 * `inconclusive` is the denominator that was missing: a target scored a hundred
 * times where ninety-nine attempts were inconclusive and one returned `1.0`
 * used to report exactly what a target scored once, cleanly, reports.
 * `mean` and `min` are `undefined` when `count` is zero.
 *
 * @category models
 * @since 0.1.0
 */
export interface Aggregate {
  readonly count: number
  readonly mean: number | undefined
  readonly min: number | undefined
  readonly inconclusive: number
}

/**
 * Page bounds for {@link Service.observations}.
 *
 * `offset` is the cursor for walking the store's total `(at, insertion)`
 * order. `before` is only a time filter and cannot advance through rows that
 * share one timestamp.
 *
 * @category models
 * @since 0.1.0
 */
export interface Page {
  /** At most {@link maxObservations} rows; defaults to that bound. */
  readonly limit?: number | undefined
  /** Only observations recorded strictly before this `at` timestamp. */
  readonly before?: number | undefined
  /** Number of rows to skip in the total observation order; defaults to zero. */
  readonly offset?: number | undefined
}

/**
 * Durable score store implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly record: (observation: Observation) => Effect.Effect<void, ScorerError>
  readonly recordOnce: (
    identity: string,
    observation: Observation
  ) => Effect.Effect<boolean, ScorerError>
  readonly observations: (
    targetStepKey: string,
    scorerKey?: string | undefined,
    page?: Page | undefined
  ) => Effect.Effect<ReadonlyArray<Observation>, ScorerError>
  readonly aggregate: (
    targetStepKey: string,
    scorerKey?: string | undefined
  ) => Effect.Effect<Aggregate | undefined, ScorerError>
  /**
   * Deletes observations whose `at` and job claims whose creation time are
   * older than `olderThan`, answering how many of each it removed. Nothing
   * else deletes from the store, so a host that never calls this keeps every
   * observation and claim forever. A pruned claim no longer suppresses a
   * duplicate, so prune only past the oldest job a host may still replay.
   * A cutoff that is not a safe integer is refused with `invalid_request`.
   */
  readonly prune: (options: { readonly olderThan: number }) => Effect.Effect<Pruned, ScorerError>
}

/**
 * How many rows one {@link Service.prune} call removed from each table.
 *
 * @category models
 * @since 0.1.0
 */
export interface Pruned {
  readonly observations: number
  readonly jobs: number
}

/**
 * Context service for durable scorer observations.
 *
 * @category services
 * @since 0.1.0
 */
export class ScoreStore extends Context.Service<ScoreStore, Service>()("flows/scorers/ScoreStore") {}

/**
 * Constructs an inoperative score store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  ScoreStore.of({
    record: () => Effect.void,
    recordOnce: () => Effect.succeed(true),
    observations: () => Effect.succeed([]),
    aggregate: () => Effect.succeed(undefined),
    prune: () => Effect.succeed({ observations: 0, jobs: 0 })
  })

/**
 * Provides the inoperative score store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<ScoreStore> = Layer.succeed(ScoreStore)(makeNoop())

const decodeObservation = Schema.decodeUnknownEffect(Observation)

const observationLabel = (observation: Observation): string => {
  try {
    const kind = String(observation.kind)
    return `${kind === "inconclusive" ? "An" : "A"} ${kind} observation`
  } catch {
    return "An observation"
  }
}

/**
 * Decodes an observation against {@link Observation} before it is persisted.
 *
 * The failure carries the schema issue, which names the offending path, and
 * never the observation itself.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (observation: Observation): Effect.Effect<Observation, ScorerError> =>
  decodeObservation(observation).pipe(
    Effect.mapError((cause) =>
      new ScorerError({
        code: "invalid_observation",
        message: `${observationLabel(observation)} does not match the durable observation contract`,
        cause
      })
    )
  )
