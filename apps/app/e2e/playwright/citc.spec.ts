import { fillComposer } from "./composer"
import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"
import { installCloudFixture } from "./cloudFixture"

test("T-APP-10: /branch opens one Branch card and keeps Chat usable", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
  await say(page, "/branch T9")
  const card = page.locator('.smithers-card[data-kind="branch"][data-testid]').last()
  await expect(card).toBeVisible()
  await expect(card.getByRole("tab", { name: "Activity", exact: true })).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await card.getByRole("button", { name: "Maximize card", exact: true }).press("Enter")
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
  await expect(page.locator('.smithers-card[data-kind="branch"][data-testid]').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="workspace"]')).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// T-UI-17: dispatcher -> registry -> View/adapter on the non-install seed fallback.
// Machine ownership and frozen live metadata remain T-APP-12/T-TRM-01 receipts.
test("T-UI-17: mounted terminal accepts owner keys and preserves the shell palette while watching", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
  const command = async (line: string) => {
    if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("ControlOrMeta+k")
    await fillComposer(page, line)
    await page.getByTestId("composer-send").press("Enter")
    await expect(page.getByTestId("composer-input")).toHaveValue("")
    const input = page.getByTestId("composer-input")
    if (await input.isVisible()) await input.press("Escape")
    if (await input.isVisible()) await input.press("Escape")
  }
  await command("/terminal T9")
  const own = page.locator(".terminal-view").last()
  await expect(own).toBeVisible()
  await own.locator(".xterm-helper-textarea").focus()
  await page.keyboard.type("pnpm test")
  await page.keyboard.press("Enter")
  await expect(own.locator(".xterm-rows")).toContainText("42 passed")
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("palette")).toBeHidden()
  await command("/terminal.watch term-retry-1")
  const watched = page.locator(".terminal-view").last()
  await expect(watched.getByRole("status")).toHaveText("Watching")
  await expect(watched.locator(".terminal-output > div")).toHaveAttribute("inert", "")
  await watched.locator(".terminal-output").click()
  await page.keyboard.press("Tab")
  await expect(watched.locator(".xterm-helper-textarea")).not.toBeFocused()
  await expect(page.getByTestId("palette")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(page.getByTestId("palette")).toBeVisible()
})

