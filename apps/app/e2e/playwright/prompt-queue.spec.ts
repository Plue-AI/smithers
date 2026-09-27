import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"

// #1944: the queued-prompt strip sits on the composer surface, never bare over the transcript.
for (const width of [390, 1280]) test(`the queued-prompt strip has the composer's surface at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 })
  await installCloudFixture(page)
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let turns = 0
  await page.route(/\/api\/(?:agent|chat)\/turn$/, async route => {
    if (turns++ === 0) await held
    await route.continue()
  })
  await page.goto("/")
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true })
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  if (await dismiss.isVisible()) await dismiss.click()
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.getByTestId("composer-input")
  await input.fill("What does this repository do?")
  await input.press("Enter")
  await expect(page.locator('.smithers-chat-message[data-role="user"]').filter({ hasText: "What does this repository do?" })).toBeVisible()
  await input.fill("Then list its open issues.")
  await input.press("Alt+Enter")
  try {
    const strip = page.getByRole("region", { name: "Queued prompts" })
    await expect(strip).toContainText("Then list its open issues.")

    const surface = await strip.evaluate(element => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + 4, box.top + box.height / 2)
      const composer = getComputedStyle(document.querySelector(".smithers-composer")!)
      return { background: style.backgroundColor, blur: style.backdropFilter, composerBlur: composer.backdropFilter, radius: style.borderTopLeftRadius, hitInside: hit !== null && element.contains(hit),
        composerBackground: composer.backgroundColor, right: box.right }
    })
    expect(surface.background).toBe(surface.composerBackground)
    expect(surface.blur).toBe(surface.composerBlur)
    expect(surface.radius).not.toBe("0px")
    expect(surface.hitInside).toBe(true)
    expect(surface.right).toBeLessThanOrEqual(width)
    await expect(strip.getByRole("button", { name: "Edit queued prompt: Then list its open issues." })).toBeVisible()
  } finally {
    release()
  }
  await expect(page.locator('.smithers-chat-message[data-role="assistant"]').filter({ hasText: "stub: Then list its open issues." })).toBeVisible({ timeout: 10_000 })
})
