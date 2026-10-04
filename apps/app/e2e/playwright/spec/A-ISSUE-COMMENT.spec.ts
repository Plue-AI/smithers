import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, J2.1, §6.3; lands with T-GH-09
test("A-ISSUE-COMMENT: comments on an issue", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J2.1, §6.3; lands with T-GH-09")
  await owner(page)
  await page.goto("/")
  await say(page, "/issue.comment #231 Both mailers handle password.reset")
  await say(page, "/issue #231")
  await expect(page.locator(".smithers-card").last()).toContainText("Both mailers handle password.reset")
  await page.reload()
  await say(page, "/issue #231")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(page.locator(".smithers-card").last()).toContainText("Both mailers handle password.reset")
})

// Seeded projection; provider and durable storage qualification remains above.
test("A-ISSUE-COMMENT: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/issue.comment #231 Both mailers handle password.reset")
  await say(page, "/issue #231")
  await expect(page.locator(".smithers-card").last()).toContainText("Both mailers handle password.reset")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
