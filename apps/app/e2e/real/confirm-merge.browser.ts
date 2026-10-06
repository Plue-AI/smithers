/** Driven by TestConfirmationsBrowserPostgres; no browser API or live route is mocked. */
import { chromium, expect } from "@playwright/test"
import { createServer } from "vite"

const origin = process.env.SMITHERS_CONFIRMATION_ORIGIN!
const member = process.env.SMITHERS_CONFIRMATION_MEMBER!
const token = process.env.SMITHERS_CONFIRMATION_TOKEN!
if (!origin || !member || !token) throw new Error("The owned PostgreSQL browser fixture is required")
const vite = await createServer({ configLoader: "runner", logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await vite.listen()
const address = vite.httpServer!.address()
if (!address || typeof address === "string") throw new Error("Vite did not bind a port")
console.log(`CONFIRMATION_BROWSER_READY http://127.0.0.1:${address.port}`)
await Bun.stdin.text()

const browser = await chromium.launch({ headless: true })
try {
  const api = async (path: string, method = "GET", body?: unknown, agent = false, key = "fixture") => {
    const response = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key,
      ...(agent ? { Authorization: `Bearer ${token}` } : { Cookie: "session=maya-browser-session; __csrf=csrf", "X-CSRF-Token": "csrf" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    return { status: response.status, value }
  }
  const created = await api("/api/todos", "POST", { title: "Browser confirmation sample", prompt: "Retain the exact private prompt." }, true, "browser-new")
  expect(created.status, JSON.stringify(created.value)).toBe(202)
  expect(Object.keys(created.value).sort()).toEqual(["confirmation", "state"])
  expect(created.value.state).toBe("pending")
  expect((await api("/api/todos")).value).toEqual([])

  const owner = await browser.newContext()
  await owner.addCookies([{ name: "session", value: "maya-browser-session", url: origin, httpOnly: true }, { name: "__csrf", value: "csrf", url: origin }])
  const page = await owner.newPage()
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`${origin}/maya/demo`)
  const commit = page.locator('[data-kind="confirm"] [data-flow="approval.approve"]').filter({ hasText: "Commit" })
  await expect(commit).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId("transcript")).toContainText("Retain the exact private prompt.")

  const stranger = await browser.newContext()
  await stranger.addCookies([{ name: "session", value: "ben-browser-session", url: origin, httpOnly: true }, { name: "__csrf", value: "csrf", url: origin }])
  const other = await stranger.newPage()
  await other.goto(`${origin}/maya/demo`)
  await expect(other.getByTestId("transcript")).toBeVisible({ timeout: 90_000 })
  expect(await other.evaluate(async () => (await fetch("/api/confirmations")).json())).toEqual([])
  const forbidden = await other.evaluate(async topic => await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/live`, "smithers.live.v1")
    const timer = setTimeout(() => { socket.close(); reject(new Error("Private topic did not answer")) }, 10_000)
    socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: 99, topic }))
    socket.onmessage = event => {
      const frame = JSON.parse(String(event.data))
      if (frame.id !== 99) return
      clearTimeout(timer); socket.close(); resolve(frame.code ?? frame.t)
    }
  }), `confirmations:${member}`)
  expect(forbidden).toBe("forbidden")
  await expect(other.locator('[data-kind="confirm"]')).toHaveCount(0)

  await commit.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api("/api/todos")).value.length).toBe(1)
  await expect(page.locator('[data-kind="confirm"]')).toContainText("Approved")
  // The admission committed, but the TODO is still queued. HTTP success alone
  // must not finish its progress notice, and Chat remains usable.
  const creationNotice = page.locator(`[data-notice="toast-todo.request.confirmation:${created.value.confirmation}"]`)
  await expect(creationNotice).toHaveAttribute("data-tone", "live", { timeout: 10_000 })
  await page.reload()
  await expect(creationNotice).toHaveAttribute("data-tone", "live", { timeout: 30_000 })

  const todos = (await api("/api/todos")).value
  const n = todos[0].n
  const dropped = await api(`/api/todos/${n}`, "POST", { op: "drop" }, true, "browser-drop")
  expect(dropped.status).toBe(202)
  expect(Object.keys(dropped.value).sort()).toEqual(["confirmation", "state"])
  expect((await api(`/api/todos/${n}`)).value.state).not.toBe("dropped")
  const drop = page.locator('[data-kind="confirm"] [data-flow="approval.approve"]').filter({ hasText: "Drop" })
  await expect(drop).toBeVisible({ timeout: 10_000 })
  const wrong = await other.evaluate(async id => {
    const response = await fetch(`/api/confirmations/${id}/approve`, { method: "POST", headers: { "X-CSRF-Token": "csrf", "Idempotency-Key": "other-press" } })
    return response.status
  }, dropped.value.confirmation)
  expect(wrong).toBe(403)
  await drop.focus(); await page.keyboard.press("Enter")
  await expect.poll(async () => (await api(`/api/todos/${n}`)).value.state).toBe("dropped")
  await expect(page.locator('[data-kind="confirm"] [data-flow="approval.approve"]')).toHaveCount(0)
  const agentRows = (await api("/api/confirmations", "GET", undefined, true)).value
  expect(agentRows).toHaveLength(2)
  for (const row of agentRows) expect(Object.keys(row).sort()).toEqual(["id", "state"])
  expect(errors).toEqual([])
  console.log("CONFIRMATION_BROWSER_PASS private delivery, keyboard approval, admission progress, reload, other-member refusal, Drop, delegated redaction")
} finally {
  await browser.close()
  await vite.close()
}
