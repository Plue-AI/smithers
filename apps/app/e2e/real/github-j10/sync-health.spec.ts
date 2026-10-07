import { readFile } from "node:fs/promises"
import { test, reloadApp } from "../support"
import { scenario } from "../coverage/types"
import { withReference, required, runSlash, realApi, expect, home, attachJson } from "../todo/reference"
import { journeyActivate } from "../support/keyboard-journey-input"

// The operator controls the reference host's pre-approved network block and
// GitHub installation. No browser interception substitutes for host failure.
// The operator log is observation, never an authenticated manual check receipt.
test("C-J10-06 Home sync ages through host network loss and Member Retry", scenario("journey-sync-health", {
  capabilities: [], coverage: ["host:local", "host:production", "door:button", "door:agent", "surface:home", "dimension:keyboard", "path:persistence", "evidence:sync-health"]
}), async ({ browser }, info) => {
  test.setTimeout(1_800_000)
  expect(required("SMITHERS_JOURNEY_KEYBOARD")).toBe("1")
  expect(["light", "dark"]).toContain(required("SMITHERS_JOURNEY_THEME"))
  const operatorLog = required("SMITHERS_JOURNEY_SYNC_OPERATOR_LOG")
  const candidate = required("SMITHERS_REAL_E2E_BUILD_SHA")
  const started = Date.now()
  const operations: Array<{ action: string; at: string; candidate: string; operator: string }> = []
  const samples: Array<{ at: number; text: string; color: string; stale: boolean; state: string; last_success_at: string }> = []
  const frames: Array<{ at: number; type: string }> = []
  const operation = async (action: string) => {
    console.log(`Reference operator: ${action}; record its UTC time and candidate in the sanitized sync operator log.`)
    let row: (typeof operations)[number] | undefined
    await expect.poll(async () => {
      let rows: typeof operations
      try { rows = JSON.parse(await readFile(operatorLog, "utf8")) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
      expect(Array.isArray(rows)).toBe(true)
      row = rows.find(value => value.action === action)
      return row !== undefined
    }, { timeout: 180_000, intervals: [1000] }).toBe(true)
    expect(row!.candidate).toBe(candidate)
    expect(row!.operator.trim()).not.toBe("")
    const at = Date.parse(row!.at)
    expect(at).toBeGreaterThanOrEqual(started)
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(at).toBeGreaterThanOrEqual(Date.parse(operations.at(-1)?.at ?? new Date(started).toISOString()))
    operations.push(row!)
  }
  try {
    await withReference(browser, info, async f => {
      const page = f.members.Alice.page
      // Observe the actual live subscription, reopening it after registration.
      page.on("websocket", socket => {
        if (new URL(socket.url()).pathname !== "/api/live") return
        const topics = new Map<number, string>()
        const parse = (payload: string | Buffer) => { try { return JSON.parse(payload.toString()) } catch { return undefined } }
        socket.on("framesent", ({ payload }) => { const frame = parse(payload); if (frame?.t === "sub") topics.set(frame.id, frame.topic) })
        socket.on("framereceived", ({ payload }) => {
          const frame = parse(payload)
          if (frame?.t === "delta" && topics.get(frame.id) === "home") frames.push({ at: Date.now(), type: frame.data?.Type ?? "" })
        })
      })
      await reloadApp(page)
      await runSlash(page, "/home")
      const row = home(page).locator(".sync")
      const readHealth = async () => {
        const response = await realApi(page, page.context().request, "GET", "/api/github/sync")
        expect(response.status()).toBe(200)
        const health = await response.json()
        expect(health).not.toHaveProperty("age")
        return health
      }
      const sample = async () => {
        const health = await readHealth()
        const rendered = await row.evaluate(element => ({ text: element.textContent ?? "", color: getComputedStyle(element).color, stale: element.hasAttribute("data-stale") }))
        const result = { at: Date.now(), ...rendered, state: health.state, last_success_at: health.last_success_at }
        samples.push(result)
        return result
      }
      const observeFor = async (milliseconds: number) => {
        const until = Date.now() + milliseconds
        while (Date.now() < until) { await sample(); await page.waitForTimeout(1000) }
      }
      await expect.poll(async () => (await readHealth()).state).toBe("fresh")
      await observeFor(300_000)
      for (const value of samples) {
        expect(value.stale).toBe(false)
        const age = Number(/synced (\d+) s ago/.exec(value.text)?.[1])
        expect(age).toBeLessThanOrEqual(60)
        expect(Math.abs(age * 1000 - (value.at - Date.parse(value.last_success_at)))).toBeLessThanOrEqual(2000)
      }
      // Age must advance locally across a span without a home delta.
      expect(samples.some((value, index) => {
        const prior = samples[index - 2]
        return prior && value.last_success_at === prior.last_success_at && value.text !== prior.text &&
          !frames.some(frame => frame.at > prior.at && frame.at <= value.at)
      })).toBe(true)
      await operation("block-github")
      const blockedAt = Date.parse(operations.at(-1)!.at)
      const offset = samples.length
      await observeFor(Math.max(0, blockedAt + 360_000 - Date.now()))
      const blocked = samples.slice(offset)
      expect(blocked.length).toBeGreaterThan(100)
      const success = Date.parse(blocked.at(-1)!.last_success_at)
      expect(blocked.every(value => Date.parse(value.last_success_at) === success)).toBe(true)
      expect(blocked.filter(value => value.at < success + 120_000).every(value => !value.stale)).toBe(true)
      const firstStale = blocked.find(value => value.stale)
      expect(firstStale).toBeDefined()
      expect(firstStale!.at - success).toBeGreaterThanOrEqual(120_000)
      expect(firstStale!.at - success).toBeLessThanOrEqual(122_500)
      expect(blocked.at(-1)!.text).toMatch(/synced [5-7] min ago/)
      const retry = row.getByRole("button", { name: "Retry", exact: true })
      await expect(retry).toBeVisible()
      const isRetry = (method: string, url: string) => method === "POST" && new URL(url).pathname === "/api/github/sync"
      const sent = page.waitForRequest(request => isRetry(request.method(), request.url())).then(() => Date.now())
      const accepted = page.waitForResponse(response => isRetry(response.request().method(), response.url()))
        .then(response => ({ response, at: Date.now() }))
      await journeyActivate(retry)
      const acknowledgment = await accepted
      expect(acknowledgment.response.status()).toBe(202)
      // Measure admission, excluding Tab traversal and artifact-capture latency.
      expect(acknowledgment.at - await sent).toBeLessThan(2000)
      await expect(row).toHaveAttribute("data-stale", "true")
      await runSlash(page, "Show the running work")
      await expect(page.getByTestId("composer-input")).toBeEnabled()
      await operation("unblock-github")
      await runSlash(page, "retry the GitHub sync")
      await expect(page.locator('.smithers-card[data-kind="confirm"]')).toHaveCount(0)
      await expect.poll(async () => (await readHealth()).state, { timeout: 10_000, intervals: [250] }).toBe("fresh")
      await expect(row).not.toHaveAttribute("data-stale")
      await operation("suspend-installation")
      await expect.poll(async () => (await readHealth()).state, { timeout: 120_000, intervals: [1000] }).toBe("refused")
      await expect(row).toContainText(/GitHub App (not installed|permission missing)/)
      await expect(row.getByRole("button", { name: "Fix", exact: true })).toBeVisible()
      await sample()
      await operation("unsuspend-installation")
      await journeyActivate(retry)
      await expect.poll(async () => (await readHealth()).state, { timeout: 10_000, intervals: [250] }).toBe("fresh")
      await sample()
      await f.read("Alice", `/api/repos/${f.repo}/home`)
    })
  } finally {
    await attachJson(info, "sync-samples", samples)
    await attachJson(info, "home-frames", frames)
    await attachJson(info, "sync-operator-actions", operations)
  }
})
