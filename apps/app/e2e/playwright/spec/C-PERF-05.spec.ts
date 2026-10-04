import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-05.md; not a qualification receipt.
// Requires real sleep/capture cycles, captured-head equality and host monotonic wake samples.
// Written before implementation: mvp.md §6.7, §9; lands with T-MCH-06, T-REL-01
test("C-PERF-05: Opening a terminal wakes a safely sleeping branch", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, §9; lands with T-MCH-06, T-REL-01")
  await owner(page)
  await page.goto("/")
  // Live fixture starts warm and safely idle; each close waits for final capture.
  for (let i = 0; i < 100; i++) {
    await say(page, "/branch upgrade-stripe")
    await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
    await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
    await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
    await page.getByRole("button", { name: "Close", exact: true }).last().press("Enter")
    await say(page, "/branch upgrade-stripe")
    await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  }
})
