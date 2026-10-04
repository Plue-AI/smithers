import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-GH-13.md.
// Integration and reference-host evidence remains required separately.
// Written before implementation: mvp.md §6.1–6.3; lands with T-GH-04
test("C-GH-13: GitHub facts use one pure decision seam", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1–6.3; lands with T-GH-04")
  // Required seed: replay first, duplicate and stale GitHub review/check/push
  // facts, then restart the inbound consumer at each transaction boundary.
  // The fixed scenario finishes T8 once and retains T9's foreign-push wait.
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T8")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("Merged into main")
  await expect(card.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, "/todo T8")
  await expect(page.locator(".smithers-card").last()).toContainText("Merged into main")
  await say(page, "/todo T9")
  await expect(page.locator(".smithers-card").last()).toContainText("Needs you")
  await expect(page.getByRole("button", { name: "Bring in", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeVisible()
  // Consumer effects and the exhaustive pure matrix require T-GH-04 receipts.
})
