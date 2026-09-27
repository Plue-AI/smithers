/**
 * What a bounded repetition does when it reaches its ceiling.
 *
 * This is the ONE ceiling vocabulary. `@smthrs/flow`'s `Poll.make` takes it as
 * `onTimeout`, for the attempt a poll gives up on, and `@smthrs/patterns`'
 * `Loop` takes it as `onMaxReached`, for the iteration a loop gives up on. It
 * was the same two words written out in both packages, with no edge between
 * them, so a third member added on one side would have been invisible to the
 * other. It lives here because `@smthrs/plan` is the package both already
 * depend on.
 *
 * @since 1.0.0-rc.0
 */

import * as Schema from "effect/Schema"

/**
 * What a bounded repetition answers with at its ceiling: `fail` raises the
 * repetition's own typed failure, and `return-last` settles with the last
 * value it produced.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const AtCeiling = Schema.Literals(["fail", "return-last"])

/**
 * The value form of {@link AtCeiling}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type AtCeiling = typeof AtCeiling.Type
