import { expect, test } from "bun:test"
import ready from "./fixtures/register-repository-ready.json"
import { cachedReportOf, sharedReportOf, shortCommit, statusOf } from "./Registration"

const recorded = (): Record<string, unknown> => {
  const walk = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const report = (value as { report?: unknown }).report
    if (typeof report === "object" && report !== null && "clone" in report) return report as Record<string, unknown>
    for (const child of Object.values(value)) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(ready)!
}

test("a whole report of the repository asked about is kept with its commit; anything else is not", () => {
  const report = recorded()
  expect(sharedReportOf({ repo: "acme/widgets", commit: "fc3f257b643b41dd", report }, "acme/widgets")).toEqual({ commit: "fc3f257b643b41dd", report })
  expect(sharedReportOf({ commit: "fc3f257", report }, "acme/other")).toBeUndefined()
  expect(sharedReportOf({ commit: "", report }, "acme/widgets")).toBeUndefined()
  expect(sharedReportOf({ commit: "fc3f257", report: { repo: "acme/widgets" } }, "acme/widgets")).toBeUndefined()
  expect(sharedReportOf(null, "acme/widgets")).toBeUndefined()
  expect(sharedReportOf([], "acme/widgets")).toBeUndefined()
})

test("a cached report folds into the same tiles and answers a run would show", () => {
  const folded = cachedReportOf(recorded())
  expect(folded.clone?.commit).toBe("fc3f257b643b41dd8de24d4b0d3248253ab411c5")
  expect(folded.license?.choice.chosen).toBeDefined()
  expect(folded.sequences).toEqual([])
  expect(cachedReportOf({})).toEqual({ unavailable: [], sequences: [] })
  expect(shortCommit("fc3f257b643b41dd")).toBe("fc3f257")
})

test("the cached phase is the Cached status, and a failed cached attempt is Failed", () => {
  const card = { payload: { phase: "cached", startedAt: 0 } } as Parameters<typeof statusOf>[0]
  expect(statusOf(card, undefined)).toBe("Cached")
  expect(statusOf({ payload: { phase: "failed", startedAt: 0 } } as Parameters<typeof statusOf>[0], undefined)).toBe("Failed")
})
