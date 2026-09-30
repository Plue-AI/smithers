/**
 * The heartbeat lease constants, re-exported from the journal's consensus
 * module.
 *
 * A leaf module on purpose. `RunStore` needs the staleness cutoff for its
 * claim predicates and `Ownership` needs all four for the supervision loop,
 * but `Ownership` imports `RunStore`, so neither could own the constants
 * without the other restating them. The definitions themselves live in
 * `@smthrs/journal`'s `Consensus`: every consensus strategy judges R5
 * staleness against the same cutoff this store uses, and one definition is
 * what keeps that structural.
 *
 * @since 0.1.0
 */

export {
  /**
   * How often the supervision loop pulses to renew the owner's lease.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatInterval,
  /**
   * How far the owner's wall clock may run behind a peer's before the lease
   * reasoning stops holding.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatSkewAllowance,
  /**
   * How old a persisted heartbeat must be before a peer may steal the run.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatStaleAfter,
  /**
   * How long the owner may keep working through failing or stalled heartbeat
   * writes.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatWriteTolerance
} from "@smthrs/journal/Consensus"
