/** The owned Go harness serves the production install; no API responses are intercepted. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import { fillComposer } from "../playwright/composer"

const origin = process.env.SMITHERS_LIVE_ORIGIN!
if (!origin) throw new Error("The owned PostgreSQL install is required")
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind a port")
console.log(`LIVE_BROWSER_READY http://127.0.0.1:${address.port}`)
await Bun.stdin.text()
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  await context.addCookies([
    { name: "session", value: "maya-browser-session", url: origin, httpOnly: true },
    { name: "__csrf", value: "csrf", url: origin }
  ])
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on("dialog", dialog => dialog.accept())
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const say = async (text: string) => { await fillComposer(page, text); await page.keyboard.press("Enter") }
  await page.goto(`${origin}/maya/demo`)
  await say("/secrets")
  const card = page.getByRole("region", { name: "Secrets", exact: true }).last()
  const secretPath = "~/.config/anthropic/key"
  const endpoint = "/api/repos/maya/demo/secrets"
  const read = async () => {
    const response = await page.request.get(origin + endpoint)
    expect(response.status()).toBe(200)
    const rows = await response.json()
    expect(JSON.stringify(rows)).not.toContain("mch-browser-key")
    return rows
  }
  await card.getByLabel("NAME", { exact: true }).fill("ANTHROPIC_API_KEY")
  await card.getByLabel("Value", { exact: true }).fill("mch-browser-key-v1")
  await card.getByLabel("Path", { exact: true }).fill(secretPath)
  const added = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/secrets")
  await card.getByRole("button", { name: "Add", exact: true }).press("Enter")
  expect((await added).status()).toBe(201)
  await expect(page.getByText("Saving ANTHROPIC_API_KEY…", { exact: true })).toHaveCount(0)
  await expect.poll(read).toEqual([expect.objectContaining({ name: "ANTHROPIC_API_KEY", path: secretPath, hosts: ["api.anthropic.com"] })])
  await expect(card.getByText(secretPath, { exact: true })).toBeVisible()
  expect(await page.locator("body").innerText()).not.toContain("mch-browser-key")
  await page.reload()
  await say("/secrets")
  await expect(card.getByText(secretPath, { exact: true })).toBeVisible()
  const row = card.locator(".secrets-list > li").filter({ has: page.getByText("ANTHROPIC_API_KEY", { exact: true }) })
  await row.getByText("Replace", { exact: true }).first().press("Enter")
  await row.getByLabel("Value", { exact: true }).fill("mch-browser-key-v2")
  const replaced = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/secrets")
  await row.getByRole("button", { name: "Replace", exact: true }).press("Enter")
  expect((await replaced).status()).toBe(201)
  await expect(page.getByText("Saving ANTHROPIC_API_KEY…", { exact: true })).toHaveCount(0)
  await expect(row.getByLabel("Value", { exact: true })).toHaveValue("")
  await expect.poll(read).toEqual([expect.objectContaining({ name: "ANTHROPIC_API_KEY", path: secretPath })])
  const deleted = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/api/secrets")
  await row.getByRole("button", { name: "Delete", exact: true }).press("Enter")
  expect((await deleted).status()).toBe(204)
  await expect.poll(read).toEqual([])
  await expect(card.getByText(secretPath, { exact: true })).toHaveCount(0)
  expect(await page.locator("body").innerText()).not.toContain("mch-browser-key")
  expect(errors).toEqual([])
  console.log("PASS C-MCH-12: path persisted, value write-only, replacement and deletion committed")
} finally { await browser.close(); await vite.close() }
