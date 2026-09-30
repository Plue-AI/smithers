/**
 * No new raw-text failure sites in the CLI (#2910).
 *
 * An operator reads a failure's sentence only when it is designed: a tagged
 * `CliError.Refused` (or another tagged error) with a stable code and product
 * words. A plain `new Error("...")`, a bare string handed to `Effect.fail` or
 * `Effect.die`, or a thrown string puts internal wording in front of the
 * operator, so every such site under `src` must be one of the reviewed
 * exceptions below. Add a tagged refusal instead of extending this list.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")

const raw = /new Error\(|Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

/** Reviewed sites, by file and exact trimmed line, with why each is not operator text. */
const reviewed: ReadonlyArray<readonly [file: string, line: string, why: string]> = [
  [
    "src/ExecutionEnvironment.ts",
    `const aborted = (): Error => Object.assign(new Error("Execution interrupted"), { name: "AbortError" })`,
    "an AbortSignal reason; cancellation is reported by its exit status"
  ],
  [
    "src/cli/Entry.ts",
    "controller.abort(new Error(`smthrs interrupted by ${signal}`))",
    "an AbortSignal reason; the interrupt is reported by exit status 130/143"
  ],
  [
    "src/Ui.ts",
    "catch: (cause) => cause instanceof Error ? cause : new Error(Failure.unknownSentence, { cause })",
    "the generic sentence around a thrown non-Error"
  ],
  [
    "src/Suggest.ts",
    "error instanceof Error ? error : new Error(Failure.unknownSentence, { cause: error })",
    "the generic sentence around a thrown non-Error"
  ],
  [
    "src/internal/RoleProfile.ts",
    "catch: (cause) => cause instanceof Error ? cause : new Error(Failure.unknownSentence, { cause })",
    "the generic sentence around a thrown non-Error"
  ],
  [
    "src/internal/backend/Client.ts",
    "if (!Failure.isTagged(error)) return new Error(message)",
    "re-states an already designed sentence with this session's secrets redacted"
  ],
  [
    "src/internal/backend/Client.ts",
    "return new Error(message)",
    "re-states an already designed sentence with this session's secrets redacted"
  ],
  [
    "src/internal/backend/Commands.ts",
    "if (!handler) throw new Error(`Missing backend command: ${name}`)",
    "static command-table invariant, thrown while the module loads, never on an operator path"
  ],
  [
    "src/internal/backend/Commands.ts",
    "if (!(\"_group\" in entry)) throw new Error(`Cannot mount backend group ${word}`)",
    "static command-table invariant, thrown while the module loads, never on an operator path"
  ],
  [
    "src/internal/backend/Commands.ts",
    "throw new Error(`Cannot merge backend command ${name}`)",
    "static command-table invariant, thrown while the module loads, never on an operator path"
  ]
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

describe("raw failure sites under src", () => {
  const found = sources(sourceRoot).flatMap((path) =>
    readFileSync(path, "utf8").split("\n").flatMap((text, index) =>
      raw.test(text) ? [{ file: relative(packageRoot, path), line: text.trim(), at: index + 1 }] : []
    )
  )

  it("are all reviewed exceptions", () => {
    const allowed = new Set(reviewed.map(([file, line]) => `${file}\n${line}`))
    const unreviewed = found.filter((site) => !allowed.has(`${site.file}\n${site.line}`))
    expect(unreviewed.map((site) => `${site.file}:${site.at}: ${site.line}`)).toEqual([])
  })

  it("keeps no stale exception", () => {
    const present = new Set(found.map((site) => `${site.file}\n${site.line}`))
    expect(reviewed.filter(([file, line]) => !present.has(`${file}\n${line}`))).toEqual([])
  })

  it("detects each raw shape", () => {
    expect(raw.test(`throw new Error("x")`)).toBe(true)
    expect(raw.test(`Effect.fail("x")`)).toBe(true)
    expect(raw.test("Effect.die(`x`)")).toBe(true)
    expect(raw.test(`throw "x"`)).toBe(true)
    expect(raw.test(`throw new CliError.Refused({ fault: "bug", code: "x", message: "y" })`)).toBe(false)
    expect(raw.test(`Effect.fail(refused("x"))`)).toBe(false)
  })
})
