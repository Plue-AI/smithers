import { expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent, waitFor } from "../../state/TestFixtures"

test("confirm.cancel refuses stale and answered revisions and persists cancellation", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} })
  try {
    controller.requestFlowConfirmation("todo.drop", "T12", "drop this TODO")
    const pending = [...store.collections.messages.values()].find(message => message.action?.flow === "todo.drop")!
    const revision = pending.action!.revision!
    const before = store.session().revision
    expect(await controller.cancelConfirmation(pending.id, "stale")).toMatchObject({ refusal: { code: "native_confirm_stale", status: 409 } })
    expect(store.collections.messages.get(pending.id)?.action).toEqual(pending.action)
    expect(store.session().revision).toBe(before)
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision: "stale" }))).toMatchObject({ status: "failed" })
    expect(store.collections.messages.get(pending.id)?.action).toEqual(pending.action)
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision }))).toMatchObject({ status: "executed" })
    expect(store.collections.messages.get(pending.id)?.action).toBeUndefined()
    expect(store.collections.messages.get(pending.id)?.answeredAction).toMatchObject({ revision, answer: "Cancelled" })
    expect(await controller.cancelConfirmation(pending.id, revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    expect(await controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: pending.id, revision }))).toMatchObject({ status: "failed" })
    expect(await controller.cancelConfirmation("missing", revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    await store.dispatch({ type: "message.appended", actor: "system", text: "Old confirmation", action: { flow: "todo.drop", label: "Confirm" } }).isPersisted.promise
    const legacy = [...store.collections.messages.values()].find(message => message.text === "Old confirmation")!
    expect(await controller.cancelConfirmation(legacy.id, revision)).toMatchObject({ refusal: { code: "native_confirm_stale" } })
    expect(store.collections.messages.get(legacy.id)?.action).toEqual(legacy.action)
    const restored = await createAppStore({ kind: "localStorage", storage })
    expect(restored.collections.messages.get(pending.id)?.answeredAction?.answer).toBe("Cancelled")
    expect(restored.collections.messages.get(pending.id)?.action).toBeUndefined()
  } finally { controller.dispose() }
})

test("on an install, Commit on a served confirmation approves it once and Cancel denies another; a stale or answered one is refused", async () => {
  const bootstrap: AppBootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "redirect", sandbox: null }
  const ID = "9b2f6c1e-3a4d-4e5f-8a6b-7c8d9e0f1a2b", OTHER = "0c6a1d2e-4b5f-4a6b-9c7d-8e9f0a1b2c3d"
  const maya = { login: "maya", name: "Maya Chen", avatar_url: PlaceholderAvatarUrl }
  const card = { kind: "one_click", action: { tag: "todo.new", verb: "Commit" }, summary: "Commit Log retry counts", subject: { kind: "todo", ref: "Log retry counts" },
    text: "Count retries per webhook.", asked_by: { kind: "agent", agent: "claude-code", id: "agent-session-5e55", session_id: "5e55", for_member: maya, avatar_url: PlaceholderAvatarUrl, color_index: 0 } }
  const rows = new Map<string, Record<string, unknown>>([ID, OTHER].map(id => [id, { id, state: "pending", created_at: "2026-10-05T08:00:00Z", card }]))
  const posts: { path: string; key: string | null }[] = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://local.test").pathname
    if (path === "/api/confirmations" && init?.method === undefined) return Response.json([...rows.values()])
    const answer = /^\/api\/confirmations\/([^/]+)\/(approve|deny)$/.exec(path)
    if (answer === null || init?.method !== "POST") return new Response("{}", { status: 404 })
    posts.push({ path, key: new Headers(init.headers).get("Idempotency-Key") })
    const approved = answer[2] === "approve"
    const settled = { ...rows.get(answer[1]!), state: approved ? "approved" : "rejected", ...(approved ? { todo: 5 } : {}),
      card: { ...card, receipt: { by: maya, result: approved ? "done" : "cancelled", at: "2026-10-05T08:01:00Z", ...(approved ? { text: "Committed T5" } : {}) } } }
    rows.set(answer[1]!, settled)
    return Response.json(settled, { status: approved ? 202 : 200 })
  })
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl, bootstrap })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  const cancel = (id: string, revision: string) => controller.commands.run("confirm.cancel", JSON.stringify({ confirmation: `confirmation:${id}`, revision }))
  const toasts = () => [...store.collections.toasts.values()].filter(toast => toast.key.startsWith("todo.request.")).map(toast => [toast.title, toast.status, toast.detail])
  const state = (id: string) => controller.confirmations.get().find(row => row.id === id)?.state
  try {
    await waitFor(() => store.collections.cards.has(`confirm:confirmation:${ID}`) && store.collections.cards.has(`confirm:confirmation:${OTHER}`))
    expect(store.collections.cards.get(`confirm:confirmation:${ID}`)).toMatchObject({ kind: "confirm", audience_member_id: "maya", title: "Commit Log retry counts?",
      payload: { id: `confirmation:${ID}` } })
    // The agent's own Commit only asks the person; it never approves.
    expect(await controller.commands.runForAgent("todo.new", JSON.stringify({ confirmation: ID }))).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
    expect(posts).toEqual([])
    expect(await controller.submitCommand({ name: "todo.new", payload: { confirmation: ID }, actor: "user" })).toEqual({ status: "executed", value: "Requested" })
    await waitFor(() => toasts().some(toast => toast[1] === "ok"))
    expect(toasts()).toEqual([["Commit Log retry counts?", "ok", "Committed T5"]])
    expect(posts).toEqual([{ path: `/api/confirmations/${ID}/approve`, key: expect.any(String) }])
    expect(state(ID)).toBe("approved")
    // Answered, its Cancel is stale; so is another's Cancel at a revision it was not asked at.
    expect(await cancel(ID, ID)).toMatchObject({ status: "failed" })
    expect(await cancel(OTHER, "stale")).toMatchObject({ status: "failed" })
    expect(posts).toHaveLength(1)
    expect(await cancel(OTHER, OTHER)).toMatchObject({ status: "executed" })
    await waitFor(() => state(OTHER) === "rejected")
    expect(posts.slice(1)).toEqual([{ path: `/api/confirmations/${OTHER}/deny`, key: expect.any(String) }])
    await waitFor(() => toasts().length === 2 && toasts().every(toast => toast[1] === "ok"))
    expect(toasts()).toContainEqual(["Commit Log retry counts?", "ok", "Cancelled"])
  } finally { controller.dispose() }
})
