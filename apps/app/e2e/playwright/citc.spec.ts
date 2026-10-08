import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"

test("T-APP-10: /branch opens one Branch card and keeps Chat usable", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch T9")
  const card = page.locator('.smithers-card[data-kind="branch"][data-testid]').last()
  await expect(card).toBeVisible()
  await expect(card.getByRole("tab", { name: "Activity", exact: true })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.reload()
  await expect(page.locator('.smithers-card[data-kind="branch"][data-testid]').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// T-UI-17: dispatcher -> registry -> View/adapter on the non-install seed fallback.
// Machine ownership and frozen live metadata remain T-APP-12/T-TRM-01 receipts.
test("T-UI-17: mounted terminal accepts owner keys and preserves the shell palette while watching", async ({ page }) => {
  await page.goto("/")
  const command = async (line: string) => {
    await fillComposer(page, line)
    await page.getByTestId("composer-send").press("Enter")
    await expect(page.getByTestId("composer-input")).toHaveValue("")
    const input = page.getByTestId("composer-input")
    if (await input.isVisible()) await input.press("Escape")
    if (await input.isVisible()) await input.press("Escape")
  }
  await command("/terminal T9")
  const own = page.locator(".terminal-view").last()
  await expect(own).toBeVisible()
  await own.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("pnpm test")
  await page.keyboard.press("Enter")
  await expect(own.locator(".xterm-rows")).toContainText("42 passed")
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
  await page.keyboard.press("Escape")
  await command("/terminal.watch term-retry-1")
  const watched = page.locator(".terminal-view").last()
  await expect(watched.getByRole("status")).toHaveText("Watching")
  await expect(watched.locator(".terminal-output > div")).toHaveAttribute("inert", "")
  await watched.locator(".terminal-output").click()
  await page.keyboard.press("Tab")
  await expect(watched.locator(".xterm-helper-textarea")).not.toBeFocused()
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
})
