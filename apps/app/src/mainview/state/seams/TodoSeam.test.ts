import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { TodoContainer } from "../../cards/TodoCard"
import { TodoView } from "../../cards/views/TodoView"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, waitFor } from "../TestFixtures"
import type { SeamContext } from "./SeamContext"
import { createTodoSeam, type DraftEntry, type TodoEntry, type TodoReceipt, type TodoTopics, type TodoSeamOptions } from "./TodoSeam"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { fixtures } from "../../../../../../packages/rpc/test/fixtures/Todo"
import { fixtures as confirms } from "@smthrs/rpc/fixtures/Confirm"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import { draftCard, todoCard } from "@smthrs/rpc/TodoCommands"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"

const json = (body: unknown, status = 202) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const harness = async (http: SeamContext["http"], storage = memoryStorage(), actors?: TodoSeamOptions["actors"], live = true, openSource?: TodoSeamOptions["openSource"], draftIssue?: TodoSeamOptions["draftIssue"], listed?: readonly TodoCard[]) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const observed = new Map<string, (model: unknown, receipts?: readonly TodoReceipt[]) => void>()
  let disposed = false
  const finalizers: (() => void)[] = []
  const topics: TodoTopics = { subscribe: (topic, receive) => { observed.set(topic, receive); return () => { observed.delete(topic) } } }
  const outcomes: unknown[] = []
  const reports: { scope: string; error: unknown }[] = []
  const context: SeamContext = {
    http: (url, init) => url.endsWith("/api/todos") && !init?.method
      ? Promise.resolve(json(listed ?? [fixtures.in_review.model, fixtures.merged.model, fixtures.dropped.model], 200)) : http(url, init), store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
    report: (scope, error) => { reports.push({ scope, error }) },
    isDisposed: () => disposed,
    resolveToast: (key, outcome) => { outcomes.push({ key, ...outcome }); store.dispatch({ type: "toast.resolved", actor: "system", key, status: outcome.status, detail: outcome.detail }) }
  }
  const seam = createTodoSeam(context, { draftIssue, openSource, actors, topics: live ? topics : undefined, debounceMs: 1, onDispose: fn => finalizers.push(fn) })
  return { store, seam, observed, outcomes, reports, context, storage,
    draft: () => [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry,
    todo: () => store.collections.cards.get("todo:12") as TodoEntry,
    close: () => { disposed = true; finalizers.forEach(fn => fn()) } }
}

