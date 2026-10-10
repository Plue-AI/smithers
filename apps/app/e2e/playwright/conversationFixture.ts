import type { ContextItem } from "@smthrs/rpc/CardPrimitives"
import type { Page } from "@playwright/test"
import { installCloudFixture } from "./cloudFixture"
import { SCOPED_TEST_USER } from "./identity"

/** Producer-shaped shared conversation for Chat interaction tests. */
export async function installConversationFixture(page: Page, options: { readonly context?: readonly ContextItem[]; readonly model?: string; readonly holdFirstTurn?: Promise<void> } = {}) {
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  await page.route("**/api/members", route => route.fulfill({ json: { members: [{ login: SCOPED_TEST_USER.login, name: SCOPED_TEST_USER.login, avatar_url: "https://example.test/member.png", role: "member", color_index: 0, needs_access: false, suspended: false, actions: [] }], access_url: "https://github.com/smithersai/smithers/settings/access" } }))
  const entries: Array<Record<string, unknown>> = []
  let active = false
  const queued: Array<{id: string; prompt: string}> = []
  const admitted = new Map<string, Record<string, unknown>>()
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: queued } }))
  await page.route("**/api/conversations/main/prompt", route => {
    const { prompt, idempotencyKey } = route.request().postDataJSON()
    if (typeof prompt !== "string" || typeof idempotencyKey !== "string") throw new Error("Invalid shared prompt")
    // A repeated key replays its turn, as the server does; a reload can re-send it (#3780).
    const replay = admitted.get(idempotencyKey)
    if (replay) return route.fulfill({ status: 202, json: { turnId: replay.id, terminal: replay.state !== "running" && replay.state !== "accepted" } })
    const id = `chat-${entries.length}`
    const entry = { id, author: 1, authorLogin: SCOPED_TEST_USER.login, runId: id, prompt, state: "completed", ...(options.context ? { context: options.context, preflight: { context: options.context, candidates: options.context.map(({ reason, ...item }) => item), model: options.model ?? "owner-fast", durationMs: 12 } } : {}), frames: [
      { runId: id, type: "delta", kind: "text", text: `stub: ${prompt}` }, { runId: id, type: "done", reason: "stop" }
    ] }
    entries.push(entry); admitted.set(idempotencyKey, entry)
    if (options.holdFirstTurn && entries.length === 1) {
      active = true; entry.state = "running"; entry.frames = []
      void options.holdFirstTurn.then(() => {
        active = false; queued.splice(0)
        for (const turn of entries) { turn.state = "completed"; turn.frames = [{ runId: turn.runId, type: "delta", kind: "text", text: `stub: ${turn.prompt}` }, { runId: turn.runId, type: "done", reason: "stop" }] }
      })
    } else if (active) { entry.state = "accepted"; entry.frames = []; queued.push({ id, prompt }) }
    return route.fulfill({ status: 202, json: { turnId: id, terminal: !active } })
  })
}
