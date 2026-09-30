/**
 * No new raw-text failure sites in @smthrs/build (#2813).
 *
 * The build CLI prints a failure through `Diagnostic.present`: a tagged error,
 * or a plain `Error` built with a deliberate operator sentence, is printed as
 * written, and anything else becomes the generic unknown-failure sentence. So
 * every existing `new Error("...")` under `src` is either a designed sentence
 * or the `cause` of a tagged failure (as in `unreadable(code, path, cause)`),
 * and this package has no bare string handed to `Effect.fail` or `Effect.die` and
 * no thrown string, which would print as an unknown failure.
 *
 * The counts below are the reviewed sites per file (13 in all). A new
 * failure is a tagged error (`Schema.TaggedError` or `Data.TaggedError`), so a
 * count may only fall: a file that gains a site fails, and one that drops a
 * site fails until its count is lowered.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")

const plainError = /new Error\(/
const bareString = /Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

/** Reviewed files and their `new Error` sites: designed sentences or causes of tagged failures. */
const reviewed: ReadonlyArray<readonly [file: string, count: number]> = [
  ["src/PackageManager.ts", 11],
  ["src/internal/boundedOutput.ts", 2]
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const lines = sources(sourceRoot).map((path) => ({
  file: relative(packageRoot, path),
  lines: readFileSync(path, "utf8").split("\n")
}))

describe("raw failure sites under src", () => {
  it("hand no bare string to a failure", () => {
    const found = lines.flatMap(({ file, lines }) =>
      lines.flatMap((text, index) => bareString.test(text) ? [`${file}:${index + 1}: ${text.trim()}`] : [])
    )
    expect(found).toEqual([])
  })

  it("match the reviewed plain Error count in every file", () => {
    const counts = Object.fromEntries(
      lines
        .map(({ file, lines }) => [file, lines.filter((text) => plainError.test(text)).length] as const)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    )
    expect(counts).toEqual(Object.fromEntries([...reviewed].sort(([a], [b]) => a.localeCompare(b))))
  })

  it("detects each raw shape", () => {
    expect(plainError.test(`throw new Error("x")`)).toBe(true)
    expect(bareString.test(`Effect.fail("x")`)).toBe(true)
    expect(bareString.test("Effect.die(`x`)")).toBe(true)
    expect(bareString.test(`throw "x"`)).toBe(true)
    expect(bareString.test(`Effect.fail(new PackageRefused({ code: "x" }))`)).toBe(false)
  })
})
