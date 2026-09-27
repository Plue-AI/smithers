/**
 * Versioned facts for an authorized native cell invocation and its delivered result.
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Schema from "effect/Schema"

/** Stable harness coordinates, independent of physical attempt or publication order.
 * @category schemas
 * @since 1.0.0
 */
export const Identity = Schema.Struct({
  /** Public logical run identity, not an authentication session credential. */
  runId: Schema.String,
  frame: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cell: Schema.String,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  declaration: Schema.String,
  layers: Schema.Array(Schema.String)
})

/** A call annotation contains data only and never changes an action key.
 * @category schemas
 * @since 1.0.0
 */
export const Call = Schema.Struct({
  callId: Schema.String.check(Schema.isPattern(/^cell-call-v1:[0-9a-f]{64}$/)),
  identity: Identity,
  flowName: Schema.String,
  input: Schema.Json,
  /**
   * The resolved declaration's display projection, as its owner encoded it.
   *
   * JSON rather than a struct because the vocabulary belongs to
   * `@smthrs/registry` (`Descriptor.FlowActivity`, `Descriptor.CallPresentation`),
   * which sits above this package: `@smthrs/harness` `Cell.displayDescriptor`
   * encodes it from a typed call and the reading card validates each field
   * before it is displayed, so the journal carries it and claims nothing about
   * it. Absent means the declaration claimed nothing.
   */
  descriptor: Schema.optional(Schema.Json)
})

/** Decoded authorized call coordinates.
 * @category models
 * @since 1.0.0
 */
export type Call = typeof Call.Type

/** Native action annotation; only the existing controller record settles a call.
 * @category services
 * @since 1.0.0
 */
export class Annotation extends Context.Service<Annotation, {
  readonly phase: "invoked" | "settled"
  readonly call: Call
}>()("@smthrs/journal/CallFact/Annotation") {}

/** Public result vocabulary. Executable outcomes remain in the protected attempt row.
 * @category schemas
 * @since 1.0.0
 */
export const Result = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("success"),
    value: Schema.Json,
    message: Schema.optional(Schema.String),
    code: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    outcome: Schema.Literal("failure"),
    value: Schema.Json,
    message: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String)
  })
])

const coordinates = {
  version: Schema.Literal(1),
  callId: Call.fields.callId,
  identity: Identity,
  flowName: Schema.String
}

/** Bounded, redacted event projection; a truncation marker is still JSON.
 * @category schemas
 * @since 1.0.0
 */
export const Fact = Schema.Union([
  Schema.Struct({
    ...coordinates,
    phase: Schema.Literal("invoked"),
    input: Schema.Json,
    descriptor: Schema.optional(Schema.Json)
  }),
  Schema.Struct({
    ...coordinates,
    phase: Schema.Literal("settled"),
    outcome: Schema.Literals(["success", "failure"]),
    value: Schema.Json,
    message: Schema.optional(Schema.Json),
    code: Schema.optional(Schema.String)
  })
])

/** Decoded public native call fact.
 * @category models
 * @since 1.0.0
 */
export type Fact = typeof Fact.Type

/** The immutable native journal is the durable outbox consumed by the native bridge.
 * @category events
 * @since 1.0.0
 */
export const eventType = "flows.harness.call-fact.v1"
