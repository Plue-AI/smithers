import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.1, §6.3; lands with T-GH-02
test("A-ISSUE: opens a synced issue", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.1, §6.3; lands with T-GH-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/issue #231")
  await expect(page.locator(".smithers-card").last()).toContainText("Password reset emails arrive twice")
  await expect(page.getByRole("button", { name: "Make TODO", exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/issue #231")
  await expect(page.locator(".smithers-card").last()).toContainText("Password reset emails arrive twice")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; provider and durable storage qualification remains above.
test("A-ISSUE: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/issue #231")
  await expect(page.locator(".smithers-card").last()).toContainText("Password reset emails arrive twice")
  await expect(page.getByRole("button", { name: "Make TODO", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
