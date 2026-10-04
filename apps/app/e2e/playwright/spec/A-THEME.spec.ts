import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// mvp.md §6.4, Appendix A /theme: personal Paper light/dark, including reload.
test("A-THEME: explicit modes, bare toggle and saved preference", async ({ page }) => {
  await page.goto("/")
  await say(page, "/theme light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await say(page, "/theme")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await say(page, "/theme light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await say(page, "/theme light")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
