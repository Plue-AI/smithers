import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FLOW_NAMES } from "./FlowName"
import { generateCatalog } from "../../../../../scripts/catalog-mvp"

const spec = readFileSync(new URL("../../../../../.specs/product/mvp.md", import.meta.url), "utf8")
const appendix = spec.split("### B.1 ")[1].split("### B.3 ")[0]
const cutRows = appendix.split("\n").filter(line => {
  const columns = line.split("|")
  return columns.length >= 6 && columns[4].trim().startsWith("Cut")
})

// These names have new meanings explicitly kept by Appendix A/B. They do not
// restore the retired pane or the old native issue-state surface. The mixed
// search row explicitly hides secrets instead of cutting it.
const replacements = new Set(["flows", "issues", "search.secrets"])
const patterns = cutRows.flatMap(line => {
  const names = [...line.split("|")[1].matchAll(/`([^`]+)`/g)].map(match => match[1])
  let prefix = ""
  return names.map(name => {
    const expanded = name.startsWith(".") ? prefix + name : name
    if (!name.startsWith(".")) prefix = name
    return expanded
  }).filter(name => !replacements.has(name))
})
const matches = (name: string, pattern: string) => pattern.endsWith("*")
  ? name.startsWith(pattern.slice(0, -1)) : name === pattern

test("C-CAT-01 Appendix B Cut rows have no registered or catalog door", () => {
  // Guard the oracle itself: a missing section must not make this pass vacuously.
  expect(cutRows).toHaveLength(15)
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