describe("TodoSeam — admission and live completion", () => {
  test("a live model received before admission populates the new card and settles its Draft", async () => {
    const admission = deferred<Response>()
    const h = await harness(() => admission.promise)
    const leave = h.seam.list.subscribe(() => {})
    try {
      await waitFor(() => h.observed.has("todo:12"))
      const outcomes = [...h.outcomes]
      const model = fixtures.queued.model
      await h.seam.newTodo({ title: model.title, text: model.prompt_revisions[0]!.text })
      await h.seam.newTodo({ cardId: h.draft().id, text: "" })
      h.observed.get("todo:12")!(model)
      expect(h.todo()).toBeUndefined()
      expect(h.draft().payload.committed).toBeUndefined()
      admission.resolve(json({ state: "accepted", n: 12 }))
      await waitFor(() => h.draft().payload.committed?.n === 12)
      expect(h.todo().payload.model).toEqual(model)
      expect(h.draft().payload.private).toBe(false)
      expect(h.outcomes).toEqual(outcomes)
      expect(h.reports).toEqual([])
    } finally { leave(); h.close() }
  })
  test("an approved Drop recovers progress without resending the action, and settles only from its TODO", async () => {
    const calls: RequestInit[] = []
    const storage = memoryStorage()
    const row: MemberConfirmation = { id: "10000000-0000-4000-8000-000000000001", command: "todo.drop", state: "approved", revision: "item:2", expires_at: "2099-01-01T00:00:00Z",
      payload: { input: { op: "drop" }, card: confirms.one_click.model, effect: { todo: 12, request: "confirmation:drop" } } }
    const h = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(fixtures.queued.model, 200) }, storage)
    await h.seam.observeConfirmation(row)
    await h.seam.observeConfirmation(row)
    expect(h.todo().payload.requests).toHaveLength(1)
    expect(h.todo().payload.requests[0]).toMatchObject({ state: "accepted", operation: "drop", key: "confirmation:drop" })
    expect(h.outcomes).toEqual([])
    h.close()
    const restored = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(fixtures.queued.model, 200) }, storage)
    try {
      restored.seam.resumeTodos()
      await restored.seam.observeConfirmation(row)
      await waitFor(() => restored.observed.has("todo:12"))
      expect(calls).toEqual([])
      expect(restored.outcomes).toEqual([])
      restored.observed.get("todo:12")!(fixtures.dropped.model)
      await waitFor(() => restored.outcomes.length === 1)
      expect(restored.outcomes[0]).toMatchObject({ key: "todo.request.confirmation:drop", status: "ok", detail: "Dropped" })
      await restored.seam.observeConfirmation(row)
      expect(restored.todo().payload.requests).toEqual([])
      expect(restored.outcomes).toHaveLength(1)
      expect(calls).toEqual([])
    } finally { restored.close() }
  })
  for (const operation of ["bring-in", "discard-foreign"] as const) test(`an approved ${operation} reconnects to the branch wait without resending`, async () => {
    const calls: RequestInit[] = [], storage = memoryStorage()
    const model = fixtures.foreign_push.model, wait = model.waits[0]!
    const row: MemberConfirmation = { id: "10000000-0000-4000-8000-000000000004", command: operation === "bring-in" ? "branch.bring-in" : "branch.discard-foreign", state: "approved", revision: "item:2:1:head", expires_at: "2099-01-01T00:00:00Z",
      payload: { input: { id: wait.id, revision: wait.sha }, card: { ...confirms.one_click.model, subject: { kind: "branch", ref: model.branch!.name, revision: "item:2:1:head" } }, effect: { todo: 12, request: "confirmation:discard" } } }
    const h = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(model, 200) }, storage)
    await h.seam.observeConfirmation(row)
    expect(h.todo().payload.requests[0]).toMatchObject({ operation, body: { id: wait.id, revision: wait.sha, branch: model.branch!.name } })
    h.close()
    const restored = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(model, 200) }, storage)
    try {
      restored.seam.resumeTodos(); await restored.seam.observeConfirmation(row)
      await waitFor(() => restored.observed.has("todo:12"))
      expect(restored.outcomes).toEqual([])
      restored.observed.get("todo:12")!({ ...model, waits: model.waits.filter(item => item.id !== wait.id) })
      await waitFor(() => restored.outcomes.length === 1)
      expect(restored.outcomes[0]).toMatchObject({ key: "todo.request.confirmation:discard", status: "ok", detail: operation === "bring-in" ? "Brought in" : "Discarded" })
      await restored.seam.observeConfirmation(row)
      expect(restored.outcomes).toHaveLength(1)
      expect(calls).toEqual([])
    } finally { restored.close() }
  })
  test("an approved Amend reconnects and waits for its exact committed revision", async () => {
    const storage = memoryStorage(), calls: RequestInit[] = []
    const row: MemberConfirmation = { id: "10000000-0000-4000-8000-000000000002", command: "todo.amend", state: "approved", revision: "item:2:1", expires_at: "2099-01-01T00:00:00Z",
      payload: { input: { prompt: "Keep cancellation responsive", acceptance: ["Cancel stops retries"] }, card: confirms.one_click.model, effect: { todo: 12, request: "confirmation:amend", revision: 2 } } }
    const h = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(fixtures.queued.model, 200) }, storage)
    await h.seam.observeConfirmation(row)
    expect(h.todo().payload.requests[0]).toMatchObject({ operation: "amend", revision: 2, state: "accepted" })
    h.close()
    const restored = await harness(async (_url, init) => { if (init?.method) calls.push(init); return json(fixtures.queued.model, 200) }, storage)
    try {
      restored.seam.resumeTodos()
      await restored.seam.observeConfirmation(row)
      await waitFor(() => restored.observed.has("todo:12"))
      const completed = { ...fixtures.in_review.model, prompt_revisions: [...fixtures.in_review.model.prompt_revisions.slice(0, 1), { ...fixtures.in_review.model.prompt_revisions[0]!, text: "Keep cancellation responsive", acceptance: ["Wrong criterion"] }] }
      restored.observed.get("todo:12")!(completed)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(restored.outcomes).toEqual([])
      completed.prompt_revisions[1]!.acceptance = ["Cancel stops retries"]
      restored.observed.get("todo:12")!(completed)
      await waitFor(() => restored.outcomes.length === 1)
      expect(restored.outcomes[0]).toMatchObject({ key: "todo.request.confirmation:amend", status: "ok", detail: "Amended" })
      await restored.seam.observeConfirmation(row)
      expect(restored.todo().payload.requests).toEqual([])
      expect(calls).toEqual([])
    } finally { restored.close() }
  })
  test("draft stays private and editable; two presses acknowledge before HTTP and commit with one key", async () => {
    const admission = deferred<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
    try {
      expect(await h.seam.newTodo({ text: "First prompt", title: "Original" })).toEqual({ value: "Drafted" })
      expect(h.draft().audience_member_id).toBe("ben")
      const id = h.draft().id
      expect(await h.seam.setTodoFormField(id, "title", "Changed")).toBeUndefined()
      expect(await h.seam.setTodoFormField(id, "acceptance", "One\nTwo")).toBeUndefined()
      const input = { text: "stale button text", cardId: id }
      expect(await h.seam.newTodo(input)).toEqual({ value: "Requested" })
      expect(await h.seam.newTodo(input)).toEqual({ value: "Requested" })
      expect(calls).toHaveLength(1)
      const key = h.draft().payload.idempotencyKey
      expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(key)
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: "Changed", prompt: "First prompt", acceptance: ["One", "Two"], place: { mode: "append" } })
      expect(await h.seam.setTodoFormField(id, "prompt", "too late")).toBe("Commit is pending.")
      expect(h.outcomes).toEqual([])
      admission.resolve(json({ state: "accepted", n: 12 }))
      await waitFor(() => h.observed.has("todo:12"))
      expect(h.draft().payload.private).toBe(true)
      expect(h.outcomes).toEqual([])
      h.observed.get("todo:12")!(fixtures.queued.model, [{ key, committed: { n: 12, rev: 1 } }])
      await waitFor(() => h.draft().payload.committed?.n === 12)
      expect(h.draft().audience_member_id).toBeNull()
      expect(h.draft().payload.private).toBe(false)
      expect(h.outcomes).toEqual([])
      h.observed.get("todo:12")!(fixtures.in_review.model, [{ key, outcome: { status: "ok", detail: "Ready" } }])
      await waitFor(() => h.outcomes.length === 1)
      expect(h.todo().payload.requests).toEqual([])
      expect(CardSchema.parse(h.draft()).payload).toEqual(h.draft().payload)
      expect(await h.seam.newTodo(input)).toEqual({ value: "Committed T12" })
      expect(calls).toHaveLength(1)
    } finally { h.close() }
  })
  test("a Draft the install's host wrote commits only on its author's press, through the same route", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness(async (url, init) => { calls.push({ url, init }); return json({ state: "accepted", n: 12 }) })
    try {
      // The host's todo.new answers with this card in a turn frame; the turn applies it as Smithers.
      const hosted = (id: string, author: string) => draftCard({ id, author, text: "Log retry counts\nin the worker", options: [], idempotencyKey: `key-${id}` }, 1, 1)
      for (const card of [hosted("draft:host-ben", "ben"), hosted("draft:host-maya", "maya")]) {
        await h.store.dispatch({ type: "card.upsert", actor: "smithers", card }).isPersisted.promise
      }
      // Arriving files nothing: the Draft is the confirmation, and only its author's Commit acts.
      expect(calls).toEqual([])
      expect(await h.seam.newTodo({ text: "x", cardId: "draft:host-maya" })).toBe("This draft belongs to its author.")
      expect(calls).toEqual([])
      expect(await h.seam.newTodo({ text: "x", cardId: "draft:host-ben" })).toEqual({ value: "Requested" })
      await waitFor(() => calls.length === 1)
      expect(calls[0]!.url).toBe("https://install.test/api/todos")
      expect(calls[0]!.init?.method).toBe("POST")
      expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe("key-draft:host-ben")
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        title: "Log retry counts", prompt: "Log retry counts\nin the worker", acceptance: [], place: { mode: "append" }
      })
    } finally { h.close() }
  })
  test("Make TODO opens the author's private Draft of the issue and its discussion; Commit sends issue, issue_digest and fixes", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness(async (url, init) => { calls.push({ url, init }); return json({ state: "accepted", n: 12 }) })
    try {
      const issue = {
        number: 7, digest: "4babb1e1dd0eee80b2bc65f0117d7ac639a2914627f7a0569119d42379ce3d37", title: "Webhooks fail on 502", body: "Webhooks fail on 502", url: "https://github.com/acme/app/issues/7",
        comments: [{ author: "maya", body: "Seen on staging too." }, { author: "alice", body: "retry at most 5 times\nwith jittered backoff" }, { author: null, body: "  " }]
      }
      expect(await h.seam.draftFromIssue(issue)).toEqual({ value: "Drafted" })
      // A second press while the Draft is open opens no second Draft.
      expect(await h.seam.draftFromIssue(issue)).toEqual({ value: "Drafted" })
      expect([...h.store.collections.cards.values()].filter(row => row.kind === "draft")).toHaveLength(1)
      const id = h.draft().id
      expect(h.draft().audience_member_id).toBe("ben")
      expect(h.draft().payload).toMatchObject({
        title: "Webhooks fail on 502",
        prompt: "Webhooks fail on 502\n\n@maya:\n> Seen on staging too.\n\n@alice:\n> retry at most 5 times\n> with jittered backoff",
        acceptance: [], private: true,
        issue: { number: 7, title: "Webhooks fail on 502", url: "https://github.com/acme/app/issues/7", fixes: true },
        // The server-issued snapshot digest is retained unchanged.
        issueDigest: "4babb1e1dd0eee80b2bc65f0117d7ac639a2914627f7a0569119d42379ce3d37"
      })
      expect(CardSchema.parse(h.draft()).payload).toEqual(h.draft().payload)
      // Nothing is written until the author commits.
      expect(calls.filter(call => call.init?.method === "POST")).toEqual([])
      expect(await h.seam.setTodoFormField(id, "prompt", `${h.draft().payload.prompt}\n\nLog each retry.`)).toBeUndefined()
      expect(await h.seam.setTodoFormField(id, "fixes", "false")).toBeUndefined()
      expect(await h.seam.newTodo({ cardId: id })).toEqual({ value: "Requested" })
      await waitFor(() => calls.some(call => call.init?.method === "POST"))
      const commit = calls.find(call => call.init?.method === "POST")!
      expect(commit.url).toBe("https://install.test/api/todos")
      expect(new Headers(commit.init?.headers).get("Idempotency-Key")).toBe(h.draft().payload.idempotencyKey)
      expect(JSON.parse(String(commit.init?.body))).toEqual({
        title: "Webhooks fail on 502",
        prompt: "Webhooks fail on 502\n\n@maya:\n> Seen on staging too.\n\n@alice:\n> retry at most 5 times\n> with jittered backoff\n\nLog each retry.",
        acceptance: [], place: { mode: "append" }, issue: 7, fixes: false, issue_digest: h.draft().payload.issueDigest
      })
    } finally { h.close() }
  })
  test("late answer keeps the text and answered_by, then steers it", async () => {
    const requests: { url: string; body: unknown }[] = []
    const h = await harness(async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return url.endsWith("/answer") ? json({ code: "answered", class: "conflict", message: "maya answered", answered_by: "maya" }, 409) : json({ state: "requested", n: 12 })
    })
    try {
      await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
      expect(await h.seam.answerTodo(12, "Keep my late text\nverbatim")).toEqual({ value: "Requested" })
      await waitFor(() => h.todo()?.payload.answeredBy === "maya")
      expect(h.todo().payload.answerDraft).toBe("Keep my late text\nverbatim")
      expect(h.outcomes).toHaveLength(1)
      expect(await h.seam.steerTodo(12, h.todo().payload.answerDraft!)).toEqual({ value: "Requested" })
      await waitFor(() => requests.length === 2)
      expect(requests[1]).toEqual({ url: "https://install.test/api/todos/12", body: { steer: "Keep my late text\nverbatim" } })
      const key = h.todo().payload.requests.find(request => request.operation === "steer")!.key
      await h.seam.applyTodoProjection(12, fixtures.working.model, [{ key, outcome: { status: "ok", detail: "Sent" } }])
      expect(h.todo().payload.answerDraft).toBeUndefined()
    } finally { h.close() }
  })
  test("retry waits for the current attempt, preserving previous evidence", async () => {
    let init: RequestInit | undefined
    const h = await harness(async (_url, request) => { init = request; return json({ state: "accepted" }) })
    try {
      await h.seam.applyTodoProjection(12, { ...fixtures.failed.model, run: { id: "run-41", attempt: 1, indicators: [] }, evidence: fixtures.failed.model.evidence.slice(0, 1) })
      expect(await h.seam.controlTodo(12, "retry", "Fix the schema")).toEqual({ value: "Requested" })
      await waitFor(() => init !== undefined)
      expect(JSON.parse(String(init!.body))).toEqual({ op: "retry", steer: "Fix the schema" })
      expect(h.todo().payload.model?.run?.attempt).toBe(1)
      expect(h.outcomes).toEqual([])
      const key = h.todo().payload.requests[0]!.key
      await h.seam.applyTodoProjection(12, fixtures.failed.model, [{ key, outcome: { status: "failed", detail: "Check failed" } }])
      expect(h.todo().payload.model?.run?.attempt).toBe(2)
      expect(h.todo().payload.model?.evidence).toEqual(fixtures.failed.model.evidence)
      expect(h.outcomes).toHaveLength(1)
    } finally { h.close() }
  })
  test("reload resends the persisted key; admission does not settle the toast", async () => {
    const storage = memoryStorage()
    const h = await harness(async () => json({ state: "requested", n: 12 }), storage)
    await h.seam.newTodo({ text: "Persist me" })
    const id = h.draft().id
    await h.seam.newTodo({ text: "Persist me", cardId: id })
    await waitFor(() => h.draft().payload.request?.n === 12)
    const key = h.draft().payload.request!.key
    h.close()
    await h.store.dispose?.()
    const keys: string[] = []
    const restored = await harness(async (_url, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return json({ state: "accepted", n: 12 }) }, storage)
    try {
      restored.seam.resumeTodos()
      await waitFor(() => keys.length > 0)
      expect(keys).toEqual([key])
      expect(restored.draft().audience_member_id).toBe("ben")
      expect(restored.outcomes).toEqual([])
    } finally { restored.close() }
  })
  test("amend placement uses PATCH; rejects merged and dropped targets", async () => {
    const calls: RequestInit[] = []
    const h = await harness(async (_url, init) => { calls.push(init!); return json({ state: "accepted", n: 12 }) })
    try {
      await h.seam.applyTodoProjection(12, fixtures.in_review.model)
      await h.seam.newTodo({ text: "An amendment" })
      const id = h.draft().id
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"amend","n":999}')).toBe("Choose an unmerged TODO.")
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"amend","n":12}')).toBeUndefined()
      expect(await h.seam.amendTodo({ n: 12, text: "An amendment", cardId: id })).toEqual({ value: "Requested" })
      await waitFor(() => calls.length === 1)
      expect(calls[0]!.method).toBe("PATCH")
      expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: "An amendment", acceptance: [] })
    } finally { h.close() }
  })
  test("restored amendment sends only revision fields with its original key and waits for completion", async () => {
    const storage = memoryStorage()
    const h = await harness(async () => { throw new Error("restoring must not send before resume") }, storage)
    const card = draftCard({ id: "draft:amend-restored", author: "ben", text: "Revised prompt", options: [], idempotencyKey: "amend-restored" }, 1, 1)
    await h.store.dispatch({ type: "card.upsert", actor: "user", card: { ...card, payload: { ...card.payload,
      request: { key: "amend-restored", owner: "ben", operation: "amend", n: 12, state: "requested",
        body: { title: "Legacy creation metadata", prompt: "Revised prompt", acceptance: ["Preserve this check"], issue: 7, fixes: true, issue_digest: "old" } }
    } } }).isPersisted.promise
    h.close()
    await h.store.dispose?.()
    const response = deferred<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    const restored = await harness((url, init) => { calls.push({ url, init }); return response.promise }, storage)
    try {
      restored.seam.resumeTodos()
      await waitFor(() => calls.length === 1)
      restored.seam.resumeTodos()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
      expect(calls[0]!.init?.method).toBe("PATCH")
      expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe("amend-restored")
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ prompt: "Revised prompt", acceptance: ["Preserve this check"] })
      expect(restored.outcomes).toEqual([])
      response.resolve(json({ state: "accepted", n: 12, rev: 2 }))
      await waitFor(() => restored.draft().payload.request?.state === "accepted")
      expect(restored.outcomes).toEqual([])
      expect(restored.draft().payload.committed).toBeUndefined()
    } finally { restored.close() }
  })
  test("sign-out fences HTTP and topic replies and disposes subscriptions", async () => {
    const response = deferred<Response>()
    const h = await harness(() => response.promise)
    try {
      await h.seam.controlTodo(12, "stop")
      const receive = h.observed.get("todo:12")!
      h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null })
      response.resolve(json({ state: "accepted", n: 12 }))
      receive(fixtures.paused.model)
      await waitFor(() => h.observed.size === 0)
      expect(h.todo()?.payload.model).toBeUndefined()
      expect(h.outcomes).toEqual([])
      expect(await h.seam.controlTodo(12, "resume")).toBe("Sign in to work on TODOs.")
    } finally { h.close() }
  })
  test("Commit retry keeps its key and disables edits before the second HTTP reply", async () => {
    const second = deferred<Response>()
    const keys: string[] = []
    const h = await harness(async (_url, init) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!)
      return keys.length === 1 ? json({ code: "busy", class: "capacity", message: "No machine", retry_at: "2026-10-02T12:00:00Z" }, 429) : second.promise
    })
    try {
      await h.seam.newTodo({ text: "Retry once" })
      const id = h.draft().id
      await h.seam.newTodo({ text: "Retry once", cardId: id })
      await waitFor(() => h.draft().payload.request?.state === "failed")
      expect(h.draft().payload.request?.error).toBe("No machine Not your fault.")
      await h.seam.newTodo({ text: "Retry once", cardId: id })
      await waitFor(() => keys.length === 2)
      expect(keys[0]).toBe(keys[1])
      expect(h.draft().payload.request?.state).toBe("requested")
      expect(await h.seam.setTodoFormField(id, "title", "Must wait")).toBe("Commit is pending.")
      expect(h.seam.dismissTodoDraft(id)).toBe("Commit was requested.")
      second.resolve(json({ state: "accepted", n: 12 }))
    } finally { h.close() }
  })
  test("uncommitted Discard removes only the author's draft; field validation cannot alter server place options", async () => {
    const h = await harness(async () => json({ state: "accepted", n: 12 }))
    try {
      await h.seam.newTodo({ text: "Private draft" })
      const id = h.draft().id
      await waitFor(() => h.draft().payload.place.options.length > 0)
      expect(h.draft().payload.place.options.map(row => row.n)).toEqual([12])
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"before","n":999,"options":[{"n":999,"title":"Forged","state":"working"}]}')).toBe("Invalid draft value.")
      expect(await h.seam.setTodoFormField(id, "place", "invalid JSON")).toBe("Invalid draft value.")
      expect(await h.seam.setTodoFormField(id, "unknown", "x")).toBe("Unknown draft field.")
      expect(h.seam.dismissTodoDraft(id)).toBeUndefined()
      expect(h.store.collections.cards.get(id)).toBeUndefined()
    } finally { h.close() }
  })
  test("TODO reads validate the topic number, and a malformed admission stays retryable", async () => {
    const h = await harness(async (_url, init) => init?.method ? json({ state: "done", n: 12 }) : json(fixtures.in_review.model, 200))
    try {
      const result = await h.seam.showTodo(12)
      if (!result || typeof result === "string") throw new Error("Expected a TODO read")
      expect(JSON.parse(result.value)).toEqual(JSON.parse(JSON.stringify(fixtures.in_review.model)))
      expect(h.todo().payload.model).toEqual(fixtures.in_review.model)
      await expect(h.seam.applyTodoProjection(13, fixtures.in_review.model)).rejects.toMatchObject({ _tag: "TodoTopicMismatch", message: "TODO topic mismatch" })
      await h.seam.controlTodo(12, "stop")
      await waitFor(() => h.todo().payload.requests[0]?.state === "failed")
      expect(h.todo().payload.requests[0]?.error).toBe("TODO admission was not confirmed.")
    } finally { h.close() }
  })

})

