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

const run = (args: ReadonlyArray<string>) => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-bin-startup-"))
  try {
    return spawnSync(process.execPath, ["--no-warnings", "--import", missingModule, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NODE_OPTIONS: "" }
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("a module that fails to load at startup", { timeout: 240_000 }, () => {
  it("prints only the generic sentence without --verbose", () => {
    const result = run(["targets"])
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(`${unknownSentence}\n`)
  })

  it("appends the unresolved module with --verbose", () => {
    const result = run(["targets", "--verbose"])
    expect(result.status).toBe(1)
    expect(result.stderr.startsWith(`${unknownSentence}\n`)).toBe(true)
    expect(result.stderr).toContain("@smthrs/missing-startup-module")
  })
})
