/**
 * Pins deterministic test selection independently of provider credentials.
 *
 * @since 0.1.0
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(process.env.SMITHERS_LIVE_EXAMPLES === "1")(
  "isolates the deterministic suite from every ambient provider key",
  () => {
    expect(process.env.OPENAI_API_KEY ?? "").toBe("")
    expect(process.env.GEMINI_API_KEY ?? "").toBe("")
    expect(process.env.SMITHERS_EXAMPLE_API_KEY ?? "").toBe("")
  }
)

it.each([
  { optIn: undefined, key: "selection-only" },
  { optIn: "0", key: "selection-only" },
  { optIn: "1", key: "selection-only" },
  { optIn: "1", key: "" }
])("selects live tests only with opt-in and their prerequisites ($optIn, $key)", async ({ key, optIn }) => {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: key }
  delete env.SMITHERS_LIVE_EXAMPLES
  if (optIn !== undefined) env.SMITHERS_LIVE_EXAMPLES = optIn
  const { stdout } = await promisify(execFile)(process.execPath, [
    new URL("./fixtures/live-test-selection.ts", import.meta.url).pathname
  ], { cwd: new URL("..", import.meta.url).pathname, env, timeout: 60_000 })
  const tests = JSON.parse(stdout) as ReadonlyArray<{ file: string; name: string; mode: string; timeout: number }>
  expect(tests).toHaveLength(2)
  for (const test of tests) {
    const requiresKey = test.file === "test/12-agent-live-smoke.test.ts"
    expect(test.mode).toBe(optIn === "1" && (!requiresKey || key !== "") ? "run" : "skip")
    expect(test.name).toContain("SMITHERS_LIVE_EXAMPLES=1")
    expect(test.timeout).toBe(300_000)
  }
}, 90_000)
