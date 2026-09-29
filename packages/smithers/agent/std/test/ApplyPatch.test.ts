import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Cause, Effect, Exit, FileSystem, Option, Path, PlatformError } from "effect"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import {
  deriveNewContents,
  ParseError,
  parsePatch,
  printSummary,
  seekSequence,
  StreamingPatchParser
} from "../src/internal/ApplyPatch.ts"
import { sourceLines } from "../src/internal/Text.ts"
import { fileInfo, layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
const executeExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect)

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`

describe("parsePatch", () => {
  it("rejects a bad first line with Codex's message", () => {
    expect(() => parsePatch("bad")).toThrowError(
      "invalid patch: The first line of the patch must be '*** Begin Patch'"
    )
  })

  it("rejects a missing End Patch with Codex's message", () => {
    expect(() => parsePatch("*** Begin Patch\nbad")).toThrowError(
      "invalid patch: The last line of the patch must be '*** End Patch'"
    )
  })

  it("rejects an empty patch on the last-line rule, matching Rust lines()", () => {
    expect(() => parsePatch("")).toThrowError(
      "invalid patch: The last line of the patch must be '*** End Patch'"
    )
  })

  it("accepts an empty hunk list", () => {
    expect(parsePatch("*** Begin Patch\n*** End Patch").hunks).toEqual([])
  })

  it("tolerates whitespace around the boundary markers", () => {
    const parsed = parsePatch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch")
    expect(parsed.hunks).toEqual([{ kind: "add", path: "foo", contents: "hi\n" }])
  })

  it("rejects an empty update hunk with the hunk line number", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Update File: test.py\n*** End Patch")).toThrowError(
      "invalid hunk at line 2, Update file hunk for path 'test.py' is empty"
    )
  })

  it("parses add, delete, and move-update hunks", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123\n*** End Patch"
    )
    expect(parsed.hunks).toEqual([
      { kind: "add", path: "path/add.py", contents: "abc\ndef\n" },
      { kind: "delete", path: "path/delete.py" },
      {
        kind: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [{
          changeContext: "def f():",
          oldLines: ["    pass"],
          newLines: ["    return 123"],
          isEndOfFile: false
        }]
      }
    ])
  })

  it("parses an update hunk followed by an add hunk", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Update File: file.py\n@@\n+line\n*** Add File: other.py\n+content\n*** End Patch"
    )
    expect(parsed.hunks).toEqual([
      {
        kind: "update",
        path: "file.py",
        movePath: undefined,
        chunks: [{ changeContext: undefined, oldLines: [], newLines: ["line"], isEndOfFile: false }]
      },
      { kind: "add", path: "other.py", contents: "content\n" }
    ])
  })

  it("parses an update chunk without an explicit @@ header", () => {
    const parsed = parsePatch("*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch")
    expect(parsed.hunks).toEqual([{
      kind: "update",
      path: "file2.py",
      movePath: undefined,
      chunks: [{
        changeContext: undefined,
        oldLines: ["import foo"],
        newLines: ["import foo", "bar"],
        isEndOfFile: false
      }]
    }])
  })

  it("preserves the End of File marker and ignores blank lines after it", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch"
    )
    expect(parsed.hunks).toEqual([{
      kind: "update",
      path: "file.txt",
      movePath: undefined,
      chunks: [{ changeContext: undefined, oldLines: [], newLines: ["quux"], isEndOfFile: true }]
    }])
  })

  it("unwraps heredoc-wrapped patches in lenient mode", () => {
    const inner = "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch"
    for (const open of ["<<EOF", "<<'EOF'", "<<\"EOF\""]) {
      const parsed = parsePatch(`${open}\n${inner}\nEOF\n`)
      expect(parsed.hunks).toHaveLength(1)
    }
  })

  it("rejects mismatched heredoc quotes with the strict error", () => {
    const inner = "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch"
    expect(() => parsePatch(`<<"EOF'\n${inner}\nEOF\n`)).toThrowError(
      "invalid patch: The first line of the patch must be '*** Begin Patch'"
    )
  })

  it("reports the missing closing marker inside a heredoc", () => {
    expect(() => parsePatch("<<EOF\n*** Begin Patch\n*** Update File: file2.py\nEOF\n")).toThrowError(
      "invalid patch: The last line of the patch must be '*** End Patch'"
    )
  })

  it("parses the Environment ID preamble", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Environment ID: remote\n*** Add File: hello.txt\n+hello\n*** End Patch"
    )
    expect(parsed.environmentId).toBe("remote")
    expect(parsed.hunks).toEqual([{ kind: "add", path: "hello.txt", contents: "hello\n" }])
  })

  it("rejects an empty or duplicate Environment ID", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Environment ID:   \n*** Add File: a\n+x\n*** End Patch"))
      .toThrowError("invalid patch: apply_patch environment_id cannot be empty")
    expect(() =>
      parsePatch(
        "*** Begin Patch\n*** Environment ID: first\n*** Environment ID: second\n*** Add File: a\n+x\n*** End Patch"
      )
    ).toThrowError("invalid patch: apply_patch environment_id cannot be specified more than once")
  })
})

