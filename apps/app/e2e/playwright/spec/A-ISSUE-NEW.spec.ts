import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, §6.3; lands with T-GH-09, T-APP-02
test("A-ISSUE-NEW: creates a GitHub issue", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, §6.3; lands with T-GH-09, T-APP-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/issue.new")
  await page.getByLabel("Title", { exact: true }).fill("Invoice totals round wrong")
  await page.getByLabel("Body", { exact: true }).fill("42.004 prints as 42.00")
  await page.getByRole("button", { name: "Open on GitHub", exact: true }).press("Enter")
  await say(page, "/issues")
  await expect(page.getByRole("button", { name: /Invoice totals round wrong/ }).last()).toBeVisible()
  await page.reload()
  await say(page, "/issues")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(page.getByRole("button", { name: /Invoice totals round wrong/ }).last()).toBeVisible()
})

// Seeded projection; provider and durable storage qualification remains above.
test("A-ISSUE-NEW: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/issue.new")
  await page.getByLabel("Title", { exact: true }).fill("Invoice totals round wrong")
  await page.getByLabel("Body", { exact: true }).fill("42.004 prints as 42.00")
  await expect(page.getByRole("button", { name: "Open on GitHub", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await say(page, '/issue.new {"title":"Invoice totals round wrong","body":"42.004 prints as 42.00"}')
  await say(page, "/issues")
  await expect(page.getByRole("button", { name: /Invoice totals round wrong/ }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
