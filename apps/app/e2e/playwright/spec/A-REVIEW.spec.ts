import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md Appendix A, §6.3, Appendix B.2, C-J10-09; lands with T-FLW-13, T-APP-16
test("A-REVIEW: reviews a teammate PR without merging", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, §6.3, Appendix B.2, C-J10-09; lands with T-FLW-13, T-APP-16")
  await owner(page)
  await page.goto("/")
  // Fixture: member PR #50 has the off-by-one described in C-J10-09.
  await say(page, "/review #50")
  await expect(page.getByText(/src\/cache.ts/).last()).toBeVisible()
  await expect(page.getByText(/Blocker|Fix/).last()).toBeVisible()
  await expect(page.getByRole("link", { name: /GitHub/ }).last()).toHaveAttribute("href", /pull\/50/)
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await say(page, "/review #51")
  await expect(page.getByText(/permission|non-member/i).last()).toBeVisible()
})

// The mounted agent door requires the person's confirmation before review.
test("A-REVIEW: mounted confirmation", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "review retry-webhooks")
  await expect(page.getByRole("button", { name: "Run review", exact: true }).last()).toBeVisible()
  await expect(page.getByText("redeliver() still sleeps a fixed 30 s.", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Cancel", exact: true }).last().press("Enter")
  await expect(page.getByRole("button", { name: "Run review", exact: true })).toHaveCount(0)
  await expect(page.getByText("redeliver() still sleeps a fixed 30 s.", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
