import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Production journey mutation and durable completion projections remain pending.
// Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05
test("A-TODO-RESUME: resumes the same paused attempt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.stop T10")
  await say(page, "/todo T10")
  const card = page.locator(".smithers-card").filter({ hasText: "T10" }).last()
  await expect(card).toContainText("Paused")
  await say(page, "/todo.resume T10")
  await expect(card).toContainText("Working")
  await expect(card).not.toContainText("Attempt 2")
  await card.getByRole("button", { name: "Inspect", exact: true }).press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("Implement")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted control projection; production receipts remain pending above.
test("A-TODO-RESUME: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.stop T10")
  await say(page, "/todo T10")
  const card = page.locator(".smithers-card").filter({ hasText: "T10" }).last()
  await expect(card).toContainText("Paused")
  await say(page, "/todo.resume T10")
  await expect(card).toContainText("Working")
  await expect(card).not.toContainText("Attempt 2")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
