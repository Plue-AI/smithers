import { expect, test } from "bun:test"
import appendixB from "./fixtures/AppendixB.json"
import { FLOW_NAMES } from "./FlowName"
import { generateCatalog } from "../../../../../scripts/catalog-mvp"

// Reviewed literal B.1/B.2 expansions. Runtime expectations never parse the
// product document, so editing a product row cannot silently weaken this gate.
const patterns = appendixB.cut
const matches = (name: string, pattern: string) => pattern.endsWith("*")
  ? name.startsWith(pattern.slice(0, -1)) : name === pattern

test("C-CAT-01 Appendix B Cut rows have no registered or catalog door", () => {
  // Guard the oracle itself: a missing section must not make this pass vacuously.
  expect(patterns).toHaveLength(48)
  expect(patterns).toContain("agent.session.*")
  expect(patterns).toContain("setup.*")
  expect(patterns).toContain("workspace.rename.edit")
  for (const pattern of patterns) {
    expect(FLOW_NAMES.filter(name => matches(name, pattern)), pattern).toEqual([])
    expect(generateCatalog().filter(row => matches(row.name, pattern)), pattern).toEqual([])
  }
  // B.2's mixed Defer row independently cuts issue-sweep from the product.
  expect(FLOW_NAMES as readonly string[]).not.toContain("issue-sweep")
  expect(generateCatalog().some(row => row.name === "issue-sweep")).toBe(false)
})
