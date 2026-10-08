import { expect, test } from "./browserTest"
import { queryDatabase, trackDatabaseWorker } from "./databaseProbe"
import { owner } from "./spec/j1-fixtures"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"

test("install reads the shared conversation with author attribution after reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [
    { id: "turn-ben", author: 1, authorLogin: "ben", runId: "run-ben", prompt: "List changed tests", state: "completed", frames: [
      { runId: "run-ben", type: "delta", kind: "text", text: "One changed test" }, { runId: "run-ben", type: "done", reason: "stop" }
    ] }
  ] } }))
  let writes = 0
  page.on("request", request => { if (request.method() === "POST" && /\/api\/(agent|chat)\/turn$/.test(new URL(request.url()).pathname)) writes++ })
  await page.goto("/")
  const transcript = page.locator('[data-shared-conversation="main"]')
  await expect(transcript).toContainText("Smithers for ben")
  await expect(transcript).toContainText("List changed tests")
  await expect(transcript).toContainText("One changed test")
  await page.reload()
  await expect(transcript).toContainText("One changed test")
  expect(writes).toBe(0)
  await expect(page.locator('[data-flow="chat.queue.resume"]')).toHaveCount(0)
})

test("composer admits in the background and reconnects the same host turn after reload", async ({ page }) => {
  await trackDatabaseWorker(page)
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  let admit!: () => void, accepted = false, completed = false
  const requests: unknown[] = []
  await page.route("**/api/conversations/main/prompt", async route => {
    requests.push(route.request().postDataJSON())
    await new Promise<void>(resolve => { admit = resolve })
    accepted = true
    await route.fulfill({ status: 202, json: { status: "accepted", turnId: "host-turn", terminal: false } })
  })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: accepted ? [
    { id: "host-turn", author: 1, authorLogin: "canary-owner", runId: "host-run", prompt: "Shared prompt", state: completed ? "completed" : "running", frames: completed ? [
      { runId: "host-run", type: "delta", kind: "text", text: "Host completed once" }, { runId: "host-run", type: "done", reason: "stop" }
    ] : [] }
  ] : [] } }))
  let legacy = 0
  page.on("request", request => { if (request.method() === "POST" && /\/api\/(agent|chat)\/turn$/.test(new URL(request.url()).pathname)) legacy++ })
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).press("Enter")
  const composer = page.getByTestId("composer-input")
  await composer.fill("Shared prompt")
  await composer.press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  await composer.fill("Unrelated draft")
  await expect(composer).toHaveValue("Unrelated draft")
  expect(requests[0]).toEqual({ prompt: "Shared prompt", idempotencyKey: expect.any(String) })
  admit()
  await expect(page.locator('[data-shared-turn="host-turn"]')).toHaveAttribute("data-state", "running")
  // A host read can paint the turn before its admission receipt commits locally.
  // Reload after that receipt, so this assertion exercises accepted recovery.
  await expect.poll(async () => {
    const rows = await queryDatabase(page, "SELECT value FROM smithers_collection_rows WHERE collection_id = 'app-sessions'") as { value: string }[]
    return rows.some(row => JSON.parse(row.value).sharedPrompts?.some((prompt: { id: string; state: string; turnId?: string }) =>
      prompt.id === (requests[0] as { idempotencyKey: string }).idempotencyKey && prompt.state === "accepted" && prompt.turnId === "host-turn"))
  }).toBe(true)
  await page.reload()
  await expect(page.locator('[data-shared-turn="host-turn"]')).toHaveAttribute("data-state", "running")
  completed = true
  await expect(page.locator('[data-shared-turn="host-turn"]')).toContainText("Host completed once")
  expect(requests).toHaveLength(1)
  expect(legacy).toBe(0)
})

test("member card view and scroll anchor restore after reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  let view: Record<string, unknown> = { scroll_anchor: "turn-4:prompt", home: { filter: "working" }, toasts_hidden: false }
  const writes: Record<string, unknown>[] = []
  await page.route("**/api/conversations/main/view-state", async route => {
    if (route.request().method() === "PUT") { view = route.request().postDataJSON(); writes.push(view) }
    await route.fulfill({ json: { ...view, queue: [] } })
  })
  const card = { id: "shared-file", kind: "file", title: "README.md", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "owner/repo", path: "README.md", content: "Shared file bytes", truncated: false } }
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index}`, author: 1, authorLogin: "ben", runId: `run-${index}`, prompt: `Question ${index}`, state: "completed", frames: [
      { runId: `run-${index}`, type: "delta", kind: "text", text: Array.from({ length: 8 }, (_, line) => `Answer ${index}, paragraph ${line}.`).join("\n\n") },
      ...(index === 4 ? [{ type: "card", runId: "run-4", card }] : []),
      { runId: `run-${index}`, type: "done", reason: "stop" }
    ]
  })) } }))
  await page.goto("/")
  const file = page.getByTestId("card-shared-file")
  await expect(file).toBeAttached()
  await file.locator('[data-flow="card.maximize"]').click()
  await expect(file).toHaveAttribute("data-maximized", "true")
  await page.reload()
  await expect(file).toHaveAttribute("data-maximized", "true")
  await file.locator('[data-flow="card.minimize"]').click()
  await expect(file).toHaveAttribute("data-maximized", "false")
  const viewport = page.getByRole("region", { name: "Conversation messages", exact: true })
  await viewport.evaluate(node => { node.scrollTop = 900; node.dispatchEvent(new Event("scroll", { bubbles: true })) })
  await expect.poll(() => typeof view.scroll_anchor === "string" && view.scroll_anchor !== "turn-4:prompt").toBe(true)
  const savedAnchor = String(view.scroll_anchor)
  await page.reload()
  await expect.poll(async () => page.locator(`[data-message-id="${savedAnchor}"]`).evaluate(node => {
    const container = node.closest('[data-slot="message-scroller-viewport"]')!
    return Math.abs(node.getBoundingClientRect().top - container.getBoundingClientRect().top)
  })).toBeLessThan(100)
  expect(writes.every(body => !("queue" in body) && JSON.stringify(body.home) === JSON.stringify({ filter: "working" }))).toBe(true)
})
