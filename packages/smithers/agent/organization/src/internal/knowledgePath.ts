/**
 * The knowledge grant grammar.
 *
 * A knowledge grant names wiki content a principal may read. The grammar is
 * deliberately smaller than a glob so that containment is decidable by
 * comparing path segments: a grant is either an exact file (`Org/Roles/a.md`)
 * or a subtree (`Org/Playbooks/`, trailing slash). The one token `./` is the
 * whole wiki: the subtree of no segments, which covers every file the grammar
 * admits and so still no hidden one. Paths are relative,
 * NFC-normalized, and made of non-empty segments that never start with a dot,
 * so `.`, `..`, hidden files, absolute paths, and every glob metacharacter are
 * refused rather than interpreted.
 *
 * @since 1.0.0
 */

/**
 * A parsed knowledge path: an exact file or a subtree of segments.
 *
 * @private
 * @since 1.0.0
 */
export interface KnowledgePath {
  readonly kind: "file" | "subtree"
  readonly segments: ReadonlyArray<string>
}

/**
 * Why a knowledge path was refused.
 *
 * @private
 * @since 1.0.0
 */
export type Refusal =
  | "empty"
  | "too-long"
  | "not-normalized"
  | "absolute"
  | "glob"
  | "invalid-character"
  | "empty-segment"
  | "dot-segment"
  | "too-deep"

/**
 * Longest accepted knowledge path, in UTF-16 code units.
 *
 * @private
 * @since 1.0.0
 */
export const maxLength = 1024

/**
 * Most segments one knowledge path may have.
 *
 * @private
 * @since 1.0.0
 */
export const maxSegments = 32

/**
 * The whole-wiki grant: exactly `./`, the served root.
 *
 * @private
 * @since 1.0.0
 */
export const wholeWiki = "./"

const globCharacters = /[*?[\]{}!]/
// Backslash, colon (drive letters and alternate data streams), and every C0
// or DEL control character, including NUL.
// eslint-disable-next-line no-control-regex -- the class exists to refuse control characters
const invalidCharacters = /[\\:\u0000-\u001f\u007f]/

/**
 * Parses one knowledge path, refusing anything outside the grammar.
 *
 * @private
 * @since 1.0.0
 */
export const parse = (
  text: string
): { readonly ok: true; readonly path: KnowledgePath } | { readonly ok: false; readonly refusal: Refusal } => {
  if (text.length === 0) return { ok: false, refusal: "empty" }
  if (text === wholeWiki) return { ok: true, path: { kind: "subtree", segments: [] } }
  if (text.length > maxLength) return { ok: false, refusal: "too-long" }
  if (text.normalize("NFC") !== text) return { ok: false, refusal: "not-normalized" }
  if (text.startsWith("/")) return { ok: false, refusal: "absolute" }
  if (globCharacters.test(text)) return { ok: false, refusal: "glob" }
  if (invalidCharacters.test(text)) return { ok: false, refusal: "invalid-character" }
  const subtree = text.endsWith("/")
  const segments = (subtree ? text.slice(0, -1) : text).split("/")
  if (segments.length > maxSegments) return { ok: false, refusal: "too-deep" }
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, refusal: "empty-segment" }
    if (segment.startsWith(".")) return { ok: false, refusal: "dot-segment" }
    if (segment.trim() !== segment) return { ok: false, refusal: "invalid-character" }
  }
  return { ok: true, path: { kind: subtree ? "subtree" : "file", segments } }
}

/**
 * Whether `grant` covers every path `target` covers.
 *
 * A file grant covers only the identical file. A subtree grant covers a file
 * or a subtree whose segments start with all of the grant's segments; a file
 * with exactly the grant's segments is the directory's name, not its content,
 * so it is not covered.
 *
 * @private
 * @since 1.0.0
 */
export const covers = (grant: KnowledgePath, target: KnowledgePath): boolean => {
  if (grant.kind === "file") {
    return target.kind === "file" && sameSegments(grant.segments, target.segments)
  }
  const minimum = target.kind === "file" ? grant.segments.length + 1 : grant.segments.length
  if (target.segments.length < minimum) return false
  return grant.segments.every((segment, index) => target.segments[index] === segment)
}

const sameSegments = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((segment, index) => right[index] === segment)
