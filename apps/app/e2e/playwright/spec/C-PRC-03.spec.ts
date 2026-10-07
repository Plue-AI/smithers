import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "../browserTest"

// Engineering CLI boundary with isolated external transport; not host qualification.
test("C-PRC-03: recorder-to-close refuses invalid evidence before publication", async () => {
  test.setTimeout(120_000)
  const root = resolve(__dirname, "../../../../..")
  const { stdout } = await promisify(execFile)(process.execPath,
    ["--test", "--test-reporter=tap", "scripts/check-receipts.test.mjs"],
    { cwd: root, timeout: 110_000, maxBuffer: 4 * 1024 * 1024 })
  expect(stdout).toMatch(/# fail 0\b/)
  expect(stdout).toMatch(/# skipped 0\b/)
  expect(stdout).toMatch(/# pass [1-9]\d*/)
})