// HTTP/socket contract proof; native conflict execution remains a composed-install check.
for (const refusal of ["still_conflicted", "stale_conflict", "rebase_execution_unavailable"] as const) {
  test(`T-APP-10: scratch Resolve/Done keeps the bound conflict after ${refusal}`, async ({ page }) => {
    await installCloudFixture(page, { capabilities: ["identity", "install"] })
    const writes: unknown[] = []
    const reads: string[] = []
    const branch = "scratch/ben/retry"
    await page.route("**/api/branches/scratch%2Fben%2Fretry", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { name: branch, machine: { id: "b-conflict" } } })
      writes.push(route.request().postDataJSON())
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      return route.fulfill({ status: refusal === "rebase_execution_unavailable" ? 503 : 409,
        json: { code: refusal, class: refusal === "rebase_execution_unavailable" ? "infra" : "conflict", message: "Rebase unavailable" } })
    })
    await page.route("**/api/branches/scratch%2Fben%2Fretry/files/src/retry.ts*", route => {
      reads.push(route.request().url())
      return route.fulfill({ json: { path: "src/retry.ts", branch, language: "typescript", digest: "sha256:conflict",
        content: { kind: "text", text: "export const retry = 2;\n" }, mode: "read_only", diagnostics: [], authors: [], editors: [] } })
    })
    await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
      if (typeof raw !== "string") return
      const frame = JSON.parse(raw)
      if (frame.t !== "sub") return
      const data = frame.topic === "branch:b-conflict" ? {
        id: "b-conflict", name: branch, head: "1111111111111111111111111111111111111111", machine: { state: "awake" },
        scratch: { forked_from: { kind: "main" } }, presence: [], terminals: [],
        rebase: { state: "conflict", onto: "main", paths: ["src/retry.ts"], conflict_change: "conflict-retained", onto_revision: "2222222222222222222222222222222222222222" },
        ssh_line: "ssh -p 2222 retry@localhost"
      } : []
      socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data }))
    }))
    await page.goto("/")
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    await say(page, `/branch ${branch}`)
    const card = page.getByTestId("card-branch:b-conflict")
    await expect(card).toContainText("Rebase conflict onto main")
    await card.getByRole("button", { name: "Resolve", exact: true }).press("Enter")
    await expect(page.getByTestId("card-file-branch-scratch/ben/retry-src/retry.ts")).toContainText("export const retry = 2;")
    expect(reads).toHaveLength(1)
    expect(new URL(reads[0]!).pathname).toBe("/api/branches/scratch%2Fben%2Fretry/files/src/retry.ts")
    expect(new URL(reads[0]!).searchParams.get("at")).toBeNull()
    expect(writes).toEqual([])
    await card.getByRole("button", { name: "Done", exact: true }).press("Enter")
    await expect.poll(() => writes).toEqual([{ conflict_change: "conflict-retained", onto_revision: "2222222222222222222222222222222222222222" }])
    await expect(page.locator('.notice[data-tone="failed"]').filter({ hasText: "Rebase" })).toBeVisible()
    await expect(card.getByRole("button", { name: "Done", exact: true })).toBeVisible()
    await expect(card).toContainText("Rebase conflict onto main")
    await expect(card).toContainText("Scratch")
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    await expect(page.getByTestId("card-branch:b-conflict")).toContainText("Rebase conflict onto main")
    expect(writes).toHaveLength(1)
    await expect(page.locator('.smithers-card[data-kind="todo"]')).toHaveCount(0)
  })
}

