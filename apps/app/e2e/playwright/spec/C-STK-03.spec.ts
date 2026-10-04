import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-03.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.1, J4.2; lands with T-STK-05
test("C-STK-03: Resume keeps finished steps and Retry retains the earlier attempt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.1, J4.2; lands with T-STK-05")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed T1 Working after Plan; Resume holds Implement briefly. T2 Failed.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card().getByText("Plan", { exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Stop", exact: true }).press("Enter")
  await say(page, "/todo T1")
  await expect(card()).toContainText("Paused")
  await page.reload()
  await say(page, "/todo T1")
  await card().getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect(card()).toContainText("Working")
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card()).toContainText("Implement")
  await expect(card().getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(card().getByText("Plan", { exact: true })).toHaveCount(1)
  await say(page, "/todo T2")
  await card().getByLabel("Steer the retry", { exact: true }).fill("Keep the regression test")
  await card().getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect(card()).toContainText("Attempt 2")
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card().getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(card()).toContainText("Keep the regression test")
  await page.reload()
  await say(page, "/todo T2")
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card().getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(card()).toContainText("Attempt 2")
})
