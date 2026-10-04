import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// mvp.md Appendix A: hermetic command door.
test("A-STOP: /stop is safe with no active answer and permits a new answer", async ({ page }) => {
  await page.goto("/")
  await say(page, "/stop")
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await say(page, "say after stop")
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]').last()).toContainText("stub: say after stop")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
