import { expect, test } from "./browserTest"

for (const path of ["/smithersai/smithers/", "/smithersai/smithers/?tutorial"]) {
  test(`arrow navigation keeps the palette selection visible and Tab leaves the input: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await page.goto(path)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await page.keyboard.press("Meta+k")
    const input = page.getByTestId("composer-input")
    await input.fill("/")
    const palette = page.getByTestId("palette")
    await expect(palette.locator('[role="option"]').nth(10)).toBeAttached()
    for (const key of [...Array(12).fill("ArrowDown"), "ArrowUp"]) {
      await input.press(key)
      await expect(palette.locator('[aria-selected="true"]')).toBeInViewport({ ratio: 1 })
      await expect(input).toBeFocused()
    }
    await input.press("Tab")
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.getByTestId("composer-send")).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Shift+Tab")
    await expect(input).toBeFocused()
  })
}
