import { describe, expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import type { SeamContext } from "./SeamContext"
import { createTodoSeam, type DraftEntry, type TodoEntry, type TodoReceipt, type TodoTopics, type TodoSeamOptions } from "./TodoSeam"
import { fixtures } from "../../../../../../packages/rpc/test/fixtures/Todo"

const json = (body: unknown, status = 202) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
// REST resources (spec §14.3), distinct from the card projection fixtures below.
const resource = (state: "queued" | "in_review" | "merged" | "dropped" = "queued") => ({
  n: 12, title: "Add the footer link", state, amendments: 0, lessons: 0,
  branch: { id: "b12", name: "smithers/add-the-footer-link" }, created_by: { kind: "person", id: 1 },
  seq: 1, created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z"
})
const admitted = () => ({ state: "requested", todo: resource() })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const harness = async (http: SeamContext["http"], storage = memoryStorage(), actors?: TodoSeamOptions["actors"]) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const observed = new Map<string, (model: unknown, receipts?: readonly TodoReceipt[]) => void>()
  let disposed = false
  const finalizers: (() => void)[] = []
  const topics: TodoTopics = { subscribe: (topic, receive) => { observed.set(topic, receive); return () => { observed.delete(topic) } } }
  const outcomes: unknown[] = []
  const context: SeamContext = {
    http: (url, init) => url.endsWith("/api/todos") && !init?.method
      ? Promise.resolve(json({ todos: [resource("in_review"), resource("merged"), resource("dropped")] }, 200)) : http(url, init), store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed,
    resolveToast: (key, outcome) => { outcomes.push({ key, ...outcome }); store.dispatch({ type: "toast.resolved", actor: "system", key, status: outcome.status, detail: outcome.detail }) }
  }
  const seam = createTodoSeam(context, { actors, topics, debounceMs: 1, onDispose: fn => finalizers.push(fn) })
  return { store, seam, observed, outcomes, context, storage,
    draft: () => [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry,
    todo: () => store.collections.cards.get("todo:12") as TodoEntry,
    close: () => { disposed = true; finalizers.forEach(fn => fn()) } }
}

describe("TodoSeam — admission and live completion", () => {
  test("append-only REST creation refuses before placement without an HTTP mutation", async () => {
    let mutations = 0
    const h = await harness(async () => { mutations++; return json(admitted()) })
    try {
      await h.seam.newTodo({ text: "First prompt", title: "Original", before: 12 })
      await waitFor(() => h.draft().payload.place.options.some(option => option.n === 12))
      expect(await h.seam.newTodo({ text: "First prompt", cardId: h.draft().id })).toBe("Before placement is unavailable.")
      expect(mutations).toBe(0)
      expect(h.draft().payload.request).toBeUndefined()
    } finally { h.close() }
  })

  // T-STK-01 Out: issue-derived creation belongs to T-STK-09; old drafts remain readable.
  test("an existing issue draft refuses before any HTTP mutation", async () => {
    let mutations = 0
    const h = await harness(async () => { mutations++; return json(admitted()) })
    try {
      await h.seam.newTodo({ text: "First prompt", title: "Original" })
      const row = h.draft()
      const issue = { number: 7, title: "Existing issue", url: "https://github.com/smithersai/smithers/issues/7", fixes: true }
      await h.store.dispatch({ type: "card.upsert", actor: "system", card: { ...row, payload: { ...row.payload, issue } } }).isPersisted.promise
      expect(await h.seam.newTodo({ text: "First prompt", cardId: row.id })).toBe("Making a TODO from an issue is unavailable.")
      expect(mutations).toBe(0)
      expect(h.draft().payload.request).toBeUndefined()
      expect(h.draft().payload.issue).toEqual(issue)
    } finally { h.close() }
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
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: "Changed", prompt: "First prompt", acceptance: "One\nTwo", place: "append" })
      expect(await h.seam.setTodoFormField(id, "prompt", "too late")).toBe("Commit is pending.")
      expect(h.outcomes).toEqual([])
      admission.resolve(json(admitted()))
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
  test("late answer keeps the text and answered_by, then steers it", async () => {
    const requests: { url: string; body: unknown }[] = []
    const h = await harness(async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return url.endsWith("/answer") ? json({ code: "answered", class: "never", message: "Already answered", answered_by: "maya" }, 409) : json({ state: "requested", n: 12 })
    })
    try {
      await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
      expect(await h.seam.answerTodo(12, "Keep my late text\nverbatim")).toEqual({ value: "Requested" })
      await waitFor(() => h.todo()?.payload.answeredBy === "maya")
      expect(h.todo().payload.answerDraft).toBe("Keep my late text\nverbatim")
      expect(h.outcomes).toHaveLength(1)
      expect(await h.seam.steerTodo(12, h.todo().payload.answerDraft!)).toEqual({ value: "Requested" })
      await waitFor(() => requests.length === 2)
      expect(requests[1]).toEqual({ url: "https://install.test/api/todos/12/steer", body: { text: "Keep my late text\nverbatim" } })
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
      expect(JSON.parse(String(init!.body))).toEqual({ steer: "Fix the schema" })
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
    const h = await harness(async () => json(admitted()), storage)
    await h.seam.newTodo({ text: "Persist me" })
    const id = h.draft().id
    await h.seam.newTodo({ text: "Persist me", cardId: id })
    await waitFor(() => h.draft().payload.request?.n === 12)
    const key = h.draft().payload.request!.key
    h.close()
    await h.store.dispose?.()
    const keys: string[] = []
    const restored = await harness(async (_url, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return json(admitted()) }, storage)
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
    const h = await harness(async (_url, init) => { calls.push(init!); return json(admitted()) })
    try {
      await h.seam.applyTodoProjection(12, fixtures.in_review.model)
      await h.seam.newTodo({ text: "An amendment" })
      const id = h.draft().id
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"amend","n":999}')).toBe("Choose an unmerged TODO.")
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"amend","n":12}')).toBeUndefined()
      expect(await h.seam.amendTodo({ n: 12, text: "An amendment", cardId: id })).toEqual({ value: "Requested" })
      await waitFor(() => calls.length === 1)
      expect(calls[0]!.method).toBe("PATCH")
      expect(JSON.parse(String(calls[0]!.body))).toEqual({ title: "An amendment", prompt: "An amendment", acceptance: "" })
    } finally { h.close() }
  })
  test("sign-out fences HTTP and topic replies and disposes subscriptions", async () => {
    const response = deferred<Response>()
    const h = await harness(() => response.promise)
    try {
      await h.seam.controlTodo(12, "stop")
      const receive = h.observed.get("todo:12")!
      h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null })
      response.resolve(json(admitted()))
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
      second.resolve(json(admitted()))
    } finally { h.close() }
  })
  test("uncommitted Discard removes only the author's draft; field validation cannot alter server place options", async () => {
    const h = await harness(async () => json(admitted()))
    try {
      await h.seam.newTodo({ text: "Private draft" })
      const id = h.draft().id
      await waitFor(() => h.draft().payload.place.options.length > 0)
      expect(h.draft().payload.place.options.map(row => row.n)).toEqual([12])
      expect(await h.seam.setTodoFormField(id, "place", '{"mode":"before","n":999,"options":[{"n":999,"title":"Forged","state":"working"}]}')).toBe("Choose an unmerged TODO.")
      expect(await h.seam.setTodoFormField(id, "place", "invalid JSON")).toBe("Invalid draft value.")
      expect(await h.seam.setTodoFormField(id, "unknown", "x")).toBe("Unknown draft field.")
      expect(h.seam.dismissTodoDraft(id)).toBeUndefined()
      expect(h.store.collections.cards.get(id)).toBeUndefined()
    } finally { h.close() }
  })
  test("TODO reads validate the topic number, and a malformed admission stays retryable", async () => {
    const h = await harness(async (_url, init) => init?.method ? json({ state: "done", n: 12 }) : json(resource("in_review"), 200))
    try {
      const result = await h.seam.showTodo(12)
      if (!result || typeof result === "string") throw new Error("Expected a TODO read")
      expect(JSON.parse(result.value)).toEqual(resource("in_review"))
      expect(h.todo().payload.model).toMatchObject({ n: 12, title: resource().title, state: "in_review" })
      await expect(h.seam.applyTodoProjection(13, fixtures.in_review.model)).rejects.toThrow("Invalid input: expected 13")
      await h.seam.controlTodo(12, "stop")
      await waitFor(() => h.todo().payload.requests[0]?.state === "failed")
      expect(h.todo().payload.requests[0]?.error).toBe("TODO admission was not confirmed.")
    } finally { h.close() }
  })

})

