import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../ControllerTestScope"
import type { AppServices } from "../AppController"
import { createAppStore as openAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * Threads and tasks through the issues seam (smithers-ui-DESIGN.md §3.1,
 * §3.2): the list narrows to chats and tasks, task metadata reads off the
 * issue DTO, and a chat is created with `--kind chat`. The chat reads and
 * sends themselves belong to the chat = issues seam (#2111).
 */

// One fixture lifetime owns transport, body readers and controller disposal.
const bareStores = new Set<AppStore>()
const retireOwners = new Set<() => void>()
const releases = new Set<() => void>()
const work = new Set<Promise<unknown>>()
const unexpectedHttp: string[] = []
const cleanupErrors: unknown[] = []
let collectingDisposalFailures = false
const settleStore = async (store: AppStore): Promise<void> => {
  if (store.settled === undefined) throw new Error("Issues fixture requires persistence settlement")
  await store.settled()
}
const closeBareStore = async (store: AppStore): Promise<void> => {
  if (store.dispose === undefined) throw new Error("Issues fixture requires store disposal")
  await store.dispose()
}
const checkpoint = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const bounded = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Issues fixture work did not settle")), 5_000)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
const observe = <A>(promise: Promise<A>): Promise<A> => {
  work.add(promise)
  const complete = () => { work.delete(promise) }
  void promise.then(complete, complete)
  return promise
}
const drain = async (): Promise<void> => {
  do {
    await Promise.allSettled([...work])
    await checkpoint()
  } while (work.size !== 0)
}
const flushStore = async (store: AppStore): Promise<void> => {
  await bounded(drain())
  await settleStore(store)
  await checkpoint()
}
const waitUntil = async (condition: () => boolean): Promise<void> => {
  let stopped = false
  try {
    await bounded((async () => { while (!stopped && !condition()) await checkpoint() })())
  } finally { stopped = true }
}
const trackResponse = (response: Response): Response => {
  const json = response.json.bind(response), text = response.text.bind(response), clone = response.clone.bind(response)
  response.json = () => observe(json())
  response.text = () => observe(text())
  response.clone = () => trackResponse(clone())
  return response
}
const createAppStore: typeof openAppStore = async (...args) => {
  const store = await openAppStore(...args)
  bareStores.add(store)
  return store
}
// Abort the public page lifetime before releasing IO; stale work must not publish
// while cleanup drains. The controller remains the sole normal store-close owner.
afterEach(async () => {
  collectingDisposalFailures = true
  const errors: unknown[] = []
  for (const retire of retireOwners) { try { retire() } catch (error) { errors.push(error) } }
  retireOwners.clear()
  for (const release of releases) { try { release() } catch (error) { errors.push(error) } }
  releases.clear()
  try { await bounded(drain()) } catch (error) { errors.push(error) }
  for (const store of bareStores) {
    try { await settleStore(store) } catch (error) { errors.push(error) }
    try { await closeBareStore(store) } catch (error) { errors.push(error) }
  }
  bareStores.clear()
  cleanupErrors.push(...errors)
  // Bun stops later afterEach hooks when one rejects. Delay reporting these
  // failures until scopedControllers has attempted every controller finalizer.
})
const scopedController = scopedControllers()
const controllerLifetimes = new WeakMap<ReturnType<typeof scopedController>, AbortController>()
const createAppController: typeof scopedController = (store, agent, services) => {
  const lifetime = new AbortController()
  retireOwners.add(() => lifetime.abort())
  const controller = scopedController(store, agent, { ...services, pageLifetime: lifetime.signal })
  bareStores.delete(store)
  controllerLifetimes.set(controller, lifetime)
  const dispose = controller.dispose
  Object.defineProperty(controller, "dispose", { value: async () => {
    try { await dispose() }
    catch (error) {
      // Preserve explicit test-time rejection. During teardown, postpone it
      // until scopedControllers has attempted every registered controller.
      if (!collectingDisposalFailures) throw error
      cleanupErrors.push(error)
    }
  } })
  return controller
}
const disposeFixture = async (controller: ReturnType<typeof scopedController>, store: AppStore): Promise<void> => {
  controllerLifetimes.get(controller)?.abort()
  const errors: unknown[] = []
  try { await flushStore(store) } catch (error) { errors.push(error) }
  try { await controller.dispose() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, "Issues fixture disposal failed")
}
afterEach(async () => {
  const errors = cleanupErrors.splice(0)
  const unexpected = unexpectedHttp.splice(0)
  collectingDisposalFailures = false
  if (unexpected.length) errors.push(new Error(`Unplanned issue HTTP: ${unexpected.join(", ")}`))
  if (errors.length) throw new AggregateError(errors, "Issues store cleanup failed")
})

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: (key) => void data.delete(key) }
}
const unavailableAgent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
type RouteAnswer = Response | ((request: Request) => Response | Promise<Response>)
// Explicit absent optional/startup resources for these repositories. No other
// request is silently converted to a valid fixture refusal.
const absentRoutes = new Set([
  "GET /api/repository-setup/state",
  "GET /api/repos/will/flows/contents/.smithers/factory.json",
  "GET /api/repos/will/flows/home",
  "GET /api/repos/smithersai/smithers/contents/.smithers/factory.json",
  "GET /api/repos/smithersai/smithers/home",
  "GET /api/user/github-repos/will/flows/issues",
  "GET /api/repos/will/flows/issue-views",
  "GET /api/repos/will/flows/issues/8/sync",
  "GET /api/repos/will/flows/issues/10/sync",
  "GET /api/repos/will/flows/issues/8/comments/31/reactions",
  "GET /api/repos/will/flows/issues/8/comments/32/reactions",
  "GET /api/repos/will/flows/issues/8/comments/41/reactions",
  "GET /api/repos/will/flows/issues/8/comments/42/reactions"
])
const backend = (routes: Record<string, RouteAnswer>, calls: Array<{ line: string; body?: unknown }> = []): AppServices => ({
  fetchImpl: (input, init) => observe((async () => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
    calls.push({ line: `${method} ${absolute.pathname}${absolute.search}`, ...(body === undefined ? {} : { body }) })
    for (const [route, answer] of Object.entries(routes)) {
      const space = route.indexOf(" ")
      if (route.slice(0, space) !== method || absolute.pathname !== route.slice(space + 1)) continue
      return trackResponse(typeof answer === "function" ? await answer(new Request(absolute.toString(), init)) : answer.clone())
    }
    if (!absentRoutes.has(`${method} ${absolute.pathname}`)) unexpectedHttp.push(`${method} ${absolute.pathname}`)
    return trackResponse(json(404, { status: "error", message: `no stub for ${method} ${absolute.pathname}` }))
  })())
})
const settled = checkpoint
const signedIn = async (store: AppStore): Promise<void> => {
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/flows", org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
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
        { number: 8, title: "Land the fence", state: "fixed", owner: { id: 2, login: "engineer" }, due: "2026-10-01", priority: 1, parent: { number: 5, title: "Fences" }, fixed_by: { login: "engineer" }, author: { login: "will" }, labels: [], updated_at: "2026-09-26T08:00:00Z" },
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
    expect(list.payload.issues[0]!.task).toEqual({ owner: { id: "engineer", name: "engineer" }, due: "2026-10-01", priority: 1, parent: { number: 5, title: "Fences" }, fixedBy: { id: "engineer", name: "engineer" } })
    expect(list.payload.issues[1]!.task).toBeUndefined()
    await controller.commands.run("issues.list", `all --kind conversation ${REPO}`)
    expect(calls.some((call) => call.line === "GET /api/repos/will/flows/issues?kind=chat")).toBe(true)
    const created = await controller.commands.run("issues.create", `Ask the assistant ${REPO} --kind conversation`)
    expect(created.status).toBe("executed")
    const post = calls.find((call) => call.line === "POST /api/repos/will/flows/issues")!
    expect(post.body).toMatchObject({ title: "Ask the assistant", kind: "chat" })
    await disposeFixture(controller, store)
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
  fixed_by: null, fixed_at: null, verified_by: null, verified_at: null, owner: null, due: null, priority: null, parent: null, created_at: at, updated_at: at
}
const commentDto = (id: number, body: string, extra: Record<string, unknown>) =>
  ({ id, issue_id: 700, user_id: 1, commenter: "will", body, type: "issue_comment", created_at: at, updated_at: at, ...extra })

