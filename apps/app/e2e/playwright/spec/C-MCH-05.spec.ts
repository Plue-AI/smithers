import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-05.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, J7; lands with T-MCH-09
test("C-MCH-05: Cleanup retains uncaptured work and active terminals with history", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, J7; lands with T-MCH-09")
  await owner(page)
  await page.goto("/")
  // Seed after cleanup: failed capture, post-capture write, active terminal,
  // active SSH, failed service stop and an unsettled In review branch retained.
  // Settled captured branches lose disks only after 24 h; retained objects rebuild on reopen.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("tab", { name: /^Terminals/ }).last().press("Enter")
  await expect(page.getByRole("button", { name: "Ben's terminal", exact: true }).last()).toBeVisible()
  await say(page, "/file shared.txt")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("uncaptured work")
  await say(page, "/todo T8")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await page.getByRole("tab", { name: /^Terminals/ }).last().press("Enter")
  await expect(page.getByRole("button", { name: "Ben's terminal", exact: true }).last()).toBeVisible()
})
