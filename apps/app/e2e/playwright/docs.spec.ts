import { expect, test } from "./browserTest"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import { owner, say } from "./spec/j1-fixtures"

test("Docs navigation clears a missing page and supports an anchor on the default page", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/docs no-such-page")
  const docs = page.getByRole("article", { name: "Docs", exact: true })
  await expect(docs).toContainText("Page not found: no-such-page")
  await docs.getByRole("navigation", { name: "Docs pages" }).getByRole("link", { name: "Quickstart", exact: true }).press("Enter")
  await expect(docs.locator(".mvp-docs-missing")).toHaveCount(0)
  await say(page, "/docs #put-https-in-front")
  await expect(docs.locator("#put-https-in-front")).toBeInViewport()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await expect(docs.locator("#put-https-in-front")).toBeVisible()
  await expect(docs.locator(".mvp-docs-missing")).toHaveCount(0)
})

// Serve the production bundle at literal browser origins; only HTTP providers
// are fixtures. Docs dispatch, bundled loading, and CardRenderers stay real.
for (const origin of ["http://mini.test", "https://mini.test", "http://localhost", "http://127.0.0.1", "http://[::1]"]) {
  test(`Settings HTTPS docs at ${origin}`, async ({ page, baseURL }) => {
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url())
      if (url.pathname.startsWith("/api/")) return route.fallback()
      const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    await owner(page)
    await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
    await page.goto(`${origin}/`)
    await say(page, "/settings")
    const settings = page.getByTestId("card-settings")
    await expect(settings).toBeVisible()
    const hint = settings.getByRole("button", { name: "Notifications need HTTPS ↗", exact: true })
    if (origin === "http://mini.test") {
      await expect(hint).toBeVisible()
      await hint.click()
      const heading = page.getByRole("article", { name: "Docs", exact: true }).locator("#put-https-in-front")
      await expect(heading).toHaveText("Put HTTPS in front")
      await expect(heading).toBeInViewport()
      await hint.press("Enter")
      await expect(heading).toBeInViewport()
      await hint.press("Space")
      await expect(heading).toBeInViewport()
    } else {
      await expect(settings.getByText("Notifications need HTTPS ↗", { exact: true })).toHaveCount(0)
      await expect(hint).toHaveCount(0)
    }
    await expect(page.getByTestId("composer-input")).toBeEditable()
  })
}

// Settings and the quickstart are taller than the window. A person who reads to their end stays there through a
// re-render, and a control there is still under the pointer when a held press is released (macOS WebKit moves focus
// to the conversation on the press, which re-rendered it and rewound the card to its top).
test("The end of Settings and of a docs page stays in view, and a held press on the hint opens the quickstart", async ({ page, baseURL }) => {
  const origin = "http://mini.test"
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith("/api/")) return route.fallback()
    const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  await owner(page)
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.goto(`${origin}/`)
  await say(page, "/settings")
  const settings = page.getByTestId("card-settings")
  await expect(settings).toContainText("48 GB · 100 GB free")
  const conversation = page.locator('[data-slot="message-scroller-viewport"]')
  const fromEnd = () => conversation.evaluate(node => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))
  // Opening and closing Chat re-renders the conversation without adding an entry.
  const rerender = async () => {
    await page.getByRole("button", { name: "Chat", exact: true }).click()
    await page.getByTestId("composer-input").press("Escape")
    await expect(page.getByTestId("composer-input")).toBeHidden()
  }
  expect(await fromEnd()).toBeGreaterThan(300)
  const hint = settings.getByRole("button", { name: "Notifications need HTTPS ↗", exact: true })
  await conversation.focus()
  await page.keyboard.press("End")
  await expect.poll(fromEnd).toBe(0)
  await rerender()
  expect(await fromEnd()).toBe(0)
  await expect(hint).toBeInViewport()
  const box = (await hint.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(150)
  await page.mouse.up()
  const docs = page.getByRole("article", { name: "Docs", exact: true })
  await expect(docs.locator("#put-https-in-front")).toHaveText("Put HTTPS in front")
  await expect(docs.locator("#put-https-in-front")).toBeInViewport()
  expect(await fromEnd()).toBeGreaterThan(300)
  await conversation.focus()
  await page.keyboard.press("End")
  await expect.poll(fromEnd).toBe(0)
  await rerender()
  expect(await fromEnd()).toBe(0)
  await expect(docs.locator("#put-https-in-front")).not.toBeInViewport()
  await expect(page.getByTestId("composer-input")).toBeHidden()
})

test("Settings docs are unavailable to a non-owner", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  await page.route("**/api/install", route => route.fulfill({ json: { ...model, github: { ...model.github, signed_in: false } } }))
  await page.goto("/")
  await say(page, "/settings")
  // The flow presents Settings before the install answers; only the settled refusal shows what a non-owner is left with.
  await expect(page.getByRole("alert").filter({ hasText: "Owner access required" })).toBeVisible()
  await expect(page.getByTestId("card-settings")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Notifications need HTTPS ↗", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
