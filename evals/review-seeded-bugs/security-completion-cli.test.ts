import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repository = resolve(import.meta.dirname, "../..")
const script = join(import.meta.dirname, "security-completion.ts")
const scratch: Array<string> = []

const outputPath = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "security-completion-cli-test-"))
  scratch.push(directory)
  return join(directory, "report.json")
}

const runWithoutCredentials = (output: string, whitespace = false) => {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.OPENAI_API_KEY
  if (whitespace) {
    env.ANTHROPIC_API_KEY = " \t\n"
    env.OPENAI_API_KEY = " \t\n"
  }
  return spawnSync("node", [script, "2", output], {
    cwd: repository,
    env,
    encoding: "utf8",
    timeout: 60_000
  })
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("security completion evaluation CLI", () => {
  test("fails before creating a report when both model credentials are missing", () => {
    const output = outputPath()
    const result = runWithoutCredentials(output)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("ANTHROPIC_API_KEY")
    expect(result.stderr).toContain("OPENAI_API_KEY")
    expect(existsSync(output)).toBe(false)
  }, 90_000)

  test("preserves an existing report when model credentials are missing", () => {
    const output = outputPath()
    const sentinel = "previous verified report\n"
    writeFileSync(output, sentinel)
    const result = runWithoutCredentials(output)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(readFileSync(output, "utf8")).toBe(sentinel)
  }, 90_000)

  test("rejects whitespace-only credentials before creating a report", () => {
    const output = outputPath()
    const result = runWithoutCredentials(output, true)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("ANTHROPIC_API_KEY")
    expect(result.stderr).toContain("OPENAI_API_KEY")
    expect(existsSync(output)).toBe(false)
  }, 90_000)
})
