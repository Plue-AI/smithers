/**
 * The heartbeat lease constants, and the one place they are related.
 *
 * A leaf module on purpose. `RunStore` needs the staleness cutoff for its steal
 * and claim predicates and `Ownership` needs all three for the supervision
 * loop, but `Ownership` imports `RunStore`, so neither could own the constants
 * without the other restating them. `RunStore` restated the cutoff as a bare
 * `heartbeatStaleAfterMs = 30_000`, and the equality between the two was held
 * only by a steal test asserting a derived timestamp. Here it is structural.
 *
 * @since 0.1.0
 */

import * as Duration from "effect/Duration"

/**
 * How often the supervision loop pulses to renew the owner's lease.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatInterval: Duration.Duration = Duration.seconds(1)

/**
 * How old a persisted heartbeat must be before a peer may steal the run.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatStaleAfter: Duration.Duration = Duration.seconds(30)

/**
 * How far the owner's wall clock may run behind a peer's before the lease
 * reasoning stops holding.
 *
 * The owner stamps `heartbeat_at_ms` from *its* clock and a would-be stealer
 * compares that stamp against *its own*, so the two hosts' clock offset is
 * subtracted directly from the owner's real safety margin. This constant names
 * that allowance instead of leaving it implicit in a "two ticks" arithmetic
 * accident, and it is a budgeted allowance, not a guarantee: see
 * {@link heartbeatWriteTolerance} for what happens once it is exceeded.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatSkewAllowance: Duration.Duration = Duration.seconds(10)

/**
 * How long the owner may keep working through *failing* heartbeat writes.
 *
 * A peer judges staleness by the persisted heartbeat and may steal the run the
 * instant it is {@link heartbeatStaleAfter} old, so an owner that tolerated
 * write failures for exactly that long would still be executing side effects
 * when the steal is admitted. The budget is therefore
 * {@link heartbeatStaleAfter} minus {@link heartbeatSkewAllowance} (the peer's
 * clock may already read that much later than the owner's) minus one
 * {@link heartbeatInterval} (the owner only re-evaluates the budget once per
 * pulse, so it may notice the expiry a full tick late).
 *
 * This bounds, but does not eliminate, overlap. Beyond
 * {@link heartbeatSkewAllowance} of clock offset a peer can be admitted while
 * the old owner is still running. *Durable* writes stay safe regardless — they
 * are fenced by the ownership compare-and-set, so the displaced owner's writes
 * fail rather than corrupt. Non-durable external side effects (an HTTP call, a
 * spawned process) can genuinely overlap. That is inherent to any wall-clock
 * lease and is stated here rather than asserted away; a caller that cannot
 * tolerate any overlap needs an external fencing token at the side effect
 * itself, not a larger timeout.
 *
 * @since 0.1.0
 * @category constants
 */
export const heartbeatWriteTolerance: Duration.Duration = Duration.millis(
  Duration.toMillis(heartbeatStaleAfter) -
    Duration.toMillis(heartbeatSkewAllowance) -
    Duration.toMillis(heartbeatInterval)
)
