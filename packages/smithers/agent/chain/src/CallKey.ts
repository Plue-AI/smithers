/**
 * The durable identity of one settled call within a link.
 *
 * Re-running a link with the same script digest prefix-matches its settled
 * calls by ordinal; editing one character of a script re-keys exactly the
 * calls inside it and nothing else. Governing contract:
 * https://chain.smithers.sh/contract/.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * A link's index in its chain, counted from zero.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const LinkId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * The decoded form of {@link LinkId}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LinkId = typeof LinkId.Type

/**
 * A call's position within its link, counted from zero in issue order.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Ordinal = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * The decoded form of {@link Ordinal}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Ordinal = typeof Ordinal.Type

/**
 * The scriptDigest recorded for calls the harness itself issues (bootstrap
 * and recovery author calls), which belong to no authored script.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const harnessDigest = ""

/**
 * The four components a settled call is keyed by: its link, the digest of
 * the script that issued it, its ordinal in that script, and the digest of
 * the entry it named.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const CallKey = Schema.Struct({
  link: LinkId,
  scriptDigest: Schema.String,
  ordinal: Ordinal,
  entryDigest: Schema.String
})

/**
 * The decoded form of {@link CallKey}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CallKey = typeof CallKey.Type

/**
 * Builds a call key from its four components.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  link: number,
  scriptDigest: string,
  ordinal: number,
  entryDigest: string
): CallKey => ({ link, scriptDigest, ordinal, entryDigest })
