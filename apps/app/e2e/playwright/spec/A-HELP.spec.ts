import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// mvp.md Appendix A: hermetic command door.
test("A-HELP: /help lists commands", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/help")
  const card = page.locator(".smithers-card").last()
  await expect(card.getByText("/help", { exact: true })).toBeVisible()
  await expect(card.getByText("/search", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
