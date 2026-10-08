/** Person approval through the composed install; no intercepted requests. */
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
  const approvals: string[] = []
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/approve")) approvals.push(new URL(request.url()).pathname)
  })
  await page.goto(origin)
  const card = page.locator('[data-kind="confirm"]').filter({ has: page.getByRole("button", { name: "Review & merge", exact: true }) }).last()
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("Wave")
  expect(approvals).toEqual([])
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/confirmations/${id}/approve` && response.request().method() === "POST")
  await card.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  const admitted = await response
  expect(admitted.status()).toBe(202)
  expect(await admitted.json()).toMatchObject({ id, state: "pending" })
  expect(approvals).toEqual([`/api/confirmations/${id}/approve`])
  await expect(page.getByTestId("composer-input")).toBeEditable()
  console.log("C-CAT-02 APPROVAL PASS: real private card, person keyboard approval, pending admission")
} finally {
  await browser.close()
}
