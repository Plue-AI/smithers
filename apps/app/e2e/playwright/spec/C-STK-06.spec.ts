import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-06.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.2, Appendix B.5; lands with T-STK-12, T-FLW-11, T-STK-01, T-GH-09, T-MCH-14
test("C-STK-06: checks and merge evidence follow the current candidate revision", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2, Appendix B.5; lands with T-STK-12, T-FLW-11, T-STK-01, T-GH-09, T-MCH-14")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed T1 In review at 8b1e204 with a person present. Rebase now moves
  // to c41a9e0; hold rechecks before completing. Real tree hashes remain integration evidence.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("8b1e204")
  await expect(card().getByText("Checks", { exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Open branch", exact: true }).press("Enter")
  await card().getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
  await expect(card()).toContainText("Rebased onto main")
  await say(page, "/todo T1")
  await expect(card()).toContainText("Checks running on c41a9e0")
  await expect(card()).toContainText("Approval cleared by rebase · checks rerun")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(card()).toContainText("Reviewed 8b1e204 · same change")
  await expect(card().getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card()).toContainText("c41a9e0")
  await expect(card()).toContainText("GitHub")
  await card().getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card()).toContainText("Merged")
})