test("multiple waits require a target and persist the exact answer wait in HTTP", async () => {
  const calls: unknown[] = []
  const h = await harness(async (url, init) => {
    calls.push({ url, ...JSON.parse(String(init?.body)) })
    return json({ state: "accepted", n: 12 })
  })
  try {
    const question = fixtures.needs_you.model.waits[0]!
    const approval = fixtures.approval.model.waits[0]!
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, waits: [question, approval] })
    expect(await h.seam.answerTodo(12, "Yes")).toBe("Choose an open wait.")
    expect(await h.seam.answerTodo(12, "Yes", "stale-wait")).toBe("Choose an open wait.")
    expect(calls).toEqual([])
    expect(await h.seam.answerTodo(12, "Approve", approval.id)).toEqual({ value: "Requested" })
    await waitFor(() => calls.length === 1)
    expect(calls).toEqual([{ url: "https://install.test/api/todos/12/answer", answer: "Approve", wait: approval.id }])
  } finally { h.close() }
})

// J2 step 4 / J3 step 6 on an install: Needs you toasts the TODO's owner once per question with its one action; the
// TODO card's and Branch card's Answer ({n, answer}, no wait id) posts to the answer route; admission settles nothing,
// and the answer and its toast settle only when the served question closes.
test("an answer posts to POST /api/todos/{n}/answer and settles with the question; Needs you toasts the owner once", async () => {
  const admission = deferred<Response>()
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
  try {
    const question = fixtures.needs_you.model.waits[0]!
    await h.seam.applyTodoProjection(12, fixtures.working.model)
    expect([...h.store.collections.toasts.values()]).toEqual([])
    await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
    await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
    const toasts = () => [...h.store.collections.toasts.values()].filter(toast => toast.key.startsWith("todo.needs-you."))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toMatchObject({ key: `todo.needs-you.12.${question.id}`, title: "T12 needs you", status: "running", sourceCard: "todo:12",
      action: { flow: "todo", args: "T12", label: "Answer" } })

    expect(await h.seam.answerTodo(12, "Include them")).toEqual({ value: "Requested" })
    expect(await h.seam.answerTodo(12, "Include them")).toEqual({ value: "Requested" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://install.test/api/todos/12/answer")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ answer: "Include them", wait: question.id })
    const key = h.todo().payload.requests[0]!.key
    expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(key)
    admission.resolve(json({ state: "accepted" }))
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
    expect(h.outcomes).toEqual([])
    expect(h.todo().payload.requests).toHaveLength(1)

    await h.seam.applyTodoProjection(12, fixtures.working.model)
    expect(h.outcomes).toEqual(expect.arrayContaining([
      { key: `todo.needs-you.12.${question.id}`, status: "ok", detail: "Answered" },
      { key: `todo.request.${key}`, status: "ok", detail: "Answered" }
    ]))
    expect(h.todo().payload.requests).toEqual([])
    expect(toasts()[0]).toMatchObject({ status: "ok" })
  } finally { h.close() }
})

// J4.2d / J4.3a: Retry with a steer posts {op: retry, steer} to POST /api/todos/{n} once per press; its toast settles
// only when the attempt the receipt names runs (Working), never on the 202, and fails if that attempt fails again.
test("a retry posts its steer once and settles when the attempt its receipt names runs", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  let attempt = 2
  const h = await harness(async (url, init) => { calls.push({ url, init }); return json({ state: "accepted", attempt: ++attempt }) })
  try {
    const failed = fixtures.failed.model
    await h.seam.applyTodoProjection(12, failed)
    expect(await h.seam.controlTodo(12, "retry", "[FIXED] use the helper")).toEqual({ value: "Requested" })
    expect(await h.seam.controlTodo(12, "retry", "[FIXED] use the helper")).toEqual({ value: "Requested" })
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: "retry", steer: "[FIXED] use the helper" })
    const key = h.todo().payload.requests[0]!.key
    expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(key)
    expect(h.todo().payload.requests[0]!.attempt).toBe(3)
    expect(CardSchema.parse(h.todo()).payload).toEqual(h.todo().payload)
    // The failed attempt, the queue and the start settle nothing.
    await h.seam.applyTodoProjection(12, failed)
    await h.seam.applyTodoProjection(12, { ...fixtures.working.model, state: "queued", run: undefined })
    await h.seam.applyTodoProjection(12, { ...fixtures.working.model, state: "starting", run: undefined })
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...fixtures.working.model, run: { id: "run-43", attempt: 3, indicators: [] } })
    expect(h.outcomes).toEqual([{ key: `todo.request.${key}`, status: "ok", detail: "Working" }])
    expect(h.todo().payload.requests).toEqual([])

    // A later retry whose attempt fails again settles failed, with the failure's words.
    calls.length = 0
    await h.seam.applyTodoProjection(12, { ...failed, run: { id: "run-43", attempt: 3, indicators: [] } })
    expect(await h.seam.controlTodo(12, "retry")).toEqual({ value: "Requested" })
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: "retry" })
    const again = h.todo().payload.requests[0]!.key
    await h.seam.applyTodoProjection(12, { ...failed, run: { id: "run-44", attempt: 3, indicators: [] } })
    expect(h.outcomes).toHaveLength(1)
    await h.seam.applyTodoProjection(12, { ...failed, run: { id: "run-44", attempt: 4, indicators: [] } })
    expect(h.outcomes[1]).toEqual({ key: `todo.request.${again}`, status: "failed", detail: "The operation failed." })
  } finally { h.close() }
})

// J4.2c / J4.3a: Move posts {op: move, direction} to POST /api/todos/{n} once per press; its toast settles only when
// the card shows the place the receipt names, never on the 202.
test("a move posts its direction once and settles when the card shows the place its receipt names", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness(async (url, init) => { calls.push({ url, init }); return json({ state: "accepted", place: 3 }) })
  try {
    const before = { ...fixtures.working.model, place: 4 }
    await h.seam.applyTodoProjection(12, before)
    expect(await h.seam.moveTodo(12, "up")).toEqual({ value: "Requested" })
    expect(await h.seam.moveTodo(12, "up")).toEqual({ value: "Requested" })
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: "move", direction: "up" })
    const key = h.todo().payload.requests[0]!.key
    expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(key)
    expect(h.todo().payload.requests[0]!.place).toBe(3)
    expect(CardSchema.parse(h.todo()).payload).toEqual(h.todo().payload)
    // The card before the move settles nothing; the moved card settles it.
    await h.seam.applyTodoProjection(12, before)
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...before, place: 3 })
    expect(h.outcomes).toEqual([{ key: `todo.request.${key}`, status: "ok", detail: "Moved" }])
    expect(h.todo().payload.requests).toEqual([])
  } finally { h.close() }
})

test("Needs you toasts anyone on the branch, but not a member who neither owns the TODO nor is on its branch (M-14)", async () => {
  const h = await harness(async () => json({ state: "accepted" }))
  try {
    const maya = { login: "maya", name: "Maya", avatar_url: fixtures.needs_you.model.owner.avatar_url }
    const needsYou = () => [...h.store.collections.toasts.values()].filter(toast => toast.key.startsWith("todo.needs-you."))
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, owner: maya, present: [] })
    expect(needsYou()).toEqual([])
    // Ben joins the branch while the question is still open: an already-open question raises nothing new.
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, owner: maya })
    expect(needsYou()).toEqual([])
    const asked = { ...fixtures.needs_you.model.waits[0]!, id: "wait-question-2", prompt: "Which region?" }
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, owner: maya, waits: [asked] })
    expect(needsYou().map(toast => toast.key)).toEqual(["todo.needs-you.12.wait-question-2"])
  } finally { h.close() }
})

