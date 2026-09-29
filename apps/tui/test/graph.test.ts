import { expect, it } from "bun:test"
import * as Graph from "../src/graph.ts"

const node = (key: string, children: ReadonlyArray<Graph.Node> = []): Graph.Node => ({
  key,
  glyph: "●",
  tone: "green",
  name: key,
  sub: "sol · 3m",
  children
})
const colors = { line: "grey", accent: "purple", text: "white", faint: "faint" }

it("draws a parent beside its first child and stacks the rest below, joined by edges", () => {
  const drawn = Graph.draw(node("plan", [node("impl", [node("change 1")]), node("docs")]), "impl", colors)
  expect(Graph.text(drawn.rows)).toBe([
    "╭────────────────────────╮     ╭────────────────────────╮     ╭────────────────────────╮",
    "│ ● plan                 │─┬──▶│ ● impl                 │────▶│ ● change 1             │",
    "│ sol · 3m               │ │   │ sol · 3m               │     │ sol · 3m               │",
    "╰────────────────────────╯ │   ╰────────────────────────╯     ╰────────────────────────╯",
    "                           │",
    "                           │   ╭────────────────────────╮",
    "                           └──▶│ ● docs                 │",
    "                               │ sol · 3m               │",
    "                               ╰────────────────────────╯"
  ].join("\n"))
  // The selected box's border is the accent; the others are lines.
  expect(drawn.rows[0]!.find((span) => span.text.startsWith("╭") && span.fg === "purple")?.text).toBe(
    "╭────────────────────────╮"
  )
})

it("clips a long name with an ellipsis inside its box", () => {
  const drawn = Graph.draw(node("a very long worker title that will not fit"), "", colors)
  expect(Graph.text(drawn.rows).split("\n")[1]).toBe("│ ● a very long worker … │")
})

it("keeps boxes and edges in their columns when a name holds wide characters", () => {
  const drawn = Graph.draw(node("中文名字 🚀", [node("child")]), "", colors)
  // Each wide character takes two columns and one cell: the border and the edge stay put.
  expect(Graph.text(drawn.rows).split("\n")[1]).toBe("│ ● 中文名字 🚀          │────▶│ ● child                │")
  expect(drawn.boxes.get("child")).toEqual({ x: 31, y: 0 })
})

it("places each box where the view scrolls to select it", () => {
  const drawn = Graph.draw(node("a", [node("b"), node("c")]), "c", colors)
  expect([...drawn.boxes]).toEqual([["a", { x: 0, y: 0 }], ["b", { x: 31, y: 0 }], ["c", { x: 31, y: 5 }]])
})
