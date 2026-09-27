/**
 * Defines the healthy sandbox state.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The sandbox answered its ping within the deadline.
 *
 * @category models
 * @since 0.1.0
 */
export class Healthy extends Schema.Class<Healthy>("@smthrs/sandbox/SandboxHealth/Healthy")({
  _tag: Schema.tag("Healthy")
}) {}
