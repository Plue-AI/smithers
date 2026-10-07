/** C-CAT-02 through the composed install, real private Live topic and source CLI. */
import { fillComposer } from "../playwright/composer"
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
  await page.addInitScript(() => {
    const observed = window as unknown as { catalogDebugReads: number }
    observed.catalogDebugReads = 0
    const nativeFetch = window.fetch.bind(window)
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error" && new URL(String(input), location.origin).pathname === "/api/todos") observed.catalogDebugReads++
      return nativeFetch(input, init)
    }, window.fetch)
  })
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
  // The same production composition also proves the canonical playground:
  // browser selection is inert and Send reads this real SQL-backed stack.
  const debugReads = () => page.evaluate(() => (window as unknown as { catalogDebugReads: number }).catalogDebugReads)
  await fillComposer(page, "/help")
  await page.keyboard.press("Enter")
  const help = page.getByRole("article", { name: "Commands", exact: true })
  await help.getByText("Advanced", { exact: true }).click()
  await help.getByRole("button", { name: /debug-api/ }).click()
  const debug = page.getByRole("article", { name: "Debug API", exact: true })
  await expect(debug).toBeVisible()
  const before = await debugReads()
  await debug.getByRole("button", { name: /^GET \/api\/todos(?: |$)/ }).click()
  expect(await debugReads()).toBe(before)
  await expect(debug.getByRole("region", { name: "Exchange" })).toHaveCount(0)
  await debug.getByRole("button", { name: "Send", exact: true }).press("Enter")
  await expect(debug.getByText(/200 ·/)).toBeVisible()
  expect(await debugReads()).toBe(before + 1)
  await expect(debug).toContainText("Wave")
  await expect(help.getByText("/docs.read <page>", { exact: true })).toHaveCount(0)
  await expect(help.getByText("/prs.triage <number> [owner/repo]", { exact: true })).toHaveCount(0)
  await fillComposer(page, "/docs flows")
  await page.keyboard.press("Enter")
  const docs = page.getByRole("article", { name: "Docs", exact: true })
  await expect(docs).toBeVisible()
  await expect(docs).toContainText("Flow.make")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  console.log("C-CAT-01 DOCS PASS: one catalog door, real bundled page, usable composer")
  console.log("C-CAT-01 DEBUG PASS: canonical Advanced door, inert selection, keyboard Send, real stack read")
  console.log("C-CAT-02 PASS: source CLI pending, real private card, reload, keyboard cancellation, no merge")
} finally {
  await browser.close()
}
