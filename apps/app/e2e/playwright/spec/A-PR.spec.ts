import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.5, §6.10; lands with T-STK-01, T-GH-03
test("A-PR: opens PR evidence and its TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.5, §6.10; lands with T-STK-01, T-GH-03")
  await owner(page)
  await page.goto("/")
  await say(page, "/pr #88")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("pnpm test")
  await expect(card).toContainText("pnpm lint")
  await expect(card).toContainText("No blocking issues")
  await card.getByRole("button", { name: "Diff", exact: true }).press("Enter")
  await expect(page.getByRole("region", { name: "package.json changes", exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/pr #88")
  await expect(page.locator(".smithers-card").last()).toContainText("GitHub")
})

// Seeded UI projection; live provider qualification remains above.
test("A-PR: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/pr #88")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("smithers/upgrade-stripe")
  await expect(card).toContainText("main")
  await card.getByRole("button", { name: "T8 ↗", exact: true }).press("Enter")
  await expect(page.locator(".todo-view").last()).toContainText("Upgrade the Stripe SDK to v17")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
