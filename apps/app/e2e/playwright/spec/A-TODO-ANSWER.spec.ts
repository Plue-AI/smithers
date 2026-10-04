import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J2.4, J3.6; lands with T-STK-01
test("A-TODO-ANSWER: settles the waiting question", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.4, J3.6; lands with T-STK-01")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T9")
  await expect(page.locator(".smithers-card").last()).toContainText("Needs you")
  await say(page, "/todo.answer T9 Use the existing retry helper.")
  await expect(page.locator(".smithers-card").last()).toContainText("answered")
  await expect(page.locator(".smithers-card").last()).toContainText("Use the existing retry helper.")
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("answered")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
