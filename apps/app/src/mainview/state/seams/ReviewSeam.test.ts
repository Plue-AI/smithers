import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import { payloadFor } from "../../flows/SlashPayload"
import { createReviewSeam } from "./ReviewSeam"
import type { SeamContext } from "./SeamContext"

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const change = {
  repo: "owner/repo", changeId: "review-50", description: "Review", commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  currentSeq: null, revisionCount: null, revisions: [], authorName: null, timestamp: null, repos: [], diff: null,
  checks: null, findings: [{ analyzer: "review", severity: "fix", path: "src/cache.ts", line: 20, summary: "Off by one", raisedAtSeq: null }],
  reviews: null, threads: null, conflicts: null, stack: null, changeset: null
}
const harness = async (http: SeamContext["http"], storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  let disposed = false
  const settled: unknown[] = []
  const ctx: SeamContext = { http, store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => disposed,
    withToast: async (_key, _title, _done, work) => { const result = await work(); settled.push(result); return result } }
  return { store, ctx, settled, storage, close: () => { disposed = true } }
}

test("review returns before launch and completion, deduplicates, then renders retained findings", async () => {
  const launch = deferred<Response>(), observation = deferred<Response>()
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness(async (url, init) => { calls.push({ url, init }); return init?.method === "POST" ? launch.promise : calls.length === 2 ? Response.json({ state: "dispatching" }) : observation.promise })
  const seam = createReviewSeam(h.ctx, 1)
  expect(await seam.request(50, "owner/repo")).toEqual({ value: "Requested" })
  expect(await seam.request(50, "owner/repo")).toEqual({ value: "Requested" })
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ number: 50, repo: "owner/repo", conversation: "main" })
  expect(h.store.session().reviewRequests?.[0]?.state).toBe("requested")
  expect(h.settled).toEqual([])
  launch.resolve(Response.json({ operationId: "review-op", state: "accepted" }, { status: 202 }))
  await waitFor(() => calls.length === 2)
  expect(h.store.session().reviewRequests?.[0]?.state).toBe("running")
  expect(h.settled).toEqual([])
  await waitFor(() => calls.length === 3)
  expect(h.settled).toEqual([])
  expect(h.store.session().reviewRequests?.[0]?.state).toBe("running")
  observation.resolve(Response.json({ state: "completed", change }))
  await waitFor(() => h.store.session().reviewRequests?.[0]?.state === "completed")
  const card = h.store.collections.cards.get("review-review-op")
  expect(card?.tabId).toBeUndefined()
  expect(card?.kind === "change" && card.payload.findings?.[0]).toMatchObject({ path: "src/cache.ts", line: 20, severity: "fix" })
  await waitFor(() => h.settled.length === 1)
  h.close(); await h.store.dispose?.()
})

// Run 12: `/review #2` sent the local frame branch "branch-main", which the
// install does not know, and every review answered 503 "Review unavailable".
test("review names the conversation every other door names", async () => {
  const sent: unknown[] = []
  const h = await harness(async (_url, init) => {
    if (init?.method === "POST") sent.push(JSON.parse(init.body as string).conversation)
    return Response.json({ operationId: `op-${sent.length}`, state: "accepted" }, { status: 202 })
  })
  const seam = createReviewSeam(h.ctx, 60_000)
  expect(h.store.session().activeBranchId).toBe("branch-main")
  await seam.request(2, "owner/repo")
  await h.store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { owner: "ben", open: true, selected_branch: "todo-12", nodes: [] } }).isPersisted.promise
  await seam.request(3, "owner/repo")
  await h.store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { owner: "alice", open: true, selected_branch: "todo-13", nodes: [] } }).isPersisted.promise
  await seam.request(4, "owner/repo")
  await waitFor(() => sent.length === 3)
  expect(sent).toEqual(["main", "todo-12", "main"])
  h.close(); await h.store.dispose?.()
})