// Recorded attribution crosses the real seam transport and persistence boundary; credential issuance is T-ACC-04.
test("TODO HTTP and live projections normalize historical delegated authors", async () => {
  const { actorName } = await import("../ProductActor")
  const { PlaceholderAvatarUrl } = await import("@smthrs/rpc/CardPrimitives")
  const by = { person: "member-ben", via: "claude-code", session: "cc-7" }
  const projection = { ...fixtures.working.model, steers: [{ text: "Steer", by, at: "now" }],
    first_answer: { text: "Answer", by, at: "now" }, prompt_revisions: [{ text: "Amend", acceptance: [], by, at: "now" }] }
  const h = await harness(async () => json(projection, 200), memoryStorage(), () => ({ roster: [
    { id: "member-ben", login: "ben", name: "Ben", avatar_url: PlaceholderAvatarUrl, color_index: 3 }
  ] }))
  try {
    await h.seam.showTodo(12)
    const model = h.todo().payload.model!
    for (const author of [model.steers[0]!.by, model.first_answer!.by, model.prompt_revisions[0]!.by]) {
      expect(actorName(author)).toBe("Claude Code for Ben")
      expect(author).toMatchObject({ kind: "agent", id: "agent-session-cc-7", color_index: 3, for_member: { name: "Ben" } })
    }
    h.observed.get("todo:12")!({ ...projection, steers: [{ text: "Cookie", by: { person: "member-ben", session: "cookie" }, at: "later" }] })
    await waitFor(() => h.todo().payload.model!.steers[0]!.text === "Cookie")
    expect(actorName(h.todo().payload.model!.steers[0]!.by)).toBe("Ben")
  } finally { h.close() }
})

test("TODO history refuses missing recorded member context", async () => {
  const projection = { ...fixtures.working.model,
    steers: [{ text: "Unknown", by: { person: "missing-ben", via: "claude-code" }, at: "now" }] }
  let served: unknown = projection
  const h = await harness(async () => json(served, 200))
  try {
    expect(await h.seam.showTodo(12)).toBe("Could not reach TODOs. Nothing answered at all — that's the connection, not something you did. Try it again.")
    expect(h.todo()).toBeUndefined()
    await expect(h.seam.applyTodoProjection(12, projection)).rejects.toThrow("Actor member missing-ben is missing from the roster")
    expect(h.todo()).toBeUndefined()
    served = fixtures.working.model
    await h.seam.showTodo(12)
    const reports = h.reports
    h.observed.get("todo:12")!(projection)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.scope).toBe("todo.projection")
    expect(String(reports[0]!.error)).toContain("Actor member missing-ben is missing from the roster")
    expect(h.todo().payload.model).toEqual(fixtures.working.model)
  } finally { h.close() }
})

test("TODO HTTP and subscribed history keep Smithers system attribution", async () => {
  const { actorName } = await import("../ProductActor")
  const projection = { ...fixtures.working.model,
    steers: [{ text: "Recorded", by: { system: "smithers", requester: "member-ben" }, at: "now" }] }
  const h = await harness(async () => json(projection, 200))
  try {
    await h.seam.showTodo(12)
    expect(h.todo().payload.model!.steers[0]!.by).toEqual({ kind: "system", color_index: 7 })
    expect(actorName(h.todo().payload.model!.steers[0]!.by)).toBe("Smithers")
    h.observed.get("todo:12")!({ ...projection, steers: [{ ...projection.steers[0]!, text: "Updated" }] })
    await waitFor(() => h.todo().payload.model!.steers[0]!.text === "Updated")
    expect(h.todo().payload.model!.steers[0]!.by).toEqual({ kind: "system", color_index: 7 })
    expect(actorName(h.todo().payload.model!.steers[0]!.by)).toBe("Smithers")
  } finally { h.close() }
})

// M3, J7.3b: Drop on a failed TODO posts {op: drop} once per press; its toast settles only when the TODO is dropped,
// never on the 202.
test("a drop posts once and settles when the TODO is dropped", async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness(async (url, init) => { calls.push({ url, init }); return json({ state: "accepted" }) })
  try {
    await h.seam.applyTodoProjection(12, fixtures.failed.model)
    expect(await h.seam.controlTodo(12, "drop")).toEqual({ value: "Requested" })
    expect(await h.seam.controlTodo(12, "drop")).toEqual({ value: "Requested" })
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: "drop" })
    const key = h.todo().payload.requests[0]!.key
    await h.seam.applyTodoProjection(12, fixtures.failed.model)
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...fixtures.dropped.model, n: 12 })
    expect(h.outcomes).toEqual([{ key: `todo.request.${key}`, status: "ok", detail: "Dropped" }])
    expect(h.todo().payload.requests).toEqual([])
  } finally { h.close() }
})

// The install serves each author as a full Actor (services.todoActor), so the
// card names a terminal's answer with no roster in the seam (T-ACC-04, M-34).
test("TODO projections name an install's served delegated authors without a roster", async () => {
  const { actorName } = await import("../ProductActor")
  const { PlaceholderAvatarUrl } = await import("@smthrs/rpc/CardPrimitives")
  const ben = { login: "ben", name: "Ben Ito", avatar_url: PlaceholderAvatarUrl }
  const agent = { kind: "agent", id: "agent-session-5e55", agent: "claude-code", avatar_url: PlaceholderAvatarUrl, session_id: "5e55", for_member: ben, color_index: 0 } as const
  const terminal = { kind: "person", ...ben, via: "terminal", color_index: 0 }
  const projection = { ...fixtures.working.model, first_answer: { text: "Use backoff", by: agent, at: "now" },
    prompt_revisions: [{ text: "Add retries", acceptance: [], by: terminal, at: "now" }] }
  const h = await harness(async () => json(projection, 200))
  try {
    await h.seam.showTodo(12)
    const model = h.todo().payload.model!
    expect(actorName(model.first_answer!.by)).toBe("Claude Code for Ben")
    expect(model.first_answer!.by).toEqual(agent)
    expect(actorName(model.prompt_revisions[0]!.by)).toBe("Ben's terminal")
  } finally { h.close() }
})

for (const operation of ["stop", "resume", "retry", "retry-current-flow", "drop"] as const) {
  test(`${operation} uses the numbered control route and acknowledges an unresolved request once`, async () => {
    const admission = deferred<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
    try {
      await h.seam.applyTodoProjection(12, fixtures.failed.model)
      const steer = operation.startsWith("retry") ? " Keep\nthis steer " : undefined
      expect(await h.seam.controlTodo(12, operation, steer)).toEqual({ value: "Requested" })
      expect(await h.seam.controlTodo(12, operation, steer)).toEqual({ value: "Requested" })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
      expect(calls[0]!.init?.method).toBe("POST")
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: operation, ...(steer ? { steer } : {}) })
      const key = h.todo().payload.requests[0]!.key
      expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(key)
      expect(h.todo().payload.requests).toHaveLength(1)
      expect(h.todo().payload.model).toEqual(fixtures.failed.model)
      expect(h.outcomes).toEqual([])
      admission.resolve(json({ code: "todo_control_unavailable", class: "infra", message: "TODO controls are unavailable" }, 503))
      await waitFor(() => h.todo().payload.requests[0]?.state === "failed")
      expect(h.outcomes).toHaveLength(1)
      expect(h.outcomes[0]).toMatchObject({ status: "failed", detail: "TODO controls are unavailable Not your fault." })
      expect(h.todo().payload.model).toEqual(fixtures.failed.model)
    } finally { h.close() }
  })
}

test("malformed Draft edits never persist or admit a Commit", async () => {
  let writes = 0
  const h = await harness(async () => { writes++; return json({ state: "accepted", n: 12 }) })
  try {
    await h.seam.newTodo({ text: "Prompt" })
    const id = h.draft().id
    for (const [field, value] of [["place", "{"], ["place", '{"mode":"append","n":12}'],
      ["place", '{"mode":"before"}'], ["place", '{"mode":"before","n":"12"}'],
      ["acceptance", '["yes",12]'], ["fixes", "yes"]]) {
      expect(await h.seam.setTodoFormField(id, field!, value!)).toBe("Invalid draft value.")
    }
    expect(h.draft().payload.place.mode).toBe("append")
    expect(h.draft().payload.acceptance).toEqual([])
    expect(writes).toBe(0)
    expect(await h.seam.setTodoFormField(id, "acceptance", '["one","two"]')).toBeUndefined()
    expect(h.draft().payload.acceptance).toEqual(["one", "two"])
  } finally { h.close() }
})

test("session Merge persists one reviewed head request and waits for the merged projection", async () => {
  const admission = deferred<Response>()
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
  try {
    await h.seam.applyTodoProjection(12, fixtures.in_review.model)
    const head = fixtures.in_review.model.pr!.head
    expect(await h.seam.mergeTodo(12, head)).toEqual({ value: "Requested" })
    expect(await h.seam.mergeTodo(12, head)).toEqual({ value: "Requested" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://install.test/api/todos/12/merge")
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ reviewed_head_sha: head })
    expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBeTruthy()
    admission.resolve(json({ state: "accepted" }))
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(h.todo().payload.model?.state).toBe("in_review")
    expect(h.outcomes).toEqual([])
    const requestKey = h.todo().payload.requests[0]!.key
    await h.seam.applyTodoProjection(12, fixtures.merged.model)
    expect(h.todo().payload.requests).toEqual([])
    expect(h.outcomes).toEqual(expect.arrayContaining([
      { key: `todo.request.${requestKey}`, status: "ok", detail: "Merged" },
      { key: "todo.merged.12.run-41.1", status: "ok", detail: "Merged" }
    ]))
    expect(h.outcomes).toHaveLength(2)
  } finally { h.close() }
})

test("a persisted TODO snapshot commits its admitted Draft; completion waits for review", async () => {
  const h = await harness(async () => json({ state: "accepted", n: 12 }))
  try {
    await h.seam.newTodo({ text: "Snapshot prompt", title: "Snapshot title" })
    const id = h.draft().id
    await h.seam.newTodo({ cardId: id })
    await waitFor(() => h.draft().payload.request?.state === "accepted")
    expect(h.draft().payload.private).toBe(true)
    await h.seam.applyTodoProjection(12, fixtures.queued.model)
    expect(h.draft().payload.private).toBe(true)
    const model = { ...fixtures.queued.model, title: "Snapshot title", prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: "Snapshot prompt" }] }
    await h.seam.applyTodoProjection(12, model)
    expect(h.draft().payload.committed).toEqual({ n: 12, rev: 1 })
    expect(h.draft().audience_member_id).toBeNull()
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...model, state: "in_review" })
    expect(h.outcomes).toHaveLength(1)
  } finally { h.close() }
})

