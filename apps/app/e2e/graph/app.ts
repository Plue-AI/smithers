import { expect, type Page } from "@playwright/test"

/*
 * The app's own doors, as the graph tier's reader uses them.
 *
 * A fresh session meets the signup, which owns the screen until it is done
 * (apps/app/AGENTS.md): no Chat controls and no rail. Control/Command-K opens
 * Chat throughout, so the reader finishes the signup from the composer, the
 * way `e2e/playwright/identity.ts` `skipSignup` does.
 */

/** Opens the composer: the Chat door where it is on screen, else Control/Command-K. */
export const openChat = async (page: Page): Promise<void> => {
  const composer = page.getByTestId("composer-input")
  if (await composer.isVisible()) return
  const door = page.locator('[data-flow="chat.open"]').first()
  // A key press into the boot skeleton is lost: wait for the door or the surface that withholds it.
  await expect(door.or(page.getByTestId("signup")).or(page.getByTestId("setup-checklist")).first()).toBeVisible()
  if (await door.isVisible()) await door.click()
  else await page.keyboard.press("ControlOrMeta+k")
  await expect(composer).toBeVisible()
}

/** Finishes a fresh session's signup so the app behind it is on screen. */
export const finishSignup = async (page: Page): Promise<void> => {
  const signup = page.getByTestId("signup")
  await expect(signup.or(page.locator('[data-flow="chat.open"]')).first()).toBeVisible()
  if (!await signup.isVisible()) return
  await openChat(page)
  const composer = page.getByTestId("composer-input")
  await composer.fill("/signup.finish")
  await composer.press("Enter")
  await expect(signup).toHaveCount(0)
}
