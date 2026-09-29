import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const entry = fileURLToPath(new URL("./run.ts", import.meta.url))
const example = fileURLToPath(new URL("./example", import.meta.url))
const answer = "Not yet: the fix ([#8](https://example.invalid/acme/pull/8)) is in review with passing checks."

const saved = (replies: ReadonlyArray<string>) => ({
  summary: { trials: replies.length },
  conversations: replies.map((reply, trial) => ({
    case: "answer-with-link",
    trial,
    checksPass: true, // Rescore must recompute this, not trust the saved verdict.
    judgePass: true,
    turns: [{
      trigger: { from: "owner", text: "is the safari signup bug fixed?" },
      reply,
      actions: [],
      modelCalls: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: 0
    }]
  }))
})

const rescore = (input: string) => {
  const dir = mkdtempSync(join(tmpdir(), "character-rescore-"))
  try {
    const suite = join(dir, "suite")
    cpSync(example, suite, { recursive: true })
    const file = join(dir, "saved.json")
    writeFileSync(file, input)
    // Run the real CLI in a separate process; no provider, runner or scorer mocks.
    const result = spawnSync("node", [
      entry, "--suite", suite, "--rescore", file, "--label", "exit-test"
    ], { encoding: "utf8", timeout: 30_000 })
    if (result.error) throw result.error
    const reports = result.status === 5 ? [] : readdirSync(join(suite, "results")).filter((name) =>
      name.endsWith("-exit-test.json")
    )
    const summary = reports.length === 1
      ? JSON.parse(readFileSync(join(suite, "results", reports[0]!), "utf8")).summary
      : undefined
    return { ...result, summary }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("character rescore exit status", () => {
  test("failed conversation exits 1 with the canonical failed checks", () => {
    const result = rescore(JSON.stringify(saved(["On it."])))
    expect(result.stderr).toBe("")
    expect(result.summary.mode).toBe("rescored")
    expect(result.summary.passAt1).toBe(0)
    expect(result.summary.allPass).toBe(0)
    expect(result.summary.failures).toHaveLength(1)
    expect(result.summary.failures[0].checks).toHaveLength(3)
    expect(result.status).toBe(1)
  }, 40_000)

  test("passing conversation exits 0", () => {
    const result = rescore(JSON.stringify(saved([answer])))
    expect(result.stderr).toBe("")
    expect(result.summary.passAt1).toBe(1)
    expect(result.summary.allPass).toBe(1)
    expect(result.summary.failures).toEqual([])
    expect(result.status).toBe(0)
  }, 40_000)

  test("a failed trial still exits 1 when another trial passes", () => {
    const result = rescore(JSON.stringify(saved([answer, "On it."])))
    expect(result.stderr).toBe("")
    expect(result.summary.passAt1).toBe(0.5)
    expect(result.summary.passAtK).toBe(1)
    expect(result.summary.allPass).toBe(0)
    expect(result.summary.failures).toHaveLength(1)
    expect(result.status).toBe(1)
  }, 40_000)

  test("an unreadable saved conversation remains a harness error (5)", () => {
    const result = rescore("{")
    expect(result.stderr).toContain("SyntaxError")
    expect(result.summary).toBeUndefined()
    expect(result.status).toBe(5)
  }, 40_000)
})
