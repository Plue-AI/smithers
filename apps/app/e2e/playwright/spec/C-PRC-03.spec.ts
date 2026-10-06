import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "../browserTest"

// Engineering-only check: exercise its public CLI, not a seeded terminal.
// The shared suite retains production recording, verification and close dispatch;
// only external GitHub transport is isolated. No live issue is written.
test("C-PRC-03: Receipt refusal cases remain observable without publishing an issue", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--test", "--test-reporter=tap", "scripts/check-receipts.test.mjs"
  ], {
    cwd: resolve(__dirname, "../../../../.."),
    timeout: 55_000,
    maxBuffer: 4 << 20
  })
  expect(stdout).toContain("# fail 0")
  expect(stdout).toMatch(/# pass [1-9][0-9]*/)
  expect(stdout).toContain("# skipped 0")
  expect(stdout).toContain("executable CLI closes recorder-produced evidence through isolated transport")
  expect(stdout).toContain("root-check-mapping-validation: markers refuse recorder and close without dispatch")
  expect(stdout).toContain("duplicate CI artifact identities refuse at recorder and completed-close boundaries")
})
