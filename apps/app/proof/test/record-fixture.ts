#!/usr/bin/env bun
/*
 * Re-record fixtures/results.json from fx.pw.ts with real Playwright, then make
 * every attachment path relative to the results file so the fixture is portable.
 * The run fails by design (fx-fail), so its exit code is ignored.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const here = dirname(new URL(import.meta.url).pathname)
const fixtures = join(here, "fixtures")
rmSync(join(fixtures, "run"), { recursive: true, force: true })
spawnSync("bunx", ["playwright", "test", "--config", join(here, "playwright.fixture.config.ts")], { cwd: join(here, "../.."), stdio: "inherit" })
rmSync(join(fixtures, "run/.last-run.json"), { force: true })
const path = join(fixtures, "results.json")
const text = readFileSync(path, "utf8")
const report = JSON.parse(text)
const walk = (value: unknown): void => {
  if (Array.isArray(value)) { value.forEach(walk); return }
  if (value === null || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (typeof record.path === "string" && record.path.startsWith("/")) record.path = relative(fixtures, record.path)
  for (const child of Object.values(record)) walk(child)
}
walk(report.suites)
report.config = { metadata: { "smithers.sha": "0123456789abcdef0123456789abcdef01234567" }, rootDir: "." }
report.stats = { ...report.stats, startTime: "2026-10-05T17:00:00.000Z" }
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
