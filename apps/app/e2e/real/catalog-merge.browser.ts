/** C-CAT-02 through the composed install, real private Live topic and source CLI. */
import { chromium, expect } from "@playwright/test"

const origin = process.env.SMITHERS_CATALOG_ORIGIN!
const id = process.env.SMITHERS_CATALOG_CONFIRMATION!
if (!origin || !id) throw new Error("TestCatalogMergeBrowserPostgres must supply the owned install")
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  await context.addCookies([
    { name: "smithers_session", value: "owner-browser-session", url: origin },
    { name: "__csrf", value: "csrf", url: origin }
  ])
  const page = await context.newPage()
  const writes: string[] = []
  page.on("request", request => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(new URL(request.url()).pathname)
  })
  await page.goto(origin)
  const card = page.locator('[data-kind="confirm"]')
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("Wave")
  await expect(card.getByRole("button", { name: "Review & merge", exact: true })).toBeVisible()
  expect(writes.filter(path => path.includes("/confirmations/") || path.endsWith("/merge"))).toEqual([])
  await page.reload()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).not.toContainText("Merged")
  await card.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(card).toContainText("Cancelled")
  expect(writes.filter(path => path.includes("/confirmations/"))).toEqual([`/api/confirmations/${id}/deny`])
  expect(writes.filter(path => path.endsWith("/merge"))).toEqual([])
  console.log("C-CAT-02 PASS: source CLI pending, real private card, reload, keyboard cancellation, no merge")
} finally {
  await browser.close()
}
