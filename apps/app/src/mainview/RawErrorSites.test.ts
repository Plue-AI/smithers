import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

/*
 * No raw-text failure sites in the seams and cards (#2813).
 *
 * A seam's or card's failure reaches a person through `presentUserFailure`
 * (`@smthrs/rpc/UserFailure`), which reads a failure's `_tag`. A plain
 * `new Error("...")`, a bare string handed to `Effect.fail` or `Effect.die`,
 * or a thrown string carries no tag, so the presenter can only call it
 * unknown. Every such site must be one of the reviewed exceptions below; add a
 * `Data.TaggedError` instead of extending this list. ChangeCards is guarded
 * by its own lane (#2910).
 */

const VIEW_ROOT = import.meta.dir
const ROOTS = ["state/seams", "cards"].map((path) => join(VIEW_ROOT, path))
const EXCLUDED = /^cards\/ChangeCards\./
const RAW = /new Error\(|Effect\.(?:fail|die)\(\s*["'`]|throw\s+["'`]/

const FIXTURE_REASON = "browser probe fixture bundled only by e2e/probes/run-trace-phase-strip; its failure fails the probe"

/** Reviewed sites, by file and exact trimmed line, with why each is not text a person reads. */
const REVIEWED: ReadonlyArray<readonly [file: string, line: string, why: string]> = [
  ["cards/fixtures/RunTraceBrowser.ts", `if (card?.kind !== "run-trace") throw new Error("The fixture run card is absent")`, FIXTURE_REASON],
  ["cards/fixtures/RunTraceBrowser.ts", `if (result.status === "failed") throw new Error(result.error)`, FIXTURE_REASON]
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })

const scanned = ROOTS.flatMap(sources).map((path) => relative(VIEW_ROOT, path)).filter((file) => !EXCLUDED.test(file))

describe("raw failure sites in seams and cards", () => {
  const found = scanned.flatMap((file) =>
    readFileSync(join(VIEW_ROOT, file), "utf8").split("\n").flatMap((text, index) =>
      RAW.test(text) ? [{ file, line: text.trim(), at: index + 1 }] : []))

  test("are all reviewed exceptions", () => {
    const allowed = new Set(REVIEWED.map(([file, line]) => `${file}\n${line}`))
    const unreviewed = found.filter((site) => !allowed.has(`${site.file}\n${site.line}`))
    expect(unreviewed.map((site) => `${site.file}:${site.at}: ${site.line}`)).toEqual([])
  })

  test("keeps no stale exception", () => {
    const present = new Set(found.map((site) => `${site.file}\n${site.line}`))
    expect(REVIEWED.filter(([file, line]) => !present.has(`${file}\n${line}`))).toEqual([])
  })

  test("scans every seam and card except ChangeCards", () => {
    expect(scanned).toContain("state/seams/CloudClient.ts")
    expect(scanned).toContain("state/seams/RepoImportSeam.ts")
    expect(scanned).toContain("cards/RunTraceSummary.tsx")
    expect(scanned.some((file) => EXCLUDED.test(file))).toBe(false)
  })

  test("detects each raw shape", () => {
    expect(RAW.test(`throw new Error("x")`)).toBe(true)
    expect(RAW.test(`cloudUnreachable(new Error("x"))`)).toBe(true)
    expect(RAW.test(`Effect.fail("x")`)).toBe(true)
    expect(RAW.test("Effect.die(`x`)")).toBe(true)
    expect(RAW.test(`throw "x"`)).toBe(true)
    expect(RAW.test(`throw new RepoImportSuperseded()`)).toBe(false)
    expect(RAW.test(`cloudUnreachable(new CloudAnswerUnusable({ expected: "session stream" }))`)).toBe(false)
  })
})
