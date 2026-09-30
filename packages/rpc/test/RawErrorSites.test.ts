/**
 * No raw-text failure sites in the shared contracts (#2813).
 *
 * The app, the Worker and the CLI read these modules' failures by `_tag` and
 * `code` (UserFailure.ts); a plain `new Error("...")`, a bare string handed to
 * `Effect.fail` or `Effect.die`, or a thrown string carries no tag, so a
 * surface can only show it as an unknown failure. Every such site under `src`
 * must be one of the reviewed exceptions below. Add a tagged error class
 * (`readonly _tag`, like `ResolverFault`) instead of extending this list.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const sourceRoot = join(packageRoot, "src")

const raw = /new Error\(|Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

/** Reviewed sites, by file and exact trimmed line, with why each is not surface text. */
const reviewed: ReadonlyArray<readonly [file: string, line: string, why: string]> = []

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

  it("scans the sources it guards", () => {
    expect(sources(sourceRoot).map((path) => relative(packageRoot, path))).toEqual(
      expect.arrayContaining(["src/ApplicationTarget.ts", "src/AgentTurnJournal.ts", "src/AgentRoles.ts"])
    )
  })

  it("detects each raw shape", () => {
    expect(raw.test(`throw new Error("x")`)).toBe(true)
    expect(raw.test(`Effect.fail("x")`)).toBe(true)
    expect(raw.test("Effect.die(`x`)")).toBe(true)
    expect(raw.test(`throw "x"`)).toBe(true)
    expect(raw.test(`throw new ApplicationTargetRefused("origin_not_http", "x")`)).toBe(false)
    expect(raw.test(`throw new ResolverFault("status 500")`)).toBe(false)
  })
})