test("an agent turn's TODO card keeps the person's pending Commit: the Draft commits and its toast settles as the TODO advances", async () => {
  const h = await harness(async () => json({ state: "accepted", n: 12 }))
  try {
    await h.seam.newTodo({ text: "Snapshot prompt", title: "Snapshot title" })
    await h.seam.newTodo({ cardId: h.draft().id })
    await waitFor(() => h.todo()?.payload.requests[0]?.state === "accepted")
    const ordinal = h.todo().ordinal
    // The person asks what is on the stack; the install's host answers with T12's TODO card.
    const model = { ...fixtures.queued.model, title: "Snapshot title", prompt_revisions: [{ ...fixtures.queued.model.prompt_revisions[0]!, text: "Snapshot prompt" }] }
    const token = "a".repeat(64)
    await h.store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "What is on the stack?", retry: false, journal: { version: 1, legId: "leg", token } }).isPersisted.promise
    const cursor = { version: 1 as const, runId: "turn", legId: "leg", batch: 0, position: 0, hash: "0".repeat(64) }
    await h.store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor }).isPersisted.promise
    const frames: AgentTurnFrame[] = [{ type: "card", runId: "turn", card: todoCard(12, model, 0, 2) }]
    const body = { version: 1 as const, runId: "turn", legId: "leg", batch: 1, from: 1, previousHash: cursor.hash, frames }
    const batch = { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
    await h.store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch }).isPersisted.promise
    expect(h.todo().payload.model).toEqual(model)
    expect(h.todo().payload.requests.map(request => request.state)).toEqual(["accepted"])
    expect(h.todo().ordinal).toBe(ordinal)
    // T12's live projection advances, and the person's Commit settles.
    h.observed.get("todo:12")!(model)
    await waitFor(() => h.draft().payload.committed?.n === 12)
    expect(h.outcomes).toEqual([])
    h.observed.get("todo:12")!({ ...model, state: "in_review" })
    await waitFor(() => h.outcomes.length === 1)
    expect(h.todo().payload.requests).toEqual([])
  } finally { h.close() }
})

test("REST refresh follows a real TODO without a topic and fences a read after sign-out", async () => {
  const refreshed = deferred<Response>()
  let reads = 0
  const h = await harness(async () => ++reads === 1 ? json(fixtures.queued.model, 200) : refreshed.promise,
    memoryStorage(), undefined, false)
  try {
    await h.seam.showTodo(12)
    expect(h.todo().payload.model?.state).toBe("queued")
    await waitFor(() => reads === 2)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reads).toBe(2)
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    refreshed.resolve(json(fixtures.merged.model, 200))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.todo()).toBeUndefined()
    expect(h.outcomes).toEqual([])
  } finally { h.close() }
})

test("a malformed topic publication leaves the REST refresh running; only a publication that validates stops it", async () => {
  let reads = 0
  const h = await harness(async () => json(++reads === 1 ? fixtures.queued.model : fixtures.in_review.model, 200))
  try {
    await h.seam.showTodo(12)
    expect(h.todo().payload.model?.state).toBe("queued")
    const publish = h.observed.get("todo:12")!
    publish({ ...fixtures.queued.model, state: "not-a-state" })
    publish({ ...fixtures.merged.model, n: 13 })
    expect(h.todo().payload.model?.state).toBe("queued")
    // The authoritative read still runs and lands.
    await waitFor(() => h.todo().payload.model?.state === "in_review")
    publish(fixtures.merged.model)
    await waitFor(() => h.todo().payload.model?.state === "merged")
    const settled = reads
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(reads).toBe(settled)
    expect(h.todo().payload.model?.state).toBe("merged")
  } finally { h.close() }
})

test("Review & merge opens the person's private Confirm card only for a served TODO in review", async () => {
  const served: Record<string, unknown> = {
    "/api/todos/12": fixtures.in_review.model, "/api/todos/13": { ...fixtures.queued.model, n: 13 }, "/api/todos/14": { ...fixtures.merged.model, n: 14 }
  }
  const h = await harness(async url => {
    const body = served[new URL(url).pathname]
    return body === undefined ? json({ code: "todo_not_found", class: "user", message: "TODO not found" }, 404) : json(body, 200)
  }, memoryStorage(), undefined, false)
  try {
    expect(await h.seam.reviewMerge(12)).toEqual({ value: "Opened Merge T12 into main?" })
    expect(h.store.collections.cards.get("confirm:merge:todo:12")).toMatchObject({ kind: "confirm", title: "Merge T12 into main?", audience_member_id: "ben", payload: { id: "merge:todo:12" } })
    expect(h.todo().payload.model?.pr?.head).toBe(fixtures.in_review.model.pr!.head)
    const ordinal = h.store.collections.cards.get("confirm:merge:todo:12")!.ordinal
    expect(await h.seam.reviewMerge(12)).toEqual({ value: "Opened Merge T12 into main?" })
    expect(h.store.collections.cards.get("confirm:merge:todo:12")!.ordinal).toBe(ordinal)
    expect(await h.seam.reviewMerge(13)).toBe("Not in review yet")
    expect(await h.seam.reviewMerge(14)).toBe("T14 already merged")
    expect(await h.seam.reviewMerge(15)).toBe("Could not open the TODO.")
    expect([...h.store.collections.cards.keys()].filter(id => id.startsWith("confirm:"))).toEqual(["confirm:merge:todo:12"])
  } finally { h.close() }
})

test("the install's queued TODO projection, as GET /api/todos/{n} serves it, renders without the seed", async () => {
  // Verbatim GET /api/todos/1 body from the J1 rehearsal on main e6492f924a (C-J1-04 evidence http.log, 2026-10-05):
  // a TODO filed through POST /api/todos before admission, with no branch, run, PR or steps.
  const avatar = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIyNCIgZmlsbD0iI2RkZCIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMTgiIHI9IjgiIGZpbGw9IiM4ODgiLz48cGF0aCBkPSJNOCA0NGExNiAxNiAwIDAgMSAzMiAwIiBmaWxsPSIjODg4Ii8+PC9zdmc+"
  const body = { evidence: [], merge: { on_github: false, reason: "state", state: "waiting" }, n: 1,
    owner: { avatar_url: avatar, login: "rehearsal-owner", name: "Rehearsal owner" }, place: 1, present: [],
    prompt_revisions: [{ at: "2026-10-05T06:16:42.354898Z", by: { kind: "person", name: "Rehearsal owner", login: "rehearsal-owner", avatar_url: avatar, color_index: 0 },
      text: "Add a greeting to JOURNEY.md", acceptance: [] }],
    state: "queued", steers: [], steps: [], title: "First TODO", waits: [] }
  const requests: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname
    requests.push(path)
    return path === "/api/todos/1" ? json(body, 200) : new Response(null, { status: 404 })
  } })
  const h = await harness((url, init) => fetch(new URL(new URL(url).pathname, server.url), init), memoryStorage(), undefined, false)
  try {
    expect(await h.seam.showTodo(1)).toBeDefined()
    const card = h.store.collections.cards.get("todo:1") as TodoEntry
    expect(card.payload.model).toMatchObject({ n: 1, state: "queued", title: "First TODO", place: 1, prompt_revisions: [{ text: "Add a greeting to JOURNEY.md" }] })
    const markup = renderToStaticMarkup(createElement(TodoContainer, { card, role: "owner", View: TodoView,
      dispatch: () => {}, view: { maximized: false }, onView: () => {} }))
    expect(markup).toContain('class="state" data-state="queued"')
    expect(markup).toContain('class="dot" data-state="queued"')
    expect(markup).toContain('class="avatar"')
    expect(markup).toContain('aria-label="Rehearsal"')
    expect(markup).toContain("First TODO")
    expect(markup).not.toMatch(/mvp-(avatar|state|dot|glyph)/)
    expect(await h.seam.reviewMerge(1)).toBe("Not in review yet")
    expect(requests).toEqual(["/api/todos/1", "/api/todos/1"])
  } finally { h.close(); await server.stop(true) }
})

describe("TodoSeam — the TODO list Home reads where no `home` topic is served (T-APP-01)", () => {
  const listHarness = async (answers: Array<() => Response | Promise<Response>>, login: string | null = "ben") => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    if (login !== null) await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise
    const calls: string[] = []
    let disposed = false
    const finalizers: (() => void)[] = []
    const context: SeamContext = {
      http: async (url, init) => { calls.push(`${init?.method ?? "GET"} ${url}`); return answers.shift()?.() ?? new Promise<Response>(() => {}) },
      store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal, isDisposed: () => disposed
    }
    const seam = createTodoSeam(context, { debounceMs: 1, listPollMs: 5, onDispose: fn => finalizers.push(fn) })
    return { seam, calls, close: () => { disposed = true; finalizers.forEach(fn => fn()) } }
  }

  test("the first reader reads at once and again until it leaves; a refusal drops the list, a failure keeps the last one", async () => {
    const last = deferred<Response>()
    const h = await listHarness([
      () => json([fixtures.queued.model, fixtures.in_review.model], 200), () => json({ code: "internal" }, 500),
      () => json({ code: "forbidden" }, 403), () => last.promise
    ])
    try {
      expect(h.seam.list.get()).toEqual({})
      const seen: Array<{ readonly n?: ReadonlyArray<number>; readonly error?: string }> = []
      const leave = h.seam.list.subscribe(() => {
        const snapshot = h.seam.list.get()
        seen.push({ ...(snapshot.todos ? { n: snapshot.todos.map(todo => todo.n) } : {}), ...(snapshot.error ? { error: snapshot.error } : {}) })
      })
      await waitFor(() => h.calls.length === 4)
      leave()
      expect(seen).toEqual([{ n: [fixtures.queued.model.n, 12] }, { n: [fixtures.queued.model.n, 12], error: "internal" }, { error: "forbidden" }])
      last.resolve(json([], 200))
      await new Promise(resolve => setTimeout(resolve, 30))
      // The read in flight when the last reader left settles, and nothing reads again.
      expect(h.calls).toEqual(Array(4).fill("GET https://install.test/api/todos"))
      expect(h.seam.list.get()).toEqual({ todos: [] })
      expect(seen).toHaveLength(3)
    } finally { h.close() }
  })

  test("a list that does not parse keeps the last list; signed out, nothing is read", async () => {
    const h = await listHarness([() => json([fixtures.queued.model], 200), () => json([{ n: "one" }], 200)])
    try {
      const leave = h.seam.list.subscribe(() => {})
      await waitFor(() => h.seam.list.get().error === "invalid")
      leave()
      expect(h.seam.list.get().todos?.map(todo => todo.n)).toEqual([fixtures.queued.model.n])
    } finally { h.close() }
    const out = await listHarness([() => json([], 200)], null)
    try {
      const leave = out.seam.list.subscribe(() => {})
      await new Promise(resolve => setTimeout(resolve, 30))
      leave()
      expect(out.calls).toEqual([])
      expect(out.seam.list.get()).toEqual({})
    } finally { out.close() }
  })
})

