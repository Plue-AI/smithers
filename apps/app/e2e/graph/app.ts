import { expect, type Page } from "@playwright/test"

/** Open the app's Chat composer after boot. */
export const openChat = async (page: Page): Promise<void> => {
  const composer = page.getByTestId("composer-input")
  if (await composer.isVisible()) return
  const door = page.locator('[data-flow="chat.open"]').first()
  await expect(door).toBeVisible()
  await door.click()
  await expect(composer).toBeVisible()
}

/** Existing callers wait for the plain app without a first-run flow. */
export const finishSignup = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("composer-input")).toBeAttached()
}