// Mounted card → typed action → production dispatcher → durable seam. HTTP
// contracts are controlled here; the native composed test proves the receipts.
for (const scenario of ["completed", "scratch completed", "failed", "unacknowledged reload", "launch failure retry"] as const) test(`T-APP-10: Rebase background request survives ${scenario}`, async ({ page }) => {
  const scratch = scenario === "scratch completed"
  const branchName = scratch ? "scratch/ben/retry" : "smithers/retry"
  const branchId = scratch ? "11111111-1111-4111-8111-111111111111" : "b-rebase"
  const outcome = scenario === "failed" ? "failed" : "completed"
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  let release!: () => void, state = "running", admitted = false, rejectLaunch = scenario === "launch failure retry"
  const writes: string[] = [], receiptKeys: string[] = [], commands: string[] = []
  page.on("console", message => { if (message.type() === "debug") commands.push(message.text()) })
  await page.route(`**/api/branches/${encodeURIComponent(branchName)}`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { name: branchName, machine: { id: branchId } } })
    writes.push(route.request().headers()["idempotency-key"]!)
    const attempt = writes.length
    expect(route.request().postDataJSON()).toEqual({ rebase: true })
    if (!admitted) await new Promise<void>(resolve => { release = resolve })
    if (rejectLaunch) return route.fulfill({ status: 503, json: { code: "rebase_execution_unavailable", class: "infra", message: "Rebase execution unavailable" } })
    // The first POST is intentionally abandoned by the unacknowledged reload.
    if (scenario === "unacknowledged reload" && attempt === 1) return route.abort().catch(() => {})
    await route.fulfill({ status: 202, json: { state: "accepted", ...(scratch ? { branch: branchId } : { n: 2 }), onto: "new-main" } })
  })
  await page.route(scratch ? `**/api/branches/${branchId}?rebase_request=*` : "**/api/todos/2?rebase_request=*", route => {
    receiptKeys.push(new URL(route.request().url()).searchParams.get("rebase_request")!)
    return route.fulfill({ json: { ...(scratch ? { kind: "scratch", machine: { id: branchId } } : { n: 2 }), rebase_execution: { onto: "new-main", state } } })
  })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    if (typeof raw !== "string") return
    const frame = JSON.parse(raw)
    if (frame.t !== "sub") return
    const data = frame.topic === `branch:${branchId}` ? {
      id: branchId, name: branchName, machine: { state: "awake" },
      ...(scratch ? { scratch: { forked_from: { kind: "main" } } } : { item: { n: 2, title: "Retry", state: "in_review", place: 1 } }),
      presence: [], terminals: [], rebase: { state: "pending", onto: "main" }, ssh_line: "ssh -p 2222 retry@localhost"
    } : []
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data }))
  }))
  await page.goto("/")
  await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
  await fillComposer(page, "/debug.verbose")
  await page.getByTestId("composer-send").click()
  await say(page, `/branch ${branchName}`)
  const card = page.getByTestId(`card-branch:${branchId}`)
  await card.getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
  const running = page.locator('.notice[data-tone="live"]').filter({ hasText: "Rebase" })
  await expect(running).toBeVisible()
  await say(page, `/branch.rebase ${branchName}`)
  // Clearing the draft precedes command admission. Keep launch unresolved until
  // the duplicate has actually returned Requested through the shared flow.
  await expect.poll(() => commands.filter(line => line.includes(`You ran /branch.rebase ${branchName} [hidden] → executed (Requested)`)).length).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  expect(writes).toHaveLength(1)
  expect(receiptKeys).toEqual([])
  const key = writes[0]!
  admitted = true
  if (scenario === "unacknowledged reload") {
    const abandon = release
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    abandon()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes).toEqual([key, key])
    await expect(page.getByTestId("composer-input")).toBeEditable()
  } else {
    release()
  }
  if (scenario === "launch failure retry") {
    await expect(page.locator('.notice[data-tone="failed"]').filter({ hasText: "Rebase" })).toBeVisible()
    expect(receiptKeys).toEqual([])
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toBeVisible()
    expect(writes).toEqual([key])
    rejectLaunch = false
    await card.getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
    await expect.poll(() => writes.length).toBe(2)
    expect(writes).toEqual([key, key])
  }
  await expect.poll(() => receiptKeys.length).toBeGreaterThan(0)
  await expect(running).toBeVisible()
  await page.reload()
  await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
  await expect(running).toBeVisible()
  expect(writes).toHaveLength(scenario === "unacknowledged reload" || scenario === "launch failure retry" ? 2 : 1)
  expect(receiptKeys.every(receiptKey => receiptKey === key)).toBe(true)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  state = outcome
  await expect(page.locator(`.notice[data-tone="${outcome === "completed" ? "done" : "failed"}"]`).filter({ hasText: "Rebase" })).toBeVisible()
  await expect(running).toHaveCount(0)
  if (scenario === "failed") {
    // A terminal execution failure survives reload and never replays its POST.
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    await expect(page.locator('.notice[data-tone="failed"]').filter({ hasText: "Rebase" })).toBeVisible()
    await expect(card.getByRole("button", { name: "Rebase now", exact: true })).toBeVisible()
    expect(writes).toEqual([key])
    const observed = receiptKeys.length
    state = "running"
    await card.getByRole("button", { name: "Rebase now", exact: true }).press("Enter")
    await expect.poll(() => writes.length).toBe(2)
    const retryKey = writes[1]!
    expect(retryKey).not.toBe(key)
    // Hold the new execution running: the failed attempt cannot settle it.
    await expect(running).toBeVisible()
    await say(page, `/branch.rebase ${branchName}`)
    expect(writes).toEqual([key, retryKey])
    await expect.poll(() => receiptKeys.slice(observed).includes(retryKey)).toBe(true)
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeEditable({ timeout: 30_000 })
    await expect(running).toBeVisible()
    expect(writes).toEqual([key, retryKey])
    state = "completed"
    await expect(page.locator('.notice[data-tone="done"]').filter({ hasText: "Rebase" })).toBeVisible()
    await expect(running).toHaveCount(0)
  }
})
