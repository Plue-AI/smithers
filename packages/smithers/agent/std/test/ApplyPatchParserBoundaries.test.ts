import { describe, expect, it } from "vitest"
import {
  deriveNewContents,
  ParseError,
  parsePatch,
  seekSequence,
  StreamingPatchParser
} from "../src/internal/ApplyPatch.ts"

const updateChunks = (patch: string) => {
  const hunk = parsePatch(patch).hunks[0]
  if (hunk?.kind !== "update") throw new Error("fixture must declare an update")
  return hunk.chunks
}

const expectParseFailure = (run: () => unknown, message: string, lineNumber?: number) => {
  let failure: unknown
  try {
    run()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(ParseError)
  expect(failure).toMatchObject({
    kind: lineNumber === undefined ? "invalid_patch" : "invalid_hunk",
    lineNumber,
    message
  })
}

describe("V4A streaming boundaries and fuzzy replacement", () => {
  it.each([
    { input: "", message: "invalid patch: The last line of the patch must be '*** End Patch'" },
    { input: "not a patch", message: "invalid patch: The first line of the patch must be '*** Begin Patch'" },
    { input: "+unexpected", message: "invalid patch: The first line of the patch must be '*** Begin Patch'" },
    { input: "\n", message: "invalid patch: The first line of the patch must be '*** Begin Patch'" }
  ])("rejects invalid streaming input $input before returning any hunks", ({ input, message }) => {
    const parser = new StreamingPatchParser()
    expectParseFailure(() => {
      parser.pushDelta(input)
      parser.finish()
    }, message)
  })

  const feeds = [1, 7, 4096].flatMap((width) =>
    ["\n", "\r\n"].flatMap((newline) => [false, true].map((finalNewline) => ({ width, newline, finalNewline })))
  )
  it.each(feeds)(
    "preserves literal hunks with width=$width newline=$newline final=$finalNewline",
    ({ width, newline, finalNewline }) => {
      const lines = [
        "*** Begin Patch",
        "*** Environment ID: remote",
        "*** Add File: notes.txt",
        "+hello 🙂",
        "*** Update File: old.txt",
        "*** Move to: moved.txt",
        "@@ section",
        "-old",
        "+new",
        "*** End of File",
        "*** Delete File: obsolete.txt",
        "*** End Patch"
      ]
      const input = lines.join(newline) + (finalNewline ? newline : "")
      const parser = new StreamingPatchParser()
      for (let offset = 0; offset < input.length; offset += width) parser.pushDelta(input.slice(offset, offset + width))
      expect(parser.finish()).toEqual([
        { kind: "add", path: "notes.txt", contents: "hello 🙂\n" },
        {
          kind: "update",
          path: "old.txt",
          movePath: "moved.txt",
          chunks: [{ changeContext: "section", oldLines: ["old"], newLines: ["new"], isEndOfFile: true }]
        },
        { kind: "delete", path: "obsolete.txt" }
      ])
      expect(parser.environmentId()).toBe("remote")
    }
  )

  it.each(["*** Add File: next.txt", "*** Delete File: next.txt", "*** Update File: next.txt"])(
    "refuses a bodyless update chunk before the next header %s with the exact offending line",
    (next) => {
      const parser = new StreamingPatchParser()
      parser.pushDelta("*** Begin Patch\n*** Update File: file.txt\n@@\n")
      expectParseFailure(
        () => parser.pushDelta(`${next}\n`),
        `invalid hunk at line 4, Unexpected line found in update hunk: '${next}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        4
      )
    }
  )

  it.each([
    {
      prefix: "*** Begin Patch\n*** Update File: file.txt\n",
      line: 3,
      body: "bad",
      message:
        "Unexpected line found in update hunk: 'bad'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
    },
    {
      prefix: "*** Begin Patch\n*** Update File: file.txt\n@@\n+added\n",
      line: 5,
      body: "bad",
      message: "Expected update hunk to start with a @@ context marker, got: 'bad'"
    },
    {
      prefix: "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End of File\n",
      line: 7,
      body: "+late",
      message: "Expected update hunk to start with a @@ context marker, got: '+late'"
    }
  ])("refuses the unsupported update line at line $line", ({ prefix, line, body, message }) => {
    const parser = new StreamingPatchParser()
    parser.pushDelta(prefix)
    expectParseFailure(() => parser.pushDelta(`${body}\n`), `invalid hunk at line ${line}, ${message}`, line)
  })

  it("finish consumes an unterminated body line but still refuses a missing closing marker", () => {
    const parser = new StreamingPatchParser()
    parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+last body")
    expectParseFailure(() => parser.finish(), "invalid patch: The last line of the patch must be '*** End Patch'")
  })

  it.each(["<<EOF", "<<'EOF'", "<<\"EOF\""])(
    "accepts the minimal empty heredoc %s and refuses a missing inner closing marker",
    (opening) => {
      expect(parsePatch(`${opening}\n*** Begin Patch\n*** End Patch\nEOF`)).toEqual({
        hunks: [],
        environmentId: undefined
      })
      expectParseFailure(
        () => parsePatch(`${opening}\n*** Begin Patch\nEOF`),
        "invalid patch: The first line of the patch must be '*** Begin Patch'"
      )
    }
  )

  const typography = [
    ...["‐", "‑", "‒", "–", "—", "―", "−"].map((glyph) => ({ glyph, canonical: "-" })),
    ...["‘", "’", "‚", "‛"].map((glyph) => ({ glyph, canonical: "'" })),
    ...["“", "”", "„", "‟"].map((glyph) => ({ glyph, canonical: "\"" })),
    ...[
      "\u00a0",
      "\u2002",
      "\u2003",
      "\u2004",
      "\u2005",
      "\u2006",
      "\u2007",
      "\u2008",
      "\u2009",
      "\u200a",
      "\u202f",
      "\u205f",
      "\u3000"
    ].map((glyph) => ({ glyph, canonical: " " }))
  ]
  it.each(typography)(
    "matches interior typography $glyph to $canonical and replaces only the selected line",
    ({ glyph, canonical }) => {
      const original = `untouched\nleft${glyph}right\nlast\n`
      const chunks = updateChunks(
        `*** Begin Patch\n*** Update File: file.txt\n@@\n-left${canonical}right\n+changed\n*** End Patch`
      )
      expect(deriveNewContents(original, "file.txt", chunks)).toBe("untouched\nchanged\nlast\n")
    }
  )

  it.each([false, true])("exact matching outranks an earlier fuzzy candidate with eof=%s", (eof) => {
    expect(seekSequence([" target ", "target"], ["target"], 0, eof)).toBe(1)
    expect(seekSequence([" target ", "different"], ["target"], 0, eof)).toBe(eof ? undefined : 0)
  })

  it.each([false, true].flatMap((eof) => [0, 2].map((start) => ({ eof, start }))))(
    "an empty sequence starts at the requested position $start with eof=$eof",
    ({ eof, start }) => {
      expect(seekSequence(["first", "second", "third"], [], start, eof)).toBe(start)
    }
  )

  // The legacy Codex representation places an insertion before its final empty
  // element: https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/file_update.rs
  it.each([
    { original: "\n", expected: "appended\n" },
    { original: "before\n\n", expected: "before\nappended\n" }
  ])("retains legacy trailing-empty insertion placement for source $original", ({ original, expected }) => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: file.txt\n@@\n+appended\n*** End Patch")
    expect(deriveNewContents(original, "file.txt", chunks)).toBe(expected)
  })

  it("requires a real body when an EOF marker precedes every chunk", () => {
    expectParseFailure(
      () => parsePatch("*** Begin Patch\n*** Update File: file.txt\n*** End of File\n*** End Patch"),
      "invalid hunk at line 2, Update file hunk for path 'file.txt' is empty",
      2
    )
  })

  it("accepts another explicit chunk after EOF and applies an insertion and replacement in source order", () => {
    const chunks = updateChunks(
      "*** Begin Patch\n*** Update File: file.txt\n@@\n+appended\n*** End of File\n@@\n-tail\n+TAIL\n*** End Patch"
    )
    expect(chunks).toEqual([
      { changeContext: undefined, oldLines: [], newLines: ["appended"], isEndOfFile: true },
      { changeContext: undefined, oldLines: ["tail"], newLines: ["TAIL"], isEndOfFile: false }
    ])
    expect(deriveNewContents("tail\n", "file.txt", chunks)).toBe("TAIL\nappended\n")
  })

  it.each([
    { original: "", expected: "appended\n" },
    { original: "before", expected: "before\nappended\n" },
    { original: "before\n", expected: "before\nappended\n" }
  ])("applies a parsed pure insertion to source $original without losing its bytes", ({ original, expected }) => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: file.txt\n@@\n+appended\n*** End Patch")
    expect(deriveNewContents(original, "file.txt", chunks)).toBe(expected)
  })

  it("drops only a missing trailing empty removal and retains the actual replacement", () => {
    const chunks = updateChunks("*** Begin Patch\n*** Update File: file.txt\n@@\n-end\n-\n+END\n*** End Patch")
    expect(deriveNewContents("before\nend\n", "file.txt", chunks)).toBe("before\nEND\n")
  })
})
