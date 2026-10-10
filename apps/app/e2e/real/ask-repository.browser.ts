/** TestFlowLoadGuestRehearsal supplies an authenticated, composed install. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"

const origin = process.env.SMITHERS_J9_BROWSER_ORIGIN!
if (!origin) throw new Error("The composed J9 rehearsal is required")
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
  const cookies = (name: string) => JSON.parse(process.env[name]!) as { name: string; value: string }[]
  const ben = await browser.newContext()
  const alice = await browser.newContext()
  await ben.addCookies(cookies("SMITHERS_J9_BEN_COOKIES").map(cookie => ({ ...cookie, url: browserOrigin })))
  await alice.addCookies(cookies("SMITHERS_J9_ALICE_COOKIES").map(cookie => ({ ...cookie, url: browserOrigin })))
  const page = await ben.newPage()
  const other = await alice.newPage()
  await Promise.all([page.goto(`${browserOrigin}/rehearsal-owner/app`), other.goto(`${browserOrigin}/rehearsal-owner/app`)])
  const answer = page.locator('.smithers-chat-message[data-role="assistant"]').filter({ has: page.locator(".message-answer-actions") }).last()
  await expect(answer.getByRole("button", { name: "Make TODO", exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(answer.getByRole("button", { name: "Save to wiki", exact: true })).toBeVisible()
  await answer.getByRole("button", { name: "Save to wiki", exact: true }).press("Enter")
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible()
  await expect(other.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0)
  await page.screenshot({ path: process.env.SMITHERS_J9_BROWSER_EVIDENCE! + "/answer.png" })
  await page.getByRole("button", { name: "Cancel", exact: true }).last().press("Enter")
  await answer.getByRole("button", { name: "Make TODO", exact: true }).press("Enter")
  const draft = page.getByRole("region", { name: "Draft", exact: true }).last()
  await expect(draft).toBeVisible()
  await expect(draft.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue(process.env.SMITHERS_J9_ANSWER!)
  await expect(draft.getByRole("textbox", { name: "Title", exact: true })).not.toHaveValue("")
  await expect(draft.getByRole("combobox", { name: "Place", exact: true })).toHaveValue('{"mode":"append"}')
  await expect(other.locator('.smithers-card[data-kind="draft"]')).toHaveCount(0)
  await page.screenshot({ path: process.env.SMITHERS_J9_BROWSER_EVIDENCE! + "/draft-ben.png" })
  await other.screenshot({ path: process.env.SMITHERS_J9_BROWSER_EVIDENCE! + "/draft-alice.png" })
  console.log("J9_BROWSER_PASS answer actions; prefilled private Draft")
} finally {
  await browser.close()
  await vite.close()
}
