import { describe, expect, it, vi } from "vitest"
import * as Match from "../src/internal/Match.ts"

describe("Match", () => {
  it("normalizes each line once per strategy on a repeated-prefix miss", () => {
    const haystack = Array.from({ length: 100 }, () => "same  ")
    const wanted = [...Array.from({ length: 19 }, () => "same"), "missing"]
    const replace = vi.spyOn(String.prototype, "replace")
    let calls: number
    let nearest: ReturnType<typeof Match.nearest>
    try {
      nearest = Match.nearest(haystack.join("\n"), wanted.join("\n"), 0)
      calls = replace.mock.calls.filter(([pattern]) =>
        pattern instanceof RegExp && pattern.source === /[ \t]+$/.source
      ).length
    } finally {
      replace.mockRestore()
    }
    expect(nearest).toEqual({ startLine: 1, endLine: 1, text: "same  " })
    expect(calls).toBe(haystack.length + wanted.length)
  })

  it("returns raw CRLF bytes in diagnostics and applied hunks", () => {
    const content = "one\r\ntwo  words\r\nthree\r\n"
    expect(Match.nearest(content, "two words", 0)).toEqual({ startLine: 2, endLine: 2, text: "two  words\r" })
    expect(Match.hunk(content, 5, 15, 0)).toEqual({ startLine: 2, endLine: 2, text: "two  words\r" })
    expect(Match.nearest("", "absent")).toBeUndefined()
  })

  it("does not diagnose an empty or whitespace-only needle against unrelated text", () => {
    for (const needle of ["", "\n\n", " \t\n \t\n"]) {
      expect(Match.nearest("one\ntwo\n", needle)).toBeUndefined()
    }
  })

  it("drops terminal blank needle lines and bounds diagnostic context to the file", () => {
    expect(Match.nearest("one  \ntwo\nthree\n", "one\n\n", 5)).toEqual({
      startLine: 1,
      endLine: 3,
      text: "one  \ntwo\nthree"
    })
    expect(Match.nearest("before\n  one   two\nafter\n", "one two", 0)).toEqual({
      startLine: 2,
      endLine: 2,
      text: "  one   two"
    })
    expect(Match.nearest("before\nanchor\nafter\n", "\nanchor\nmissing", 0)).toEqual({
      startLine: 2,
      endLine: 2,
      text: "anchor"
    })
  })

  it("locates replaceable non-overlapping spans and excludes a terminating LF from the end line", () => {
    expect(Match.locate("aaa\naa\n", "aa")).toEqual([
      { start: 0, end: 2, startLine: 1, endLine: 1 },
      { start: 4, end: 6, startLine: 2, endLine: 2 }
    ])
    expect(Match.locate("first\nsecond\nthird", "first\nsecond\n")).toEqual([
      { start: 0, end: 13, startLine: 1, endLine: 2 }
    ])
    expect(Match.locate("one", "missing")).toEqual([])
    expect(Match.lineAt("one\ntwo", 100)).toBe(2)
    expect(Match.lineAt("one\ntwo", 0)).toBe(1)
  })
})
