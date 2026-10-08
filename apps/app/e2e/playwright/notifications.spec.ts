import { expect as baseExpect, test as base } from "./browserTest"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installCloudFixture } from "./cloudFixture"
import { fixtures } from "../../../../packages/rpc/test/fixtures/Todo"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import type { TodoCard } from "@smthrs/rpc/TodoCard"

// Playwright's normal Chromium connection forces document.hidden=false in every tab.
// Attach to a fresh browser without those overrides so the test uses native tab visibility.
const expect = baseExpect.configure({ timeout: 20_000 })
const test = base.extend({
  context: async ({ browserName, playwright, headless }, use) => {
    const profile = await mkdtemp(join(tmpdir(), "smithers-notifications-"))
    if (browserName === "webkit") {
      const context = await playwright.webkit.launchPersistentContext(profile, { headless,
        ...(process.platform === "darwin" ? { env: { ...process.env, CFFIXED_USER_HOME: profile } } : {}) })
      try { await use(context) } finally {
        await context.close()
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
      return
    }
    const child = spawn(playwright.chromium.executablePath(), [
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
      ...(headless ? ["--headless=new"] : []), "about:blank"
    ], { stdio: "ignore" })
    let browser: Awaited<ReturnType<typeof playwright.chromium.connectOverCDP>> | undefined
    try {
      let port: string | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break } catch {}
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!port) throw new Error("Notification test browser did not start")
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true })
      await use(browser.contexts()[0]!)
    } finally {
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once("exit", resolve))
        child.kill()
        await stopped
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

