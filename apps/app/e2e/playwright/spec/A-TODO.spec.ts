import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J2, J4; lands with T-APP-02
test("A-TODO: opens the requested TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2, J4; lands with T-APP-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T9")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("T9")
  await expect(card).toContainText("Needs you")
  await expect(card.getByRole("button", { name: "Open branch", exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("T9")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
