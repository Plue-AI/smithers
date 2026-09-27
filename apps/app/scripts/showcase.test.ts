import { describe, expect, test } from "bun:test"
import { loadCases } from "../e2e/showcase/cases"
import { coverage, flowCatalog, UNAVAILABLE } from "../e2e/showcase/coverage"
import { renderPage } from "../e2e/showcase/page"
import type { ShowcaseRecord } from "../e2e/showcase/showcase"

/*
 * The showcase's static contract. Whether each case's walk passes is the
 * browser tier's job (scripts/run-pr-e2e.mjs runs playwright.showcase.config.ts
 * without recording); this keeps the metadata honest without a browser.
 */
describe("showcase cases", () => {
  const cases = loadCases()
  const catalog = new Map(flowCatalog().map(flow => [flow.name, flow]))

  test("ids and orders are unique", () => {
    expect(new Set(cases.map(definition => definition.id)).size).toBe(cases.length)
    expect(new Set(cases.map(definition => definition.order)).size).toBe(cases.length)
  })

  test("every named flow is declared and can run on the test host", () => {
    for (const definition of cases) {
      expect(definition.flows.length).toBeGreaterThan(0)
      for (const flow of definition.flows) {
        expect(catalog.has(flow), `${definition.id}: ${flow}`).toBe(true)
        expect(catalog.get(flow)?.unavailable, `${definition.id}: ${flow}`).toBeUndefined()
      }
    }
  })

  test("titles and summaries stay short", () => {
    for (const definition of cases) {
      expect(definition.title.split(/\s+/).length, definition.id).toBeLessThanOrEqual(5)
      expect(definition.summary.length, definition.id).toBeLessThanOrEqual(100)
      expect(definition.summary).not.toContain("\n")
    }
  })
})

describe("showcase coverage", () => {
  test("every unavailable entry names a declared flow or namespace", () => {
    const names = flowCatalog().map(flow => flow.name)
    for (const key of Object.keys(UNAVAILABLE)) {
      const known = key.endsWith(".*") ? names.some(name => name.startsWith(key.slice(0, -1))) : names.includes(key)
      expect(known, key).toBe(true)
    }
  })

  test("a record's flows count as recorded and unknown names are reported", () => {
    const record: ShowcaseRecord = {
      id: "x", order: 1, title: "X", summary: "x", flows: ["history.show", "missing-flow"], doors: [], observed: ["history.show", "palette.open"],
      registered: ["history.show", "palette.open"], fakeBackend: true, revision: "abc", trimStart: 0, recordedAt: ""
    }
    const result = coverage([record])
    expect(result.rows.find(row => row.name === "history.show")?.bucket).toBe("recorded")
    // Observed but not asserted is not proof.
    expect(result.rows.find(row => row.name === "palette.open")?.bucket).toBe("unrecorded")
    expect(result.rows.find(row => row.name === "wiki")?.bucket).toBe("unavailable")
    expect(result.rows.find(row => row.name === "admin.health")?.unavailable).toBe("not registered on the test host")
    expect(result.unknown).toEqual(["missing-flow"])
    expect(result.counts.recorded + result.counts.unrecorded + result.counts.unavailable).toBe(result.rows.length)
  })

  test("the page escapes case text and tags fake-backend cases", () => {
    const record: ShowcaseRecord = {
      id: "x", order: 1, title: "<b>", summary: "a & b", flows: ["history.show"], doors: ["/history.show"], observed: ["history.show"],
      registered: ["history.show", "palette.open"], fakeBackend: true, revision: "abc", trimStart: 0, recordedAt: ""
    }
    const html = renderPage({ records: [record], coverage: coverage([record]), revision: "abc", generatedAt: "now" })
    expect(html).toContain("&lt;b&gt;")
    expect(html).toContain("a &amp; b")
    expect(html).toContain("fake backend")
    expect(html).toContain('src="gifs/x.gif"')
  })
})
