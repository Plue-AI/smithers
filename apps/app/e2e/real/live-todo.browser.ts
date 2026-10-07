/** TestLiveTodoBrowserPostgres supplies the composed install. No API response or Live frame is mocked. */
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
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error" && /TypeError|ReferenceError/.test(message.text())) errors.push(message.text()) })
  const subscriptions: Array<{ id: number; topic: string; cursor?: number }> = []
  const frames: Array<{ t: string; id: number; cursor?: number; data?: unknown }> = []
  const reads: string[] = []
  page.on("request", request => { if (request.url().includes("/api/todos")) reads.push(`${request.method()} ${request.url()}`) })
  let unblock: Promise<void> | undefined
  const connections = new Set<() => void>()
  // Transparent proxy to the real install; fault injection changes delivery
  // only. Every forwarded snapshot/delta comes from committed PostgreSQL rows.
  await page.routeWebSocket("**/api/live", async socket => {
    const pending: Array<string | Buffer> = []
    socket.onMessage(raw => pending.push(raw))
    if (unblock) await unblock
    const server = socket.connectToServer()
    const forward = (raw: string | Buffer) => {
      if (typeof raw === "string") {
        const frame = JSON.parse(raw)
        if (frame.t === "sub") subscriptions.push({ id: frame.id, topic: frame.topic, ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }) })
      }
      server.send(raw)
    }
    socket.onMessage(forward)
    for (const raw of pending) forward(raw)
    server.onMessage(raw => {
      if (typeof raw === "string") frames.push(JSON.parse(raw))
      socket.send(raw)
    })
    const cut = () => { server.close(); socket.close({ code: 1001, reason: "network fault" }) }
    connections.add(cut)
    socket.onClose((code, reason) => { connections.delete(cut); server.close({ code, reason }) })
  })
  await page.goto(`${origin}/maya/demo`)
  const say = async (text: string) => {
    await fillComposer(page, text)
    await page.keyboard.press("Enter")
  }
  await say("/todo.new Replay alpha")
  await page.getByRole("region", { name: "Draft", exact: true }).getByRole("button", { name: "Commit", exact: true }).click()
  const first = page.getByRole("article", { name: "TODO T1", exact: true })
  await expect.poll(async () => (await page.request.get(`${origin}/__live_test/held`)).status()).toBe(204)
  await expect(first).toHaveCount(0)
  await expect(page.getByText("Commit pending", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("region", { name: "Draft", exact: true })).not.toContainText("Working")
  await say("Can chat answer while the TODO waits?")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.getByText("Chat answered while the TODO waits", { exact: true }).first()).toBeVisible()
  await expect(first).toHaveCount(0)
  expect((await page.request.post(`${origin}/__live_test/release`)).status()).toBe(204)
  await expect(first).toBeVisible({ timeout: 30000 })
  // This control-only install has no machine runtime. Queue positions come
  // from that runtime's admission facts, not from counting queued cards.
  // Assert the committed TODO state without inventing machine admission.
  await expect(first.getByText("Queued", { exact: true })).toBeVisible()
  await expect(first.locator('[data-state="starting"], [data-state="working"]')).toHaveCount(0)
  console.log("PASS live install: held admission keeps chat responsive and shows no uncommitted TODO")
  await say("/todo.new Replay beta")
  await page.getByRole("region", { name: "Draft", exact: true }).getByRole("button", { name: "Commit", exact: true }).click()
  const second = page.getByRole("article", { name: "TODO T2", exact: true })
  await expect.poll(() => subscriptions.some(subscription => subscription.topic === "todo:2"
    && frames.some(frame => frame.id === subscription.id && frame.t === "snap"))).toBe(true)
  await expect(second).toHaveCount(0)
  expect((await page.request.post(`${origin}/__live_test/admit`)).status()).toBe(204)
  await expect(second).toBeVisible({ timeout: 30000 })
  console.log("PASS live install: a source model arriving before admission populates its card")
  const beforeReload = subscriptions.length
  const beforeReloadFrames = frames.length
  await page.reload()
  for (const card of [first, second]) {
    await expect(card.getByText("Queued", { exact: true })).toBeVisible()
    await expect(card.locator('[data-state="starting"], [data-state="working"]')).toHaveCount(0)
  }
  await expect.poll(() => {
    const mounted = subscriptions.slice(beforeReload)
    return ["home", "todo:1", "todo:2"].every(topic => mounted.some(s => s.topic === topic
      && frames.slice(beforeReloadFrames).some(frame => frame.id === s.id && frame.t === "snap")))
  }).toBe(true)
  console.log("PASS live install: queued cards reconnect from committed snapshots after reload")
  const before = subscriptions.length
  const beforeFrames = frames.length
  const beforeReads = reads.length
  const at = Date.now()
  unblock = new Promise(resolve => setTimeout(resolve, 10000))
  expect(connections.size).toBe(1)
  for (const cut of connections) cut()
  for (const n of [1, 2]) {
    const response = await fetch(`${origin}/api/todos/${n}`, { method: "POST", headers: {
      Cookie: "session=maya-browser-session; __csrf=csrf", Origin: origin,
      "Content-Type": "application/json", "X-CSRF-Token": "csrf", "Idempotency-Key": `live-drop-${n}`
    }, body: JSON.stringify({ op: "drop" }) })
    expect(response.status, await response.text()).toBe(202)
  }
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(first).not.toContainText("Dropped")
  await expect(second).not.toContainText("Dropped")
  await expect(first).toContainText("Dropped", { timeout: 20000 })
  await expect(second).toContainText("Dropped")
  if (Date.now() - at < 10000) console.log(JSON.stringify({ reads: reads.slice(beforeReads), subscriptions: subscriptions.slice(before), frames: frames.slice(beforeFrames) }))
  expect(Date.now() - at).toBeGreaterThanOrEqual(10000)
  const resumed = subscriptions.slice(before).filter(s => s.topic === "todo:1" || s.topic === "todo:2")
  expect(resumed).toHaveLength(2)
  expect(resumed.every(s => s.cursor !== undefined)).toBe(true)
  for (const subscription of resumed) {
    const replayed = frames.slice(beforeFrames).filter(frame => frame.id === subscription.id && frame.t === "delta")
    expect(replayed, subscription.topic).toHaveLength(1)
    expect(replayed[0]!.cursor).toBeGreaterThan(subscription.cursor!)
    expect(replayed[0]!.data).toMatchObject({
      State: "dropped", Type: "todo.dropped", Sequence: replayed[0]!.cursor,
      Data: { from: "queued", to: "dropped", n: Number(subscription.topic.split(":")[1]), card: { state: "dropped" } }
    })
  }
  const home = subscriptions.slice(before).filter(s => s.topic === "home")
  expect(home).toHaveLength(1)
  expect(home[0]!.cursor).toBeDefined()
  const aggregate = frames.slice(beforeFrames).filter(frame => frame.id === home[0]!.id && frame.t === "delta")
  expect(aggregate).toHaveLength(2)
  expect(aggregate[0]!.cursor).toBeGreaterThan(home[0]!.cursor!)
  expect(aggregate[1]!.cursor).toBeGreaterThan(aggregate[0]!.cursor!)
  expect(aggregate[0]!.data).toMatchObject({ Type: "todo.dropped", Data: { n: 1, home: { counts: { queued: 1, dropped: 1 } } } })
  expect(aggregate[1]!.data).toMatchObject({ Type: "todo.dropped", Data: { n: 2, home: { items: [], counts: { queued: 0, dropped: 2 } } } })
  expect(frames.filter(frame => frame.t === "gap")).toHaveLength(0)
  console.log("PASS live install: production commands, committed TODO cards, ten-second outage and cursor replay")
  unblock = undefined
  await page.reload()
  await say("/todo T1")
  await expect(first).toContainText("Dropped")
  expect(errors).toEqual([])
  console.log("PASS live install: reload reads the committed snapshot")
} finally {
  await browser.close()
  await vite.close()
}
