import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J7.4, §4.2; lands with T-STK-08
test("A-BRANCH-REBASE: rebases and exposes fresh checks before merge", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J7.4, §4.2; lands with T-STK-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T8")
  await say(page, "/branch.rebase T8")
  await say(page, "/todo T8")
  const todo = page.locator(".smithers-card").last()
  await expect(todo).toContainText("Checks running")
  await expect(todo.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(todo).toContainText("Reviewed")
  await expect(todo).toContainText("same change")
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("Checks running")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-BRANCH-REBASE: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T10")
  const card = page.locator(".branch-view").last()
  await say(page, "/branch.rebase T10")
  await expect(card.getByRole("tabpanel")).toContainText("Rebased onto main")
  await expect(card).toContainText("Working")
  await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toHaveCount(0)
})