describe("StreamingPatchParser", () => {
  it("streams complete lines before End Patch", () => {
    const parser = new StreamingPatchParser()
    expect(parser.pushDelta("*** Begin Patch\n*** Add File: src/hello.txt\n+hello\n+wor")).toEqual([
      { kind: "add", path: "src/hello.txt", contents: "hello\n" }
    ])
    expect(parser.pushDelta("ld\n")).toEqual([
      { kind: "add", path: "src/hello.txt", contents: "hello\nworld\n" }
    ])
  })

  it("keeps indented update markers as context lines", () => {
    const parser = new StreamingPatchParser()
    const hunks = parser.pushDelta(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n *** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch\n"
    )
    expect(hunks).toEqual([{
      kind: "update",
      path: "a.txt",
      movePath: undefined,
      chunks: [
        {
          changeContext: undefined,
          oldLines: ["old a", "*** Update File: b.txt"],
          newLines: ["new a", "*** Update File: b.txt"],
          isEndOfFile: false
        },
        { changeContext: undefined, oldLines: ["old b"], newLines: ["new b"], isEndOfFile: false }
      ]
    }])
  })

  it("preserves bare empty update lines as empty context lines", () => {
    const parser = new StreamingPatchParser()
    const hunks = parser.pushDelta(
      "*** Begin Patch\n*** Update File: file.txt\n@@\n context before\n\n context after\n*** End Patch\n"
    )
    expect(hunks).toEqual([{
      kind: "update",
      path: "file.txt",
      movePath: undefined,
      chunks: [{
        changeContext: undefined,
        oldLines: ["context before", "", "context after"],
        newLines: ["context before", "", "context after"],
        isEndOfFile: false
      }]
    }])
  })

  it("strips CR from CRLF line endings and keeps interior CR", () => {
    const parser = new StreamingPatchParser()
    const hunks = parser.pushDelta(
      "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\r\n+new\r\n*** End Patch\r\n"
    )
    expect(hunks).toEqual([{
      kind: "update",
      path: "file.txt",
      movePath: undefined,
      chunks: [{ changeContext: undefined, oldLines: ["old\r"], newLines: ["new"], isEndOfFile: false }]
    }])
  })

  it("finish processes a final line without a newline", () => {
    const parser = new StreamingPatchParser()
    parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch")
    expect(parser.finish()).toEqual([{ kind: "add", path: "file.txt", contents: "hello\n" }])
  })

  it("finish requires End Patch", () => {
    const parser = new StreamingPatchParser()
    parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n")
    expect(() => parser.finish()).toThrowError(
      "invalid patch: The last line of the patch must be '*** End Patch'"
    )
  })

  it("rejects non-blank content after End Patch", () => {
    const parser = new StreamingPatchParser()
    expect(() => parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\nextra\n"))
      .toThrowError("invalid patch: The last line of the patch must be '*** End Patch'")
    const parser2 = new StreamingPatchParser()
    expect(parser2.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch\n \t\n")).toEqual([
      { kind: "add", path: "file.txt", contents: "hello\n" }
    ])
  })

  it("emits Codex's hunk-header and update-hunk errors verbatim", () => {
    const header =
      "is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\nbad\n")).toThrowError(
      `invalid hunk at line 2, 'bad' ${header}`
    )
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Add File: f\nbad\n")).toThrowError(
      `invalid hunk at line 3, 'bad' ${header}`
    )
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Delete File: f\nbad\n")).toThrowError(
      `invalid hunk at line 3, 'bad' ${header}`
    )
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Update File: f\n@@\n*** End Patch\n"))
      .toThrowError("invalid hunk at line 4, Update hunk does not contain any lines")
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Update File: f\n@@\n*** End of File\n"))
      .toThrowError("invalid hunk at line 4, Update hunk does not contain any lines")
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Update File: f\n@@\n@@\n")).toThrowError(
      "invalid hunk at line 4, Unexpected line found in update hunk: '@@'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
    )
    expect(() => new StreamingPatchParser().pushDelta("*** Begin Patch\n*** Update File: f\n@@\n-old\nbad\n"))
      .toThrowError("invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: 'bad'")
    expect(() =>
      new StreamingPatchParser().pushDelta(
        "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** Delete File: other.txt\n"
      )
    ).toThrowError("invalid hunk at line 2, Update file hunk for path 'old.txt' is empty")
  })

  it("marks parse failures with structured kind and line numbers", () => {
    try {
      new StreamingPatchParser().pushDelta("*** Begin Patch\nbad\n")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect((error as ParseError).kind).toBe("invalid_hunk")
      expect((error as ParseError).lineNumber).toBe(2)
    }
  })
})

