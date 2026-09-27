/**
 * Durable trigger declarations.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Schedule from "./Schedule.ts"
import { fromSchemaError, type TriggerError } from "./TriggerError.ts"

/**
 * How a trigger behaves when an occurrence arrives while its previous run
 * is still going.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Overlap = Schedule.Overlap
/**
 * The decoded form of {@link Overlap}.
 *
 * @category models
 * @since 0.1.0
 */
export type Overlap = Schedule.Overlap
/**
 * How many missed occurrences a trigger owes after downtime.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CatchUp = Schedule.CatchUp
/**
 * The decoded form of {@link CatchUp}.
 *
 * @category models
 * @since 0.1.0
 */
export type CatchUp = Schedule.CatchUp

/**
 * A trigger declaration: which flow to run, with what input, on what
 * schedule.
 *
 * `input` is JSON rather than `unknown` because the store persists it with
 * `JSON.stringify` into a `NOT NULL` column. The schema refuses `undefined`,
 * `NaN`, a `Date`, and functions at the declaration boundary.
 * Enumerable getters are accepted when their values are JSON. They are
 * evaluated during decoding and again during SQL serialization. Every store
 * takes an eager serialized snapshot before returning its Effect; use plain
 * JSON values for stable input across reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Trigger = Schema.Struct({
  id: Schema.NonEmptyString,
  flowId: Schema.NonEmptyString,
  input: Schema.Json,
  ...Schedule.Schedule.fields,
  enabled: Schema.Boolean
})
/**
 * The decoded form of {@link Trigger}.
 *
 * @category models
 * @since 0.1.0
 */
export type Trigger = typeof Trigger.Type

/**
 * Decodes and validates a trigger declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (input: unknown): Effect.Effect<Trigger, TriggerError> =>
  Schema.decodeUnknownEffect(Trigger)(input).pipe(
    Effect.mapError((cause) => fromSchemaError("invalid_trigger", "Trigger declaration is invalid", cause)),
    Effect.flatMap(Schedule.validate)
  )
