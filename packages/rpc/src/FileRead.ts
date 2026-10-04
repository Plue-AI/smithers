/**
 * The `files.read` answer shared by every reader: the File card's content cap
 * and the model's copy of what the card shows.
 * @since 1.0.0
 */

/**
 * The card cap (characters): a transcript card states a file, it is not an editor.
 * @since 1.0.0
 * @category constants
 */
export const CARD_CONTENT_CAP = 16 * 1024

/**
 * The model's copy of a file: the same bounded text the card shows, with truncation and binary stated.
 * @since 1.0.0
 * @category utilities
 */
export const fileValue = (
  repo: string,
  path: string,
  payload: { readonly content: string; readonly truncated: boolean; readonly binary?: boolean }
): string =>
  payload.binary === true
    ? `${path} in ${repo} is a binary file; its bytes are not shown.`
    : `${path} in ${repo}${
      payload.truncated ? " (truncated at the card cap; the rest stays in the repository)" : ""
    }:\n${payload.content}`