describe("seekSequence", () => {
  it("finds exact sequences", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toBe(1)
  })

  it("ignores trailing whitespace", () => {
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0)
  })

  it("ignores leading and trailing whitespace", () => {
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0)
  })

  it("returns undefined when the pattern is longer than the input", () => {
    expect(seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeUndefined()
  })

  it("normalises unicode punctuation for the most lenient pass", () => {
    expect(seekSequence(["let x = ‘a’ — done"], ["let x = 'a' - done"], 0, false)).toBe(0)
  })

  it("anchors end-of-file patterns at the end first", () => {
    expect(seekSequence(["a", "b", "a", "b"], ["a", "b"], 0, true)).toBe(2)
  })
})

describe("deriveNewContents", () => {
  it("splices CRLF source lines without changing their bytes", () => {
    const oldLines = sourceLines("two\r\nthree\r\n")
    expect(deriveNewContents("one\r\ntwo\r\nthree\r\nfour\r\n", "f.txt", [{
      changeContext: undefined,
      oldLines: [...oldLines],
      newLines: oldLines.map((line) => line.replace("two", "TWO")),
      isEndOfFile: false
    }])).toBe("one\r\nTWO\r\nthree\r\nfour\r\n")
  })

  it("applies a simple replacement", () => {
    expect(
      deriveNewContents("a\nold\nc\n", "f.txt", [
        { changeContext: undefined, oldLines: ["old"], newLines: ["new"], isEndOfFile: false }
      ])
    ).toBe("a\nnew\nc\n")
  })

  it("locates chunks through @@ context and applies adjacent chunks in order", () => {
    const original = "impl A\n  one\nimpl B\n  one\n"
    expect(
      deriveNewContents(original, "f.rs", [
        { changeContext: "impl A", oldLines: ["  one"], newLines: ["  uno"], isEndOfFile: false },
        { changeContext: "impl B", oldLines: ["  one"], newLines: ["  ein"], isEndOfFile: false }
      ])
    ).toBe("impl A\n  uno\nimpl B\n  ein\n")
  })

  it("fails with Codex's context error text", () => {
    expect(() =>
      deriveNewContents("a\n", "f.txt", [
        { changeContext: "missing", oldLines: ["a"], newLines: ["b"], isEndOfFile: false }
      ])
    ).toThrowError("Failed to find context 'missing' in f.txt")
  })

  it("fails with Codex's expected-lines error text", () => {
    expect(() =>
      deriveNewContents("a\nb\n", "f.txt", [
        { changeContext: undefined, oldLines: ["nope", "nah"], newLines: ["x"], isEndOfFile: false }
      ])
    ).toThrowError("Failed to find expected lines in f.txt:\nnope\nnah")
  })

  it("appends pure additions at the end of file", () => {
    expect(
      deriveNewContents("a\nb\n", "f.txt", [
        { changeContext: undefined, oldLines: [], newLines: ["c"], isEndOfFile: false }
      ])
    ).toBe("a\nb\nc\n")
  })

  it("retries without the trailing empty pattern line at end of file", () => {
    expect(
      deriveNewContents("a\nend\n", "f.txt", [
        { changeContext: undefined, oldLines: ["end", ""], newLines: ["END", ""], isEndOfFile: true }
      ])
    ).toBe("a\nEND\n")
  })

  it("ensures a trailing newline on the result", () => {
    expect(
      deriveNewContents("only", "f.txt", [
        { changeContext: undefined, oldLines: ["only"], newLines: ["one"], isEndOfFile: false }
      ])
    ).toBe("one\n")
  })
})

