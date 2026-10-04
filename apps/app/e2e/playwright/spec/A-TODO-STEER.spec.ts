import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J3.6, J4; lands with T-STK-06
test("A-TODO-STEER: keeps a question open after a steer", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3.6, J4; lands with T-STK-06")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T9")
  await say(page, "/todo.steer T9 Use the existing retry helper.")
  const todo = page.locator(".smithers-card").filter({ hasText: "T9" }).last()
  await expect(todo).toContainText("Needs you")
  await expect(todo.getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  await todo.getByRole("button", { name: "Open branch", exact: true }).press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("Use the existing retry helper.")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
