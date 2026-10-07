import { expect, test, type Page } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"
import { say } from "./j1-fixtures"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import * as Y from "yjs"

// Two real browser editors over the composed install router, PostgreSQL and
// native Yrs. The UI identity/model fixture does not own document data.
test("C-J8-02: wiki edits converge across members and survive offline reload", async ({ page }) => {
  test.setTimeout(240_000)
  if (!process.env.SMITHERS_FFI_LIBRARY_PATH || !process.env.SMITHERS_TEST_DATABASE_URL) throw new Error("Native FFI and PostgreSQL are required for the wiki tracer")
  const dir = await mkdtemp(join(tmpdir(), "smithers-wiki-browser-")), config = join(dir, "host.json")
  const lane = (process.env.LANE ?? "wiki-browser").replace(/[^a-zA-Z0-9_-]/g, "_")
  const binary = process.env.SMITHERS_WIKI_TEST_BINARY
  const backend = spawn(binary ?? "go", binary ? ["-test.run=^TestWikiHostCommittedReceiptsAndRestart$", "-test.count=1"] : ["test", "./internal/compose", "-run", "^TestWikiHostCommittedReceiptsAndRestart$", "-count=1"], {
    cwd: resolve("../../packages/backend"), env: { ...process.env, LANE: lane,
      SMITHERS_TEST_DATABASE_NAMESPACE: process.env.SMITHERS_TEST_DATABASE_NAMESPACE ?? lane.replace(/-/g, "_"), SMITHERS_WIKI_BROWSER_HARNESS: config, SMITHERS_WIKI_SPA_DIR: resolve("dist") }, stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = ""; backend.stdout.on("data", bytes => { logs += String(bytes) }); backend.stderr.on("data", bytes => { logs += String(bytes) })
  const exited = new Promise<number | null>(done => backend.on("exit", done))
  const alice = await page.context().browser()!.newContext(), other = await alice.newPage()
  const wire: string[] = []
  for (const browser of [page, other]) browser.on("websocket", socket => {
    socket.on("framereceived", event => { wire.push("received " + (typeof event.payload === "string" ? event.payload : event.payload.toString("base64"))) })
    socket.on("framesent", event => { wire.push("sent " + (typeof event.payload === "string" ? event.payload : event.payload.toString("base64"))) })
  })
  try {
    let host!: { origin: string; repo: string; pageId: number; owner: string; member: string }
    await expect.poll(async () => {
      try { host = JSON.parse(await readFile(config, "utf8")); return true } catch { if (backend.exitCode !== null) throw new Error(logs); return false }
    }, { timeout: 120_000 }).toBe(true)
    const open = async (browser: Page, login: string, cookie: string) => {
      // Exercise the supported durable fallback on this non-isolated HTTP host.
      await browser.addInitScript(() => localStorage.setItem("smithers-mvp.persistenceBackend", "localStorage"))
      await installCloudFixture(browser, { capabilities: ["agent", "identity", "install"], repos: [{ owner: host.owner, name: "app", full_name: host.repo, owner_type: "User", default_bookmark: "main" }] })
      await browser.context().addCookies([{ name: "session", value: cookie, url: host.origin }, { name: "__csrf", value: "c".repeat(64), url: host.origin }])
      await browser.route("**/api/user", route => route.fulfill({ json: { id: login === host.owner ? 2 : 3, username: login, is_admin: false } }))
      await browser.route("**/api/install", route => route.fulfill({ json: { ...installFixture(), repository: { owner: host.owner, name: "app" }, repositories: [host.repo] } }))
      await browser.route("**/api/members", route => route.fulfill({ json: { access_url: "https://github.com/" + host.repo + "/settings/access", members: [
        { id: "2", login: host.owner, avatar_url: "https://example.test/owner.png", color_index: 0, role: "owner", needs_access: false, suspended: false, actions: [] },
        { id: "3", login: host.member, avatar_url: "https://example.test/member.png", color_index: 1, role: "member", needs_access: false, suspended: false, actions: [] }
      ] } }))
      await browser.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
      await browser.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
      await browser.route(url => /^\/api\/repos\/[^/]+\/[^/]+\/wiki(?:\/|$)/.test(url.pathname), route => route.continue())
      await browser.route("**/api/public/repos**", route => route.fulfill({ json: { repos: [] } }))
      await browser.goto(`${host.origin}/${host.repo}`)
      await expect(browser.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
      await say(browser, "/wiki.page Home")
      const card = browser.getByTestId(`card-wiki-open-wiki:${host.repo}:${host.pageId}`)
      await expect(card).toBeVisible({ timeout: 30_000 })
      await card.getByRole("button", { name: "Edit", exact: true }).click()
      await expect(card.locator('.ProseMirror[contenteditable="true"]')).toBeVisible({ timeout: 30_000 })
      return card.locator('.ProseMirror[contenteditable="true"]')
    }
    const benDoc = await open(page, host.owner, "wiki-browser"), aliceDoc = await open(other, host.member, "wiki-member")
    await benDoc.click(); await page.keyboard.press("Control+End"); await page.keyboard.type("Ben")
    await expect(aliceDoc).toContainText("Ben", { timeout: 20_000 })
    await aliceDoc.click(); await other.keyboard.press("Control+End"); await other.keyboard.type("Alice")
    await expect(benDoc).toContainText("Alice", { timeout: 20_000 })
    await alice.setOffline(true)
    await aliceDoc.click(); await other.keyboard.press("Control+End"); await other.keyboard.type("Offline", { delay: 125 })
    await expect(aliceDoc).toContainText("Offline")
    // Reload after the local commit receipt, while the socket remains blocked.
    // A visible keystroke alone does not imply that command admission finished.
    await expect.poll(async () => {
      const row = await other.evaluate(pageId => {
        const envelope = JSON.parse(localStorage.getItem("smithers-mvp.store") ?? "{}");
        const find = (value: any): any => {
          if (!value || typeof value !== "object") return undefined
          if (value.cloud?.pageId === pageId) return value
          for (const nested of Object.values(value)) { const row = find(nested); if (row) return row }
        }
        for (const [key, raw] of Object.entries(envelope.entries ?? {})) {
          if (!key.includes("world-documents")) continue
          try { const row = find(JSON.parse(raw as string)); if (row) return row } catch { /* another collection */ }
        }
      }, host.pageId)
      if (!row || row.cloud.pending.length || !row.cloud.live?.pending.length) return false
      const doc = new Y.Doc()
      try { Y.applyUpdate(doc, Buffer.from(row.cloud.state, "base64")); return doc.getText("markdown").toString().includes("Offline") }
      finally { doc.destroy() }
    }, { timeout: 30_000 }).toBe(true)
    await other.reload().catch(() => {})
    await alice.setOffline(false)
    await other.reload()
    await expect(other.getByRole("button", { name: "Chat", exact: true })).toBeVisible({ timeout: 30_000 })
    await say(other, "/wiki.page Home")
    const restored = other.getByTestId(`card-wiki-open-wiki:${host.repo}:${host.pageId}`).locator('.ProseMirror')
    await expect(restored).toContainText("Offline", { timeout: 30_000 })
    await expect(benDoc).toContainText("Offline", { timeout: 20_000 })
    const text = await restored.textContent()
    for (const word of ["Ben", "Alice", "Offline"]) expect(text!.split(word).length - 1).toBe(1)
    await expect.poll(async () => {
      const response = await page.request.get(`${host.origin}/api/repos/${host.repo}/wiki/home/document`)
      const value = await response.json()
      return value.page.body.replace(/\n/g, "")
    }, { timeout: 20_000 }).toBe(text)
    const historical = await page.request.get(`${host.origin}/api/repos/${host.repo}/wiki/history/${host.pageId}/1/content?visibility=public`)
    expect(historical.status()).toBe(200)
    expect(await historical.text()).toBe("old")
    const csrf = (await page.context().cookies(host.origin)).find(cookie => cookie.name === "__csrf")!.value
    for (const [method, suffix] of [["GET", "updates"], ["POST", "updates"], ["GET", "stream"]] as const) {
      const response = await page.request.fetch(`${host.origin}/api/repos/${host.repo}/wiki/home/${suffix}`, { method, headers: { Origin: host.origin, "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": csrf } })
      expect(response.status()).toBe(404)
    }
  } finally {
    await writeFile(join(tmpdir(), `${lane}-browser-wire.log`), wire.join("\n"))
    await writeFile(join(tmpdir(), `${lane}-browser-store.json`), await other.evaluate(() => localStorage.getItem("smithers-mvp.store") ?? "{}").catch(() => "{}"))
    await writeFile(join(tmpdir(), `${lane}-browser-host.log`), logs)
    await alice.close()
    await writeFile(config + ".stop", "stop")
    const code = await exited
    await rm(dir, { recursive: true, force: true })
    expect(code, logs).toBe(0)
  }
})
