import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "../browserTest"

/** The owned Go harness starts the production install and the real browser client. */
export async function runLiveInstall(pattern: string): Promise<string> {
  expect(process.env.SMITHERS_TEST_DATABASE_URL, "A real PostgreSQL test server is required").toBeTruthy()
  const { stdout } = await promisify(execFile)("go", [
    "test", "./packages/backend/internal/compose", "-count=1", "-v", "-run", pattern
  ], {
    cwd: resolve(__dirname, "../../../../.."), timeout: 290_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SMITHERS_LIVE_BROWSER: "1", SMITHERS_REQUIRE_DATABASE_TESTS: "1" }
  }).catch(async (error: Error & { stdout?: string; stderr?: string }) => {
    await test.info().attach("install-output", {
      body: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, contentType: "text/plain"
    })
    throw error
  })
  expect(stdout).not.toContain("--- SKIP:")
  return stdout
}