for (const secure of [true, false]) test(`C-UI-03 notifications: ${secure ? "localhost" : "plain HTTP LAN"}`, async ({ page, baseURL, context, browserName }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`) })
  const origin = secure ? baseURL! : baseURL!.replace("127.0.0.1", "smithers-lan.test")
  if (!secure) await context.route("http://smithers-lan.test:**/**", async route => {
    const response = await route.fetch({ url: route.request().url().replace("smithers-lan.test", "127.0.0.1") })
    await route.fulfill({ response })
  })
  await page.addInitScript(() => {
    const notices: { title: string; click: () => void }[] = []
    let requests = 0, focus = 0
    const originalFocus = window.focus.bind(window)
    window.focus = () => { focus++; originalFocus() }
    class RecordedNotification {
      static permission = "default"
      static requestPermission() { requests++; this.permission = "granted"; return Promise.resolve("granted") }
      onclick: (() => void) | null = null
      constructor(readonly title: string) { notices.push({ title, click: () => this.onclick?.() }) }
      close() {}
      static observations() { return { requests, titles: notices.map(row => row.title), focus } }
      static clickReview() { notices.find(row => row.title === "T3 ready for review")?.click() }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: RecordedNotification })
  })
  await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  let viewState: unknown = {}
  await page.route("**/api/conversations/main/view-state", route => {
    if (route.request().method() === "PUT") viewState = route.request().postDataJSON()
    return route.fulfill({ json: viewState })
  })
  await page.route("**/api/members", route => route.fulfill({ json: { members: [{ ...fixtures.working.model.owner,
    color_index: 3, role: "member", needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/smithersai/smithers/settings/access" } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/github/sync", route => route.fulfill({ json: { state: "fresh", last_success_at: "2026-10-06T00:00:00Z" } }))
  await page.route("**/contents/.smithers/factory.json", route => route.fulfill({ json: {
    content: JSON.stringify({ summary: "Notification journey", flows: [] }), encoding: "utf-8" } }))
  await page.route("**/api/repos/smithersai/smithers/home", route => route.fulfill({ json: { kind: "blocks", blocks: [{ type: "stack" }] } }))
  await page.route("**/api/repos/smithersai/smithers/mythical", route => route.fulfill({ json: {
    repository: "smithersai/smithers", state: "active", generation: 1, mainBehind: false, changes: [], items: [],
    lanes: [{ index: 0, state: "idle" }], limits: { maxParallel: 1 }
  } }))
  await page.route("**/api/repos/smithersai/smithers/mythical/events", route => route.fulfill({ contentType: "text/event-stream", body: ": keepalive\n\n" }))
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  let t3: TodoCard = { ...fixtures.working.model, n: 3, title: "T3 questions" }
  let t4: TodoCard = { ...fixtures.working.model, n: 4, title: "T4 retry" }
  const topics = new Map<string, { id: number; cursor: number; send: (raw: string) => void }>()
  const publish = (model: TodoCard) => {
    if (model.n === 3) t3 = model; else t4 = model
    const topic = topics.get(`todo:${model.n}`)
    topic?.send(JSON.stringify({ t: "snap", id: topic.id, cursor: ++topic.cursor, data: model }))
  }
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t === "sub") {
      const model = frame.topic === "todo:3" ? t3 : frame.topic === "todo:4" ? t4 : undefined
      if (!model) { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
      topics.set(frame.topic, { id: frame.id, cursor: 0, send: raw => socket.send(raw) })
      publish(model)
    } else if (frame.t === "unsub") for (const [name, topic] of topics) if (topic.id === frame.id) topics.delete(name)
  }))
  let listReads = 0
  await page.route("**/api/todos", route => { listReads++; return route.fulfill({ json: [t3, t4] }) })
  await page.route("**/api/todos/3", route => route.fulfill({ json: t3 }))
  await page.route("**/api/todos/4", route => route.fulfill({ json: t4 }))
  await page.goto(origin)
  const observations = () => page.evaluate(() => (Notification as unknown as { observations(): { requests: number; titles: string[]; focus: number } }).observations())
  await expect.poll(() => page.evaluate(() => isSecureContext)).toBe(secure)
  await expect.poll(() => topics.has("todo:3") && topics.has("todo:4")).toBe(true)
  publish({ ...fixtures.needs_you.model, n: 3, title: "T3 questions" })
  await expect(page.getByText("T3 needs you", { exact: true }).first()).toBeVisible()
  const allow = page.getByRole("button", { name: "Allow notifications", exact: true })
  expect(await observations()).toEqual({ requests: 0, titles: [], focus: 0 })
  if (secure) {
    await expect(allow).toHaveCount(1)
    await allow.press("Enter")
    await expect.poll(async () => (await observations()).requests).toBe(1)
    await expect(allow).toHaveCount(0)
  } else await expect(allow).toHaveCount(0)
  const cdp = browserName === "chromium" ? await context.newCDPSession(page) : undefined
  const opened = context.waitForEvent("page")
  if (cdp) {
    const { targetInfo } = await cdp.send("Target.getTargetInfo")
    await cdp.send("Target.createTarget", { url: "about:blank", newWindow: false, browserContextId: targetInfo.browserContextId })
  }
  else await page.evaluate(() => { window.open("about:blank", "_blank") })
  const other = await opened
  await other.bringToFront()
  // WebKit's pinned Playwright driver forces each page active. Set the browser's native activity state,
  // keeping document.hidden and the app's live-event/dispatcher paths untouched.
  const webkitActivity = browserName === "webkit" ? (page as unknown as {
    _connection: { toImpl(page: unknown): { delegate: { _pageProxySession: { send(name: string, args: { active: boolean }): Promise<void> } } } }
  })._connection.toImpl(page).delegate._pageProxySession : undefined
  if (webkitActivity) await webkitActivity.send("Emulation.setActiveAndFocused", { active: false })
  await expect.poll(() => page.evaluate(() => document.hidden)).toBe(true)
  publish({ ...t3, waits: [{ ...t3.waits[0]!, id: "question-2", prompt: "Which region?" }] })
  await expect(page.getByText("T3 needs you", { exact: true })).toHaveCount(2)
  publish({ ...fixtures.in_review.model, n: 3, title: "T3 ready for review" })
  await expect(page.getByText("T3 ready for review", { exact: true }).first()).toBeVisible()
  publish({ ...fixtures.failed.model, n: 4, title: "T4 retry failed" })
  await expect(page.getByText("T4 retry failed", { exact: true }).first()).toBeVisible()
  if (secure) {
    await expect.poll(async () => (await observations()).titles).toEqual(["T3 needs you", "T3 ready for review", "T4 retry failed"])
    await page.evaluate(() => (Notification as unknown as { clickReview(): void }).clickReview())
    await expect(page.locator('[data-kind="todo"]').last()).toContainText("T3 ready for review")
    expect((await observations()).focus).toBe(1)
  } else expect(await observations()).toEqual({ requests: 0, titles: [], focus: 0 })
  if (webkitActivity) await webkitActivity.send("Emulation.setActiveAndFocused", { active: true })
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hidden)).toBe(false)
  publish({ ...fixtures.needs_you.model, n: 3, title: "T3 visible question", waits: [{ ...fixtures.needs_you.model.waits[0]!, id: "visible-question" }] })
  await expect(page.locator('[data-notice="toast-todo.needs-you.3.visible-question"]')).toBeVisible()
  publish(t3); publish(t4)
  const seen = listReads
  await expect.poll(() => listReads).toBeGreaterThanOrEqual(seen + 2)
  expect((await observations()).titles).toEqual(secure ? ["T3 needs you", "T3 ready for review", "T4 retry failed"] : [])
  expect(errors).toEqual([])
  await other.close()
})
