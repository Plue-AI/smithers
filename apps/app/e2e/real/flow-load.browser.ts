/** TestFlowLoadGuestRehearsal supplies an authenticated, composed install. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import { fillComposer } from "../playwright/composer"

const origin = process.env.SMITHERS_FLOW_BROWSER_ORIGIN!
const active = process.env.SMITHERS_FLOW_BROWSER_ACTIVE!
const failed = process.env.SMITHERS_FLOW_BROWSER_FAILED === "1"
if (!origin || !active) throw new Error("The composed flow-load rehearsal is required")
// Forward actual HTTP and live traffic to the install; no API responses are seeded.
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: {
  host: "127.0.0.1", port: 0, proxy: { "/api": {
    target: origin, changeOrigin: true, ws: true,
    configure(proxy) {
      proxy.on("proxyReq", request => request.setHeader("Origin", origin))
      proxy.on("proxyReqWs", request => request.setHeader("Origin", origin))
    }
  } }
} })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind a port")
const browserOrigin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  const cookies = JSON.parse(process.env.SMITHERS_FLOW_BROWSER_COOKIES!) as { name: string; value: string }[]
  await context.addCookies(cookies.map(cookie => ({ ...cookie, url: browserOrigin })))
  const page = await context.newPage()
  await page.goto(`${browserOrigin}/rehearsal-owner/app`)
  await fillComposer(page, "/flow todo")
  await page.keyboard.press("Enter")
  const card = page.getByRole("region", { name: "TODO flow", exact: true }).last()
  const current = card.locator(`[data-state="active"][data-version="${active}"]`)
  await expect(current).toBeVisible({ timeout: 90_000 })
  if (failed) {
    await card.locator('[data-state="merged-failed"]').press("Enter")
    await expect(card).toContainText("Load failed")
    await expect(card).toContainText("flows/todo/flow.ts")
    await page.reload()
    await expect(card).toContainText("Load failed", { timeout: 90_000 })
    await expect(card.locator('[data-state="merged-failed"]')).toHaveAttribute("aria-pressed", "true")
    await current.press("Enter")
    await expect(card).not.toContainText("Load failed")
  }
  await page.reload()
  await expect(page.getByRole("region", { name: "TODO flow", exact: true }).last()
    .locator(`[data-state="active"][data-version="${active}"]`)).toBeVisible({ timeout: 90_000 })
  console.log(`FLOW_BROWSER_PASS ${failed ? "failure retains Active" : "guest version Active"}; reload`)
} finally {
  await browser.close()
  await vite.close()
}
