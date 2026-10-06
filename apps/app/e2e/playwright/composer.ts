import { expect, type Page } from "@playwright/test"

/** Open the composer through the visible Chat button. */
export const fillComposer = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  // A reload may still be restoring the app before either control mounts.
  await expect.poll(async () => await input.isVisible() || await chat.isVisible(), { timeout: 30_000 }).toBe(true)
  if (!await input.isVisible()) {
    await expect(chat).toBeVisible()
    await chat.click()
  }
  await expect(input).toBeVisible()
  await input.fill(text)
}
