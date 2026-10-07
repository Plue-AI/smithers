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

test("Settings docs are unavailable to a non-owner", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  await page.route("**/api/install", route => route.fulfill({ json: { ...model, github: { ...model.github, signed_in: false } } }))
  await page.goto("/")
  await say(page, "/settings")
  await expect(page.getByTestId("card-settings")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Notifications need HTTPS ↗", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
