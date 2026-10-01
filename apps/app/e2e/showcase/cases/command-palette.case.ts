import { expect } from "@playwright/test"
import { showcase } from "../showcase"

export default showcase({
  id: "command-palette",
  order: 20,
  title: "⌘K and slash commands",
  summary: "⌘K opens Chat; / lists every flow; a flow answers with a card.",
  flows: ["palette.open", "appearance.theme", "appearance.dark-mode"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await app.open("/")
    await expect(page.getByTestId("setup-checklist")).toBeVisible()
    await app.press("ControlOrMeta+k")
    const input = page.getByTestId("composer-input")
    await expect(input).toBeFocused()
    await app.type(input, "/")
    const palette = page.getByTestId("palette")
    await expect(palette.locator('[role="option"]').nth(8)).toBeAttached()
    await app.beat(800)
    for (let step = 0; step < 5; step++) await app.press("ArrowDown")
    await app.type(input, "/appearance.th")
    await app.beat(900)
    await app.press("Enter")
    const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
    await expect(card).toBeVisible()
    await app.show(card)
    await app.click(card.getByRole("option", { name: /Catppuccin/ }))
    await expect(card.getByRole("option", { name: /Catppuccin/ })).toContainText("current")
    await app.beat(900)
    const shade = () => page.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)
    const before = await shade()
    await app.slash("/appearance.dark-mode")
    await expect.poll(shade).not.toBe(before)
    await app.beat(1200)
  }
})
