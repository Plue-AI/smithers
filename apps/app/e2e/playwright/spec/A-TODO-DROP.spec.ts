import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Production journey mutation and durable completion projections remain pending.
// Written before implementation: mvp.md Appendix A, J4, J7.3; lands with T-STK-05
test("A-TODO-DROP: removes an unmerged TODO durably", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J4, J7.3; lands with T-STK-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.drop T10")
  await say(page, "/todo T10")
  await expect(page.locator(".smithers-card").last()).toContainText("Dropped")
  await say(page, "/stack")
  await expect(page.locator(".mvp-stack-row").filter({ hasText: "T10" })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted control projection; production receipts remain pending above.
test("A-TODO-DROP: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.drop T10")
  await say(page, "/todo T10")
  await expect(page.locator(".smithers-card").last()).toContainText("Dropped")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
