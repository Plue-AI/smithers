import { describe, expect, test } from "bun:test"
import { isTestPath } from "../../src/text/isTestPath.ts"

// One table for the shared review checklist and walkthrough path rule.
//
// the walkthrough chapters all read this, so a disagreement here is a bug in all
// three at once.
const cases: Array<[string, boolean]> = [
  ["src/app.test.ts", true],
  ["src/app.spec.tsx", true],
  ["src/login.e2e.ts", true],
  ["packages/x/tests/foo.ts", true],
  ["packages/x/test/foo.ts", true],
  ["src/__tests__/foo.ts", true],
  ["apps/ui/e2e/login.ts", true],
  ["spec/rendering/table.rb", true],
  ["internal/parser_test.go", true],
  ["internal/parser_spec.rb", true],
  ["Src/Tests/Foo.TS", true],
  ["src/app.ts", false],
  ["src/latest.ts", false],
  ["src/contest/index.ts", false],
  ["docs/testing.md", false],
  ["src/protest.ts", false]
]

describe("isTestPath", () => {
  for (const [path, expected] of cases) {
    test(`${path} is ${expected ? "" : "not "}a test path`, () => {
      expect(isTestPath(path)).toBe(expected)
    })
  }
})
