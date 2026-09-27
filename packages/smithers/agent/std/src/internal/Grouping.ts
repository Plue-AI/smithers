/**
 * Match-centric grep results: the limit counts matches, and context rides
 * inside the match it belongs to.
 *
 * A flat list of rows made `limit` a row budget, and a row budget can spend
 * itself on context and drop the match. That is not a display detail: on
 * astropy-7166 the clip dropped the match row twice and cost three frames of
 * guard-bailing, because the agent could see the lines around its hit and not
 * the hit. Ripgrep's own JSON groups by match for the same reason.
 *
 * Both peers group here rather than each in its own way, so the native and
 * in-process implementations cannot drift on what a limit means or on which
 * match owns a shared context line.
 *
 * @since 1.0.0
 */

import type * as Search from "../Search.ts"
import * as Symbols from "./Symbols.ts"
import * as Text from "./Text.ts"

/**
 * A file's text as the numbered lines both peers count.
 *
 * This is `Text.sourceLines` under the name the search peers reach for, not a
 * second copy of it. There used to be two byte-identical definitions of the
 * rule, one here and one in `internal/Text.ts`, and a divergence between them
 * is exactly how `read` came to report one more line than `grep` for every
 * file ending in a newline. One definition cannot drift from itself.
 *
 * @category search
 * @since 1.0.0
 */
export const sourceLines: (content: string) => ReadonlyArray<string> = Text.sourceLines

/** Every context line belongs to exactly one match: the nearest, earliest on a tie. */
const owner = (matches: ReadonlyArray<number>, line: number): number => {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  for (let index = 0; index < matches.length; index++) {
    const candidate = Math.abs(matches[index]! - line)
    if (candidate < distance) {
      best = index
      distance = candidate
    }
  }
  return best
}

/**
 * Groups a peer's flat rows into matches, each carrying its own context.
 *
 * @category search
 * @since 1.0.0
 */
export const group = (
  lines: ReadonlyArray<Search.GrepLine>
): ReadonlyArray<Search.GrepMatch> => {
  const byFile = new Map<string, Array<Search.GrepLine>>()
  for (const line of lines) {
    const existing = byFile.get(line.file)
    if (existing === undefined) byFile.set(line.file, [line])
    else existing.push(line)
  }
  const grouped: Array<Search.GrepMatch> = []
  for (const [file, rows] of byFile) {
    const matches = rows.filter((row) => row.kind === "match")
    if (matches.length === 0) continue
    const numbers = matches.map((row) => row.line)
    const before = matches.map((): Array<Search.ContextLine> => [])
    const after = matches.map((): Array<Search.ContextLine> => [])
    for (const row of rows) {
      if (row.kind !== "context") continue
      const index = owner(numbers, row.line)
      const bucket = row.line < numbers[index]! ? before[index]! : after[index]!
      bucket.push({ line: row.line, text: row.text })
    }
    for (let index = 0; index < matches.length; index++) {
      const row = matches[index]!
      grouped.push({ file, line: row.line, text: row.text, before: before[index]!, after: after[index]! })
    }
  }
  return grouped
}

/**
 * Attaches each hit's enclosing definition, for the hits actually being
 * returned.
 *
 * `contents` holds a matched file's lines. A peer that does not have them — the
 * `rg` process reports lines, not files — reads only the files whose hits
 * survived the limit, so the cost is bounded by what the caller receives rather
 * than by what the search covered.
 *
 * @category search
 * @since 1.0.0
 */
export const annotate = (
  matches: ReadonlyArray<Search.GrepMatch>,
  contents: ReadonlyMap<string, ReadonlyArray<string>>
): ReadonlyArray<Search.GrepMatch> =>
  matches.map((match) => {
    const source = contents.get(match.file)
    const symbol = source === undefined ? undefined : Symbols.enclosing(source, match.line)
    return symbol === undefined ? match : { ...match, symbol }
  })
