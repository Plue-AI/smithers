import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.1–J2.2, §6.3; lands with T-STK-09, T-GH-02
test("A-ISSUES: lists synced issues and opens discussion", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.1–J2.2, §6.3; lands with T-STK-09, T-GH-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/issues")
  await page.getByRole("button", { name: /#231 Password reset emails arrive twice/ }).last().press("Enter")
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(/legacy mailer/)
  await page.reload()
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(/legacy mailer/)
})

// Seeded UI projection; live provider qualification remains above.
test("A-ISSUES: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/issues")
  await page.getByRole("button", { name: /#231 Password reset emails arrive twice/ }).last().press("Enter")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("Both the legacy mailer and the v2 template handle password.reset.")
  await expect(card.getByRole("button", { name: "Make TODO", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
