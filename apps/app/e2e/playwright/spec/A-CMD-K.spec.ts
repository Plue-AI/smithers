import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// mvp.md Appendix A: hermetic command door.
test("A-CMD-K: ⌘K submits a plain request", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await say(page, "say cycle25")
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]').last()).toContainText("stub: say cycle25")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
