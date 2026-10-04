import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Production journey mutation and durable completion projections remain pending.
// Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05
test("A-TODO-RETRY: retains the failed attempt and retry steer", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05")
  await owner(page)
  await page.goto("/")
  // Disposable journey fixture: T3 failed at Verify; attempt 1 remains readable.
  await say(page, "/todo.retry T3 FIXED: keep the regression test")
  await say(page, "/todo T3")
  const card = page.locator(".smithers-card").filter({ hasText: "T3" }).last()
  await expect(card).toContainText("Attempt 2")
  await card.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  const run = page.locator(".smithers-card").last()
  await expect(run).toContainText("FIXED: keep the regression test")
  await expect(run.getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await page.reload()
  await expect(run).toContainText("Attempt 2")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted refusal boundary; failed-attempt history remains pending above.
test("A-TODO-RETRY: refuses retry of a working TODO", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T10")
  const card = page.locator(".smithers-card").filter({ hasText: "T10" }).last()
  await expect(card).toContainText("Working")
  await say(page, "/todo.retry T10 Keep the regression test")
  await expect(page.getByText("Only failed TODOs retry", { exact: true }).last()).toBeVisible()
  await expect(card).toContainText("Working")
  await expect(card).not.toContainText("Attempt 2")
})
