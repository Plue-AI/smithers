import { expect, test } from "./browserTest"
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