test("multiple waits require a target and persist the exact answer wait in HTTP", async () => {
  const calls: unknown[] = []
  const h = await harness(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)))
    return json(admitted())
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
    expect(calls).toEqual([{ answer: "Approve", wait: approval.id }])
  } finally { h.close() }
})

// Recorded attribution crosses the real seam transport and persistence boundary; credential issuance is T-ACC-04.
test("TODO HTTP keeps actor references; live projections normalize historical delegated authors", async () => {
  const { actorName } = await import("../ProductActor")
  const { PlaceholderAvatarUrl } = await import("@smthrs/rpc/CardPrimitives")
  const by = { person: "member-ben", via: "claude-code", session: "cc-7" }
  const projection = { ...fixtures.working.model, steers: [{ text: "Steer", by, at: "now" }],
    first_answer: { text: "Answer", by, at: "now" }, prompt_revisions: [{ text: "Amend", acceptance: [], by, at: "now" }] }
  const rest = { ...resource(), created_by: { kind: "person", id: 1, via: "claude-code", session: "cc-7" } }
  const h = await harness(async () => json(rest, 200), memoryStorage(), () => ({ roster: [
    { id: "member-ben", login: "ben", name: "Ben", avatar_url: PlaceholderAvatarUrl, color_index: 3 }
  ] }))
  try {
    const read = await h.seam.showTodo(12)
    if (!read || typeof read === "string") throw new Error("Expected a TODO read")
    expect(JSON.parse(read.value).created_by).toEqual(rest.created_by)
    h.observed.get("todo:12")!(projection)
    await waitFor(() => h.todo().payload.model !== undefined)
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

// GET must populate the existing card before any live topic callback (spec §6.3).
test("opening a TODO applies its REST snapshot and retains pending requests", async () => {
  const h = await harness(async () => json({ ...resource("merged"), title: "Already merged",
    issue: { number: fixtures.working.model.issue!.number, fixes: false } }, 200))
  try {
    await h.seam.applyTodoProjection(12, fixtures.working.model)
    const pending = { key: "held", owner: "ben", operation: "steer" as const, n: 12, body: { text: "Later" }, state: "requested" as const }
    const row = h.todo()
    await h.store.dispatch({ type: "card.upsert", actor: "system", card: { ...row, payload: { ...row.payload, requests: [pending] } } }).isPersisted.promise
    const opened = await h.seam.showTodo(12)
    expect(opened).toMatchObject({ value: expect.any(String) })
    expect(h.todo().title).toBe("Already merged")
    expect(h.todo().payload.model?.state).toBe("merged")
    expect(h.todo().status).toBe("acted")
    expect(h.todo().payload.requests).toEqual([pending])
    expect(h.todo().payload.model?.issue).toEqual({ ...fixtures.working.model.issue!, fixes: false })
  } finally { h.close() }
})

// Without live transport, GET is the initial card authority (§6.3).
test("opening a TODO without topics creates a card and resolves REST authors", async () => {
  const { PlaceholderAvatarUrl } = await import("@smthrs/rpc/CardPrimitives")
  const { actorName } = await import("../ProductActor")
  const actors = () => ({ roster: [{ id: "1", login: "ben", name: "Ben", avatar_url: PlaceholderAvatarUrl, color_index: 3 }] })
  const rest = { ...resource("dropped"), owner: 1, title: "Closed TODO", revisions: [
    { rev: 1, prompt: "Original", acceptance: "Verified", reason: "create", author: { kind: "person", id: 1 }, at: "now" }
  ] }
  const h = await harness(async () => json(rest, 200))
  const seam = createTodoSeam(h.context, { actors })
  try {
    expect(await seam.showTodo(12)).toMatchObject({ value: expect.any(String) })
    expect(h.todo().title).toBe("Closed TODO")
    expect(h.todo().status).toBe("acted")
    expect(h.todo().payload.model?.state).toBe("dropped")
    expect(h.todo().payload.model?.owner.name).toBe("Ben")
    expect(h.todo().payload.model?.prompt_revisions[0]?.text).toBe("Original")
    expect(actorName(h.todo().payload.model!.prompt_revisions[0]!.by)).toBe("Ben")
    expect(h.observed.size).toBe(0)
  } finally { h.close() }
})

// A GET captured before an observed live projection must not overwrite it (§6.3).
test("an older REST snapshot cannot replace a newer live projection", async () => {
  const pending = deferred<Response>()
  let reads = 0
  const h = await harness(async () => ++reads === 1 ? json(resource(), 200) : pending.promise)
  try {
    await h.seam.showTodo(12)
    const opening = h.seam.showTodo(12)
    h.observed.get("todo:12")!({ ...fixtures.working.model, title: "Current live title" })
    await waitFor(() => h.todo().title === "Current live title")
    pending.resolve(json({ ...resource(), title: "Earlier snapshot" }, 200))
    await opening
    expect(h.todo().title).toBe("Current live title")
    expect(h.todo().payload.model?.state).toBe("working")
  } finally { h.close() }
})

test("the latest concurrent TODO read wins when REST responses arrive out of order", async () => {
  const first = deferred<Response>(), second = deferred<Response>()
  let reads = 0
  const h = await harness(async () => ++reads === 1 ? first.promise : second.promise)
  try {
    const older = h.seam.showTodo(12), newer = h.seam.showTodo(12)
    second.resolve(json({ ...resource("merged"), seq: 2, title: "Latest read" }, 200))
    await newer
    first.resolve(json({ ...resource(), title: "Earlier read" }, 200))
    expect(await older).toBeUndefined()
    expect(h.todo().title).toBe("Latest read")
    expect(h.todo().status).toBe("acted")
  } finally { h.close() }
})

test("an obsolete TODO read failure cannot report over a newer successful read", async () => {
  let reject!: (error: unknown) => void
  const first = new Promise<Response>((_resolve, fail) => { reject = fail })
  let reads = 0
  const h = await harness(async () => ++reads === 1 ? first : json({ ...resource("merged"), seq: 2 }, 200))
  try {
    const older = h.seam.showTodo(12)
    await h.seam.showTodo(12)
    reject(new TypeError("Earlier request failed"))
    expect(await older).toBeUndefined()
    expect(h.todo().status).toBe("acted")
  } finally { h.close() }
})