describe("a conversation on the chat = issues contract", () => {
  test("reads kind and visibility, persona comments, the sync mapping and reactions off the backend's DTOs; a message posts with its request id as the key and a refusal stays retryable and says what failed and whose fault it was", async () => {
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
    // A message: acknowledged at once, posted with its request id as the idempotency key; the refusal keeps the row failed with what failed and whose fault it was, never the server's words.
    expect(await controller.commentOnIssue(7, "Ship it.", REPO)).toEqual({ value: "Requested" })
    await settled()
    await waitUntil(() => calls.some((call) => call.line === "POST /api/repos/will/flows/issues/7/comments"))
    const post = calls.find((call) => call.line === "POST /api/repos/will/flows/issues/7/comments")
    expect(post?.body).toMatchObject({ body: "Ship it." })
    const key = (post?.body as { idempotency_key?: string } | undefined)?.idempotency_key
    expect(typeof key).toBe("string")
    await waitUntil(() => {
      const current = store.collections.cards.get(`issue-${REPO}-7`)
      return current?.kind === "issue" && current.payload.pendingComments?.[0]?.status === "failed"
    })
    await flushStore(store)
    const live = store.collections.cards.get(`issue-${REPO}-7`)
    if (live?.kind !== "issue") throw new Error("the conversation card is absent")
    expect(live.payload.pendingComments).toMatchObject([{ id: key, text: "Ship it.", status: "failed", error: "Posting the message failed (503). Something on Smithers' side failed. Not your fault, and nothing your request could have changed." }])
    expect(live.payload.pendingComments?.[0]?.error).not.toContain("the mirror is down")
    await controller.dispose()
  })
})

