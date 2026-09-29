import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Edit from "../src/Edit.ts"
import * as Read from "../src/Read.ts"
import { fileInfo, layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** Applies one edit and returns the file as the same host then reads it. */
const editThenRead = (
  files: Readonly<Record<string, string>>,
  input: Parameters<typeof Edit.run>[0]
) =>
  execute(Effect.provide(
    Effect.gen(function*() {
      const result = yield* Edit.run(input)
      const fileSystem = yield* FileSystem.FileSystem
      const content = yield* fileSystem.readFileString(input.path)
      return { result, content }
    }),
    layer({ files })
  ))

const refusal = (
  files: Readonly<Record<string, string>>,
  input: Parameters<typeof Edit.run>[0]
) =>
  execute(Effect.provide(
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Edit.run(input))
      const fileSystem = yield* FileSystem.FileSystem
      const content = yield* fileSystem.readFileString(input.path)
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      return { content, failure: Option.getOrUndefined(failure) }
    }),
    layer({ files })
  ))

describe("Edit anchoring", () => {
  it.each(["oldString", "expect"] as const)(
    "accepts a CRLF read page as %s and preserves its bytes",
    async (anchor) => {
      const content = await execute(Effect.provide(
        Effect.gen(function*() {
          const page = yield* Read.run({ path: "/crlf.txt", offset: 2, limit: 2 })
          yield* Edit.run({
            path: "/crlf.txt",
            ...(anchor === "oldString"
              ? { oldString: page.content }
              : { startLine: page.startLine, endLine: page.endLine, expect: page.content }),
            newString: page.content.replace("two", "TWO")
          })
          const fileSystem = yield* FileSystem.FileSystem
          return yield* fileSystem.readFileString("/crlf.txt")
        }),
        layer({ files: { "/crlf.txt": "one\r\ntwo\r\nthree\r\nfour\r\n" } })
      ))
      expect(content).toBe("one\r\nTWO\r\nthree\r\nfour\r\n")
    }
  )

  it("splices a raw CRLF line replacement without expect", async () => {
    const { content } = await editThenRead(
      { "/crlf.txt": "one\r\ntwo\r\nthree\r\n" },
      { path: "/crlf.txt", startLine: 2, endLine: 2, newString: "TWO\r" }
    )
    expect(content).toBe("one\r\nTWO\r\nthree\r\n")
  })

  it("replaces a byte-exact block and returns the applied hunk", async () => {
    const { content, result } = await editThenRead(
      { "/a.py": "def add(a, b):\n    return a - b\n" },
      { path: "/a.py", oldString: "return a - b", newString: "return a + b" }
    )
    expect(result).toMatchObject({ replacements: 1, startLine: 1, endLine: 2 })
    expect(result.hunk).toBe("def add(a, b):\n    return a + b")
    expect(content).toBe("def add(a, b):\n    return a + b\n")
  })

  it("refuses a block whose file copy differs, and quotes the file's own bytes", async () => {
    // The tolerant cascade used to relocate this edit silently. A whitespace
    // difference the caller cannot see is a file the caller has not read.
    const { content, failure } = await refusal(
      { "/c.py": "value = 1  \nother = 2\n" },
      { path: "/c.py", oldString: "value = 1\nother = 2", newString: "value = 3" }
    )
    expect(failure).toMatchObject({ code: "no_match", path: "/c.py" })
    expect(failure?.message).toContain("Lines 1-2 actually hold this")
    expect(failure?.message).toContain("value = 1  ")
    expect(content).toBe("value = 1  \nother = 2\n")
  })

  it("refuses an indentation-collapsed anchor rather than dedenting a guard", async () => {
    const { failure } = await refusal(
      { "/b.py": "result  =  compute( a ,  b )\n" },
      { path: "/b.py", oldString: "result = compute( a , b )", newString: "result = compute(a, b)" }
    )
    expect(failure?.code).toBe("no_match")
    expect(failure?.message).toContain("result  =  compute( a ,  b )")
  })

  it("says the file is the wrong one when no line of the anchor occurs in it", async () => {
    const { failure } = await refusal(
      { "/d.py": "before = 0\n" },
      { path: "/d.py", oldString: "def target():\n    return 9", newString: "x" }
    )
    expect(failure?.message).toContain("this is the wrong file")
  })

  it("names every line an ambiguous anchor sits on", async () => {
    const { failure } = await refusal(
      { "/e.py": "x = 1\ny = 0\nx = 1\n" },
      { path: "/e.py", oldString: "x = 1", newString: "x = 2" }
    )
    expect(failure?.code).toBe("invalid_input")
    expect(failure?.message).toContain("occurs 2 times")
    expect(failure?.message).toContain("lines 1, 3")
  })

  it("replaces every occurrence when the caller asks for it", async () => {
    const { content, result } = await editThenRead(
      { "/e.py": "x = 1\nx = 1\n" },
      { path: "/e.py", oldString: "x = 1", newString: "x = 2", replaceAll: true }
    )
    expect(result.replacements).toBe(2)
    expect(content).toBe("x = 2\nx = 2\n")
  })

  // A self-overlapping anchor is the case that separates "find every occurrence"
  // from "find every occurrence a replacement can consume". Scanning forward one
  // character at a time reports "aa" twice in "aaa", and splicing both spans
  // writes the replacement twice over bytes only one of them owns.
  it("counts a self-overlapping anchor the way a replacement consumes it", async () => {
    const { content, result } = await editThenRead(
      { "/o.txt": "aaa" },
      { path: "/o.txt", oldString: "aa", newString: "b", replaceAll: true }
    )
    expect(result.replacements).toBe(1)
    expect(content).toBe("ba")
  })

  it("collapses a run of repeated blank lines without doubling the replacement", async () => {
    const { content, result } = await editThenRead(
      { "/o.py": "a\n\n\n\n\nb\n" },
      { path: "/o.py", oldString: "\n\n", newString: "\n", replaceAll: true }
    )
    expect(result.replacements).toBe(2)
    expect(content).toBe("a\n\n\nb\n")
  })

  it("rewrites a separator run byte-exactly", async () => {
    const { content, result } = await editThenRead(
      { "/o.md": "====" },
      { path: "/o.md", oldString: "==", newString: "-", replaceAll: true }
    )
    expect(result.replacements).toBe(2)
    expect(content).toBe("--")
  })

  it("does not call a singly-occurring overlapping anchor ambiguous", async () => {
    const { content, result } = await editThenRead(
      { "/o2.txt": "aab" },
      { path: "/o2.txt", oldString: "aa", newString: "c" }
    )
    expect(result.replacements).toBe(1)
    expect(content).toBe("cb")
  })

  it("anchors on the line range of a prior hit", async () => {
    const { content, result } = await editThenRead(
      { "/f.py": "one\ntwo\nthree\n" },
      { path: "/f.py", startLine: 2, endLine: 2, expect: "two", newString: "TWO" }
    )
    expect(result).toMatchObject({ replacements: 1 })
    expect(content).toBe("one\nTWO\nthree\n")
  })

  it("edits line 1 and the real last line of a trailing-newline file", async () => {
    const first = await editThenRead(
      { "/lines.txt": "first\nlast\n" },
      { path: "/lines.txt", startLine: 1, endLine: 1, newString: "FIRST" }
    )
    const last = await editThenRead(
      { "/lines.txt": "first\nlast\n" },
      { path: "/lines.txt", startLine: 2, endLine: 2, newString: "LAST" }
    )
    expect(first.content).toBe("FIRST\nlast\n")
    expect(last.content).toBe("first\nLAST\n")
  })

  it("uses the same trailing-newline line count as grep", async () => {
    const { content, failure } = await refusal(
      { "/lines.txt": "first\nlast\n" },
      { path: "/lines.txt", startLine: 3, endLine: 3, newString: "phantom" }
    )
    expect(failure).toMatchObject({ code: "offset_out_of_range", path: "/lines.txt" })
    expect(failure?.message).toContain("2 lines")
    expect(content).toBe("first\nlast\n")
  })

  it("refuses a line range whose contents moved, and shows what is there now", async () => {
    const { content, failure } = await refusal(
      { "/g.py": "one\ntwo\nthree\n" },
      { path: "/g.py", startLine: 2, endLine: 2, expect: "TWO", newString: "x" }
    )
    expect(failure?.code).toBe("no_match")
    expect(failure?.message).toContain("do not hold expect")
    expect(failure?.message).toContain("two")
    expect(content).toBe("one\ntwo\nthree\n")
  })

  it("refuses a line range outside the file", async () => {
    const { failure } = await refusal(
      { "/h.py": "one\n" },
      { path: "/h.py", startLine: 40, endLine: 41, newString: "x" }
    )
    expect(failure?.code).toBe("offset_out_of_range")
  })

  it("refuses an endLine past the real end instead of clamping it", async () => {
    const { content, failure } = await refusal(
      { "/h.py": "one\ntwo\n" },
      { path: "/h.py", startLine: 2, endLine: 9, newString: "x" }
    )
    expect(failure).toMatchObject({ code: "offset_out_of_range", path: "/h.py" })
    expect(failure?.message).toContain("endLine 9")
    expect(failure?.message).toContain("2 lines")
    expect(content).toBe("one\ntwo\n")
  })

  it("rejects expect when oldString is the anchor", async () => {
    const { content, failure } = await refusal(
      { "/ignored.py": "old\n" },
      { path: "/ignored.py", oldString: "old", expect: "WRONG", newString: "new" }
    )
    expect(failure).toMatchObject({ code: "invalid_input", path: "/ignored.py" })
    expect(failure?.message).toContain("expect")
    expect(content).toBe("old\n")
  })

  it("rejects replaceAll when a line span is the anchor", async () => {
    const { content, failure } = await refusal(
      { "/ignored.py": "one\ntwo\n" },
      { path: "/ignored.py", startLine: 1, endLine: 1, replaceAll: true, newString: "ONE" }
    )
    expect(failure).toMatchObject({ code: "invalid_input", path: "/ignored.py" })
    expect(failure?.message).toContain("replaceAll")
    expect(content).toBe("one\ntwo\n")
  })

  it("refuses inverted, doubled, and missing anchors", async () => {
    const inverted = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", startLine: 2, endLine: 1, newString: "x" }
    )
    const both = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", oldString: "one", startLine: 1, endLine: 1, newString: "x" }
    )
    const half = await refusal(
      { "/i.py": "one\ntwo\n" },
      { path: "/i.py", startLine: 1, newString: "x" }
    )
    const neither = await refusal({ "/i.py": "one\ntwo\n" }, { path: "/i.py", newString: "x" })
    const blank = await refusal({ "/i.py": "one\ntwo\n" }, { path: "/i.py", oldString: "", newString: "x" })
    expect(inverted.failure?.message).toContain("before startLine")
    expect(both.failure?.message).toContain("not by both")
    expect(half.failure?.message).toContain("both startLine and endLine")
    expect(neither.failure?.message).toContain("write flow")
    expect(blank.failure?.message).toContain("must not be empty")
  })

  it("fails with not_found on a file that is not there", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({ path: "/absent.py", oldString: "a", newString: "b" })),
      layer({ files: {} })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.code).toBe("not_found")
    }
  })

  it.each([
    { location: "before", bytes: new Uint8Array([0xff, 0x0a, ...new TextEncoder().encode("target\n")]) },
    { location: "after", bytes: new Uint8Array([...new TextEncoder().encode("target\n"), 0xff, 0x0a]) }
  ])("refuses invalid UTF-8 $location the target without changing bytes or mode", async ({ bytes }) => {
    const original = bytes.slice()
    let stored = bytes.slice()
    let mode = 0o100644
    let writes = 0
    const host = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      makeDirectory: () => Effect.void,
      remove: () => Effect.void,
      stat: () => Effect.succeed(fileInfo({ mode, size: stored.byteLength })),
      readFile: () => Effect.succeed(stored.slice()),
      readFileString: () => Effect.succeed(new TextDecoder().decode(stored)),
      writeFileString: (_path, content) =>
        Effect.sync(() => {
          writes++
          stored = new TextEncoder().encode(content)
          mode = 0o100755
        }),
      chmod: (_path, value) =>
        Effect.sync(() => {
          mode = 0o100000 | value
        })
    }))
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({ path: "/invalid.txt", oldString: "target", newString: "changed" })),
      host
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "binary_file", path: "/invalid.txt" })
    expect(stored).toEqual(original)
    expect(mode).toBe(0o100644)
    expect(writes).toBe(0)
  })

  it("refuses a NUL-containing file before writing", async () => {
    const original = new Uint8Array([...new TextEncoder().encode("target\n"), 0, 0x0a])
    let stored = original.slice()
    let writes = 0
    const host = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      makeDirectory: () => Effect.void,
      remove: () => Effect.void,
      readFile: () => Effect.succeed(stored.slice()),
      readFileString: () => Effect.succeed(new TextDecoder().decode(stored)),
      writeFileString: (_path, content) =>
        Effect.sync(() => {
          writes++
          stored = new TextEncoder().encode(content)
        })
    }))
    const exit = await execute(Effect.provide(
      Effect.exit(Edit.run({ path: "/nul.txt", oldString: "target", newString: "changed" })),
      host
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "binary_file", path: "/nul.txt" })
    expect(stored).toEqual(original)
    expect(writes).toBe(0)
  })

  it("puts back permission bits the host's write moved", async () => {
    // Five graded SWE-bench patches shipped spurious 100644 -> 100755 sections
    // around their real edits. A patch is content; mode is not this library's
    // to change.
    const chmods: Array<{ readonly path: string; readonly mode: number }> = []
    let temporary = ""
    let mode = 0o100644
    const host = Layer.succeed(FileSystem.FileSystem)(FileSystem.makeNoop({
      makeDirectory: () => Effect.void,
      realPath: (path) => Effect.succeed(path),
      rename: () => Effect.void,
      remove: () => Effect.void,
      stat: () => Effect.succeed(fileInfo({ mode })),
      readFile: () => Effect.succeed(new TextEncoder().encode("value = 1\n")),
      readFileString: () => Effect.succeed("value = 1\n"),
      writeFileString: (path) =>
        Effect.sync(() => {
          temporary = path
          // A host that writes by replacing the file loses its bits.
          mode = 0o100755
        }),
      chmod: (path, value) =>
        Effect.sync(() => {
          chmods.push({ path, mode: value })
          mode = 0o100000 | value
        })
    }))
    await execute(Effect.provide(
      Edit.run({ path: "/a.py", oldString: "value = 1", newString: "value = 2" }),
      host
    ))
    expect(temporary).toMatch(/^\/\.smithers-.+\.tmp$/)
    expect(chmods).toEqual([{ path: temporary, mode: 0o644 }])
  })

  it("declares compensable hermetic effects and narrows each invocation", () => {
    expect(Edit.effects).toMatchObject({ tier: "compensable", mode: "hermetic" })
    expect(Edit.effectsFor({ path: "/a.py", newString: "x", oldString: "y" }).writes).toEqual(["/a.py"])
  })
})
