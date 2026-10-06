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
