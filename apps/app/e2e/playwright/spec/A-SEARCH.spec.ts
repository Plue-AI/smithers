import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// mvp.md Appendix A: hermetic command door.
test("A-SEARCH: /search shows an absent query", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/search cycle25-no-such-result")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("cycle25-no-such-result")
  await expect(card).toContainText("No results")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
