import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-05.md.
// Requires seeded DesignWorld; backend race, tree and reference-host receipts remain separate.
// Written before implementation: mvp.md §4.1, J2.5, J3.6; lands with T-MCH-14
test("C-STK-05: a late review steer wakes the retained branch and run", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.1, J2.5, J3.6; lands with T-MCH-14")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed T1 In review, sleeping for three days, run-41 and src/retry.ts retained.
  // Seed wake completion after Steer; the retained Run card is titled Retry webhooks.
  await say(page, "/todo T1")
  const card = () => page.locator(".smithers-card").last()
  await expect(card()).toContainText("In review")
  await card().getByRole("button", { name: "Open branch", exact: true }).press("Enter")
  await expect(card()).toContainText("Asleep")
  await card().getByLabel("Steer the coding agent", { exact: true }).fill("Keep the old retry name")
  await card().getByRole("button", { name: "Steer", exact: true }).press("Enter")
  await expect(card()).toContainText("Keep the old retry name")
  await expect(card()).toContainText("Awake")
  await card().getByRole("tab", { name: /^Files/ }).press("Enter")
  await card().getByRole("button", { name: "src/retry.ts", exact: true }).press("Enter")
  await expect(card()).toContainText("export const retry =")
  await say(page, "/todo T1")
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card().getByRole("heading", { name: "Retry webhooks", exact: true })).toBeVisible()
  await expect(card().getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(card()).toContainText("Keep the old retry name")
  await page.reload()
  await say(page, "/todo T1")
  await card().getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(card().getByRole("heading", { name: "Retry webhooks", exact: true })).toBeVisible()
  await expect(card()).not.toContainText("Attempt 2")
})
