/**
 * The fencing token the journal accepts on durable appends.
 *
 * `OwnerId` lives here rather than with the ownership *arbitration* in
 * `@smthrs/run-store` because the journal is what it fences: `emitDurable`
 * takes an owner and refuses the append when the persisted fence has moved on.
 * The journal therefore defines the token, and the run store (which stores it
 * on runs and arbitrates who holds it) imports it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * `pid` is a real operating-system process id, so the schema states that: a
 * non-negative integer. A fractional, `NaN`, or negative `pid` is a caller
 * bug, and the fenced methods reject it as `invalid_event` rather than
 * degrading it into `fence_lost`, which would read as "someone else owns this
 * run" and send the caller looking for a race that never happened.
 *
 * `hostId` and `nonce` stay plain strings. An empty one is a legal value that
 * simply matches no persisted owner, which is exactly `fence_lost`.
 *
 * @since 0.1.0
 * @category models
 */
export const OwnerId = Schema.Struct({
  hostId: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  nonce: Schema.String
})

/**
 * A process identity scoped to a host and a unique ownership nonce.
 *
 * @since 0.1.0
 * @category models
 */
export type OwnerId = typeof OwnerId.Type
