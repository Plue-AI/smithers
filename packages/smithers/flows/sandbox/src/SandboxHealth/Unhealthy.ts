/**
 * Defines the unhealthy sandbox state.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { UnhealthyReason } from "./UnhealthyReason.ts"

/**
 * The sandbox did not prove liveness because its ping failed or never
 * answered.
 *
 * @category models
 * @since 0.1.0
 */
export class Unhealthy extends Schema.Class<Unhealthy>("@smthrs/sandbox/SandboxHealth/Unhealthy")({
  _tag: Schema.tag("Unhealthy"),
  component: Schema.Literal("sandbox"),
  reason: UnhealthyReason,
  message: Schema.optional(Schema.String)
}) {}
