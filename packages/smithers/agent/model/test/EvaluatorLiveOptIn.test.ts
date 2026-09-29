import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url))
const blockedFetch = new URL("./fixtures/blockProviderFetch.mjs", import.meta.url).href
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const liveCase = "Evaluator over the live gateway answers the three question shapes"

const runLiveCase = (optIn: string | undefined) => {
  const scratch = mkdtempSync(join(tmpdir(), "smithers-evaluator-gate-"))
  const reportPath = join(scratch, "report.json")
  const markerPath = join(scratch, "fetch-called")
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_GATEWAY_API_KEY: "unused-test-key",
      SMITHERS_EVALUATOR_FETCH_MARKER: markerPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${blockedFetch}`,
      NO_COLOR: "1"
    }
    if (optIn === undefined) delete env.SMITHERS_LIVE_MODEL_TESTS
    else env.SMITHERS_LIVE_MODEL_TESTS = optIn

    const result = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        "test/Evaluator.test.ts",
        "--testNamePattern=Evaluator over the live gateway",
        "--coverage.enabled=false",
        "--reporter=json",
        `--outputFile=${reportPath}`
      ],
      { cwd: packageRoot, env, encoding: "utf8", timeout: 30_000 }
    )
    if (result.error !== undefined) throw result.error
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      testResults: ReadonlyArray<{ assertionResults: ReadonlyArray<{ fullName: string; status: string }> }>
    }
    const cases = report.testResults.flatMap((suite) => suite.assertionResults)
      .filter((test) => test.fullName === liveCase)
      .map(({ fullName, status }) => ({ fullName, status }))
    return { status: result.status, cases, fetched: existsSync(markerPath) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

describe("evaluator live suite opt-in", () => {
  it.each([undefined, "0", "false"])("skips with an ambient key and opt-in %s", (optIn) => {
    const result = runLiveCase(optIn)
    expect(result.status).toBe(0)
    expect(result.cases).toEqual([{ fullName: liveCase, status: "skipped" }])
    expect(result.fetched).toBe(false)
  }, 35_000)

  it("reaches the blocked fetch when explicitly enabled", () => {
    const result = runLiveCase("1")
    expect(result.status).not.toBe(0)
    expect(result.cases).toEqual([{ fullName: liveCase, status: "failed" }])
    expect(result.fetched).toBe(true)
  }, 35_000)
})
