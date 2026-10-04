import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-GH-08.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md §6.3, §9; lands with T-GH-02
test("C-GH-08: ten pending PRs retain automatic sync while Chat remains usable", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.3, §9; lands with T-GH-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Folded check: T-GH-02 owns request-budget instrumentation.
  // Required seed: ten pending TODO PRs and 100 issues, repeated scheduled
  // poll deltas under the budget. UI assertions never claim request-count evidence.
  await say(page, "/stack")
  const card = () => page.locator(".smithers-card").last()
  for (let n = 1; n <= 10; n++) {
    await say(page, `/todo T${n}`)
    await expect(card()).toContainText("In review")
    await expect(card()).not.toContainText("Merged")
  }
  await say(page, "/help")
  await expect(card()).toContainText("Commands")
  await say(page, "/issue 231")
  await expect(card()).toContainText("Password reset emails arrive twice")
  await say(page, "/stack")
  await expect(card()).toContainText("synced 3 s ago")
  await expect(card().getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
})
