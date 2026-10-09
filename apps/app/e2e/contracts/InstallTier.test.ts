import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import t1 from "../../playwright.config"
import install from "../../playwright.install.config"

/*
 * T1 (browserE2e) runs on a host with no Go backend toolchain, PostgreSQL 18
 * or test database, inside a 30-minute budget. A Playwright test that starts a
 * real install is tagged @install and runs in the install tier
 * (//apps/app:installE2e) instead. This check is lexical: a test whose body
 * reaches one of the real-install doors below must carry the tag.
 */

const SUITE = join(import.meta.dir, "../playwright")
const REAL_INSTALL = /withGitHubInstall\(|runLiveInstall\(|spawn(?:Sync)?\(\s*"go"|execFile(?:Sync)?\)?\(\s*"go"|local-own-read\.ts|startLocalOwn\(|SMITHERS_TEST_DATABASE_URL|SMITHERS_FFI_LIBRARY_PATH/
const DECLARATION = /(?:^\s*|\)\s*)test(?:\.each\(.*?\))?\(\s*[`"']/
const TAGGED = /\{ tag: "@install" \}/

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

/* A top-level helper: its body runs until the next test or helper. */
const HELPER = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>)/

/**
 * Each test declaration with the lines up to the next test or helper, in
 * every suite file. A door in a helper the file defines counts wherever the
 * file calls that helper.
 */
const declarations = () => sources(SUITE).flatMap(path => {
  const lines = readFileSync(path, "utf8").split("\n")
  const end = (start: number, stops: ReadonlyArray<number>) => stops.find(stop => stop > start) ?? lines.length
  const starts = lines.flatMap((line, index) => DECLARATION.test(line) ? [index] : [])
  const declared = lines.flatMap((line, index) => {
    const name = HELPER.exec(line)?.slice(1).find(Boolean)
    return name ? [{ name, index }] : []
  })
  const stops = [...starts, ...declared.map(helper => helper.index)].sort((a, b) => a - b)
  const helpers = declared.map(({ name, index }) => ({ name, body: lines.slice(index, end(index, stops)).join("\n") }))
  const doors = new Set<string>()
  for (let pass = 0; pass < 3; pass++) for (const helper of helpers) {
    if (REAL_INSTALL.test(helper.body) || [...doors].some(name => new RegExp(`\\b${name}\\(`).test(helper.body))) doors.add(helper.name)
  }
  const reaches = (body: string) => REAL_INSTALL.test(body) || [...doors].some(name => new RegExp(`\\b${name}\\(`).test(body))
  return starts.map(start => {
    const body = lines.slice(start, end(start, stops)).join("\n")
    return { at: `${relative(SUITE, path)}:${start + 1}`, head: lines[start]!, install: reaches(body) }
  })
})

describe("the install tier", () => {
  test("every test that starts a real install is tagged @install", () => {
    const untagged = declarations().filter(test => test.install && !TAGGED.test(test.head)).map(test => test.at)
    expect(untagged).toEqual([])
  })

  test("the tag marks only tests that start a real install", () => {
    const stray = declarations().filter(test => TAGGED.test(test.head) && !test.install).map(test => test.at)
    expect(stray).toEqual([])
  })

  test("T1 excludes the tag and the install config selects only it", () => {
    expect(t1.grepInvert).toEqual(/@install/)
    expect(t1.grep).toBeUndefined()
    expect(install.grep).toEqual(/@install/)
    expect(install.grepInvert).toBeUndefined()
    expect(install.testDir).toBe(t1.testDir)
  })

  test("the lexical check sees each real-install door", () => {
    for (const door of [`await runLiveInstall("^TestX$")`, `spawn("go", ["test"])`, `spawnSync("go", [])`, `promisify(execFile)("go", [])`,
      `["e2e/playwright/debug-api/local-own-read.ts", output]`, `await withGitHubInstall(page, "TestX", "ENABLE", async () => {})`,
      `process.env.SMITHERS_TEST_DATABASE_URL`]) expect(REAL_INSTALL.test(door)).toBe(true)
    expect(REAL_INSTALL.test(`await installCloudFixture(page, {})`)).toBe(false)
    expect(DECLARATION.test(`for (const verb of ["Amend"] as const) test(\`C: \${verb}\`, { tag: "@install" }, async () => {`)).toBe(true)
  })
})
