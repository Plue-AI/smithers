import { expect, test } from "./browserTest"
import type { Page } from "./browserTest"

/*
 * The Home card (T-APP-01) on the seeded design world: it stands first in
 * main's conversation with the stack in merge order; the row menu's Move up
 * and `/stack.move` reorder it; a failed background run's Retry runs it again
 * and Dismiss removes it; `/stack` returns a member on a branch to main.
 */

/** A slash command through the composer: Control+K, type, Enter, Escape. */
const command = async (page: Page, line: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.keyboard.press("Control+k")
  await expect(input).toBeFocused()
  await page.keyboard.insertText(line)
  await page.keyboard.press("Enter")
  await expect(input).toHaveValue("")
  if (await input.isVisible()) await page.keyboard.press("Escape")
}

test("the Home card: merge order, Move, a failed run's Retry and Dismiss, and /stack", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto("/")
  const home = page.locator(".mvp-home").first()
  await expect(home).toBeVisible()
  const refs = home.locator(".mvp-stack-row .mvp-ref")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])
  await expect(home.locator(".mvp-stack-row[data-state='in_review']").getByRole("button", { name: "Merge", exact: true })).toBeVisible()

  await home.getByRole("button", { name: "Order Log every webhook retry attempt", exact: true }).click()
  await home.getByRole("menuitem", { name: "Move up", exact: true }).click()
  await expect(refs).toHaveText(["T8", "T9", "T11", "T10"])
  await command(page, "/stack.move T11 down")
  await expect(refs).toHaveText(["T8", "T9", "T10", "T11"])

  const failed = home.locator(".mvp-run-row[data-state='failed']", { hasText: "release-notes" })
  await expect(failed).toContainText("GitHub API rate limited")
  await expect(failed.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
  await failed.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(home.locator(".mvp-run-row", { hasText: "release-notes" })).toHaveAttribute("data-state", "running")
  await command(page, "/background.dismiss r-release")
  await expect(home.locator(".mvp-run-row", { hasText: "release-notes" })).toHaveCount(0)
  await expect(home.locator(".mvp-run-row", { hasText: "Wiki refresh" })).toHaveCount(1)

  // /stack from a branch returns to main, where the Home card stands first: the crumbs lose the branch.
  const crumbs = page.locator(".session-navigation")
  await command(page, "/branch retry-webhooks")
  await expect(crumbs).toContainText("retry-webhooks")
  await command(page, "/stack")
  await expect(crumbs).not.toContainText("retry-webhooks")
  await expect(home).toBeVisible()
})
