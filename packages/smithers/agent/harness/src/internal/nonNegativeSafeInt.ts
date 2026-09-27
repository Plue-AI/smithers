/**
 * The bound every journaled count in this package is declared with.
 *
 * A count that crossed the safe-integer ceiling would compare and re-encode
 * wrongly on the way back out of a journal, so every ordinal, frame number,
 * byte count and cap is admitted through one validator rather than six copies
 * that happened to agree.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { Schema } from "effect"

/**
 * A count in `[0, Number.MAX_SAFE_INTEGER]`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
