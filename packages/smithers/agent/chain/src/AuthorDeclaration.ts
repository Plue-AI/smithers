/**
 * The author entry's declaration — the one leaf both the trampoline and
 * the prompt read, so the model always sees exactly the declaration the
 * call key pins, and the pure prompt module never imports the runtime.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"

/**
 * The name every script uses to call the author seat: model calls are
 * ordinary calls, one mechanism.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorName = "author"

/**
 * The author entry's one-line description.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDescription = "Author the successor flow script from the context the caller built"

/**
 * The declaration digest pinned into every author call key.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorDigest: string = Digest.digest(
  Digest.canonical({ description: authorDescription, name: authorName })
)

/**
 * The capability the author seat claims — the authorization seam evaluates
 * the model call against this claim like any other effect, so an operator's
 * policy must cover it before a chain can author at all.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const authorCapability = "model:call:author"
