import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "../browserTest"

// The owner reads JSON; there is no scorecard card. Exercise the composed
// install router against real PostgreSQL, never a seeded terminal's output.
test("C-REL-04: Owner scorecard reads lifecycle receipts and refuses missing sources", async () => {
  test.setTimeout(180_000)
  const database = process.env.SMITHERS_TEST_DATABASE_URL
  expect(database, "C-REL-04 requires real PostgreSQL").toBeTruthy()
  const { stdout, stderr } = await promisify(execFile)("go", [
    "test", "-v", "-count=1", "-run", "Scorecard",
    "./packages/backend/internal/compose", "./packages/backend/internal/services", "./packages/backend/internal/routes"
  ], {
    cwd: resolve(__dirname, "../../../../.."),
    env: process.env,
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024
  })
  expect(stdout + stderr).toContain("--- PASS: TestInstallScorecardOwnerReadsRealCreationReceipts")
  expect(stdout + stderr).not.toContain("--- FAIL:")
  expect(stdout + stderr).not.toContain("--- SKIP:")
})
