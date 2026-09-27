/**
 * The payload shape most patterns take.
 *
 * `@smthrs/flow` requires a flow's payload to be a STRUCT, and most patterns
 * here have always taken one opaque input: a goal, a topic, a target, a
 * question. Declaring that struct once means nine patterns share one
 * declaration instead of restating it, and a caller that reads one pattern's
 * payload has read them all.
 *
 * A pattern whose input really has fields, such as `MapReduce`'s `{ shards }`,
 * declares its own.
 *
 * @since 1.0.0
 * @private
 */

import * as Schema from "effect/Schema"

/**
 * One opaque caller input, wrapped as the struct a flow payload must be.
 *
 * @since 1.0.0
 * @private
 */
export const OpaqueInput = Schema.Struct({ input: Schema.Unknown })
