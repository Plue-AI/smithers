import { expect, test } from "bun:test"
import appendixB from "./fixtures/AppendixBPolicy.json"
import { FLOW_NAMES } from "./FlowName"
import { generateCatalog } from "../../../../../scripts/catalog-mvp"
import { auditAppIds } from "../../../../../scripts/catalog-policy"

// The full literal policy replaces the old Cut-only fixture. This existing
// cleanup check remains independently useful while the strict build audit
// names every unlisted or renamed registration awaiting T-CUT-03.
test("C-CAT-01 Appendix B Cut rows have no registered or catalog door", () => {
  const cuts = appendixB.rows.filter(row => row.status === "cut").flatMap(row => row.ids)
  expect(cuts).toHaveLength(50)
  expect(cuts).toContain("agent.session.*")
  expect(cuts).toContain("setup.*")
  expect(cuts).toContain("workspace.rename.edit")
  for (const ids of [FLOW_NAMES, generateCatalog().map(row => row.name)]) {
    expect(auditAppIds(ids).filter(row => row.reason === "cut")).toEqual([])
    expect(ids as readonly string[]).not.toContain("issue-sweep")
  }
})
