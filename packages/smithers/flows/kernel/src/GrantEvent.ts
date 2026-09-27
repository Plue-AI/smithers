/**
 * Durable grant decision events.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 1.0.0-rc.0
 */

import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import * as Schema from "effect/Schema"

/**
 * The tier at which a capability decision was made.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const GrantTier = Schema.Literals(["sealed", "compensable", "irreversible"])

/**
 * The scope selected for a permission grant.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const GrantScope = Schema.Literals(["once", "run", "remembered"])

/**
 * A one-call grant.
 *
 * It is durable audit evidence but is deliberately never replayed as active
 * authority.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class OnceGrant extends Schema.TaggedClass<OnceGrant>()("@smthrs/kernel/GrantEvent/OnceGrant", {
  eventType: Schema.Literal("flows.kernel.grant.once.v1"),
  requestId: Schema.String,
  runId: Schema.String,
  planDigest: Schema.optional(Schema.String),
  capability: Capability,
  pattern: CapabilityPattern,
  scope: Schema.Literal("once"),
  tier: GrantTier
}) {}

/**
 * A grant remembered across runs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class RememberedGrant extends Schema.TaggedClass<RememberedGrant>()(
  "@smthrs/kernel/GrantEvent/RememberedGrant",
  {
    eventType: Schema.Literal("flows.kernel.grant.remembered.v1"),
    requestId: Schema.String,
    runId: Schema.String,
    planDigest: Schema.optional(Schema.String),
    capability: Capability,
    pattern: CapabilityPattern,
    scope: Schema.Literal("remembered"),
    tier: GrantTier
  }
) {}

/**
 * A grant scoped to the current run.
 *
 * Version 2 captures the requesting fiber's normalized conjunction of any-of
 * capability-pattern groups. Replay intersects it with the constructor ceiling.
 * Version 1 omitted this boundary and cannot safely activate authority.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class RunGrant extends Schema.TaggedClass<RunGrant>()("@smthrs/kernel/GrantEvent/RunGrant", {
  eventType: Schema.Literal("flows.kernel.grant.run.v2"),
  requestId: Schema.String,
  runId: Schema.String,
  planDigest: Schema.String,
  capability: Capability,
  pattern: CapabilityPattern,
  ceiling: Schema.Array(Schema.Array(CapabilityPattern)),
  scope: Schema.Literal("run"),
  tier: GrantTier
}) {}

/**
 * A denied permission request.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class DeniedGrant extends Schema.TaggedClass<DeniedGrant>()("@smthrs/kernel/GrantEvent/DeniedGrant", {
  eventType: Schema.Literal("flows.kernel.grant.denied.v1"),
  requestId: Schema.String,
  runId: Schema.String,
  planDigest: Schema.optional(Schema.String),
  capability: Capability,
  pattern: CapabilityPattern,
  scope: Schema.Literal("once"),
  tier: GrantTier
}) {}

/**
 * A capability envelope grant.
 *
 * Envelope grants are not attached to an individual request. `planDigest`
 * binds the decision to exactly the plan shown to the approver. A `run`
 * envelope is replayed only for that run and digest; a `remembered` envelope
 * becomes remembered predicate grants for future plans while retaining its
 * origin digest as audit evidence.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class EnvelopeGrant extends Schema.TaggedClass<EnvelopeGrant>()(
  "@smthrs/kernel/GrantEvent/EnvelopeGrant",
  {
    eventType: Schema.Literal("flows.kernel.grant.envelope.v1"),
    runId: Schema.String,
    planDigest: Schema.String,
    patterns: Schema.Array(CapabilityPattern),
    scope: Schema.Literals(["run", "remembered"])
  }
) {}

/**
 * All durable grant events understood by the kernel.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const GrantEventSchema = Schema.Union([
  OnceGrant,
  RememberedGrant,
  DeniedGrant,
  EnvelopeGrant,
  RunGrant
])

/**
 * All durable grant events understood by the kernel.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type GrantEvent = typeof GrantEventSchema.Type

/**
 * Decodes one JSON-compatible journal payload into a grant event.
 *
 * Excess payload keys are rejected rather than stripped. Grant payloads are
 * replayed as active permission authority, so a payload that mixes fields
 * from two grant variants — for example an envelope carrying request-only
 * fields — is treated as corrupt instead of silently narrowed to whichever
 * variant its declared keys happen to satisfy.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decode = Schema.decodeUnknownResult(GrantEventSchema, { onExcessProperty: "error" })

/**
 * Encodes a grant event into its JSON-compatible journal payload.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export const encode = Schema.encodeUnknownResult(GrantEventSchema)
