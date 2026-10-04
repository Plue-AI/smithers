import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-12; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6, §9; lands with T-UI-01..T-UI-14
test("C-UI-12: Every card fixture renders inline and maximized", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6, §9; lands with T-UI-01..T-UI-14")
  // Required seed: all View boundary fixtures as ordinary conversation entries,
  // including failures, empty lists, unavailable machines and stale confirmations.
  await owner(page)
  await page.goto("/")
  for (const mode of ["light", "dark"]) {
    await say(page, `/theme ${mode}`)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const line of ["/stack", "/todo T8", "/branch retry-webhooks", "/settings", "/members", "/secrets", "/flows", "/wiki", "/help"]) {
        await say(page, line)
        const card = page.locator(".smithers-card").last()
        await expect(card).toBeVisible()
        await expect(card).not.toContainText("Something went wrong")
        await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
        await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
        await expect(card).toBeVisible()
        await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
        await expect(card).toBeVisible()
      }
    }
  }
})
