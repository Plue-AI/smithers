import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J3, §6.7, §6.8; lands with T-APP-10, T-COL-06
test("A-BRANCH: opens a shared branch by ref and retains it on reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3, §6.7, §6.8; lands with T-APP-10, T-COL-06")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  const card = page.locator(".branch-view").last()
  await expect(card).toContainText("retry-webhooks")
  await expect(card.getByRole("list", { name: "On this branch" })).toContainText("Alice")
  await expect(card).toContainText("Coding agent")
  await page.reload()
  await expect(page.locator(".branch-view").last()).toContainText("retry-webhooks")
  await expect(page.locator(".session-navigation")).toContainText("retry-webhooks")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-BRANCH: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  const card = page.locator(".branch-view").last()
  await expect(card).toContainText("retry-webhooks")
  await expect(card).toContainText("Needs you")
  await expect(card).toContainText("#2 in stack")
  await expect(card.getByRole("list", { name: "On this branch" })).toContainText("Alice")
  await expect(card).toContainText("Coding agent")
  await card.getByRole("tab", { name: /Terminals/ }).press("Enter")
  await expect(card.getByRole("tabpanel")).toContainText("terminal 1")
})