test("reload reconnects the persisted operation without another launch", async () => {
  const observation = deferred<Response>()
  const h = await harness(async (_url, init) => init?.method ? Response.json({ operationId: "recovered", state: "accepted" }, { status: 202 }) : observation.promise)
  const seam = createReviewSeam(h.ctx, 1)
  await seam.request(50, "owner/repo")
  await waitFor(() => h.store.session().reviewRequests?.[0]?.state === "running")
  h.close(); await h.store.dispose?.()
  const calls: (RequestInit | undefined)[] = []
  const recovered = await harness(async (_url, init) => { calls.push(init); return Response.json({ state: "completed", change }) }, h.storage)
  createReviewSeam(recovered.ctx, 1)
  await waitFor(() => recovered.store.session().reviewRequests?.[0]?.state === "completed")
  expect(calls).toEqual([undefined])
  observation.resolve(Response.json({ state: "completed", change }))
  recovered.close(); await recovered.store.dispose?.()
})

test("host refusal remains visible and retryable; an agent cannot bypass Confirm", async () => {
  let calls = 0
  const h = await harness(async () => { calls++; return Response.json({ error: { class: "permission", code: "permission", message: "PR author is not a member" } }, { status: 403 }) })
  const agent = createReviewSeam({ ...h.ctx, actor: () => "smithers" }, 1)
  expect(await agent.request(51, "owner/repo")).toBe("Confirm review.")
  expect(calls).toBe(0)
  const seam = createReviewSeam(h.ctx, 1)
  await seam.request(51, "owner/repo")
  await waitFor(() => h.settled.length === 1)
  expect(h.store.session().reviewRequests?.[0]?.state).toBe("failed")
  expect(String(h.settled[0])).toContain("PR author is not a member")
  await seam.request(51, "owner/repo")
  await waitFor(() => h.settled.length === 2)
  expect(calls).toBe(2)
  h.close(); await h.store.dispose?.()
})

test("an account change ignores a stale launch response", async () => {
  const launch = deferred<Response>()
  const h = await harness(async () => launch.promise)
  const seam = createReviewSeam(h.ctx, 1)
  await seam.request(50, "owner/repo")
  await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  launch.resolve(Response.json({ operationId: "stale", state: "accepted" }, { status: 202 }))
  await waitFor(() => h.settled.length === 1)
  expect(h.store.session().reviewRequests?.[0]?.operationId).toBeUndefined()
  expect([...h.store.collections.cards.values()]).toEqual([])
  h.close(); await h.store.dispose?.()
})


test("the canonical review command accepts the specified #PR spelling", () => {
  for (const door of ["review"]) {
    expect(payloadFor(door, "#50 owner/repo")).toEqual({ payload: { number: 50, repo: "owner/repo" } })
  }
})

test("an approved Review resumes the admitted operation and its confirmation toast without another launch", async () => {
  const observation = deferred<Response>(), calls: string[] = [], notices: string[] = []
  const h = await harness(async (url, init) => {
    expect(init?.method).not.toBe("POST")
    calls.push(url)
    return observation.promise
  })
  const seam = createReviewSeam({ ...h.ctx, withToast: async (key, ...args) => { notices.push(key); return h.ctx.withToast!(key, ...args) } }, 1)
  const { fixtures } = await import("@smthrs/rpc/fixtures/Confirm")
  const { MemberConfirmationSchema } = await import("@smthrs/rpc/ConfirmCard")
  const row = MemberConfirmationSchema.parse({ id: "10000000-0000-4000-8000-000000000001", command: "review", state: "approved", revision: "pinned-review",
    expires_at: "2099-01-01T00:00:00Z", payload: { input: { number: 50, repo: "owner/repo", conversation: "main" },
      card: { ...fixtures.one_click.model, action: { tag: "review", verb: "Review" } }, effect: { review: "review-op", request: "confirmation:10000000-0000-4000-8000-000000000001" } } })
  await seam.observeConfirmation(row)
  await seam.observeConfirmation(row)
  expect(calls).toEqual(["/api/reviews/review-op"])
  expect(notices).toEqual(["todo.request.confirmation:10000000-0000-4000-8000-000000000001"])
  expect(h.settled).toEqual([])
  expect(h.store.session().reviewRequests?.[0]).toMatchObject({ operationId: "review-op", state: "running", confirmationId: row.id })
  observation.resolve(Response.json({ state: "completed", change }))
  await waitFor(() => h.store.session().reviewRequests?.[0]?.state === "completed")
  await waitFor(() => h.settled.length === 1)
  await seam.observeConfirmation(row)
  expect(calls).toHaveLength(1)
  expect(h.store.collections.cards.get("review-review-op")?.kind).toBe("change")
  h.close()
})
