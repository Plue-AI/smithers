/**
 * How the host reads a credential store a provider scan names: the text of
 * the file, or `undefined` when it cannot be read.
 *
 * One reader, so the seat scan `smithers suggest` makes and the seat catalog a
 * native host routes by read the same files the same way.
 *
 * @since 1.0.0
 * @private
 */

import { readFileSync } from "node:fs"

/**
 * The text of the file at `path`, or `undefined` when it cannot be read.
 *
 * @since 1.0.0
 * @private
 */
export const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}
