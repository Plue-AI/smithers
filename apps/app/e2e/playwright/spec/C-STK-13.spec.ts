import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-STK-13.md.
// Requires scenario-specific seeded events; backend and reference-host receipts remain separate.
// Written before implementation: mvp.md M-39, §4.2; lands with T-STK-04
test("C-STK-13: pre-approval waits for readiness and can be removed", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-39, §4.2; lands with T-STK-04")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Required seed: maintainer, T2 behind T1, current-head checks held;
  // settle T1, then checks, then observe one externally confirmed merge.
  await say(page, "/todo T2")
  const card = () => page.locator(".smithers-card").last()
  await card().getByRole("button", { name: "Pre-approve", exact: true }).press("Enter")
  await expect(card()).toContainText("Merges after T1")
  await expect(card()).not.toContainText("Merged")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Remove pre-approval", exact: true }).press("Enter")
  await expect(card().getByRole("button", { name: "Pre-approve", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Pre-approve", exact: true }).press("Enter")
  await page.reload()
  await say(page, "/todo T2")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toBeVisible()
  await expect(card()).toContainText("Checks running")
  await expect(card()).not.toContainText("Merged")
  await expect(card()).toContainText("Merged")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toHaveCount(0)
})