// T-APP-07: the real persisted TODO seam supplies the mounted rail, rather
// than a seeded entry fixture or a second request path.
test("served TODO rail and edge actions reach Retry and private Review & merge", async () => {
  const { railLines, railEdges, timelineActions } = await import("../../ShellRail")
  const calls: { url: string; init?: RequestInit }[] = []
  const h = await harness(async (url, init) => {
    calls.push({ url, init })
    return init?.method ? json({ state: "accepted" }) : json(fixtures.in_review.model, 200)
  })
  try {
    await h.store.dispatch({ type: "card.upsert", actor: "system", card: todoCard(12, undefined, 1, 1) }).isPersisted.promise
    const failed = { ...fixtures.in_review.model, state: "failed" as const, failure: { class: "checks", step: "Check", message: "Checks failed", retryable: true } }
    await h.seam.applyTodoProjection(12, failed)
    const read = () => railLines([{ kind: "card", card: h.todo() }], { role: "owner" })
    const retry = read()[0]!
    expect([retry.title, retry.tone, retry.glyph, retry.action?.tag]).toEqual(["Card model contracts", "failed", { state: "failed" }, "todo.retry"])
    const edges = railEdges([retry, { entry_id: "visible", kind: "answer", title: "Done", tone: "quiet", glyph: { state: "queued" } }], ["visible", "visible"])
    expect(edges.above[0]!.action).toEqual({ tag: "todo.retry", label: "Retry", primary: true, args: { n: "12" } })
    const pending: Promise<unknown>[] = []
    const bind = () => timelineActions(read(), (tag, input) => {
      const n = (input as { n: number }).n
      if (tag === "todo.retry") pending.push(h.seam.controlTodo(n, "retry"))
      if (tag === "merge") pending.push(h.seam.reviewMerge(n))
    })
    bind().onAction("todo.retry", edges.above[0]!.action!.args)
    await Promise.all(pending)
    await waitFor(() => calls.some(call => call.init?.method === "POST"))
    expect(calls.filter(call => call.init?.method === "POST").map(call => [call.url, JSON.parse(String(call.init?.body))])).toEqual([["https://install.test/api/todos/12", { op: "retry" }]])
    await h.seam.applyTodoProjection(12, fixtures.in_review.model)
    expect(read()[0]!.action?.tag).toBe("merge")
    expect(railLines([{ kind: "card", card: h.todo() }], { role: "member" })[0]!.action).toBeUndefined()
    bind().onAction("merge", { n: "12" })
    await Promise.all(pending)
    await waitFor(() => h.store.collections.cards.has("confirm:merge:todo:12"))
    expect(h.store.collections.cards.get("confirm:merge:todo:12")).toMatchObject({ audience_member_id: "ben" })
    expect(calls.some(call => call.url.endsWith("/merge"))).toBe(false)
    await h.seam.applyTodoProjection(12, { ...fixtures.in_review.model, place: 2 })
    expect(read()[0]!.action).toBeUndefined()
    await h.seam.applyTodoProjection(12, { ...failed, failure: { ...failed.failure, retryable: false } })
    expect(read()[0]!.action).toBeUndefined()
  } finally { h.close() }
})

test("Queued Edit sends one idempotent PATCH with prompt and acceptance while launch is unresolved", async () => {
  const launch = deferred<Response>()
  const calls: RequestInit[] = []
  const h = await harness(async (_url, init) => { if (init?.method === "PATCH") calls.push(init); return launch.promise })
  try {
    const input = { n: 12, text: "PROMPT-B", acceptance: ["One acceptance line"] }
    expect(await h.seam.amendTodo(input)).toEqual({ value: "Requested" })
    expect(await h.seam.amendTodo(input)).toEqual({ value: "Requested" })
    expect(calls.length).toBe(1)
    expect(calls[0]!.method).toBe("PATCH")
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: "PROMPT-B", acceptance: ["One acceptance line"] })
    expect(new Headers(calls[0]!.headers).get("Idempotency-Key")).toBeTruthy()
    expect(h.todo().payload.requests).toHaveLength(1)
    expect(h.outcomes).toEqual([])
  } finally { launch.resolve(json({ state: "accepted", n: 12, rev: 2 })); h.close() }
})

test("image.add acknowledges unresolved main reads once, persists recovery and disables early Commit", async () => {
 const read = deferred<Response>()
 const urls: string[] = []
 const h = await harness(async (url) => { urls.push(url); return read.promise })
 try {
  await h.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "ben/app", org: "ben", ownerKind: "user", name: "app", head: { bookmark: "main", changeId: "main", commitId: "main" } }] }).isPersisted.promise
  expect(await h.seam.draftImagePackage("figlet")).toEqual({ value: "Requested" })
  expect(await h.seam.draftImagePackage("figlet")).toEqual({ value: "Requested" })
  expect(urls).toEqual(["https://install.test/api/repos/ben/app/contents/.smithers/machine.json?ref=main"])
  expect(h.draft().payload.imagePreparation?.state).toBe("requested")
  expect(await h.seam.newTodo({ cardId: h.draft().id })).toBe("Machine image draft is not ready.")
  expect(h.outcomes).toEqual([])
  read.resolve(json({ content: '{"packages":["git"]}', encoding: "utf-8" }, 200))
  await waitFor(() => h.draft().payload.imagePreparation?.state === "ready")
  expect(h.draft().payload.seed?.diff).toContain('+    "figlet"')
  expect(h.draft().audience_member_id).toBe("ben")
  expect(h.outcomes).toEqual([expect.objectContaining({ status: "ok", detail: "Drafted" })])
 } finally { read.resolve(json({}, 404)); h.close() }
})

test("image Draft failures stay visible, refuse Commit and retry the same private Draft", async () => {
 let reads = 0
 const h = await harness(async () => ++reads === 1 ? json({}, 503) : json({}, 404))
 try {
  await h.store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "ben/app", org: "ben", ownerKind: "user", name: "app", head: { bookmark: "main", changeId: "main", commitId: "main" } }] }).isPersisted.promise
  await h.seam.draftImagePackage("figlet")
  await waitFor(() => h.draft().payload.imagePreparation?.state === "failed")
  const id = h.draft().id
  expect(h.draft().payload.imagePreparation?.error).toBe("Could not read machine.json.")
  expect(await h.seam.newTodo({ cardId: id })).toBe("Machine image draft is not ready.")
  await h.seam.draftImagePackage("figlet")
  await waitFor(() => h.draft().payload.imagePreparation?.state === "ready")
  expect(h.draft().id).toBe(id)
  expect([...h.store.collections.cards.values()].filter(card => card.kind === "draft")).toHaveLength(1)
  expect(h.draft().payload.seed?.diff).toContain("--- /dev/null")
 } finally { h.close() }
})

test("Edit toast waits for the exact admitted revision, then settles from the real TODO projection", async () => {
 const h = await harness(async () => json({ state: "accepted", n: 12, rev: 2 }))
 try {
  await h.seam.amendTodo({ n: 12, text: "PROMPT-B", acceptance: ["Keep the check"] })
  await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
  await h.seam.applyTodoProjection(12, fixtures.queued.model)
  expect(h.outcomes).toEqual([])
  const model = { ...fixtures.queued.model, prompt_revisions: [fixtures.queued.model.prompt_revisions[0]!,
    { ...fixtures.queued.model.prompt_revisions[0]!, text: "PROMPT-B", acceptance: ["Keep the check"] }] }
  await h.seam.applyTodoProjection(12, model)
  expect(h.outcomes).toEqual([expect.objectContaining({ status: "ok", detail: "Amended" })])
  expect(h.todo().payload.requests).toEqual([])
 } finally { h.close() }
})


test("Source refuses a missing File continuation before drafting", async () => {
  const h = await harness(async () => { throw new Error("No HTTP expected") })
  try {
    expect(await h.seam.newFlowSourceTodo({ title: "Change the TODO flow", text: "Edit the source" }, "flows/todo/flow.ts")).toBe("Branch files are unavailable.")
    expect(h.draft()).toBeUndefined()
  } finally { h.close() }
})

test("Source keeps polling after a live publication until the derived file is ready", async () => {
  let ready = false
  let opens = 0
  let reads = 0
  let posts = 0
  const h = await harness(async (_url, init) => {
    if (init?.method === "POST") { posts++; return json({ state: "accepted", n: 12 }) }
    reads++
    return json(fixtures.in_review.model, 200)
  }, memoryStorage(), undefined, true, async () => { opens++; return ready })
  try {
    await h.seam.newFlowSourceTodo({ title: "Change the TODO flow", text: "Edit the source" }, "flows/todo/flow.ts")
    expect(opens).toBe(0)
    const id = h.draft().id
    await h.seam.newTodo({ cardId: id })
    await waitFor(() => h.observed.has("todo:12"))
    h.seam.resumeTodos()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(posts).toBe(1)
    h.observed.get("todo:12")!(fixtures.in_review.model, [{ key: h.draft().payload.idempotencyKey, committed: { n: 12, rev: 1 } }])
    await waitFor(() => opens === 1)
    expect(h.draft().payload.source?.opened).toBe(false)
    ready = true
    await waitFor(() => h.draft().payload.source?.opened === true)
    expect(reads).toBeGreaterThan(0)
    expect(opens).toBe(2)
    await h.seam.applyTodoProjection(12, fixtures.in_review.model, [])
    expect(opens).toBe(2)
  } finally { h.close() }
})


test("a server snapshot recovers Source after the TODO receipt cleared before its Draft persisted", async () => {
  let posts = 0
  const h = await harness(async () => { posts++; return json({ state: "accepted", n: 12 }) }, memoryStorage(), undefined, true, async () => true)
  try {
    await h.seam.newFlowSourceTodo({ title: "Recover a confirmed edit", text: "Edit the source" }, "flows/todo/flow.ts")
    await h.seam.newTodo({ cardId: h.draft().id })
    await waitFor(() => h.observed.has("todo:12"))
    const card = h.todo()
    await h.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload, requests: [] } } }).isPersisted.promise
    expect(h.draft().payload.committed).toBeUndefined()
    await h.seam.applyTodoProjection(12, { ...fixtures.in_review.model, title: "Recover a confirmed edit",
      prompt_revisions: [{ ...fixtures.in_review.model.prompt_revisions[0], text: "Edit the source", acceptance: [] }] }, [])
    expect(h.draft().payload.committed).toEqual({ n: 12, rev: 1 })
    expect(h.draft().payload.source?.opened).toBe(true)
    expect(posts).toBe(1)
  } finally { h.close() }
})