/*
 * issues.set (#2186): one flow sets an issue's owner, due date, priority or
 * parent through PATCH /issues/{n} with the value the backend stores; an
 * empty value clears the field, and a malformed number never leaves the app.
 */
describe("issues.set stores intent metadata on the issue", () => {
  const setup = async (patch: RouteAnswer) => {
    const calls: Array<{ line: string; body?: unknown }> = []
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, backend({
      "PATCH /api/repos/will/flows/issues/7": patch,
      "GET /api/repos/will/flows/issues/7": json(200, { ...issueDto, kind: "issue", priority: 2, owner: { id: 2, login: "engineer" }, due: "2026-10-01", parent: { number: 5, title: "Fences" } }),
      "GET /api/repos/will/flows/issues/7/comments": json(200, []),
      "GET /api/repos/will/flows/issues/7/sync": json(404, { message: "not found" })
    }, calls))
    await signedIn(store)
    return { calls, store, controller }
  }
  const run = (controller: Awaited<ReturnType<typeof setup>>["controller"], field: string, value: string) =>
    controller.commands.run("issues.set", JSON.stringify({ number: 7, field, value, repo: REPO }))
  const patches = (calls: Array<{ line: string; body?: unknown }>) => calls.filter((call) => call.line.startsWith("PATCH ")).map((call) => call.body)

  test("sends each field in the type the backend stores, clears on empty, and shows the stored values", async () => {
    const { calls, store, controller } = await setup(json(200, issueDto))
    for (const [field, value] of [["owner", "engineer"], ["due", "2026-10-01"], ["priority", "P2"], ["parent", "#5"], ["priority", "0"], ["owner", " "]] as const) {
      expect((await run(controller, field, value)).status).toBe("executed")
    }
    expect(patches(calls)).toEqual([{ owner: "engineer" }, { due: "2026-10-01" }, { priority: 2 }, { parent: 5 }, { priority: 0 }, { owner: null }])
    const card = [...store.collections.cards.values()].find((entry) => entry.kind === "issue")
    if (card?.kind !== "issue") throw new Error("the issue card is absent")
    expect(card.payload.task).toMatchObject({ owner: { id: "engineer" }, due: "2026-10-01", priority: 2, parent: { number: 5, title: "Fences" } })
    await controller.dispose()
  })

  test("a malformed priority or parent is refused before any request", async () => {
    const { calls, controller } = await setup(json(200, issueDto))
    for (const [field, value] of [["priority", "4"], ["priority", "high"], ["priority", "-1"], ["parent", "0"], ["parent", "five"]] as const) {
      const result = await run(controller, field, value)
      expect(JSON.stringify(result)).toContain(field === "priority" ? "Priority is 0 to 3" : "Parent is an issue number")
    }
    expect(patches(calls)).toEqual([])
    await controller.dispose()
  })

  test("the backend's refusal is reported in its words and nothing claims the value was set", async () => {
    const { controller } = await setup(json(422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "parent", code: "cycle" }] }))
    const result = await run(controller, "parent", "5")
    expect(JSON.stringify(result)).not.toContain("parent set")
    await controller.dispose()
  })
})
