/**
 * The Summary overview's graph (`g`): the selected row's run forest drawn left
 * to right as boxes, `glyph name` over `seat · clock`, each child one column
 * right of its parent with a `──▶` edge. A worker's children are the agents it
 * spawned; a flow run's are its node calls. Pure: it returns colored text
 * rows, and `subagent-view.tsx` draws them.
 */
import stringWidth from "string-width"

export interface Node {
  /** The overview row key this box selects, when it is one. */
  readonly key: string
  readonly glyph: string
  readonly tone: string
  readonly name: string
  readonly sub: string
  readonly children: ReadonlyArray<Node>
}

/** A run of text in one color. */
export interface Span {
  readonly text: string
  readonly fg: string
}

export const size = { width: 26, height: 4, gap: 5 } as const

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Columns a character takes: box drawing and the arrow are one, as the terminal draws them. */
const cellWidth = (char: string): number => /^[\u2500-\u25ff]$/.test(char) ? 1 : Math.max(1, stringWidth(char))

const clip = (text: string, width: number): string => {
  if (stringWidth(text) <= width) return text + " ".repeat(width - stringWidth(text))
  let kept = ""
  for (const { segment: char } of graphemes.segment(text)) {
    if (stringWidth(kept + char) > width - 1) break
    kept += char
  }
  return kept + "…" + " ".repeat(Math.max(0, width - 1 - stringWidth(kept)))
}

interface Placed {
  readonly node: Node
  readonly column: number
  readonly row: number
}

/** Each node's column (its depth) and row: a parent sits on its first child's row, leaves stack downward. */
const place = (root: Node): ReadonlyArray<Placed> => {
  const placed: Array<Placed> = []
  let next = 0
  const visit = (node: Node, column: number): number => {
    const at = placed.length
    placed.push({ node, column, row: -1 })
    let row: number | undefined
    for (const child of node.children) {
      const childRow = visit(child, column + 1)
      row ??= childRow
    }
    const own = row ?? next++
    placed[at] = { node, column, row: own }
    return own
  }
  visit(root, 0)
  return placed
}

/** The drawn graph: colored rows, and where each box sits, to scroll the selection into view. */
export interface Drawn {
  readonly rows: ReadonlyArray<ReadonlyArray<Span>>
  readonly boxes: ReadonlyMap<string, { readonly x: number; readonly y: number }>
}

/**
 * The graph as rows of colored spans. `selected` is the row key whose box is
 * drawn in `accent`; other borders and edges are `line`.
 */
export const draw = (
  root: Node,
  selected: string,
  colors: { readonly line: string; readonly accent: string; readonly text: string; readonly faint: string }
): Drawn => {
  const placed = place(root)
  const { width, height, gap } = size
  const columns = Math.max(...placed.map((each) => each.column)) + 1
  const rows = Math.max(...placed.map((each) => each.row)) + 1
  // A wide character fills its cell and leaves the next one empty (""), so every row keeps its width.
  const canvas = Array.from(
    { length: rows * (height + 1) - 1 },
    () => Array.from({ length: columns * (width + gap) }, () => ({ char: " ", fg: colors.line }))
  )
  const put = (x: number, y: number, text: string, fg: string) => {
    let at = x
    for (const { segment: char } of graphemes.segment(text)) {
      const cells = cellWidth(char)
      for (let offset = 0; offset < cells; offset++) {
        const cell = canvas[y]?.[at + offset]
        if (cell !== undefined) {
          cell.char = offset === 0 ? char : ""
          cell.fg = fg
        }
      }
      at += cells
    }
  }
  const origin = (each: Placed) => ({ x: each.column * (width + gap), y: each.row * (height + 1) })
  const byNode = new Map(placed.map((each) => [each.node, each]))
  const boxes = new Map<string, { x: number; y: number }>()
  for (const each of placed) {
    const { x, y } = origin(each)
    boxes.set(each.node.key, { x, y })
    const border = each.node.key === selected ? colors.accent : colors.line
    put(x, y, `╭${"─".repeat(width - 2)}╮`, border)
    put(x, y + 1, "│", border)
    put(x + 2, y + 1, each.node.glyph, each.node.tone)
    put(x + 4, y + 1, clip(each.node.name, width - 6), colors.text)
    put(x + width - 1, y + 1, "│", border)
    put(x, y + 2, "│", border)
    put(x + 2, y + 2, clip(each.node.sub, width - 4), colors.faint)
    put(x + width - 1, y + 2, "│", border)
    put(x, y + 3, `╰${"─".repeat(width - 2)}╯`, border)
  }
  // Edges: straight along the parent's row, else down a spine beside it and across.
  for (const parent of placed) {
    const children = parent.node.children.map((child) => byNode.get(child)!)
    if (children.length === 0) continue
    const { x, y } = origin(parent)
    const spine = x + width + 1
    const last = Math.max(...children.map((child) => child.row))
    if (children.length > 1) {
      for (let at = y + 1; at <= last * (height + 1) + 1; at++) put(spine, at, "│", colors.line)
    }
    for (const child of children) {
      const target = origin(child)
      const row = target.y + 1
      if (child.row === parent.row) put(x + width, row, "─".repeat(target.x - x - width - 1), colors.line)
      else {
        put(spine, row, child.row === last ? "└" : "├", colors.line)
        put(spine + 1, row, "─".repeat(target.x - spine - 2), colors.line)
      }
      put(target.x - 1, row, "▶", colors.line)
    }
    if (children.length > 1) put(spine, y + 1, "┬", colors.line)
  }
  return {
    boxes,
    rows: canvas.map((line) => {
      const spans: Array<Span> = []
      for (const cell of line) {
        const last = spans.at(-1)
        if (last !== undefined && last.fg === cell.fg) {
          spans[spans.length - 1] = { text: last.text + cell.char, fg: last.fg }
        } else spans.push({ text: cell.char, fg: cell.fg })
      }
      return spans
    })
  }
}

/** Plain text of drawn rows, for tests and screenshots. */
export const text = (rows: ReadonlyArray<ReadonlyArray<Span>>): string =>
  rows.map((spans) => spans.map((span) => span.text).join("").trimEnd()).join("\n")
