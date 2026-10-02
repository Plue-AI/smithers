import { expect, type Page } from "@playwright/test"

/**
 * Open the closed-by-default composer and type into it: through the visible
 * Chat door, or with Control+K where the door is withheld (the signup owns the
 * screen, or Chat waits for the first job; apps/app/AGENTS.md First-run).
 * Control+K opens Chat throughout once the app has booted.
 */
export const fillComposer = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) {
    const chat = page.getByRole("button", { name: "Chat", exact: true })
    // A press into the boot skeleton is lost: wait for the door or the surface that withholds it.
    await expect(chat.or(page.getByTestId("signup")).or(page.getByTestId("setup-checklist")).first()).toBeVisible()
    if (await chat.isVisible()) await chat.click()
    else await page.keyboard.press("ControlOrMeta+k")
  }
  await expect(input).toBeVisible()
  await input.fill(text)
}
