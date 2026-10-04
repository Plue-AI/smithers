import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Production journey mutation and durable completion projections remain pending.
// Written before implementation: mvp.md Appendix A, J1, J2, J4, §4.2; lands with T-STK-04
test("A-MERGE: reviews the next item before merging", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J1, J2, J4, §4.2; lands with T-STK-04")
  await owner(page)
  await page.goto("/")
  await say(page, "/merge T8")
  const confirm = page.locator(".smithers-card").last()
  await expect(confirm).toContainText("Merge T8 into main?")
  await expect(confirm).toContainText("GitHub")
  await expect(confirm).toContainText("rev")
  await confirm.getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(confirm).toContainText("Merged T8")
  await say(page, "/stack")
  await expect(page.locator(".mvp-stack-row").filter({ hasText: "T8" })).toHaveCount(0)
  await expect(page.locator(".mvp-stack-row").filter({ hasText: "T10" })).toContainText("Merges after T9")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted control projection; production receipts remain pending above.
test("A-MERGE: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/merge T8")
  const card = page.locator(".smithers-card").last()
  await expect(card).toContainText("Merge T8 into main?")
  await expect(card).toContainText("GitHub")
  await card.getByRole("button", { name: "Merge", exact: true }).press("Enter")
  await expect(card).toContainText("Merged T8")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
