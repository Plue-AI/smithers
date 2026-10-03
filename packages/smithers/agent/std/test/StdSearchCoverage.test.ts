import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import { Context, Effect, PlatformError, Sink, Stream } from "effect"
import * as FileSystem from "effect/FileSystem"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as ContractFailures from "../src/internal/SearchContract.ts"
import * as Ls from "../src/Ls.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as Search from "../src/Search.ts"
import * as SearchContract from "../src/SearchContract.ts"
import { fileInfo } from "./TestLayers.ts"

const summary = { type: "summary", data: { stats: { searches: 1 } } }
const records = (...events: ReadonlyArray<unknown>): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n"
const line = (type: "match" | "context", file: string, number: number, text: string) => ({
  type,
  data: { path: { text: file }, lines: { text }, line_number: number }
})
const grepInput: Search.GrepInput = {
  root: "/search",
  pattern: "needle",
  globs: [],
  fixedStrings: false,
  ignoreCase: false,
  smartCase: false,
  beforeContext: 0,
  afterContext: 0,
  filesWithMatches: false,
  hidden: false,
  symbols: false,
  limit: 10
}

// Script only the process protocol. The filesystem still supplies the real
// targets, so no malformed output can bypass root discovery or target selection.
const native = (options: {
  readonly json: string
  readonly binary?: string
  readonly stderr?: string
  readonly binaryStderr?: string
  readonly exitCode?: number
  readonly commands?: Array<ChildProcess.StandardCommand>
}) =>
  Effect.gen(function*() {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const spawner = ChildProcessSpawner.makeNoop({
      spawn: (value) =>
        Effect.sync(() => {
          const command = value as ChildProcess.StandardCommand
          options.commands?.push(command)
          const json = command.args.includes("--json")
          const stdout = Stream.make(new TextEncoder().encode(json ? options.json : options.binary ?? ""))
          const stderr = Stream.make(new TextEncoder().encode(json ? options.stderr ?? "" : options.binaryStderr ?? ""))
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(options.exitCode ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout,
            stderr,
            all: Stream.concat(stdout, stderr),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    })
    return NativeSearch.make(Context.add(services, ChildProcessSpawner.ChildProcessSpawner, spawner))
  })

const withRoot = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = mkdtempSync(join(tmpdir(), "std-search-boundary-"))
  writeFileSync(join(root, "a.txt"), "needle\n")
  try {
    return await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("native search protocol boundaries", () => {
  it.each([
    ["invalid JSON", "{broken\n"],
    ["null event", records(null)],
    ["primitive event", records(1)],
    ["missing event type", records({ data: {} })],
    ["unknown event type", records({ type: "progress", data: {} })],
    ["missing match data", records({ type: "match" })],
    ["missing path", records({ type: "match", data: { lines: { text: "needle" }, line_number: 1 } })],
    [
      "non-text path",
      records({ type: "match", data: { path: { bytes: "YS50eHQ=" }, lines: { text: "needle" }, line_number: 1 } })
    ],
    ["missing line text", records({ type: "context", data: { path: { text: "a.txt" }, line_number: 1 } })],
    [
      "non-string line text",
      records({ type: "match", data: { path: { text: "a.txt" }, lines: { text: 1 }, line_number: 1 } })
    ],
    [
      "non-number line",
      records({ type: "match", data: { path: { text: "a.txt" }, lines: { text: "needle" }, line_number: "1" } })
    ],
    ["begin without path", records({ type: "begin", data: {} })],
    ["end without path", records({ type: "end", data: { binary_offset: null } })],
    ["end without offset", records({ type: "end", data: { path: { text: "a.txt" } } })],
    ["end with non-number offset", records({ type: "end", data: { path: { text: "a.txt" }, binary_offset: "0" } })],
    ["summary without stats", records({ type: "summary", data: {} })],
    ["summary with null stats", records({ type: "summary", data: { stats: null } })],
    ["summary with non-number searches", records({ type: "summary", data: { stats: { searches: "1" } } })],
    ["valid records without summary", records(line("match", "a.txt", 1, "needle\n"))],
    ["empty stream", ""]
  ])("rejects %s without returning partial matches", async (_, json) => {
    await withRoot(async (root) => {
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({ json })
          return yield* Effect.flip(search.grep({ ...grepInput, root }))
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(error).toMatchObject({ code: "request_failed", message: "rg returned malformed JSON" })
    })
  })

  it("accepts begin/end records, sorts hits and caps previews by UTF-8 bytes", async () => {
    await withRoot(async (root) => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({
            json: records(
              { type: "begin", data: { path: { text: "./a.txt" } } },
              line("match", "b.txt", 2, "needle b\r\n"),
              line("match", "./a.txt", 3, "😀".repeat(501) + "\n"),
              line("match", "./a.txt", 1, "needle a\n"),
              { type: "end", data: { path: { text: "a.txt" }, binary_offset: null } },
              { type: "end", data: { path: { text: "b.txt" }, binary_offset: 0 } },
              summary
            )
          })
          return yield* search.grep({ ...grepInput, root })
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result.matches.map((match) => [match.file, match.line])).toEqual([
        [join(root, "a.txt"), 1],
        [join(root, "a.txt"), 3],
        [join(root, "b.txt"), 2]
      ])
      expect(result.matches[0]?.text).toBe("needle a")
      expect(result.matches[2]?.text).toBe("needle b")
      expect(new TextEncoder().encode(result.matches[1]?.text).length).toBeLessThanOrEqual(500)
      expect(result.matches[1]?.text).not.toContain("�")
    })
  })

  it("demotes surplus matches into context independently for each file", async () => {
    await withRoot(async (root) => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({
            json: records(
              line("match", "b.txt", 2, "needle b2\n"),
              line("match", "a.txt", 2, "needle a2\n"),
              line("context", "a.txt", 3, "tail\n"),
              line("match", "b.txt", 1, "needle b1\n"),
              line("match", "a.txt", 1, "needle a1\n"),
              summary
            )
          })
          return yield* search.grep({ ...grepInput, root, maxCount: 1 })
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result.matches).toEqual([
        {
          file: join(root, "a.txt"),
          line: 1,
          text: "needle a1",
          before: [],
          after: [{ line: 2, text: "needle a2" }, { line: 3, text: "tail" }]
        },
        { file: join(root, "b.txt"), line: 1, text: "needle b1", before: [], after: [{ line: 2, text: "needle b2" }] }
      ])
    })
  })

  it("fails when the binary detector is rejected even if grep returned a valid summary", async () => {
    await withRoot(async (root) => {
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({
            json: records(summary),
            binaryStderr: "  binary detector failed\n",
            exitCode: 2
          })
          return yield* Effect.flip(search.grep({ ...grepInput, root }))
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(error).toMatchObject({ code: "request_failed", message: "binary detector failed" })
    })
  })

  it("returns an empty answer without spawning when globs admit no targets", async () => {
    await withRoot(async (root) => {
      const commands: Array<ChildProcess.StandardCommand> = []
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({ json: "malformed", commands })
          const grep = yield* search.grep({ ...grepInput, root, globs: ["*.missing"] })
          const glob = yield* search.glob({ root, pattern: "*.missing", hidden: false, limit: 10 })
          return { grep, glob }
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(commands).toEqual([])
      expect(result).toEqual({
        grep: { matches: [], files: [], filesSearched: 0, skippedBinary: 0, truncated: false },
        glob: { paths: [], total: 0, truncated: false }
      })
    })
  })

  it.each([
    { count: 257, width: 5, expectedBatches: 2 },
    { count: 180, width: 200, expectedBatches: 2 }
  ])(
    "batches $count targets with width=$width without losing their order",
    async ({ count, width, expectedBatches }) => {
      await withRoot(async (root) => {
        const names = Array.from(
          { length: count },
          (_, index) => `${index.toString().padStart(3, "0")}-${"x".repeat(width)}.txt`
        )
        for (const name of names) {
          writeFileSync(join(root, name), "needle\n")
        }
        const commands: Array<ChildProcess.StandardCommand> = []
        await Effect.runPromise(
          Effect.gen(function*() {
            const search = yield* native({ json: "", commands })
            return yield* search.glob({ root, pattern: "*", hidden: false, limit: 10 })
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(commands).toHaveLength(expectedBatches)
        const batches = commands.map((command) => command.args.slice(command.args.indexOf("--") + 1))
        expect(batches.flat()).toEqual([...names, "a.txt"].sort())
        for (const batch of batches) {
          expect(batch.length).toBeLessThanOrEqual(256)
          expect(batch.reduce((bytes, target) => bytes + new TextEncoder().encode(target).length + 1, 0))
            .toBeLessThanOrEqual(32_768)
        }
      })
    }
  )

  it.each(["stdout", "stderr"] as const)(
    "refuses an aggregate %s overflow across individually valid batches",
    async (stream) => {
      const names = Array.from({ length: 257 }, (_, index) => `${index}.txt`)
      const fs = FileSystem.makeNoop({
        stat: (path) => Effect.succeed(fileInfo({ type: path === "/search" ? "Directory" : "File" })),
        readDirectory: () => Effect.succeed(names)
      })
      const chunk = "x".repeat(NativeSearch.MAX_CAPTURE_BYTES / 2 + 1)
      const error = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* native({
            json: "",
            binary: stream === "stdout" ? chunk : "",
            binaryStderr: stream === "stderr" ? chunk : ""
          })
          return yield* Effect.flip(
            search.glob({ root: "/search", pattern: "*", hidden: false, noIgnore: true, limit: 10 })
          )
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(NodeServices.layer))
      )
      expect(error).toMatchObject({
        code: "command_failed",
        message: `rg ${stream} exceeded the ${NativeSearch.MAX_CAPTURE_BYTES}-byte capture cap`
      })
    }
  )
})

describe("search wrapper boundaries", () => {
  it("narrows omitted roots to the default workspace subtree", () => {
    expect(Grep.effectsFor({}).reads).toEqual(["./**"])
    expect(Glob.effectsFor({}).reads).toEqual(["./**"])
  })

  it("forwards the complete default grep and glob requests to the peer", async () => {
    const greps: Array<Search.GrepInput> = []
    const globs: Array<Search.GlobInput> = []
    const search = Search.make({
      grep: (input) => {
        greps.push(input)
        return Effect.succeed({ matches: [], files: [], filesSearched: 0, skippedBinary: 0, truncated: false })
      },
      glob: (input) => {
        globs.push(input)
        return Effect.succeed({ paths: [], total: 0, truncated: false })
      }
    })
    await Effect.runPromise(Grep.run({ pattern: "needle" }).pipe(Effect.provideService(Search.Search, search)))
    await Effect.runPromise(Glob.run({ pattern: "*.ts" }).pipe(Effect.provideService(Search.Search, search)))
    expect(greps).toEqual([{
      ...grepInput,
      root: ".",
      noIgnore: false,
      symbols: true,
      maxCount: undefined,
      limit: 200
    }])
    expect(globs).toEqual([{ pattern: "*.ts", root: ".", noIgnore: false, hidden: false, limit: 1_000 }])
  })

  it("does not retry an explicitly literal metacharacter pattern after an empty answer", async () => {
    const greps: Array<Search.GrepInput> = []
    const empty: Search.GrepOutput = { matches: [], files: [], filesSearched: 2, skippedBinary: 0, truncated: false }
    const search = Search.make({
      grep: (input) => {
        greps.push(input)
        return Effect.succeed(empty)
      },
      glob: () => Effect.succeed({ paths: [], total: 0, truncated: false })
    })
    const result = await Effect.runPromise(
      Grep.run({ pattern: "call(x)", fixedStrings: true }).pipe(Effect.provideService(Search.Search, search))
    )
    expect(greps).toHaveLength(1)
    expect(greps[0]?.fixedStrings).toBe(true)
    expect(result).toEqual(empty)
  })

  it.each([
    { ignoreCase: true, smartCase: true },
    { context: 0, beforeContext: 0 },
    { context: 0, afterContext: 0 },
    { maxCount: 0 },
    { globs: ["*.ts", "!"] }
  ])("refuses conflicting or invalid options before invoking a peer: %j", async (options) => {
    let invoked = false
    const search = Search.make({
      grep: () => {
        invoked = true
        return Effect.succeed({ matches: [], files: [], filesSearched: 0, skippedBinary: 0, truncated: false })
      },
      glob: () => Effect.succeed({ paths: [], total: 0, truncated: false })
    })
    const error = await Effect.runPromise(
      Grep.run({ pattern: "needle", ...options }).pipe(
        Effect.flip,
        Effect.provideService(Search.Search, search)
      )
    )
    expect(error.code).toBe("globs" in options ? "invalid_pattern" : "invalid_input")
    expect(invoked).toBe(false)
  })

  it("preserves a literal retry's notice and file-only success", async () => {
    const calls: Array<Search.GrepInput> = []
    const empty: Search.GrepOutput = { matches: [], files: [], filesSearched: 4, skippedBinary: 0, truncated: false }
    const literal = {
      ...empty,
      files: ["/search/a.txt"],
      truncated: true,
      notice: "Showing 1 of 2 files; output was truncated."
    }
    const search = Search.make({
      grep: (input) => {
        calls.push(input)
        return Effect.succeed(input.fixedStrings ? literal : empty)
      },
      glob: () => Effect.succeed({ paths: [], total: 0, truncated: false })
    })
    const result = await Effect.runPromise(
      Grep.run({ pattern: "call(x)", filesWithMatches: true }).pipe(Effect.provideService(Search.Search, search))
    )
    expect(calls.map((call) => call.fixedStrings)).toEqual([false, true])
    expect(result).toEqual({
      ...literal,
      retriedAsLiteral: true,
      notice:
        "The pattern found nothing as a regular expression and these results come from re-running it literally (fixedStrings: true). Showing 1 of 2 files; output was truncated."
    })
  })

  it("forwards explicit zero limits and caller options after normalization", async () => {
    const greps: Array<Search.GrepInput> = []
    const globs: Array<Search.GlobInput> = []
    const search = Search.make({
      grep: (input) => {
        greps.push(input)
        return Effect.succeed({
          matches: [],
          files: ["/search/a"],
          filesSearched: 1,
          skippedBinary: 0,
          truncated: true
        })
      },
      glob: (input) => {
        globs.push(input)
        return Effect.succeed({ paths: [], total: 1, truncated: true })
      }
    })
    await Effect.runPromise(
      Grep.run({
        pattern: "needle",
        root: "/search",
        context: 2,
        noIgnore: true,
        hidden: true,
        symbols: false,
        limit: 0
      }).pipe(Effect.provideService(Search.Search, search))
    )
    await Effect.runPromise(
      Glob.run({ pattern: "*.ts", root: "/search", noIgnore: true, hidden: true, limit: 0 }).pipe(
        Effect.provideService(Search.Search, search)
      )
    )
    expect(greps).toEqual([{
      ...grepInput,
      beforeContext: 2,
      afterContext: 2,
      noIgnore: true,
      hidden: true,
      limit: 0,
      maxCount: undefined
    }])
    expect(globs).toEqual([{ pattern: "*.ts", root: "/search", noIgnore: true, hidden: true, limit: 0 }])
  })

  it.each(
    [
      ["NotFound", "not_found"],
      ["PermissionDenied", "permission_denied"],
      ["Unknown", "command_failed"]
    ] as const
  )("maps a %s root failure to %s while retaining its path", (reason, code) => {
    const error = PlatformError.systemError({
      _tag: reason,
      module: "FileSystem",
      method: "stat",
      description: "root failure"
    })
    expect(ContractFailures.rootFailure("/search", error)).toMatchObject({ code, path: "/search" })
    if (reason !== "NotFound") expect(ContractFailures.rootFailure("/search", error).message).toContain(error.message)
  })

  it("retains glob matching semantics after eviction of the bounded compiled-pattern cache", () => {
    expect(SearchContract.matchesGlob("cache/original?.ts", "cache/original1.ts", "original1.ts")).toBe(true)
    for (let index = 0; index < 257; index++) {
      const name = `eviction-${index}.ts`
      expect(SearchContract.matchesGlob(name, `nested/${name}`, name)).toBe(true)
      expect(SearchContract.matchesGlob(name, "nested/other.ts", "other.ts")).toBe(false)
    }
    expect(SearchContract.matchesGlob("cache/original?.ts", "cache/original1.ts", "original1.ts")).toBe(true)
    expect(SearchContract.matchesGlob("cache/original?.ts", "nested/cache/original1.ts", "original1.ts")).toBe(false)
  })

  it.each([
    { pattern: "{unfinished", relative: "nested/{unfinished", basename: "{unfinished", absent: "unfinished" },
    { pattern: "{single}", relative: "nested/{single}", basename: "{single}", absent: "single" },
    { pattern: "src/{unfinished", relative: "src/{unfinished", basename: "{unfinished", absent: "src/unfinished" },
    { pattern: "src/{single}", relative: "src/{single}", basename: "{single}", absent: "src/single" }
  ])("matches unchecked malformed brace glob $pattern as literal braces", ({ pattern, relative, basename, absent }) => {
    expect(SearchContract.validateGlob(pattern)?.code).toBe("invalid_pattern")
    expect(SearchContract.matchesGlob(pattern, relative, basename)).toBe(true)
    expect(SearchContract.matchesGlob(pattern, absent, absent)).toBe(false)
    if (pattern.startsWith("src/")) {
      expect(SearchContract.matchesGlob(pattern, `nested/${relative}`, basename)).toBe(false)
    }
  })

  it.each([
    ["\\.(", "\"(\" at column 3 is never closed; write \\( for a literal parenthesis"],
    ["[^a](", "\"(\" at column 5 is never closed; write \\( for a literal parenthesis"],
    ["[\\]](", "\"(\" at column 5 is never closed; write \\( for a literal parenthesis"],
    ["(a)(", "\"(\" at column 4 is never closed; write \\( for a literal parenthesis"],
    ["a{2}(", "\"(\" at column 5 is never closed; write \\( for a literal parenthesis"],
    ["a*(", "\"(\" at column 3 is never closed; write \\( for a literal parenthesis"],
    ["{1}", "\"{\" at column 1 repeats nothing; write \\{ for a literal brace"],
    ["}", "\"}\" at column 1 closes nothing; write \\} for a literal brace"],
    ["]", "\"]\" at column 1 closes nothing; write \\] for a literal bracket"]
  ])("names the malformed construct in %s after scanning valid prefixes", (pattern, detail) => {
    expect(SearchContract.validatePattern(pattern, false)).toMatchObject({
      code: "invalid_pattern",
      message: `Unsupported ripgrep pattern "${pattern}": ${detail}`
    })
  })

  it("rejects repeated quantifiers while scanning accepted repetition and escaped class content", () => {
    expect(SearchContract.validatePattern("a**", false)).toMatchObject({ code: "invalid_pattern" })
    expect(SearchContract.validatePattern("[\\]", false)?.message).toContain("\"[\" at column 1 is never closed")
  })

  it("compiles dot and end anchoring case-insensitively while preserving literal class members", () => {
    const expression = SearchContract.expression("n.edle$", false, true)
    expect(expression.test("Needle")).toBe(true)
    expect(expression.test("N\redle")).toBe(true)
    expect(expression.test("N\nedle")).toBe(false)
    expect(expression.test("Needle\n")).toBe(false)
    const members = SearchContract.expression("[.$]", false, false)
    expect(members.test(".")).toBe(true)
    expect(members.test("$")).toBe(true)
    expect(members.test("x")).toBe(false)
    expect(SearchContract.canonicalGlob("!./src/./*.ts  ")).toBe("!/src/*.ts")
  })

  it("explains a missing literal parent directory without a wildcard", async () => {
    await withRoot(async (root) => {
      const notice = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          return yield* SearchContract.unsatisfiableNotice({
            fileSystem: fs,
            path,
            root,
            globs: ["missing/file.txt"],
            hidden: false,
            noIgnore: true
          })
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(notice).toBe(`No file under ${root} can match "missing/file.txt": there is no missing directory there.`)
    })
  })

  it("keeps a listed entry when its stat fails and still pages the whole directory order", async () => {
    const fs = FileSystem.makeNoop({
      stat: (path) =>
        path === "/search" || path === "/search/zdir"
          ? Effect.succeed(fileInfo({ type: "Directory" }))
          : path === "/search/broken"
          ? Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "stat",
              description: "guarded entry"
            })
          )
          : Effect.succeed(fileInfo()),
      readDirectory: () => Effect.succeed(["plain", "zdir", "broken"])
    })
    const result = await Effect.runPromise(
      Ls.run({ path: "/search", offset: 2, limit: 1 }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(result).toEqual({
      entries: [{ name: "broken", kind: "file" }],
      total: 3,
      truncated: true,
      notice: "Showing 1 of 3 entries; output was truncated."
    })
  })

  it("reports a root listing permission failure instead of an empty directory", async () => {
    const fs = FileSystem.makeNoop({
      stat: () => Effect.succeed(fileInfo({ type: "Directory" })),
      readDirectory: () =>
        Effect.fail(PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "readDirectory",
          description: "guarded directory"
        }))
    })
    const error = await Effect.runPromise(
      Ls.run({ path: "/search" }).pipe(
        Effect.flip,
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(error).toMatchObject({ code: "permission_denied", path: "/search" })
    expect(error.message).toBe("Permission denied: /search")
  })
})
