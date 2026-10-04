import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-01.md; not a qualification receipt.
// Written before implementation: mvp.md §14, M-26; lands with T-MNT-01
test("C-MNT-01: Incoming outsider events await a maintainer act", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14, M-26; lands with T-MNT-01")
  await owner(page)
  await page.goto("/")
  // Stage-M fixture: duplicate outsider events and no admitted runs.
  await say(page, "/stack")
  await page.getByRole("button", { name: "Incoming", exact: true }).last().press("Enter")
  await expect(page.getByText("Retry drops the final webhook", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Retry drops the final webhook", { exact: true }).last()).toBeVisible()
  // Command names for the M extension await approval; use its visible control.
  await page.getByRole("button", { name: "Triage", exact: true }).last().press("Enter")
  await expect(page.getByText("Queued", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0)
})
