import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-11.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, M-13; lands with T-MCH-06
test("C-MCH-11: Coalesced branch demand waits until capacity is released", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, M-13; lands with T-MCH-06")
  await owner(page)
  await page.goto("/")
  // Seed capacity 1 with a held boot/stop and two requests on this branch.
  await say(page, "/branch upgrade-stripe")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await expect(page.getByText("Waiting for a machine", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("1st in queue", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await expect(page.getByText("1st in queue", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Waiting for a machine", { exact: true }).last()).toBeVisible()
  // The seeded runtime confirms the previous holder stopped before granting.
  await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Waiting for a machine", { exact: true })).toHaveCount(0)
})
