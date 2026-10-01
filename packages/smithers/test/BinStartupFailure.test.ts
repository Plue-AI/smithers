/**
 * A module that fails to load at startup is a failure nobody designed a
 * sentence for, so the executable prints the generic sentence. `--verbose`
 * appends the raw cause, which names the missing package (#2907).
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { unknownSentence } from "../src/internal/Failure.ts"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const missingModule = fileURLToPath(new URL("./fixtures/missing-startup-module.ts", import.meta.url))

const run = (args: ReadonlyArray<string>, redaction = false) => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-bin-startup-"))
  try {
    return spawnSync(process.execPath, ["--no-warnings", "--import", missingModule, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_OPTIONS: "", SMITHERS_TEST_STARTUP_REDACTION: redaction ? "1" : "" }
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("a module that fails to load at startup", { timeout: 240_000 }, () => {
  it.each([
    { name: "default", args: ["targets"] },
    { name: "explicit false", args: ["targets", "--verbose=false"] },
    { name: "spaced false", args: ["targets", "--verbose", "false"] },
    { name: "negated", args: ["targets", "--no-verbose"] },
    { name: "malformed inline boolean", args: ["targets", "--verbose=maybe"] },
    { name: "empty inline boolean", args: ["targets", "--verbose="] },
    { name: "malformed negated boolean", args: ["targets", "--no-verbose=true"] },
    { name: "opaque local option value", args: ["targets", "--message", "--verbose"] },
    { name: "opaque global option value", args: ["--root", "--verbose", "targets"] },
    { name: "opaque inline option value", args: ["targets", "--header=x-opaque:--verbose"] },
    { name: "literal argument tail", args: ["targets", "--", "--verbose"] },
    { name: "first false occurrence wins", args: ["--verbose=false", "targets", "--verbose"] }
  ])("prints only the generic sentence for $name", ({ args }) => {
    const result = run(args)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(`${unknownSentence}\n`)
  })

  it.each([
    { name: "global prefix", args: ["--verbose", "targets"] },
    { name: "command leaf", args: ["targets", "--verbose"] },
    { name: "inline true", args: ["targets", "--verbose=true"] },
    { name: "spaced true", args: ["targets", "--verbose", "true"] },
    { name: "first true occurrence wins", args: ["--verbose", "targets", "--no-verbose"] }
  ])("appends the unresolved module for $name", ({ args }) => {
    const result = run(args)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr.startsWith(`${unknownSentence}\n`)).toBe(true)
    expect(result.stderr).toContain("@smthrs/missing-startup-module")
  })

  it.each([["--verbose", "targets"], ["targets", "--verbose"]])(
    "redacts the real startup error's nested diagnostic for %j",
    (...args) => {
      const result = run(args, true)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("@smthrs/missing-startup-module")
      expect(result.stderr).toContain("[REDACTED")
      expect(result.stderr).not.toContain("synthetic-startup-bearer")
      expect(result.stderr).not.toContain("synthetic-startup-api-key")
    }
  )
})
