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

/** Each test declaration with the lines up to the next one, in every suite file. */
const declarations = () => sources(SUITE).flatMap(path => {
  const lines = readFileSync(path, "utf8").split("\n")
  const starts = lines.flatMap((line, index) => DECLARATION.test(line) ? [index] : [])
  return starts.map((start, at) => ({
    at: `${relative(SUITE, path)}:${start + 1}`,
    head: lines[start]!,
    body: lines.slice(start, starts[at + 1] ?? lines.length).join("\n")
  }))
})

describe("the install tier", () => {
  test("every test that starts a real install is tagged @install", () => {
    const untagged = declarations().filter(test => REAL_INSTALL.test(test.body) && !TAGGED.test(test.head)).map(test => test.at)
    expect(untagged).toEqual([])
  })

  test("the tag marks only tests that start a real install", () => {
    const stray = declarations().filter(test => TAGGED.test(test.head) && !REAL_INSTALL.test(test.body)).map(test => test.at)
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
