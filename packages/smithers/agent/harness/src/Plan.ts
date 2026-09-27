/**
 * Local structural plan nodes used at the harness-to-engine boundary.
 *
 * These values project the canonical registry metadata defined by
 * `@smthrs/registry`'s `Descriptor` and consumed at the splice boundary
 * described in `../docs/concepts.md#child-plans-and-the-splice-boundary`. Source order is retained
 * only for result correlation; graph dependencies are the sole sequencing
 * signal.
 *
 * @since 0.1.0
 */

import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Schema } from "effect"

/**
 * One flow invocation elaborated from a model tool call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Child extends Schema.Class<Child>("flows/harness/Plan/Child")({
  flowName: Schema.String,
  callId: Schema.String,
  args: Schema.Unknown,
  capabilities: Schema.Array(Schema.String),
  effects: Descriptor.EffectDeclaration,
  placement: Schema.Option(Descriptor.Placement)
}) {}

/**
 * The children passed through to the engine.
 *
 * The harness preserves model-call order for correlation but never schedules
 * or serializes a child itself.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Batch extends Schema.Class<Batch>("flows/harness/Plan/Batch")({
  children: Schema.Array(Child)
}) {}

/**
 * A settled child outcome suitable for transcript projection.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ChildResult extends Schema.Class<ChildResult>("flows/harness/Plan/ChildResult")({
  callId: Schema.String,
  outcome: Schema.Literals(["success", "error", "aborted"]),
  result: ModelRequest.ToolResultPart
}) {}

/**
 * One harness-owned progress update emitted while a child call is executing.
 *
 * Progress is intentionally separate from {@link ChildResult}: it is
 * transient execution telemetry, while a result is the durable transcript
 * settlement for the call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ChildProgress extends Schema.TaggedClass<ChildProgress>(
  "flows/harness/Plan/ChildProgress"
)("progress", {
  callId: Schema.String,
  message: Schema.String
}) {}

/**
 * One settled child result in the streaming splice protocol.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ChildSettled extends Schema.TaggedClass<ChildSettled>(
  "flows/harness/Plan/ChildSettled"
)("settled", {
  result: ChildResult
}) {}

/**
 * Streaming output of one engine splice.
 *
 * Engines may publish any number of progress updates before exactly one
 * settlement for each call. The harness publishes progress immediately and
 * restores final settlements to model-call order.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SpliceEvent = Schema.Union([ChildProgress, ChildSettled]).pipe(
  Schema.toTaggedUnion("_tag")
)

/**
 * Streaming output of one engine splice.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SpliceEvent = typeof SpliceEvent.Type
