import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("../..", import.meta.url))
const queue = join(root, "factory/queue")

describe("queue inventory", () => {
  test("six stale docs are absent", () => {
    for (const path of [
      "MONDAY_RELEASE_REVIEW.md",
      "TESTING_REVIEW.md",
      "apps/HUMAN-TASKS.md",
      "apps/REMEDIATION.md",
      "apps/E2E-CANARY-CHECKLIST.md",
      "apps/MULTI-ACTIONS-GAP.md"
    ]) {
      expect(existsSync(join(root, path))).toBe(false)
    }
  })

  test("each retained queue prompt has an issue URL and queued status", () => {
    for (const name of readdirSync(queue).filter((name) => name.endsWith(".md") && name !== "README.md")) {
      const content = readFileSync(join(queue, name), "utf8")
      expect(content).toMatch(/^issue: https:\/\/github\.com\/smithersai\/smithers\/issues\/\d+$/m)
      expect(content).toMatch(/^status: queued$/m)
    }
  })
})
