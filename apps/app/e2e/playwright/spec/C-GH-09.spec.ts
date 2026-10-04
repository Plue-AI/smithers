import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-GH-09.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md §6.1, §9; lands with T-GH-09, T-GH-01
test("C-GH-09: uncertain PR creation and Drop recover without a duplicate PR", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1, §9; lands with T-GH-09, T-GH-01")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Required seed: hold an uncertain PR-create, Drop before settlement,
  // restart the host, then release the late PR response and settle its close.
  // Browser reload observes recovery; it does not simulate the host restart.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("Working")
  await expect(card().getByRole("link", { name: /PR #/ })).toHaveCount(0)
  await card().getByRole("button", { name: "Drop", exact: true }).press("Enter")
  await expect(card()).toContainText("Drop")
  await card().getByRole("button", { name: "Drop", exact: true }).press("Enter")
  await expect(card()).toContainText("Dropped")
  await page.reload()
  await say(page, "/todo T1")
  await expect(card()).toContainText("Dropped")
  await expect(card()).toContainText("Closed")
  await expect(card().getByRole("link", { name: /PR #/ })).toHaveCount(1)
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await say(page, "/stack")
  await expect(card()).not.toContainText("T1")
})
