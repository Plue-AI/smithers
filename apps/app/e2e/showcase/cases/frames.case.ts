import { expect } from "@playwright/test"
import { showcase } from "../showcase"

const path = (url: string) => decodeURIComponent(new URL(url).pathname)

export default showcase({
  id: "frames",
  order: 40,
  title: "Frames and tabs",
  summary: "Every card has an address: maximize, back, forward, open in a tab.",
  flows: ["card.maximize", "frame.back", "frame.forward", "tab.card"],
  run: async ({ page, app }) => {
    await app.open("/")
    await app.slash("/appearance.theme")
    await app.closeComposer()
    const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
    await app.show(card)
    const id = (await card.getAttribute("data-testid"))!.replace(/^card-/, "")
    await app.maximize(card)
    await expect.poll(() => path(page.url())).toMatch(/\/f\/frame-card:/)
    const maximized = page.url()

    await app.click(page.getByTestId("frame-back"))
    await expect(card).toHaveAttribute("data-maximized", "false")
    await expect.poll(() => path(page.url())).toMatch(/\/f\/frame-root:/)
    await app.beat(700)
    await page.goForward()
    await expect(card).toHaveAttribute("data-maximized", "true")
    await expect(page).toHaveURL(maximized)
    await app.beat(700)
    await app.click(page.getByTestId("frame-back"))
    await expect(card).toHaveAttribute("data-maximized", "false")
    await app.slash("/frame.forward")
    await expect(card).toHaveAttribute("data-maximized", "true")
    await app.closeComposer()

    await app.click(page.getByTestId(`card-open-in-tab-${id}`))
    await expect(page.locator(".card-tab .smithers-card")).toBeVisible()
    await app.beat(1500)
  }
})
