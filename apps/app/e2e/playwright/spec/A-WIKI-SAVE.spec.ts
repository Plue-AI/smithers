import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J9.3; lands with T-APP-02
test("A-WIKI-SAVE: saves an answer as a page", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J9.3; lands with T-APP-02")
  await owner(page)
  await page.goto("/")
  await say(page, "Where do we retry webhooks?")
  await page.getByRole("button", { name: "Save to wiki", exact: true }).last().press("Enter")
  await page.getByLabel("Name", { exact: true }).fill("Retry answer")
  await page.getByRole("button", { name: "Save", exact: true }).last().press("Enter")
  await say(page, "/wiki.page Retry answer")
  await expect(page.locator(".smithers-card").last()).toContainText("webhooks")
  await page.reload()
  await say(page, "/wiki.page Retry answer")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(page.locator(".smithers-card").last()).toContainText("webhooks")
})

// Seeded projection; provider and durable storage qualification remains above.
test("A-WIKI-SAVE: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/wiki.save Retry answer")
  await expect(page.getByText("Saving answers is unavailable.", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