describe("printSummary", () => {
  it("renders the Codex A/M/D summary", () => {
    expect(printSummary({ added: ["a.txt"], modified: ["m.txt"], deleted: ["d.txt"] })).toBe(
      "Success. Updated the following files:\nA a.txt\nM m.txt\nD d.txt\n"
    )
  })
})

describe("ApplyPatch.run", () => {
  it.each(
    [
      { reason: "PermissionDenied", code: "permission_denied" },
      { reason: "Unknown", code: "command_failed" }
    ] as const
  )("maps $reason during path preflight to $code", async ({ reason, code }) => {
    const path = "/target.txt"
    const host = FileSystem.makeNoop({
      realPath: () =>
        Effect.fail(PlatformError.systemError({
          _tag: reason,
          module: "FileSystem",
          method: "realPath",
          pathOrDescriptor: path
        }))
    })
    const exit = await executeExit(Effect.provide(
      Effect.provideService(
        ApplyPatch.run({ input: wrap(`*** Update File: ${path}\n@@\n-old\n+new`) }),
        FileSystem.FileSystem,
        host
      ),
      layer()
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code, path })
  })

  it("adds, updates, moves, and deletes files", async () => {
    const patch = wrap(
      "*** Add File: /nested/add/added.txt\n+hello\n*** Update File: /update.txt\n@@\n-old\n+new\n*** Update File: /move-src.txt\n*** Move to: /nested/move/move-dst.txt\n@@\n-from\n+to\n*** Delete File: /gone.txt"
    )
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const result = yield* ApplyPatch.run({ input: patch })
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.readFile("/nested/add/added.txt")).toEqual(new TextEncoder().encode("hello\n"))
        expect(yield* fs.readFile("/update.txt")).toEqual(new TextEncoder().encode("a\nnew\nb\n"))
        expect(yield* fs.readFile("/nested/move/move-dst.txt")).toEqual(new TextEncoder().encode("to\n"))
        expect(yield* fs.exists("/gone.txt")).toBe(false)
        expect(yield* fs.exists("/move-src.txt")).toBe(false)
        return result
      }),
      layer({
        files: {
          "/update.txt": "a\nold\nb\n",
          "/move-src.txt": "from\n",
          "/gone.txt": "x\n"
        }
      })
    ))
    expect(result.output).toBe(
      "Success. Updated the following files:\nA /nested/add/added.txt\nM /update.txt\nM /nested/move/move-dst.txt\nD /gone.txt\n"
    )
    expect(result.added).toEqual(["/nested/add/added.txt"])
    expect(result.modified).toEqual(["/update.txt", "/nested/move/move-dst.txt"])
    expect(result.deleted).toEqual(["/gone.txt"])
  })

  it("puts back permission bits the host's write moved", async () => {
    // The same rule `edit` and `write` follow, at the third door onto the same
    // files. Five graded SWE-bench patches shipped spurious 100644 -> 100755
    // sections around their real edits, and a grader that reverse-applies a
    // patch can fail on a mode section the agent never intended.
    const chmods: Array<{ readonly path: string; readonly mode: number }> = []
    let temporary = ""
    let mode = 0o100644
    const host = FileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path),
      rename: () => Effect.void,
      remove: () => Effect.void,
      stat: () => Effect.succeed(fileInfo({ mode })),
      readFile: () => Effect.succeed(new TextEncoder().encode("old\n")),
      writeFile: (path) =>
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
    })
    await execute(Effect.provide(
      Effect.provideService(
        ApplyPatch.run({ input: wrap("*** Update File: /a.txt\n@@\n-old\n+new") }),
        FileSystem.FileSystem,
        host
      ),
      layer()
    ))
    expect(temporary).toMatch(/^\/\.smithers-.+\.tmp$/)
    expect(chmods).toEqual([{ path: temporary, mode: 0o644 }])
  })

  it.each([
    { location: "before", bytes: new Uint8Array([0xff, 0x0a, ...new TextEncoder().encode("target\n")]) },
    { location: "after", bytes: new Uint8Array([...new TextEncoder().encode("target\n"), 0xff, 0x0a]) }
  ])("refuses invalid UTF-8 $location an update target without changing bytes or mode", async ({ bytes }) => {
    const original = bytes.slice()
    let stored = bytes.slice()
    let mode = 0o100644
    let writes = 0
    const host = FileSystem.makeNoop({
      stat: () => Effect.succeed(fileInfo({ mode, size: stored.byteLength })),
      readFile: () => Effect.succeed(stored.slice()),
      writeFile: (_path, content) =>
        Effect.sync(() => {
          writes++
          stored = content.slice()
          mode = 0o100755
        }),
      chmod: (_path, value) =>
        Effect.sync(() => {
          mode = 0o100000 | value
        })
    })
    const exit = await executeExit(Effect.provide(
      Effect.provideService(
        ApplyPatch.run({ input: wrap("*** Update File: /invalid.txt\n@@\n-target\n+changed") }),
        FileSystem.FileSystem,
        host
      ),
      layer()
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "binary_file", path: "/invalid.txt" })
    expect(stored).toEqual(original)
    expect(mode).toBe(0o100644)
    expect(writes).toBe(0)
  })

  it("refuses a NUL-containing update target before writing", async () => {
    const original = new Uint8Array([...new TextEncoder().encode("target\n"), 0, 0x0a])
    let stored = original.slice()
    let writes = 0
    const host = FileSystem.makeNoop({
      readFile: () => Effect.succeed(stored.slice()),
      writeFile: (_path, content) =>
        Effect.sync(() => {
          writes++
          stored = content.slice()
        })
    })
    const exit = await executeExit(Effect.provide(
      Effect.provideService(
        ApplyPatch.run({ input: wrap("*** Update File: /nul.txt\n@@\n-target\n+changed") }),
        FileSystem.FileSystem,
        host
      ),
      layer()
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "binary_file", path: "/nul.txt" })
    expect(stored).toEqual(original)
    expect(writes).toBe(0)
  })

  it("preflights every update before adding, modifying, or deleting files", async () => {
    const patch = wrap(
      "*** Add File: /added.txt\n+added\n*** Update File: /valid.txt\n@@\n-valid\n+changed\n*** Update File: /miss.txt\n@@\n-missing\n+changed"
    )
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(ApplyPatch.run({ input: patch }))
        const fileSystem = yield* FileSystem.FileSystem
        return {
          exit,
          addedExists: yield* fileSystem.exists("/added.txt"),
          valid: yield* fileSystem.readFileString("/valid.txt"),
          missed: yield* fileSystem.readFileString("/miss.txt")
        }
      }),
      layer({ files: { "/valid.txt": "valid\n", "/miss.txt": "present\n" } })
    ))
    const failure = Exit.isFailure(result.exit)
      ? Option.getOrUndefined(Cause.findErrorOption(result.exit.cause))
      : undefined
    expect(failure).toMatchObject({ code: "no_match", path: "/miss.txt" })
    expect(result.addedExists).toBe(false)
    expect(result.valid).toBe("valid\n")
    expect(result.missed).toBe("present\n")
  })

  it("reports completed paths when a later write fails", async () => {
    let writes = 0
    const host = FileSystem.makeNoop({
      makeDirectory: () => Effect.void,
      writeFile: (path) => {
        writes++
        return path === "/second.txt"
          ? Effect.fail(PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: path
          }))
          : Effect.void
      }
    })
    const exit = await executeExit(Effect.provide(
      Effect.provideService(
        ApplyPatch.run({
          input: wrap("*** Add File: /first.txt\n+first\n*** Add File: /second.txt\n+second")
        }),
        FileSystem.FileSystem,
        host
      ),
      layer()
    ))
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "permission_denied", path: "/second.txt" })
    expect(failure?.message).toContain("added=[\"/first.txt\"]")
    expect(failure?.message).toContain("modified=[]")
    expect(failure?.message).toContain("deleted=[]")
    expect(writes).toBe(2)
  })

  it("fails with invalid_input and the Codex parse message", async () => {
    const exit = await executeExit(Effect.provide(ApplyPatch.run({ input: "bad" }), layer()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain(
      "The first line of the patch must be '*** Begin Patch'"
    )
  })

  it("fails with no_match and the Codex expected-lines message", async () => {
    const patch = wrap("*** Update File: /a.txt\n@@\n-missing\n+x")
    const exit = await executeExit(Effect.provide(
      ApplyPatch.run({ input: patch }),
      layer({ files: { "/a.txt": "present\n" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("Failed to find expected lines in /a.txt")
  })

  // Two sections for one path both derive from the same on-disk original, so
  // the second write erased the first while the summary claimed two
  // modifications. The patch is refused whole, before anything is written.
  it("refuses a patch that names one path in two sections", async () => {
    const patch = wrap(
      "*** Update File: /a.txt\n@@\n-one\n+ONE\n*** Update File: /a.txt\n@@\n-two\n+TWO"
    )
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(ApplyPatch.run({ input: patch }))
        const fileSystem = yield* FileSystem.FileSystem
        return { exit, contents: yield* fileSystem.readFileString("/a.txt") }
      }),
      layer({ files: { "/a.txt": "one\ntwo\n" } })
    ))
    const failure = Exit.isFailure(result.exit)
      ? Option.getOrUndefined(Cause.findErrorOption(result.exit.cause))
      : undefined

    expect(failure).toMatchObject({ code: "invalid_input", path: "/a.txt" })
    expect(result.contents).toBe("one\ntwo\n")
  })

  it("refuses equivalent path spellings and symlinks before writing on the real filesystem", async () => {
    const results = await execute(Effect.scoped(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped()
        const original = `${root}/a.txt`
        const alias = `${root}/alias.txt`
        yield* fs.writeFileString(original, "one\ntwo\n")
        yield* fs.symlink(original, alias)
        const results = []
        for (const second of [`${root}/./a.txt`, alias]) {
          const exit = yield* Effect.exit(ApplyPatch.run({
            input: wrap(
              `*** Update File: ${original}\n@@\n-one\n+ONE\n*** Update File: ${second}\n@@\n-two\n+TWO`
            )
          }))
          results.push({
            failure: Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
            contents: yield* fs.readFileString(original)
          })
        }
        const collision = yield* Effect.exit(ApplyPatch.run({
          input: wrap(
            `*** Update File: ${original}\n*** Move to: ${root}/b.txt\n@@\n-one\n+ONE\n*** Add File: ${root}/./b.txt\n+other`
          )
        }))
        const collisionContents = yield* fs.readFileString(original)
        const destinationExists = yield* fs.exists(`${root}/b.txt`)
        const move = yield* Effect.exit(ApplyPatch.run({
          input: wrap(
            `*** Update File: ${original}\n*** Move to: ${root}/./a.txt\n@@\n-one\n+ONE`
          )
        }))
        return {
          results,
          collision,
          collisionContents,
          destinationExists,
          move,
          contents: yield* fs.readFileString(original)
        }
      }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(Path.layer))
    ))
    for (const result of results.results) {
      expect(result.failure).toMatchObject({ code: "invalid_input" })
      expect(result.contents).toBe("one\ntwo\n")
    }
    expect(
      Exit.isFailure(results.collision)
        ? Option.getOrUndefined(Cause.findErrorOption(results.collision.cause))
        : undefined
    )
      .toMatchObject({ code: "invalid_input" })
    expect(results.collisionContents).toBe("one\ntwo\n")
    expect(results.destinationExists).toBe(false)
    expect(Exit.isSuccess(results.move)).toBe(true)
    expect(results.contents).toBe("ONE\ntwo\n")
  })

  it("refuses a patch whose move destination is another section's path", async () => {
    const patch = wrap(
      "*** Update File: /a.txt\n*** Move to: /b.txt\n@@\n-one\n+ONE\n*** Add File: /b.txt\n+other"
    )
    const result = await execute(Effect.provide(
      Effect.gen(function*() {
        const exit = yield* Effect.exit(ApplyPatch.run({ input: patch }))
        const fileSystem = yield* FileSystem.FileSystem
        return { exit, moved: yield* fileSystem.exists("/b.txt") }
      }),
      layer({ files: { "/a.txt": "one\n" } })
    ))
    const failure = Exit.isFailure(result.exit)
      ? Option.getOrUndefined(Cause.findErrorOption(result.exit.cause))
      : undefined

    expect(failure).toMatchObject({ code: "invalid_input", path: "/b.txt" })
    expect(result.moved).toBe(false)
  })

  it("fails with the Codex read message for a missing update target", async () => {
    const patch = wrap("*** Update File: /nope.txt\n@@\n-a\n+b")
    const exit = await executeExit(Effect.provide(ApplyPatch.run({ input: patch }), layer()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("Failed to read file to update /nope.txt")
  })
})

describe("ApplyPatch.paths", () => {
  it("names every path the parser run uses would write, including an indented header", () => {
    const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hi\n  *** Delete File: /Users/x/important.txt\n" +
      "*** Update File: a.ts\n*** Move to: b.ts\n@@\n-a\n+b\n*** End Patch"
    expect(parsePatch(patch).hunks.map((hunk) => hunk.path)).toEqual(["notes.txt", "/Users/x/important.txt", "a.ts"])
    expect(ApplyPatch.paths(patch)).toEqual(["notes.txt", "/Users/x/important.txt", "a.ts", "b.ts"])
  })

  it("is undefined for a patch run would refuse to parse", () => {
    expect(ApplyPatch.paths("*** Begin Patch\n*** Delete File: a.ts\n")).toBeUndefined()
    expect(ApplyPatch.paths("not a patch")).toBeUndefined()
  })
})