for (const operation of ["bring-in", "discard-foreign"] as const) for (const status of [202, 409] as const) {
  test(`${operation} binds its branch/wait/head, persists once before HTTP and handles ${status}`, async () => {
    const admission = deferred<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
    try {
      const foreign = fixtures.foreign_push.model.waits[0]!
      const model = { ...fixtures.foreign_push.model, waits: [foreign, fixtures.needs_you.model.waits[0]!] }
      await h.seam.applyTodoProjection(12, model)
      expect(await h.seam[operation === "bring-in" ? "bringIn" : "discardForeign"]("unserved/branch", foreign.id, foreign.sha!)).toBe("Could not open the TODO.")
      expect(calls).toEqual([])
      for (let press = 0; press < 2; press++) {
        expect(await h.seam[operation === "bring-in" ? "bringIn" : "discardForeign"](model.branch!.name, foreign.id, foreign.sha!)).toEqual({ value: "Requested" })
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe("https://install.test/api/branches/todo%2F12")
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: operation, id: foreign.id, revision: foreign.sha })
      const pending = h.todo().payload.requests[0]!
      expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(pending.key)
      expect(CardSchema.parse(h.todo()).payload).toEqual(h.todo().payload)
      expect(h.outcomes).toEqual([])
      admission.resolve(status === 202 ? json({ state: "accepted", n: 12 })
        : json({ code: "conflict", class: "conflict", message: "Outside push changed; refresh the TODO" }, 409))
      await waitFor(() => h.todo().payload.requests[0]?.state === (status === 202 ? "accepted" : "failed"))
      if (status === 409) {
        expect(h.outcomes).toEqual([{ key: `todo.request.${pending.key}`, status: "failed", detail: "Outside push changed; refresh the TODO" }])
        expect(h.todo().payload.model).toEqual(model)
      } else {
        expect(h.outcomes).toEqual([])
        await h.seam.applyTodoProjection(12, model)
        expect(h.outcomes).toEqual([])
        await h.seam.applyTodoProjection(12, { ...model, waits: [model.waits[1]!] })
        expect(h.todo().payload.requests).toEqual([])
        expect(h.todo().payload.model?.waits).toEqual([model.waits[1]!])
        expect(h.todo().payload.model?.evidence).toEqual(model.evidence)
        expect(h.outcomes).toEqual([
          { key: `todo.needs-you.12.${foreign.id}`, status: "ok", detail: "" },
          { key: `todo.request.${pending.key}`, status: "ok", detail: operation === "bring-in" ? "Brought in" : "Discarded" }
        ])
      }
    } finally { h.close() }
  })
}


test("a refused Discard refreshes the served wait and the next press binds the newer head", async () => {
  const foreign = fixtures.foreign_push.model.waits[0]!
  const newer = { ...fixtures.foreign_push.model, waits: [{ ...foreign, sha: "e".repeat(40) }, fixtures.needs_you.model.waits[0]!] }
  const refresh = deferred<Response>()
  const posts: RequestInit[] = []
  let reads = 0
  const h = await harness(async (url, init) => {
    if (!init?.method) {
      expect(url).toBe("https://install.test/api/todos/12")
      reads++
      return refresh.promise
    }
    posts.push(init)
    return posts.length === 1
      ? json({ class: "conflict", message: "Outside push changed; refresh the TODO" }, 409)
      : json({ state: "accepted", n: 12 })
  })
  try {
    await h.seam.applyTodoProjection(12, fixtures.foreign_push.model)
    expect(await h.seam.discardForeign(newer.branch!.name, foreign.id, foreign.sha!)).toEqual({ value: "Requested" })
    await waitFor(() => reads === 1)
    expect(h.todo().payload.requests[0]?.state).toBe("failed")
    expect(h.todo().payload.model?.waits[0]?.sha).toBe(foreign.sha)
    expect(h.outcomes).toEqual([{ key: `todo.request.${h.todo().payload.requests[0]!.key}`, status: "failed", detail: "Outside push changed; refresh the TODO" }])
    refresh.resolve(json(newer, 200))
    await waitFor(() => h.todo().payload.model?.waits[0]?.sha === newer.waits[0]!.sha)
    expect(h.todo().payload.model?.waits).toEqual(newer.waits)
    expect(posts).toHaveLength(1)
    expect(await h.seam.discardForeign(newer.branch!.name, foreign.id, newer.waits[0]!.sha!)).toEqual({ value: "Requested" })
    await waitFor(() => posts.length === 2)
    expect(JSON.parse(String(posts[1]!.body))).toEqual({ op: "discard-foreign", id: foreign.id, revision: newer.waits[0]!.sha })
    expect(new Headers(posts[1]!.headers).get("Idempotency-Key")).not.toBe(new Headers(posts[0]!.headers).get("Idempotency-Key"))
  } finally { h.close() }
})

test("the served merge transition notifies only its owner once, already terminal, without replaying historical merges", async () => {
  const h = await harness(async () => json(fixtures.in_review.model, 200))
  try {
    const merged = () => [...h.store.collections.toasts.values()].filter(toast => toast.audience?.kind === "merged")
    await h.seam.showTodo(12)
    expect(merged()).toEqual([])
    h.observed.get("todo:12")!(fixtures.merged.model)
    await waitFor(() => merged().length === 1)
    expect(merged()[0]).toMatchObject({ sourceCard: "todo:12", status: "ok", detail: "Merged",
      audience: { member: "ben", kind: "merged", target: { flow: "todo", n: 12 } } })
    expect(merged()[0]!.action).toBeUndefined()
    h.observed.get("todo:12")!(fixtures.merged.model)
    await h.seam.applyTodoProjection(12, fixtures.merged.model)
    expect(merged()).toHaveLength(1)
    // Being present on another owner's branch grants no merge notice.
    const owner = { ...fixtures.in_review.model.owner, login: "maya" }
    await h.seam.applyTodoProjection(12, { ...fixtures.in_review.model, owner })
    await h.seam.applyTodoProjection(12, { ...fixtures.merged.model, owner })
    expect(merged()).toHaveLength(1)
    await h.store.dispatch({ type: "toast.dismissed", actor: "user", id: merged()[0]!.id }).isPersisted.promise
    // A delayed pre-merge response followed by a terminal replay cannot undo Hide.
    await h.seam.applyTodoProjection(12, fixtures.in_review.model)
    await h.seam.applyTodoProjection(12, fixtures.merged.model)
    expect(merged()).toEqual([])
  } finally { h.close() }
  const history = await harness(async () => json(fixtures.merged.model, 200))
  try {
    await history.seam.showTodo(12)
    expect([...history.store.collections.toasts.values()].filter(toast => toast.audience?.kind === "merged")).toEqual([])
  } finally { history.close() }
})

 test("prompt-only amendment settles with preserved acceptance and never replays on recovery", async () => {
  const calls: RequestInit[] = []
  const h = await harness(async (_url, init) => { if (init?.method === "PATCH") calls.push(init); return json({ state: "accepted", n: 12, rev: 2 }) })
  try {
    await h.seam.amendTodo({ n: 12, text: "PROMPT-B" })
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    const before = { ...fixtures.queued.model.prompt_revisions[0]!, acceptance: ["Keep the check"] }
    await h.seam.applyTodoProjection(12, { ...fixtures.queued.model, prompt_revisions: [before] })
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...fixtures.queued.model, prompt_revisions: [before, { ...before, text: "PROMPT-B" }] })
    expect(h.outcomes).toEqual([expect.objectContaining({ status: "ok", detail: "Amended" })])
    expect(h.todo().payload.requests).toEqual([])
    h.seam.resumeTodos()
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ prompt: "PROMPT-B" })
  } finally { h.close() }
})

test("served approval and conflict waits notify branch recipients once and settle only on removal", async () => {
  const h = await harness(async () => json(fixtures.queued.model, 200))
  try {
    await h.seam.showTodo(12)
    const notices = () => [...h.store.collections.toasts.values()].filter(toast =>
      toast.audience?.kind === "approval" || toast.audience?.kind === "conflict")
    const approval = fixtures.approval.model.waits[0]!
    const conflict = fixtures.conflict.model.waits[0]!
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, waits: [approval, conflict] })
    await waitFor(() => notices().length === 2)
    expect(notices().map(toast => [toast.audience?.kind, toast.audience?.member, toast.status])).toEqual([
      ["approval", "ben", "running"], ["conflict", "ben", "running"]
    ])
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, waits: [approval, conflict] })
    expect(notices()).toHaveLength(2)
    expect(h.outcomes).toEqual([])
    await h.seam.applyTodoProjection(12, { ...fixtures.needs_you.model, waits: [conflict] })
    await waitFor(() => notices().find(toast => toast.audience?.kind === "approval")?.status === "ok")
    expect(notices().find(toast => toast.audience?.kind === "conflict")?.status).toBe("running")
    await h.seam.applyTodoProjection(12, { ...fixtures.working.model, waits: [] })
    await waitFor(() => notices().every(toast => toast.status === "ok"))
    const other = { ...fixtures.approval.model, owner: { ...fixtures.approval.model.owner, login: "maya" }, present: [] }
    await h.seam.applyTodoProjection(12, { ...other, waits: [{ ...approval, id: "private-approval" }] })
    expect(notices()).toHaveLength(2)
    // M-14: a person on the branch receives its conflict even when another person owns it.
    await h.seam.applyTodoProjection(12, { ...other, present: fixtures.needs_you.model.present, waits: [{ ...conflict, id: "branch-conflict" }] })
    await waitFor(() => notices().length === 3)
    expect(notices()[2]?.audience).toMatchObject({ kind: "conflict", member: "ben" })
  } finally { h.close() }
})

