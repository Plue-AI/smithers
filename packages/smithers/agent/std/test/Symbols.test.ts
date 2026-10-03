import { describe, expect, it } from "vitest"
import * as Symbols from "../src/internal/Symbols.ts"

describe("Symbols.enclosing", () => {
  it("rejects out-of-range lines and source without a plain declaration", () => {
    for (const line of [0, -1, 2]) expect(Symbols.enclosing(["value = 1"], line)).toBeUndefined()
    expect(Symbols.enclosing([], 1)).toBeUndefined()
    expect(Symbols.enclosing(["", "value = 1"], 1)).toBeUndefined()
    expect(Symbols.enclosing(["def", "    missing_name()"], 2)).toBeUndefined()
  })

  it("uses indentation to select nested definitions and trim trailing blank lines", () => {
    const lines = ["class Outer:", "    def inner():", "        hit", "", "    sibling = 1", "", "outside = 2"]
    expect(Symbols.enclosing(lines, 3)).toEqual({ kind: "def", name: "inner", startLine: 2, endLine: 3 })
    expect(Symbols.enclosing(lines, 4)).toEqual({ kind: "def", name: "inner", startLine: 2, endLine: 3 })
    expect(Symbols.enclosing(lines, 5)).toEqual({ kind: "class", name: "Outer", startLine: 1, endLine: 5 })
    expect(Symbols.enclosing(lines, 7)).toBeUndefined()
  })

  it("includes a closing brace and recognizes declaration modifiers", () => {
    const lines = ["export default async function work() {", "\treturn 1", "}", "next()"]
    expect(Symbols.enclosing(lines, 2)).toEqual({ kind: "function", name: "work", startLine: 1, endLine: 3 })
    expect(Symbols.enclosing(lines, 1)).toEqual({ kind: "function", name: "work", startLine: 1, endLine: 3 })
    expect(Symbols.enclosing(["pub(crate) unsafe fn work() {", "    hit"], 2)).toEqual({
      kind: "fn",
      name: "work",
      startLine: 1,
      endLine: 2
    })
  })

  it("skips blank lines while searching and trims an unfinished block at EOF", () => {
    expect(Symbols.enclosing(["def work():", "", "    hit", "", ""], 3)).toEqual({
      kind: "def",
      name: "work",
      startLine: 1,
      endLine: 3
    })
    expect(Symbols.enclosing(["def work():"], 1)).toEqual({
      kind: "def",
      name: "work",
      startLine: 1,
      endLine: 1
    })
  })
})
