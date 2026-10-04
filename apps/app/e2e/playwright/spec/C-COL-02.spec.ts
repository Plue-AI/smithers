import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-COL-02.md; not a qualification receipt.
// Written before implementation: mvp.md §2 rule 5, J4.3, J10.6; lands with T-COL-02
test("C-COL-02: Reconnect preserves committed stack and branch activity once", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §2 rule 5, J4.3, J10.6; lands with T-COL-02")
  await owner(page)
  await page.goto("/")
  // Seed: 1,000 committed projection events, a send-budget gap and a
  // retention-expired reconnect. UI checks final state; seq equality belongs
  // to the fault suite. The seed must expose events only after real commit.
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Ben answered", { exact: true }).last()).toBeVisible()
  await page.context().setOffline(true)
  await say(page, "/stack")
  await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
  await page.context().setOffline(false)
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(page.getByText("Log every webhook retry attempt", { exact: true })).toHaveCount(1)
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Ben answered", { exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Maya via SSH changed 12 files", exact: true })).toHaveCount(1)
  await page.reload()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Ben answered", { exact: true })).toHaveCount(1)
})
