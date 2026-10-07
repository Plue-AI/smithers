/** Production composed router and PostgreSQL; no page.route or seeded cards. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"
import { createInterface } from "node:readline"

const origin = process.env.SMITHERS_CONFIRMATION_ORIGIN!
const token = process.env.SMITHERS_CONFIRMATION_TOKEN!
const id = process.env.SMITHERS_CONFIRMATION_ID!
const todo = process.env.SMITHERS_CONFIRMATION_TODO!
const head = process.env.SMITHERS_CONFIRMATION_HEAD!
const lines = createInterface({ input: process.stdin })
const input = lines[Symbol.asyncIterator]()
async function barrier(name: string) {
  console.log(name)
  const next = await input.next()
  if (next.done) throw new Error("Fixture barrier closed")
}
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind")
await barrier(`MERGE_BROWSER_READY http://127.0.0.1:${address.port}`)
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  await context.addCookies([{ name: "smithers_session", value: "owner-browser-session", url: origin, httpOnly: true }, { name: "__csrf", value: "csrf", url: origin }])
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${origin}/merge-owner/app`)
  const card = page.locator('[data-kind="confirm"]').first()
  const press = card.getByRole("button", { name: "Review & merge", exact: true })
  await expect(card).toBeVisible({ timeout: 90_000 })
  await expect(press).toBeEnabled({ timeout: 90_000 })
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  const agent = async (path: string, body: unknown, key: string) => {
    const response = await fetch(origin + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Smithers-Via": "smithers", "Smithers-Actor": "person", "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const denied = await agent(`/api/confirmations/${id}/approve`, {}, "forged-agent-press")
  expect(denied.status).toBe(403)
  expect(denied.body.class).toBe("permission")
  expect(denied.body.code).toBe("permission")
  await barrier("MERGE_BROWSER_STALE")
  const staleResponse = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${id}/approve`))
  await press.press("Enter")
  const stale = await staleResponse
  expect(stale.status()).toBe(409)
  expect((await stale.json()).code).toBe("confirmation_resolved")
  await expect(card).toContainText("Expired")
  await expect(card.getByRole("button")).toHaveCount(0)
  const current = await agent(`/api/todos/${todo}/merge`, { reviewed_head_sha: head }, "current-browser-generation")
  expect(current.status, JSON.stringify(current.body)).toBe(202)
  expect(current.body.state).toBe("pending")
  const fresh = page.locator('[data-kind="confirm"]').filter({ has: page.getByRole("button", { name: "Review & merge", exact: true }) })
  await expect(fresh.getByRole("button", { name: "Review & merge", exact: true })).toBeEnabled({ timeout: 30_000 })
  const approved = page.waitForResponse(response => response.url().endsWith(`/api/confirmations/${current.body.confirmation}/approve`))
  await fresh.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  const response = await approved
  expect(response.status(), JSON.stringify(await response.json())).toBe(202)
  expect(response.request().headers()["authorization"]).toBeUndefined()
  await barrier("MERGE_BROWSER_ADMITTED")
  await expect(fresh).not.toContainText("Merged")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await page.reload()
  await expect(page.locator('[data-kind="confirm"]').last()).not.toContainText("Merged")
  expect(errors).toEqual([])
  console.log("MERGE_BROWSER_PASS delegated refusal, stale generation, expired card, fresh keyboard press, pending execution, reload")
} finally {
  lines.close()
  await browser.close()
  await vite.close()
}
