import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J3.3, J6, §6.8; lands with T-TRM-01, T-APP-12
test("A-TERMINAL: opens an owned shell and restores it after reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3.3, J6, §6.8; lands with T-TRM-01, T-APP-12")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  await say(page, "/terminal T9")
  const terminal = page.locator(".terminal-view").last()
  await expect(terminal).toContainText("retry-webhooks")
  const input = terminal.locator("textarea")
  await input.focus()
  await page.keyboard.type("id -un")
  await page.keyboard.press("Enter")
  await expect(terminal.getByRole("region", { name: /output/ })).toContainText("maya")
  await page.reload()
  await expect(page.locator(".terminal-view").last()).toContainText("retry-webhooks")
  await expect(page.locator(".terminal-view").last().getByRole("region", { name: /output/ })).toContainText("maya")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-TERMINAL: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/terminal T9")
  const own = page.locator(".terminal-view").last()
  await expect(own).toContainText("retry-webhooks")
  await expect(own.getByRole("status")).toHaveCount(0)
  await expect(own.locator("textarea")).toBeEnabled()
  await say(page, "/branch T9")
  const branch = page.locator(".branch-view").last()
  await branch.getByRole("tab", { name: /Terminals/ }).press("Enter")
  await branch.getByRole("tabpanel").getByRole("button", { name: "terminal 1", exact: true }).press("Enter")
  const watched = page.locator(".terminal-view").last()
  await expect(watched.getByRole("status")).toHaveText("Watching")
  await expect(watched.locator("[inert]")).toHaveCount(1)
})
