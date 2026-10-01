import type { Page } from "@playwright/test"
import { expect } from "./test"

export const finishFirstVisit = async (page: Page): Promise<void> => {
  const name = page.getByTestId("signup-name")
  if (!await name.isVisible().catch(() => false)) return
  await name.fill("Smithers Canary")
  await page.getByTestId("signup-account-continue").click()
  await page.locator('[data-testid="signup-question"][data-question="repo"]').getByTestId("signup-skip").click()
  await page.getByTestId("signup-finish").click()
  await expect(page.getByTestId("signup-name")).toHaveCount(0)
}
