import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const pages = [
  "../docs/concepts/retries.md",
  "../docs/troubleshooting.md"
]

describe("retry documentation", () => {
  for (const page of pages) {
    it(`preserves the declared failure contract in ${page}`, () => {
      const source = readFileSync(new URL(page, import.meta.url), "utf8")
      expect(source).not.toMatch(/RetryAttemptsExhausted|RetryPolicyExpired/)
      if (page.includes("/concepts/retries.")) {
        expect(source).toMatch(/final (?:declared|typed|business) failure/)
        expect(source).toContain("retry.stopReason")
        expect(source).toContain("\"exhausted\"")
        expect(source).toContain("\"expired\"")
        expect(source).toContain("retry.attempt")
      }
    })
  }
})
