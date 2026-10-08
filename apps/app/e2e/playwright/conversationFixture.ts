import type { Page } from "@playwright/test"
import { installCloudFixture } from "./cloudFixture"
import { SCOPED_TEST_USER } from "./identity"

/** Producer-shaped shared conversation for Chat interaction tests. */
export async function installConversationFixture(page: Page) {
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  const entries: unknown[] = []
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/conversations/main/prompt", route => {
    const { prompt, idempotencyKey } = route.request().postDataJSON()
    if (typeof prompt !== "string" || typeof idempotencyKey !== "string") throw new Error("Invalid shared prompt")
    const id = `chat-${entries.length}`
    entries.push({ id, author: 1, authorLogin: SCOPED_TEST_USER.login, runId: id, prompt, state: "completed", frames: [
      { runId: id, type: "delta", kind: "text", text: `stub: ${prompt}` }, { runId: id, type: "done", reason: "stop" }
    ] })
    return route.fulfill({ status: 202, json: { turnId: id, terminal: true } })
  })
}
