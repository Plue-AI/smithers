/** TestJ10SyncRehearsal supplies an authenticated, composed install. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"

const origin = process.env.SMITHERS_GITHUB_BROWSER_ORIGIN!
if (!origin) throw new Error("The composed GitHub refusal rehearsal is required")
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
  const cookies = JSON.parse(process.env.SMITHERS_GITHUB_BROWSER_COOKIES!) as { name: string; value: string }[]
  await context.addCookies(cookies.map(cookie => ({ ...cookie, url: browserOrigin })))
  const page = await context.newPage()
  await page.goto(`${browserOrigin}/rehearsal-owner/app`)
  const home = page.locator('.home').last()
  await expect(home).toContainText("GitHub App permission missing", { timeout: 90_000 })
  await expect(home.locator('button[data-flow="settings"]')).toBeVisible()
  await page.screenshot({ path: process.env.SMITHERS_GITHUB_BROWSER_EVIDENCE! + "/refused-home.png" })
  await home.locator('button[data-flow="settings"]').press("Enter")
  await expect(page.locator('.smithers-card[data-kind="settings"]').last()).toBeVisible()
  console.log("GITHUB_REFUSAL_BROWSER_PASS installation cause; Fix opens Settings")
} finally {
  await browser.close()
  await vite.close()
}
