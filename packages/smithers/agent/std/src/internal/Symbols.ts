/**
 * The definition a line sits inside, read off the file's own shape.
 *
 * A search hit is a line number, and a line number is not a read window. Agents
 * guess one: `offset: line - 10, limit: 40`, which lands short (astropy-15569
 * missed `get_lookup` by one line and probed the wrong binding) or long (six
 * blind-offset reads on sympy-13878). The enclosing definition is the window the
 * hit actually belongs to, and for indentation- and brace-structured source it
 * is derivable from the text already in hand.
 *
 * This is a heuristic and reports only what it can see plainly: a declaration
 * keyword, a name, and the block that keyword opens. When the shape is not
 * plain — a match at top level, a language this table does not name, a
 * declaration split across lines — it answers `undefined` rather than guessing,
 * because a wrong window is worse than none.
 *
 * @since 1.0.0
 */

/**
 * The definition enclosing a line.
 *
 * @category models
 * @since 1.0.0
 */
export interface Symbol {
  readonly kind: string
  readonly name: string
  readonly startLine: number
  readonly endLine: number
}

/**
 * Declaration keywords this heuristic recognises across the languages the
 * standard flows meet. Modifiers before the keyword are skipped, the name after
 * it is captured, and everything else is left alone.
 */
const declaration =
  /^([ \t]*)(?:(?:async|export|default|public|private|protected|internal|static|final|abstract|open|pub(?:\([^)]*\))?|unsafe|const|declare)[ \t]+)*(def|class|function|fn|func|struct|impl|interface|trait|enum|module|namespace|type|sub|method)[ \t]+([A-Za-z_$][A-Za-z0-9_$]*)/

const closer = /^[ \t]*[)}\]]/

const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].length

const blank = (line: string): boolean => line.trim() === ""

/**
 * The definition enclosing a 1-based line, or `undefined` when there is none to
 * read plainly.
 *
 * @category navigation
 * @since 1.0.0
 */
export const enclosing = (lines: ReadonlyArray<string>, line: number): Symbol | undefined => {
  const index = line - 1
  if (index < 0 || index >= lines.length) return undefined
  // A blank match line has no indentation of its own; the nearest text above it
  // does, and that is the block the blank line belongs to.
  let reference = index
  while (reference > 0 && blank(lines[reference]!)) reference--
  const indent = indentOf(lines[reference]!)
  let start = -1
  let parsed: RegExpExecArray | null = null
  for (let candidate = index; candidate >= 0; candidate--) {
    const text = lines[candidate]!
    if (blank(text)) continue
    const found = declaration.exec(text)
    if (found === null) continue
    if (candidate !== index && indentOf(text) >= indent) continue
    start = candidate
    parsed = found
    break
  }
  if (parsed === null) return undefined
  const opening = indentOf(lines[start]!)
  let end = lines.length - 1
  for (let candidate = start + 1; candidate < lines.length; candidate++) {
    const text = lines[candidate]!
    if (blank(text)) continue
    if (indentOf(text) > opening) continue
    // A brace language closes the block at the declaration's own indentation,
    // and that closing line is part of the definition rather than what follows.
    end = closer.test(text) ? candidate : candidate - 1
    break
  }
  while (end > start && blank(lines[end]!)) end--
  return { kind: parsed[2]!, name: parsed[3]!, startLine: start + 1, endLine: end + 1 }
}
