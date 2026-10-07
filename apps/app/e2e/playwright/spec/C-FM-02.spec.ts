import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-FM-02.md; not a qualification receipt.
// Written before implementation: mvp.md §12 item 5, Models; spec.md §11.5b.2, §11.5b.3; lands with T-FM-02
test("C-FM-02: daily gateway quota leaves Chat usable without billing", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12 item 5, Models; spec.md §11.5b.2, §11.5b.3; lands with T-FM-02")
  // Seed an install signed into the gateway with no team key. Its next
  // completion exhausts the daily quota; the controlled clock then crosses
  // the UTC reset. Backend auth, counts-only storage and key confinement
  // require the separate gateway integration receipt, not a UI assertion.
  await owner(page)
  await page.goto("/")
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()
  await say(page, "/settings")
  await expect(page.getByText("Fast model: daily Smithers quota used; using coding model until 00:00 UTC", { exact: true })).toBeVisible()
  await expect(page.getByText(/billing|credit card/i)).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.reload()
  await say(page, "/settings")
  await expect(page.getByText("Fast model: daily Smithers quota used; using coding model until 00:00 UTC", { exact: true })).toBeVisible()
  // After the seeded midnight boundary, the sign-in source is usable again.
  await say(page, "What needs me?")
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible()
  await say(page, "/settings")
  await expect(page.getByText("Fast model: daily Smithers quota used; using coding model until 00:00 UTC", { exact: true })).toHaveCount(0)
})
