import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Durable production Drop and fork preservation are exercised by C-J7-02.spec.ts.
// Mounted control projection supplements the composed-install journey.
test("A-TODO-DROP: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.drop T10")
  await page.getByRole("button", { name: "Confirm: drop this TODO", exact: true }).press("Enter")
  await say(page, "/todo T10")
  await expect(page.locator(".smithers-card").last()).toContainText("Dropped")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
