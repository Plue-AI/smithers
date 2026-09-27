/** Durable observations owned by an agent checkpoint action.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Schema from "effect/Schema"

const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

/** Invocation and retry coordinates remain distinct across replay.
 * @category schemas
 * @since 1.0.0
 */
export const Step = Schema.Struct({
  stepId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  executionId: Schema.String,
  action: Schema.String,
  attempt: positive,
  ask: Schema.Union([nonnegative, Schema.Literal("repair")]),
  retry: positive,
  scope: Schema.String
})

/** Decoded invocation coordinates.
 * @category models
 * @since 1.0.0
 */
export type Step = typeof Step.Type

/** The first recorded observation, including its original generation and time.
 * @category schemas
 * @since 1.0.0
 */
export const Fact = Schema.Struct({
  version: Schema.Literal(1),
  step: Step,
  generation: nonnegative,
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  ordinal: nonnegative,
  cell: Schema.String,
  at: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  eventType: Schema.String.check(Schema.isPattern(/^control\.agent\.[a-z-]+$/)),
  sourceSequence: nonnegative,
  payload: Schema.Json
})

/** Decoded checkpoint observation.
 * @category models
 * @since 1.0.0
 */
export type Fact = typeof Fact.Type

/** Marks a checkpoint whose saved success is the fact to publish.
 * @category services
 * @since 1.0.0
 */
// The annotation is a marker with no fields; its presence is the entire contract.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class Annotation extends Context.Service<Annotation, {}>()("@smthrs/journal/StepFact/Annotation") {}

/** Native outbox event, committed with its owning checkpoint.
 * @category events
 * @since 1.0.0
 */
export const eventType = "flows.harness.step-fact.v1"
