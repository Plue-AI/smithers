import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * Threads and tasks through the issues seam (smithers-ui-DESIGN.md §3.1,
 * §3.2): the list narrows to chats and tasks, task metadata reads off the
 * issue DTO, and a chat is created with `--kind chat`. The chat reads and
 * sends themselves belong to the chat = issues seam (#2111).
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const unavailableAgent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
type RouteAnswer = Response | ((request: Request) => Response | Promise<Response>)
const backend = (routes: Record<string, RouteAnswer>, calls: Array<{ line: string; body?: unknown }> = []): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
    calls.push({ line: `${method} ${absolute.pathname}${absolute.search}`, ...(body === undefined ? {} : { body }) })
    for (const [route, answer] of Object.entries(routes)) {
      const space = route.indexOf(" ")
      if (route.slice(0, space) !== method || absolute.pathname !== route.slice(space + 1)) continue
      return typeof answer === "function" ? answer(new Request(absolute.toString(), init)) : answer.clone()
    }
    return json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` })
  }
})
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }] })
  await settled()
}
const REPO = "will/flows"
const chatIssue = { number: 7, title: "Owner ↔ Assistant", state: "open", kind: "chat", visibility: "private", body: "", author: { login: "will" }, labels: [], created_at: "2026-09-26T09:00:00Z", updated_at: "2026-09-26T09:05:00Z" }

describe("conversations and issues through the issues seam", () => {
  test("issues.list narrows to conversations or issues; a conversation is created with --kind conversation", async () => {
    const calls: Array<{ line: string; body?: unknown }> = []
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, backend({
      "GET /api/repos/will/flows/issues": json(200, [
        chatIssue,
        { number: 8, title: "Land the fence", state: "fixed", fixed_by: { login: "engineer" }, author: { login: "will" }, labels: [], updated_at: "2026-09-26T08:00:00Z" },
        { number: 9, title: "Plain issue", state: "open", author: { login: "will" }, labels: [], updated_at: "2026-09-25T08:00:00Z" }
      ]),
      "POST /api/repos/will/flows/issues": json(201, { ...chatIssue, number: 10 }),
      "GET /api/repos/will/flows/issues/10": json(200, { ...chatIssue, number: 10 }),
      "GET /api/repos/will/flows/issues/10/comments": json(200, [])
    }, calls))
    await signedIn(store)
    const tasks = await controller.commands.run("issues.list", `all --kind issue ${REPO}`)
    expect(tasks.status).toBe("executed")
    const found = [...store.collections.cards.values()].find((card) => card.kind === "issue-list")
    if (found?.kind !== "issue-list") throw new Error("the issue list card is absent")
    const list = found
    expect(list.payload.kind).toBe("issue")
    expect(list.payload.issues.map((issue) => issue.number)).toEqual([8, 9])
    expect(list.payload.issues[0]!.task).toEqual({ fixedBy: { id: "engineer", name: "engineer" } })
    await controller.commands.run("issues.list", `all --kind conversation ${REPO}`)
    expect(calls.some((call) => call.line === "GET /api/repos/will/flows/issues?kind=chat")).toBe(true)
    const created = await controller.commands.run("issues.create", `Ask the assistant ${REPO} --kind conversation`)
    expect(created.status).toBe("executed")
    const post = calls.find((call) => call.line === "POST /api/repos/will/flows/issues")!
    expect(post.body).toMatchObject({ title: "Ask the assistant", kind: "chat" })
    await controller.dispose()
  })
})

/*
 * The chat = issues contract (#2111), read through the backend's own DTOs:
 * services.IssueResponse (`kind`, `visibility`, `idempotency_key`),
 * services.IssueCommentResponse (`persona` {username, iconEmoji|iconUrl},
 * `commenter`, `type`, `idempotency_key`), the `/sync` mapping row and
 * services.IssueReaction. Field names here are the Go struct tags.
 */
const at = "2026-09-26T09:05:00Z"
const issueDto = {
  idempotency_key: "thread-request", kind: "chat", visibility: "private", id: 700, number: 7, title: "Owner ↔ Assistant", body: "", state: "open",
  author: { id: 1, login: "will" }, assignees: [], labels: [], linear: null, milestone_id: null, comment_count: 2, closed_at: null,
  fixed_by: null, fixed_at: null, verified_by: null, verified_at: null, created_at: at, updated_at: at
}
const commentDto = (id: number, body: string, extra: Record<string, unknown>) =>
  ({ id, issue_id: 700, user_id: 1, commenter: "will", body, type: "issue_comment", created_at: at, updated_at: at, ...extra })

describe("a conversation on the chat = issues contract", () => {
  test("reads kind and visibility, persona comments, the sync mapping and reactions off the backend's DTOs; a message posts with its request id as the key and a refusal stays retryable in the server's words", async () => {
    const calls: Array<{ line: string; body?: unknown }> = []
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, backend({
      "GET /api/repos/will/flows/issues/7": json(200, issueDto),
      "GET /api/repos/will/flows/issues/7/comments": json(200, [
        commentDto(31, "Taking it.", { idempotency_key: "dispatch:step", persona: { username: "engineering", iconEmoji: ":hammer:" } }),
        commentDto(32, "from Slack", { commenter: "U0HUMAN", persona: { username: "" } })
      ]),
      "GET /api/repos/will/flows/issues/7/sync": json(200, {
        provider: "slack", connection_id: "slack-main", scope_id: "T0123", conversation_id: "C0123", thread_id: "1700000000.000100", external_user_id: "", state: "synced", error: ""
      }),
      "GET /api/repos/will/flows/issues/7/comments/31/reactions": json(200, [{ name: "eyes", actor: "will", active: true }, { name: "eyes", actor: "U0HUMAN", active: false }]),
      "GET /api/repos/will/flows/issues/7/comments/32/reactions": json(200, []),
      "POST /api/repos/will/flows/issues/7/comments": json(503, { status: "error", message: "the mirror is down" })
    }, calls))
    await signedIn(store)
    expect((await controller.commands.run("issues.view", `7 ${REPO}`)).status).toBe("executed")
    const card = store.collections.cards.get(`issue-${REPO}-7`)
    if (card?.kind !== "issue") throw new Error("the conversation card is absent")
    expect(card.title).toBe("Owner ↔ Assistant")
    expect(card.payload).toMatchObject({ kind: "chat", visibility: "private", number: 7, author: "will", state: "open" })
    expect(card.payload.comments).toEqual([
      { id: 31, idempotencyKey: "dispatch:step", persona: { username: "engineering", iconEmoji: ":hammer:" }, author: "will", commentBody: "Taking it.", createdAt: at,
        reactions: [{ name: "eyes", actor: "will", active: true }, { name: "eyes", actor: "U0HUMAN", active: false }] },
      // An empty persona is no persona: the external commenter is the author, as the mirror recorded it.
      { id: 32, author: "U0HUMAN", commentBody: "from Slack", createdAt: at, reactions: [] }
    ])
    expect(card.payload.sync).toEqual({ provider: "slack", connectionId: "slack-main", scopeId: "T0123", conversationId: "C0123", threadId: "1700000000.000100", state: "synced", error: "" })
    // A message: acknowledged at once, posted with its request id as the idempotency key; the refusal keeps the row failed in the server's words.
    expect(await controller.commentOnIssue(7, "Ship it.", REPO)).toEqual({ value: "Requested" })
    await settled()
    for (let attempt = 0; attempt < 40 && !calls.some((call) => call.line === "POST /api/repos/will/flows/issues/7/comments"); attempt++) await settled()
    const post = calls.find((call) => call.line === "POST /api/repos/will/flows/issues/7/comments")
    expect(post?.body).toMatchObject({ body: "Ship it." })
    const key = (post?.body as { idempotency_key?: string } | undefined)?.idempotency_key
    expect(typeof key).toBe("string")
    for (let attempt = 0; attempt < 40; attempt++) {
      const live = store.collections.cards.get(`issue-${REPO}-7`)
      if (live?.kind === "issue" && live.payload.pendingComments?.[0]?.status === "failed") break
      await settled()
    }
    const live = store.collections.cards.get(`issue-${REPO}-7`)
    if (live?.kind !== "issue") throw new Error("the conversation card is absent")
    expect(live.payload.pendingComments).toMatchObject([{ id: key, text: "Ship it.", status: "failed", error: expect.stringContaining("the mirror is down") }])
    await controller.dispose()
  })
})
