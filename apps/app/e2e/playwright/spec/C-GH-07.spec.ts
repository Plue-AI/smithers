import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-GH-07.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md J10.6, §6.3, §9; lands with T-GH-02
test("C-GH-07: GitHub changes arrive without Retry or a public address", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.6, §6.3, §9; lands with T-GH-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Required seed: ten pending PRs, 100 issues, automatic poll deltas
  // with inactive/dropped webhooks. The 100-sample p95 receipt is separate.
  await say(page, "/stack")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("synced 40 s ago")
  await say(page, "/todo T1")
  await expect(card()).toContainText("In review")
  await expect(card()).toContainText("Approved")
  await expect(card()).toContainText("7/7")
  await say(page, "/issue 231")
  await expect(card()).toContainText("freshness-1")
  await say(page, "/stack")
  await expect(card()).toContainText("Rebase pending")
  await expect(card()).toContainText("synced 3 s ago")
  await expect(card().getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
})
