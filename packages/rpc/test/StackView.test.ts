import { describe, expect, test } from "vitest"
import { type MythicalItem, MYTHICAL_ROUTES, mythicalRoute } from "../src/Mythical.ts"
import { landable, retryable } from "../src/StackView.ts"

const head = "c".repeat(40)
const proposed: MythicalItem = {
  id: "item-1",
  issue: { number: 12, title: "Add the footer link", url: "https://github.com/o/r/issues/12" },
  state: "proposed",
  attempt: 1,
  runs: {},
  todo: { replans: 0 },
  pullRequest: { number: 40, url: "https://github.com/o/r/pull/40", state: "open", head },
  dependsOn: [],
  updatedAt: "2026-09-30T10:00:00Z"
}

describe("landable", () => {
  test("a proposed TODO whose pull request is open at a known head, not yet asked to merge", () => {
    expect(landable(proposed)).toBe(true)
  })

  test("anything else is not landed from Smithers", () => {
    const { issue: _issue, ...chat } = proposed
    const { todo: _todo, ...proposal } = proposed
    const { head: _head, ...headless } = proposed.pullRequest!
    const { pullRequest: _pull, ...unopened } = proposed
    for (const item of [
      chat,
      proposal,
      unopened,
      { ...proposed, automerge: true },
      { ...proposed, state: "landed" as const },
      { ...proposed, state: "verifying" as const },
      { ...proposed, pullRequest: { ...proposed.pullRequest!, state: "closed" as const } },
      { ...proposed, pullRequest: headless }
    ]) {
      expect(landable(item)).toBe(false)
    }
  })

  test("landing and retrying never offer on the same item", () => {
    expect(retryable(proposed)).toBe(false)
    expect(landable({ ...proposed, state: "blocked" })).toBe(false)
  })

  test("the land route names the item", () => {
    expect(MYTHICAL_ROUTES.land).toBe("/api/repos/{owner}/{repo}/mythical/items/{id}/land")
    expect(mythicalRoute("land", "o", "r", "item 1")).toBe("/api/repos/o/r/mythical/items/item%201/land")
  })
})
