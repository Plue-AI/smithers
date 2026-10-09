import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import { resolve } from "node:path"

// The Go acceptance owns the production router, PostgreSQL and boot observation.
// Vite forwards HTTP/WebSocket bytes; no API response or live frame is fabricated.
const origin = process.env.SMITHERS_ADMISSION_ORIGIN!
const branch = process.env.SMITHERS_ADMISSION_BRANCH!
const cookie = process.env.SMITHERS_ADMISSION_COOKIE!
const mixed = process.env.SMITHERS_ADMISSION_MIXED === "1"
const successful = process.env.SMITHERS_ADMISSION_SUCCESSFUL === "1"
const publicURL = process.env.SMITHERS_ADMISSION_PUBLIC_URL ?? "http://127.0.0.1:4000"
if (!origin || !branch || !cookie) throw new Error("An owned composed install is required")
const fixture = resolve("e2e/real/admission-branch.fixture.tsx")
const vite = await createServer({ configLoader: "runner", logLevel: "error", plugins: [{
  name: "admission-browser-mount",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/__admission")) return next()
      const html = await server.transformIndexHtml(req.url, `<html><body><div id="root"></div><script type="module" src="/@fs/${fixture}"></script></body></html>`)
      res.setHeader("Content-Type", "text/html")
      res.end(html)
    })
  }
}], server: { host: "127.0.0.1", port: 0, proxy: { "/api": {
  target: origin, ws: true, changeOrigin: true,
  headers: { Origin: publicURL, Host: new URL(publicURL).host }
} } } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind")
const base = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  await context.addCookies([{ name: "smithers_session", value: cookie, url: base, httpOnly: true }])
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${base}/__admission?branch=${encodeURIComponent(branch)}`)
  const card = page.locator('[data-kind="branch"]')
  await expect(card).toContainText("Waiting for a machine · #1", { timeout: 60000 })
  const cursor = await page.evaluate(() => (window as unknown as { admission: { cursor(): number } }).admission.cursor())
  expect(cursor).toBeGreaterThan(0)
  const stack = page.getByRole("list", { name: "Stack", exact: true })
  if (mixed) {
    await expect(stack.locator('li').filter({ hasText: "T5" })).toContainText("waiting for a machine #3")
    await expect(stack.locator('li').filter({ hasText: "T6" })).toContainText("waiting for a machine #4")
    await expect(page.getByRole("list", { name: "Background runs" })).toContainText("Learning · T2")
    await expect(page.getByRole("list", { name: "Background runs" })).toContainText("waiting for a machine #5")
    await page.reload()
    await expect(card).toContainText("Waiting for a machine · #1")
    await expect(page.getByRole("list", { name: "Background runs" })).toContainText("waiting for a machine #5")
  } else if (!successful) await expect(stack).toContainText("waiting for a machine #2")
  console.log("ADMISSION_BROWSER_WAITING")
  await expect(card).toContainText(successful ? "Awake" : "Waking", { timeout: 60000 })
  await expect(card).not.toContainText("Waiting for a machine")
  if (mixed) {
    await expect(stack.locator('li').filter({ hasText: "T5" })).toContainText("waiting for a machine #2")
    await expect(page.getByRole("list", { name: "Background runs" })).toContainText("waiting for a machine #4")
  }
  if (!successful && !mixed) {
    await expect(stack.locator('li[data-state="starting"]')).toContainText("T4")
    await expect(stack).toContainText("waiting for a machine #1")
  }
  const granted = await page.evaluate(() => (window as unknown as { admission: { cursor(): number } }).admission.cursor())
  expect(granted).toBeGreaterThan(cursor)
  await page.reload()
  await expect(card).toContainText(successful ? "Awake" : "Waking", { timeout: 30000 })
  await expect(card).not.toContainText("Waiting for a machine")
  if (mixed) await expect(page.getByRole("list", { name: "Background runs" })).toContainText("waiting for a machine #4")
  expect(errors).toEqual([])
  console.log("PASS C-MCH-11 production Branch/Home live mount, grant cursor and reload")
  if (mixed) console.log("PASS C-MCH-02 mixed queue mounted Home Learning position and reload")
} finally {
  await browser.close()
  await vite.close()
}
