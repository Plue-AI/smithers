import { expect, type Page } from "@playwright/test"

/** Open the composer through its visible Chat button or the signed-out keyboard door. */
export const fillComposer = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  // A reload may still be restoring the app before either control mounts.
  await expect.poll(async () => await input.isVisible() || await chat.isVisible() || await page.getByTestId("login").isVisible(), { timeout: 30_000 }).toBe(true)
  if (!await input.isVisible()) {
    if (await chat.isVisible()) await chat.click()
    else await page.keyboard.press("ControlOrMeta+k")
  }
  await expect(input).toBeVisible()
  await input.fill(text)
}
