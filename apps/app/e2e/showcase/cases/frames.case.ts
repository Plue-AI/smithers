import { expect } from "@playwright/test"
import { showcase } from "../showcase"

const path = (url: string) => decodeURIComponent(new URL(url).pathname)

export default showcase({
  id: "frames",
  order: 40,
  title: "Frames",
  summary: "Every card has an address: maximize, back and forward.",
  flows: ["card.maximize", "frame.back", "frame.forward"],
  run: async ({ page, app }) => {
    await app.open("/")
    await app.slash("/agent.list")
    await app.closeComposer()
    const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="agents"]')
    await app.show(card)
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

  }
})
