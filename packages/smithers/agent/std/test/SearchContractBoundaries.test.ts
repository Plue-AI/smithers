import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Effect, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as SearchContract from "../src/SearchContract.ts"
import * as StdError from "../src/StdError.ts"

const ignoredNotice = "No results; ignore files excluded paths. Retry with noIgnore: true to include them."
const syntaxCases = [
  ["(?=a)", "special groups and lookaround are not supported"],
  ["\\d", "backreferences, shorthand classes and encoded escapes are not supported"],
  ["\\1", "backreferences, shorthand classes and encoded escapes are not supported"],
  ["\\", "backreferences, shorthand classes and encoded escapes are not supported"],
  ["[[a]]", "nested and named character classes are not supported"],
  ["[]", "empty character classes are not supported"],
  ["[^]", "empty character classes are not supported"],
  ["[a&&b]", "character-class set operations are not supported"],
  ["[a--b]", "character-class set operations are not supported"],
  ["[a~~b]", "character-class set operations are not supported"],
  ["a{1001}", "repetition counts above 1000 are not supported"],
  ["[z-a]", "invalid expression: Range out of order in character class"],
  ["a{3,2}", "invalid expression: numbers out of order in {} quantifier"]
] as const

describe("SearchContract author-facing refusal and ignore diagnostics", () => {
  it("rejects a trailing regex escape while retaining it in fixed-string searches", () => {
    expect(() => SearchContract.expression("\\", false, false)).toThrow(SyntaxError)
    const literal = SearchContract.expression("\\", true, false)
    expect(literal.test("before \\ after")).toBe(true)
    expect(literal.test("no escape")).toBe(false)
  })

  it.each([
    ["", "glob patterns must not be empty"],
    ["   ", "glob patterns must not be empty"],
    ["é", "globs must contain printable ASCII only"],
    ["a\nb", "globs must contain printable ASCII only"],
    ["[a]", "glob escapes and character classes are not supported"],
    ["a\\b", "glob escapes and character classes are not supported"],
    ["{a}", "braces must contain alternatives"],
    ["a}", "braces must contain alternatives"],
    ["{a,b", "glob braces must be balanced"],
    ["{a,{b,c}}", "nested brace alternatives are not supported"]
  ].flatMap(([pattern, detail]) => [false, true].map((excluded) => ({ pattern, detail, excluded }))))(
    "rejects glob $pattern with exclusion=$excluded using the author-facing correction",
    ({ pattern, detail, excluded }) => {
      const glob = excluded ? `!${pattern}` : pattern!
      expect(SearchContract.validateGlob(glob)).toMatchObject({
        code: "invalid_pattern",
        message: `Unsupported ripgrep pattern "${glob}": ${detail}`
      })
    }
  )

  it.each([
    { alternatives: 256, prefix: "", accepted: true, candidate: "x255" },
    { alternatives: 257, prefix: "", accepted: false, candidate: "x256" },
    { alternatives: 128, prefix: "{a,b}", accepted: true, candidate: "bx127" },
    { alternatives: 129, prefix: "{a,b}", accepted: false, candidate: "bx128" }
  ])(
    "bounds brace expansion products: $prefix × $alternatives alternatives",
    ({ alternatives, prefix, accepted, candidate }) => {
      const glob = `${prefix}{${Array.from({ length: alternatives }, (_, index) => `x${index}`).join(",")}}`
      if (accepted) {
        expect(SearchContract.validateGlob(glob)).toBeUndefined()
        expect(SearchContract.matchesGlob(glob, candidate, candidate)).toBe(true)
        expect(SearchContract.matchesGlob(glob, "not-an-alternative", "not-an-alternative")).toBe(false)
      } else {
        expect(SearchContract.validateGlob(glob)).toMatchObject({
          code: "invalid_pattern",
          message: `Unsupported ripgrep pattern "${glob}": glob brace expansion exceeds 256 patterns`
        })
      }
    }
  )

  it.each(["missing", "file"] as const)(
    "returns no directory diagnostic for a real %s root without attempting a walk",
    async (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "std-notice-root-"))
      const root = join(directory, kind)
      if (kind === "file") writeFileSync(root, "explicit source bytes")
      const listings: Array<string> = []
      try {
        const notice = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* SearchContract.unsatisfiableNotice({
              fileSystem: {
                ...fs,
                readDirectory: (candidate) => {
                  listings.push(candidate)
                  return fs.readDirectory(candidate)
                }
              },
              path: yield* Path.Path,
              root,
              globs: ["missing/*.txt"],
              hidden: false,
              ignored: true
            })
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(notice).toBeUndefined()
        expect(listings).toEqual([])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(syntaxCases)(
    "rejects regex %s with its literal diagnostic while fixed-string matching stays literal",
    (pattern, detail) => {
      expect(SearchContract.validatePattern(pattern, false)).toMatchObject({
        code: "invalid_pattern",
        message: `Unsupported ripgrep pattern "${pattern}": ${detail}`
      })
      expect(SearchContract.validatePattern(pattern, true)).toBeUndefined()
      const literal = SearchContract.expression(pattern, true, false)
      expect(literal.test(`before ${pattern} after`)).toBe(true)
      expect(literal.test("unrelated plain text")).toBe(false)
    }
  )

  it.each([false, true])(
    "enforces printable ASCII and the exact 4096-byte boundary with fixedStrings=%s",
    (fixedStrings) => {
      expect(SearchContract.validatePattern("a".repeat(4096), fixedStrings)).toBeUndefined()
      const oversized = "a".repeat(4097)
      expect(SearchContract.validatePattern(oversized, fixedStrings)).toMatchObject({
        code: "invalid_pattern",
        message: `Unsupported ripgrep pattern "${oversized}": patterns must not exceed 4096 bytes`
      })
      for (const pattern of ["é", "a\nb", "a\tb"]) {
        expect(SearchContract.validatePattern(pattern, fixedStrings)).toMatchObject({
          code: "invalid_pattern",
          message: `Unsupported ripgrep pattern "${pattern}": patterns must contain printable ASCII only`
        })
      }
    }
  )

  it.each(
    [
      ["invalid_pattern", "Unsupported ripgrep pattern \"[\": explicit correction", true],
      ["invalid_pattern", "Unsupported ripgrep pattern provider-private-details", false],
      ["invalid_pattern", "ripgrep: provider-private-details", false],
      ["command_failed", "Unsupported ripgrep pattern \"[\": explicit correction", false],
      ["invalid_input", "Unsupported ripgrep pattern \"[\": explicit correction", false]
    ] as const
  )("classifies code=%s message=%s as a trusted contract refusal=%s", (code, message, expected) => {
    expect(SearchContract.isContractRejection(new StdError.StdError({ code, message }))).toBe(expected)
  })

  const ignoreOptions = [undefined, false, true].flatMap((noIgnore) =>
    [undefined, false, true].map((ignored) => ({ noIgnore, ignored }))
  )
  it.each(ignoreOptions)(
    "uses noIgnore=$noIgnore and prior ignored=$ignored without redundant IO",
    async ({ noIgnore, ignored }) => {
      const root = mkdtempSync(join(tmpdir(), "std-ignore-notice-"))
      writeFileSync(join(root, ".gitignore"), "excluded.txt\n")
      writeFileSync(join(root, "excluded.txt"), "real excluded source")
      const reads: Array<string> = []
      try {
        const notice = await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            return yield* SearchContract.unsatisfiableNotice({
              fileSystem: {
                ...fs,
                readFileString: (file, options) => {
                  reads.push(file)
                  return fs.readFileString(file, options)
                }
              },
              path,
              root,
              globs: ["*.txt"],
              hidden: false,
              noIgnore,
              ignored
            })
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(notice).toBe(noIgnore || ignored === false ? undefined : ignoredNotice)
        expect(reads).toEqual(!noIgnore && ignored === undefined ? [join(root, ".gitignore")] : [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it("an ignore-file read failure creates no false exclusion notice and a repaired read restores the notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-ignore-read-error-"))
    const ignoreFile = join(root, ".gitignore")
    writeFileSync(ignoreFile, "excluded.txt\n")
    writeFileSync(join(root, "excluded.txt"), "excluded bytes")
    const reads: Array<string> = []
    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          let broken = true
          const fileSystem: FileSystem.FileSystem = {
            ...fs,
            readFileString: (file, options) => {
              reads.push(file)
              return broken && file === ignoreFile ?
                Effect.fail(PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "controlled unreadable ignore file"
                })) :
                fs.readFileString(file, options)
            }
          }
          const options = { fileSystem, path, root, globs: ["*.txt"], hidden: false }
          const failedRead = yield* SearchContract.unsatisfiableNotice(options)
          broken = false
          const recovered = yield* SearchContract.unsatisfiableNotice(options)
          return { failedRead, recovered }
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result).toEqual({ failedRead: undefined, recovered: ignoredNotice })
      expect(reads).toEqual([ignoreFile, ignoreFile])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a failed diagnostic walk gives no ignore claim and recovers after the root listing succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-ignore-list-error-"))
    writeFileSync(join(root, ".gitignore"), "excluded.txt\n")
    writeFileSync(join(root, "excluded.txt"), "excluded bytes")
    const listings: Array<string> = []
    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          let broken = true
          const fileSystem: FileSystem.FileSystem = {
            ...fs,
            readDirectory: (directory) => {
              listings.push(directory)
              return broken ?
                Effect.fail(PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  description: "controlled root listing refusal"
                })) :
                fs.readDirectory(directory)
            }
          }
          const options = { fileSystem, path, root, globs: ["*.txt"], hidden: false }
          const failedListing = yield* SearchContract.unsatisfiableNotice(options)
          broken = false
          return { failedListing, recovered: yield* SearchContract.unsatisfiableNotice(options) }
        }).pipe(Effect.provide(NodeServices.layer))
      )
      expect(result).toEqual({ failedListing: undefined, recovered: ignoredNotice })
      expect(listings).toEqual([root, root])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    "preserves an impossible-glob correction alongside ignores with noIgnore=%s",
    async (noIgnore) => {
      const root = mkdtempSync(join(tmpdir(), "std-mixed-glob-notice-"))
      writeFileSync(join(root, ".gitignore"), "excluded.txt\n")
      writeFileSync(join(root, "excluded.txt"), "excluded bytes")
      try {
        const notice = await Effect.runPromise(
          Effect.gen(function*() {
            return yield* SearchContract.unsatisfiableNotice({
              fileSystem: yield* FileSystem.FileSystem,
              path: yield* Path.Path,
              root,
              globs: ["missing/*.txt", "*.txt", "!other.txt"],
              hidden: false,
              noIgnore
            })
          }).pipe(Effect.provide(NodeServices.layer))
        )
        const missing = `No file under ${root} can match "missing/*.txt": there is no missing directory there.`
        expect(notice).toBe(noIgnore ? missing : `${missing} ${ignoredNotice}`)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
