import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J2.2; lands with T-STK-09
test("A-TODO-FROM-ISSUE: drafts from issue discussion", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.2; lands with T-STK-09")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.from-issue 7")
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toHaveValue(/retry/i)
  await expect(page.getByLabel("Closes #7 when merged")).toBeChecked()
  await page.getByLabel("Prompt", { exact: true }).last().fill("Retry at most five times with jitter. Log each retry.")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("Committed as")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
