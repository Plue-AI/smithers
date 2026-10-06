import { expect, test } from "./browserTest"
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
})

test("composer admits in the background and reconnects the same host turn after reload", async ({ page }) => {
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
  await page.reload()
  await expect(page.locator('[data-shared-turn="host-turn"]')).toHaveAttribute("data-state", "running")
  completed = true
  await expect(page.locator('[data-shared-turn="host-turn"]')).toContainText("Host completed once")
  expect(requests).toHaveLength(1)
  expect(legacy).toBe(0)
})
