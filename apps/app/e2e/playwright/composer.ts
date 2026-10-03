import { expect, type Page } from "@playwright/test"

/** Open the composer through the visible Chat button. */
export const fillComposer = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) {
    const chat = page.getByRole("button", { name: "Chat", exact: true })
    await expect(chat).toBeVisible()
    await chat.click()
  }
  await expect(input).toBeVisible()
  await input.fill(text)
}
