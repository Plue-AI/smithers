import { describe, expect, it } from "vitest"
import * as Grouping from "../src/internal/Grouping.ts"
import { notice, slice, sourceLines, truncateBytes } from "../src/internal/Text.ts"

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength

describe("Text", () => {
  it("retains carriage returns as source-line bytes", () => {
    expect(sourceLines("one\r\ntwo\r\n")).toEqual(["one\r", "two\r"])
    expect(sourceLines("one\r\ntwo\nthree\r")).toEqual(["one\r", "two", "three\r"])
    expect(sourceLines("\r\n")).toEqual(["\r"])
    expect(sourceLines("")).toEqual([])
  })

  it("reports the bytes retained when a head cut crosses a multibyte scalar", () => {
    const source = "abc😀"
    const result = truncateBytes(source, 5, { keep: "head" })

    expect(result).toMatchObject({ text: "abc", keptBytes: 3, droppedBytes: 4, truncated: true })
    expect(result.keptBytes + result.droppedBytes).toBe(bytes(source))
  })

  it("preserves source replacement characters at either retained boundary", () => {
    expect(truncateBytes("abc�x", 6, { keep: "head" })).toMatchObject({
      text: "abc�",
      keptBytes: 6,
      droppedBytes: 1
    })
    expect(truncateBytes("x�abc", 6, { keep: "tail" })).toMatchObject({
      text: "�abc",
      keptBytes: 6,
      droppedBytes: 1
    })
  })

  it("keeps a complete Unicode scalar at the head or tail byte boundary", () => {
    const source = "abc😀def"
    expect(truncateBytes(source, 7, { keep: "head" })).toEqual({
      text: "abc😀",
      truncated: true,
      keptBytes: 7,
      droppedBytes: 3
    })
    expect(truncateBytes(source, 7, { keep: "tail" })).toEqual({
      text: "😀def",
      truncated: true,
      keptBytes: 7,
      droppedBytes: 3
    })
    expect(truncateBytes(source, 5, { keep: "tail" })).toMatchObject({
      text: "def",
      keptBytes: 3,
      droppedBytes: 7
    })
    expect(truncateBytes("😀", 0, { keep: "head" })).toMatchObject({
      text: "",
      keptBytes: 0,
      droppedBytes: 4
    })
  })

  it("keeps an exact byte budget without a truncation notice", () => {
    expect(truncateBytes("é", 2, { keep: "head" })).toEqual({
      text: "é",
      truncated: false,
      keptBytes: 2,
      droppedBytes: 0
    })
    expect(notice("bytes", 3, 7)).toBe("Showing 3 of 7 bytes; output was truncated.")
  })

  it("pages with one-based offsets and an empty limit", () => {
    const source = "one\ntwo\nthree\n"
    expect(slice(source, { offset: 2, limit: 1 })).toEqual({
      lines: ["two"],
      startLine: 2,
      endLine: 2,
      totalLines: 3
    })
    expect(slice(source, { offset: 0, limit: 0 })).toEqual({
      lines: [],
      startLine: 1,
      endLine: 0,
      totalLines: 3
    })
  })

  // `read` pages with `slice` and both search peers number with
  // `Grouping.sourceLines`. Two copies of that rule is how `read` came to
  // report one more line than `grep` for every file ending in a newline, so
  // the identity is the assertion: not "the two agree today", but "there is
  // only one of them".
  it("numbers lines for read and for both search peers with one function", () => {
    expect(Grouping.sourceLines).toBe(sourceLines)
  })

  it("counts a terminal newline as a terminator rather than as a line", () => {
    for (const text of ["", "alpha", "alpha\n", "alpha\nbeta\n", "alpha\nbeta", "alpha\n\n", "alpha\r\nbeta\r\n"]) {
      expect(slice(text, { offset: 1, limit: 2_000 }).totalLines, text).toBe(Grouping.sourceLines(text).length)
    }
  })
})
