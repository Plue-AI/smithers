import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The Go fixture owns PostgreSQL and the GitHub fake, then invokes the source
// CLI in isolated homes. Keep one composed-boundary implementation of the
// login, private confirmation, stale-head and session-approval assertions.
const run = promisify(execFile)
const backend = fileURLToPath(new URL("../../backend/", import.meta.url))
describe.skipIf(!process.env.SMITHERS_TEST_DATABASE_URL && !process.env.CI)("delegated laptop login against the install", () => {
  it("uses the issued credential to request a review_merge card without merging", async () => {
    const { stdout, stderr } = await run("go", [
      "test", "./internal/compose", "-run", "^Test(DelegatedCredentialComposedInstallPostgres|ConfirmationMergeAdmissionComposedPostgres)$", "-count=1", "-v"
    ], { cwd: backend, env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: "1" }, timeout: 600_000, maxBuffer: 4 << 20 }).catch((error: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`)
    })
    expect(stdout + stderr).not.toContain("--- SKIP:")
    expect(stdout).toContain("--- PASS: TestConfirmationMergeAdmissionComposedPostgres")
    expect(stdout).toContain("--- PASS: TestDelegatedCredentialComposedInstallPostgres")
  }, 610_000)
})
