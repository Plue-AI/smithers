import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J4; lands with T-APP-01
test("A-STACK: /stack keeps a Needs you filter", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J4; lands with T-APP-01")
  await owner(page)
  await page.goto("/")
  await say(page, "/stack")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("main")
  await card.getByRole("button", { name: /Needs you/ }).press("Enter")
  await page.reload()
  await expect(page.locator(".smithers-card").last()).toContainText("Needs you")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
