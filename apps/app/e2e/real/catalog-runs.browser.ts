/** Canonical /runs through the composed install's real run inventory. */
import { chromium, expect } from "@playwright/test"
import { fillComposer } from "../playwright/composer"
const origin = process.env.SMITHERS_CATALOG_ORIGIN!
if (!origin) throw new Error("Run TestCatalogRunsBrowserInstallInventory")
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_CATALOG_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin })))
  const page = await context.newPage()
  await page.goto(origin)
  const listing = page.waitForResponse(r => new URL(r.url()).pathname === "/api/runs" && r.request().method() === "GET")
  await fillComposer(page, "/runs")
  await page.keyboard.press("Enter")
  const response = await listing
  expect(response.status()).toBe(200)
  const runs: Array<{ id: string; title: string }> = await response.json()
  expect(Array.isArray(runs)).toBe(true)
  for (const run of runs) await expect(page.getByTestId(`card-run:${run.id}`)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-kind="run"]')).toHaveCount(runs.length)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  console.log(`C-CAT-01 RUNS PASS: ${runs.length} served runs, composed install, canonical /runs`)
} finally { await browser.close() }
