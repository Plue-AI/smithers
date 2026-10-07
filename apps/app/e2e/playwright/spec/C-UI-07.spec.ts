import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// HTTP-contract regression only. C-UI-07-native.spec.ts supplies acceptance
// through PostgreSQL, the packaged host and the native repository store.
test("Context HTTP contract: shared prompt opens four pinned sources and Inspect", async ({ page }) => {
  await owner(page)
  await page.route("**/api/bootstrap", route => route.fulfill({ json: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  const revision = "0123456789abcdef0123456789abcdef01234567"
  const context = [
    { kind: "file", label: "retry.ts", ref: "src/webhooks/retry.ts", revision, reason: "Retry implementation" },
    { kind: "page", label: "Retries", ref: "retries", revision: "4", reason: "Retry policy" },
    { kind: "todo", label: "T24", ref: "T24", revision: "1", reason: "Retry work" },
    { kind: "run", label: "Retry run", ref: "context-run", revision: "1", reason: "Retry evidence" }
  ]
  let accepted = false
  const prompts: unknown[] = []
  await page.route("**/api/conversations/main/prompt", route => {
    prompts.push(route.request().postDataJSON()); accepted = true
    return route.fulfill({ status: 202, json: { status: "accepted", turnId: "context-turn", terminal: false } })
  })
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: accepted ? [{
    id: "context-turn", author: 1, authorLogin: "ben", runId: "context-run", prompt: "Where do we retry webhooks?", state: "completed", context, preflight: { context, candidates: context.map(({reason, ...item}) => item), model: "owner-fast", durationMs: 12 },
    frames: [{ runId: "context-run", type: "delta", kind: "text", text: "Retries three times." }, { runId: "context-run", type: "done", reason: "stop" }]
  }] : [] } }))
  await page.route(`**/api/branches/main/files/src/webhooks/retry.ts?at=${revision}`, route => route.fulfill({ json: {
    branch: "main", path: "src/webhooks/retry.ts", language: "typescript", digest: "literal-retry", content: { kind: "text", text: "export const retry = 3" }, mode: "read_only", diagnostics: [], authors: [], editors: []
  } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/navigation/index?*", route => route.fulfill({ json: { pages: [{
    id: 42, slug: "retries", title: "Retries", path: "Retries.md", revision: 9, author: { id: 1, login: "alice" }, created_at: "2026-10-01", updated_at: "2026-10-06", metadata: {}
  }] } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/history/42/4/content?*", route => route.fulfill({ contentType: "text/markdown", body: "# Retries\n\nRetry three times." }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: {
    n: 24, title: "Retry from the install", state: "working",
    owner: { login: "canary-owner", name: "Ben", avatar_url: "https://example.test/avatar.png" },
    branch: { id: "b-live", name: "smithers/retry-webhooks", machine: { state: "asleep" } },
    prompt_revisions: [], steps: [], steers: [], evidence: [], present: [], waits: [],
    merge: { state: "waiting", reason: "attention", on_github: false }
  } }))
  let legacy = 0, wakes = 0
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/(agent|chat)\/turn$/.test(new URL(request.url()).pathname)) legacy++
    if (/\/wake(?:\?|$)/.test(request.url())) wakes++
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).press("Enter")
  const composer = page.getByTestId("composer-input")
  await composer.fill("Where do we retry webhooks?"); await composer.press("Enter")
  const disclosure = page.getByRole("button", { name: "Context · 4", exact: true })
  await expect(disclosure).toBeVisible()
  await composer.press("Escape"); await disclosure.press("Enter")
  const file = page.locator('.context-chip[data-flow="file"]')
  await expect(file).toHaveAttribute("title", `src/webhooks/retry.ts · ${revision} · Retry implementation`)
  await file.press("Enter")
  await expect(page.locator('.smithers-card').last()).toContainText("export const retry = 3")
  const wiki = page.locator('.context-chip[data-flow="wiki.page"]')
  await wiki.click()
  await expect(page.getByTestId("wiki-pinned-content")).toHaveAttribute("data-revision", "4")
  await page.locator('.context-chip[data-flow="todo"]').press("Space")
  await expect(page.getByRole("article", { name: "TODO T24", exact: true })).toContainText("Retry from the install")
  await page.locator('.context-chip[data-flow="run.inspect"]').press("Enter")
  const monitor = page.locator('.mvp-run[data-maximized]')
  await expect(monitor).toBeVisible()
  await expect(monitor.locator(".mvp-run-step-head").first()).toHaveText("Preflight")
  await expect(monitor).toContainText("owner-fast")
  await expect(monitor).toContainText("Retry implementation")
  await page.getByTestId("card-run:context-run").locator('[data-flow="card.minimize"]').click()
  await page.locator('[data-shared-turn="context-turn"]').getByRole("button", { name: "Inspect", exact: true }).click()
  await expect(monitor).toContainText("Retry policy")
  await page.reload()
  await expect(monitor).toContainText("Retry implementation")
  await disclosure.press("Enter")
  await expect(file).toBeVisible(); await expect(wiki).toBeVisible()
  expect(prompts).toEqual([{ prompt: "Where do we retry webhooks?", idempotencyKey: expect.any(String) }])
  expect(legacy).toBe(0); expect(wakes).toBe(0)
})
