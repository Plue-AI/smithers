import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Log from "../src/log.ts"

it("appends private redacted diagnostics without losing earlier failures", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const token = `ghp_${"x".repeat(36)}`
    const cause = new Error(`missing dependency ${token}`)
    const failure = new Error("refused", { cause })
    cause.cause = failure
    Log.write("discovery", failure)
    Log.write("compaction", "seat unavailable")
    const saved = readFileSync(Log.path(), "utf8")
    const records = saved.trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((r) => r.tag)).toEqual(["discovery", "compaction"])
    expect(records[0].detail).toContain("Error: refused")
    expect(records[0].detail).toContain("Caused by: Error: missing dependency")
    expect(records[0].detail).toContain("[circular cause]")
    expect(saved.includes(token)).toBe(false)
    expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it("records renderer errors while retaining the renderer console sink", () => {
  const previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  const previousError = console.error
  const root = mkdtempSync(join(tmpdir(), "tui-render-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  const captured: unknown[][] = []
  console.error = (...values) => {
    captured.push(values)
  }
  const uninstall = Log.install()
  try {
    console.error(new Error("render failed"))
    expect(captured).toHaveLength(1)
    expect(readFileSync(Log.path(), "utf8")).toContain("render failed")
  } finally {
    uninstall()
    console.error = previousError
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})
