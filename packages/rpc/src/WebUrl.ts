/**
 * The URL shapes a renderer may link, embed or open.
 *
 * A card, homepage or backend answer carries URLs written by repository
 * authors, upstream forges and remote servers. Any of them may be rendered
 * as an `href`, an `<img src>` or a window to open, so the contract refuses
 * every scheme that could run script (`javascript:`, `data:`, `vbscript:`) or
 * reach the host (`file:`, custom protocol handlers) before a renderer sees it.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * An absolute `http://` or `https://` URL.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HttpUrlSchema = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: "Expected an http:// or https:// URL."
})

/**
 * An origin-relative path (`/api/...`): one leading slash, never `//` (a
 * scheme-relative URL naming another host), no backslash and no control
 * characters.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RelativeUrlPathSchema = z.string().max(4096).refine(
  (value) => /^\/(?![/\\])/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value),
  { message: "Expected an origin-relative path." }
)