for (const operation of ["stop", "resume"] as const) for (const branchWait of [false, true]) {
  test(`${operation} waits for the same attempt's durable pause projection with branch wait ${branchWait}`, async () => {
    const admission = deferred<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    const h = await harness((url, init) => { calls.push({ url, init }); return admission.promise })
    try {
      const base = structuredClone(fixtures.working.model)
      const pause = { reason: "person" as const, since: "2026-10-06T00:00:00Z" }
      const model = { ...base, state: branchWait ? "needs_you" as const : operation === "resume" ? "paused" as const : "working" as const,
        waits: branchWait ? fixtures.foreign_push.model.waits : [], ...(operation === "resume" ? { pause } : {}) }
      await h.seam.applyTodoProjection(12, model)
      for (let press = 0; press < 2; press++) expect(await h.seam.controlTodo(12, operation)).toEqual({ value: "Requested" })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toBe("https://install.test/api/todos/12")
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ op: operation })
      const pending = h.todo().payload.requests[0]!
      expect(pending.attempt).toBe(base.run!.attempt)
      admission.resolve(json({ state: "accepted", n: 12 }))
      await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
      await h.seam.applyTodoProjection(12, model)
      expect(h.outcomes).toEqual([])
      const completed = { ...model, state: branchWait ? "needs_you" as const : operation === "stop" ? "paused" as const : "queued" as const,
        pause: operation === "stop" ? pause : undefined }
      await h.seam.applyTodoProjection(12, { ...completed, run: { ...base.run!, attempt: base.run!.attempt + 1 } })
      expect(h.outcomes).toEqual([])
      if (operation === "stop") {
        await h.seam.applyTodoProjection(12, { ...completed, pause: { reason: "daily_token_budget", since: pause.since } })
        expect(h.outcomes).toEqual([])
      }
      await h.seam.applyTodoProjection(12, completed)
      expect(h.todo().payload.requests).toEqual([])
      expect(h.todo().payload.model?.waits).toEqual(model.waits)
      expect(h.todo().payload.model?.evidence).toEqual(model.evidence)
      expect(h.outcomes).toEqual([{ key: `todo.request.${pending.key}`, status: "ok", detail: operation === "stop" ? "Paused" : "Resumed" }])
    } finally { h.close() }
  })
}

for (const operation of ["stop", "resume"] as const) {
  test(`${operation} reports provider refusal and terminal settlement without claiming a pause`, async () => {
    let unavailable = true
    const h = await harness(async () => unavailable
      ? json({ code: "todo_control_unavailable", class: "infra", message: "TODO controls are unavailable" }, 503)
      : json({ state: "accepted", n: 12 }))
    try {
      await h.seam.applyTodoProjection(12, fixtures.working.model)
      await h.seam.controlTodo(12, operation)
      await waitFor(() => h.todo().payload.requests[0]?.state === "failed")
      expect(h.outcomes.at(-1)).toMatchObject({ status: "failed", detail: "TODO controls are unavailable Not your fault." })
      expect(h.todo().payload.model?.state).toBe("working")
      unavailable = false
      await h.seam.controlTodo(12, operation)
      await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
      await h.seam.applyTodoProjection(12, fixtures.failed.model)
      expect(h.outcomes.at(-1)).toMatchObject({ status: "failed", detail: fixtures.failed.model.failure!.message })
      expect(h.todo().payload.requests).toEqual([])
      expect(h.todo().payload.model?.evidence).toEqual(fixtures.failed.model.evidence)
    } finally { h.close() }
  })
}

for (const operation of ["stop", "resume"] as const) test(`${operation} without an open card acknowledges before its attempt read and sends no control until it binds`, async () => {
  const snapshot = deferred<Response>()
  const calls: { url: string; method?: string }[] = []
  const h = await harness(async (url, init) => {
    calls.push({ url, method: init?.method })
    return init?.method === "POST" ? json({ state: "accepted", n: 12 }) : snapshot.promise
  })
  try {
    expect(await h.seam.controlTodo(12, operation)).toEqual({ value: "Requested" })
    expect(calls).toEqual([{ url: "https://install.test/api/todos/12", method: undefined }])
    expect(h.todo().payload.requests[0]?.state).toBe("requested")
    const initial = operation === "stop" ? fixtures.working.model : fixtures.paused.model
    snapshot.resolve(json(initial, 200))
    await waitFor(() => h.todo().payload.requests[0]?.state === "accepted")
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1)
    expect(h.todo().payload.requests[0]?.attempt).toBe(initial.run!.attempt)
    await h.seam.applyTodoProjection(12, operation === "stop" ? { ...initial, state: "paused", pause: fixtures.paused.model.pause }
      : { ...initial, state: "queued", pause: undefined })
    expect(h.outcomes.at(-1)).toMatchObject({ status: "ok", detail: operation === "stop" ? "Paused" : "Resumed" })
  } finally { h.close() }
})

test("Make TODO refuses a missing server digest before writing any Draft", async () => {
 const h = await harness(async () => json({state:"accepted",n:12}))
 try {
  expect(typeof await h.seam.draftFromIssue({number:7,title:"Issue",body:"Body",url:"https://github.com/acme/app/issues/7",comments:[]})).toBe("string")
  expect([...h.store.collections.cards.values()].filter(row => row.kind === "draft")).toHaveLength(0)
 } finally {h.close()}
})

test("pending Merge confirmation reconnects without resending, and a refused attempt permits retry", async () => {
  const calls: RequestInit[] = [], storage = memoryStorage()
  const id = "10000000-0000-4000-8000-000000000009"
  const row: MemberConfirmation = { id, command: "merge", state: "pending", revision: "item:1:h2", expires_at: "2099-01-01T00:00:00Z", payload: { input: { reviewed_head_sha: "h2" }, card: confirms.review_merge.model, effect: { todo: 12, request: `confirmation:${id}` } } }
  const http: SeamContext["http"] = async (_url, init) => { if (init?.method) calls.push(init); return json(fixtures.in_review.model, 200) }
  const h = await harness(http, storage)
  await h.seam.observeConfirmation(row)
  expect(h.todo().payload.requests[0]).toMatchObject({ operation: "merge", state: "accepted" })
  h.close()
  const restored = await harness(http, storage)
  try {
    restored.seam.resumeTodos()
    await restored.seam.observeConfirmation(row)
    expect(restored.todo().payload.requests).toHaveLength(1)
    expect(restored.outcomes).toEqual([])
    await restored.seam.observeConfirmation({ ...row, payload: { ...row.payload, effect: undefined, merge_attempt: 1 } })
    expect(restored.todo().payload.requests).toEqual([])
    await restored.seam.observeConfirmation({ ...row, payload: { ...row.payload, merge_attempt: 1 } })
    expect(restored.todo().payload.requests).toHaveLength(1)
    await restored.seam.applyTodoProjection(12, fixtures.merged.model)
    expect(restored.todo().payload.requests).toEqual([])
    expect(restored.outcomes.at(-1)).toMatchObject({ status: "ok", detail: "Merged" })
    expect(calls).toEqual([])
  } finally { restored.close() }
})

test("issue model drafting acknowledges unresolved work, freezes its snapshot and recovers the same private Draft", async () => {
  const source = { digest: "a".repeat(64), number: 7, title: "Original", body: "Original body", url: "https://github.com/owner/repo/issues/7", comments: [{ author: "carol", body: "Quoted comment" }] }
  let calls = 0
  let finish!: (draft: { title: string; prompt: string; acceptance: string[] }) => void
  const pending = new Promise<{ title: string; prompt: string; acceptance: string[] }>(resolve => { finish = resolve })
  const storage = memoryStorage()
  const first = await harness(async () => { throw Error("No admission while drafting") }, storage, undefined, true, undefined, async snapshot => {
    calls++; expect(snapshot).toEqual(source); return pending
  })
  expect(await first.seam.draftFromIssue(source)).toEqual({ value: "Requested" })
  expect(await first.seam.draftFromIssue({ ...source, body: "Later remote edit" })).toEqual({ value: "Requested" })
  expect(calls).toBe(1)
  expect(first.draft().payload.issuePreparation?.state).toBe("requested")
  expect(await first.seam.newTodo({ cardId: first.draft().id })).toBe("Issue draft is not ready.")
  await waitFor(() => first.store.collections.toasts.size > 0)
  expect(first.outcomes).toEqual([])
  const id = first.draft().id
  first.close()
  const restored = await harness(async () => { throw Error("No admission while drafting") }, storage, undefined, true, undefined, async snapshot => {
    expect(snapshot).toEqual(source)
    return { title: "Model title", prompt: "Model prompt", acceptance: ["Behavior verified"] }
  })
  try {
    restored.seam.resumeTodos()
    await waitFor(() => restored.draft().payload.issuePreparation?.state === "ready")
    expect(restored.draft().id).toBe(id)
    expect(restored.draft().payload).toMatchObject({ title: "Model title", prompt: "Model prompt", acceptance: ["Behavior verified"], issueDigest: source.digest })
    finish({ title: "Stale", prompt: "Stale", acceptance: [] })
    await settle()
    expect(restored.draft().payload.title).toBe("Model title")
    expect(restored.outcomes).toContainEqual({ key: `todo.request.${id}`, status: "ok", detail: "Drafted" })
  } finally { restored.close() }
})

test("failed issue model preparation is visible and retry uses the admitted snapshot", async () => {
  const source = { digest: "a".repeat(64), number: 7, title: "Original", body: "Body", url: "https://github.com/owner/repo/issues/7", comments: [] }
  let calls = 0
  const h = await harness(async () => json([]), memoryStorage(), undefined, true, undefined, async snapshot => {
    expect(snapshot).toEqual(source)
    if (++calls === 1) throw Error("Model unavailable")
    return { title: "Ready", prompt: "Prompt", acceptance: [] }
  })
  try {
    expect(await h.seam.draftFromIssue(source)).toEqual({ value: "Requested" })
    await waitFor(() => h.draft().payload.issuePreparation?.state === "failed")
    expect(h.draft().payload.issuePreparation?.error).toBe("Model unavailable")
    expect(await h.seam.newTodo({ cardId: h.draft().id })).toBe("Issue draft is not ready.")
    expect(await h.seam.draftFromIssue({ ...source, body: "Later edit" })).toEqual({ value: "Requested" })
    await waitFor(() => h.draft().payload.issuePreparation?.state === "ready")
    expect(calls).toBe(2)
  } finally { h.close() }
})

test("a Branch answer binds the listed question before its TODO card is opened", async () => {
  const calls: { url: string; body: unknown }[] = []
  const question = fixtures.needs_you.model.waits[0]!
  const h = await harness(async (url, init) => { calls.push({ url, body: JSON.parse(String(init?.body)) }); return json({ state: "accepted" }) }, memoryStorage(), undefined, false, undefined, undefined, [fixtures.needs_you.model])
  const stop = h.seam.list.subscribe(() => {})
  try {
    await waitFor(() => h.seam.list.get().todos !== undefined)
    expect(h.store.collections.cards.has("todo:12")).toBe(false)
    expect(await h.seam.answerTodo(12, "Include them", "stale-question")).toBe("Choose an open wait.")
    expect(calls).toEqual([])
    expect(await h.seam.answerTodo(12, "Include them", question.id)).toEqual({ value: "Requested" })
    await waitFor(() => calls.some(call => call.url.endsWith("/answer")))
    expect(calls[0]).toEqual({ url: "https://install.test/api/todos/12/answer", body: { answer: "Include them", wait: question.id } })
  } finally { stop(); h.close() }
})
