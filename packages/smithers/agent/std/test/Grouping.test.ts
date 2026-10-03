import { describe, expect, it } from "vitest"
import * as Grouping from "../src/internal/Grouping.ts"
import type * as Search from "../src/Search.ts"

describe("Grouping", () => {
  it("assigns shared context to the nearest match, preferring the earlier match on a tie", () => {
    const rows: Array<Search.GrepLine> = [
      { file: "a.py", line: 1, text: "before", kind: "context" },
      { file: "a.py", line: 2, text: "first", kind: "match" },
      { file: "a.py", line: 3, text: "tie", kind: "context" },
      { file: "a.py", line: 4, text: "second", kind: "match" },
      { file: "a.py", line: 5, text: "after", kind: "context" }
    ]
    expect(Grouping.group(rows)).toEqual([
      {
        file: "a.py",
        line: 2,
        text: "first",
        before: [{ line: 1, text: "before" }],
        after: [{ line: 3, text: "tie" }]
      },
      { file: "a.py", line: 4, text: "second", before: [], after: [{ line: 5, text: "after" }] }
    ])
  })

  it("groups interleaved files without leaking context from a file that has no matches", () => {
    expect(Grouping.group([
      { file: "context.txt", line: 1, text: "orphan", kind: "context" },
      { file: "b.txt", line: 2, text: "b", kind: "match" },
      { file: "a.txt", line: 1, text: "a", kind: "match" },
      { file: "b.txt", line: 1, text: "b before", kind: "context" }
    ])).toEqual([
      { file: "b.txt", line: 2, text: "b", before: [{ line: 1, text: "b before" }], after: [] },
      { file: "a.txt", line: 1, text: "a", before: [], after: [] }
    ])
    expect(Grouping.group([])).toEqual([])
  })

  it("annotates only definitions available in the returned file contents", () => {
    const matches: Array<Search.GrepMatch> = [
      { file: "a.py", line: 2, text: "    hit", before: [], after: [] },
      { file: "a.py", line: 4, text: "outside", before: [], after: [] },
      { file: "absent.py", line: 2, text: "hit", before: [], after: [] }
    ]
    const annotated = Grouping.annotate(
      matches,
      new Map([
        ["a.py", ["def find():", "    hit", "", "outside"]]
      ])
    )
    expect(annotated[0]).toEqual({
      ...matches[0],
      symbol: { kind: "def", name: "find", startLine: 1, endLine: 2 }
    })
    expect(annotated[1]).toBe(matches[1])
    expect(annotated[2]).toBe(matches[2])
    expect(matches[0]).not.toHaveProperty("symbol")
  })
})
