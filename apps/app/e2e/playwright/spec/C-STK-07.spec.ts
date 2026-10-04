import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-07.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.2, J2.6; lands with T-STK-04
test("C-STK-07: a stale merge confirmation offers the same blocker as the TODO and stack", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2, J2.6; lands with T-STK-04")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed T1 ready at 8b1e204; opening confirmation delivers c41a9e0
  // with required checks held. No stale merge is accepted; later rechecks pass.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card()).toContainText("Merge T1 into main?")
  await expect(card()).toContainText("Checks running on c41a9e0")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await card().getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await say(page, "/todo T1")
  await expect(card()).toContainText("Checks running on c41a9e0")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await say(page, "/stack")
  const row = page.getByRole("list", { name: "Stack", exact: true }).getByRole("listitem").filter({ hasText: /\bT1\b/ })
  await expect(row).toContainText("Checks running on c41a9e0")
  await expect(row.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await say(page, "/todo T1")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card()).toContainText("c41a9e0")
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card()).toContainText("Merged")
})
