import { describe, expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"
import type { SeamContext } from "./SeamContext"
import { createTodoSeam, type DraftEntry, type TodoEntry, type TodoReceipt, type TodoTopics, type TodoSeamOptions } from "./TodoSeam"
import { fixtures } from "../../../../../../packages/rpc/test/fixtures/Todo"
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
const harness = async (http: SeamContext["http"], storage = memoryStorage(), actors?: TodoSeamOptions["actors"], live = true) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
  const observed = new Map<string, (model: unknown, receipts?: readonly TodoReceipt[]) => void>()
  let disposed = false
  const finalizers: (() => void)[] = []
  const topics: TodoTopics = { subscribe: (topic, receive) => { observed.set(topic, receive); return () => { observed.delete(topic) } } }
  const outcomes: unknown[] = []
  const context: SeamContext = {
    http: (url, init) => url.endsWith("/api/todos") && !init?.method
      ? Promise.resolve(json([fixtures.in_review.model, fixtures.merged.model, fixtures.dropped.model], 200)) : http(url, init), store, dispatch: store.dispatch, baseUrl: "https://install.test", actor: () => "user", nextOrdinal: store.nextOrdinal,
    isDisposed: () => disposed,
    resolveToast: (key, outcome) => { outcomes.push({ key, ...outcome }); store.dispatch({ type: "toast.resolved", actor: "system", key, status: outcome.status, detail: outcome.detail }) }
  }
  const seam = createTodoSeam(context, { actors, topics: live ? topics : undefined, debounceMs: 1, onDispose: fn => finalizers.push(fn) })
  return { store, seam, observed, outcomes, context, storage,
    draft: () => [...store.collections.cards.values()].find(row => row.kind === "draft") as DraftEntry,
    todo: () => store.collections.cards.get("todo:12") as TodoEntry,
    close: () => { disposed = true; finalizers.forEach(fn => fn()) } }
}

describe("TodoSeam — admission and live completion", () => {
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
        number: 7, title: "Webhooks fail on 502", body: "Webhooks fail on 502", url: "https://github.com/acme/app/issues/7",
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
        // SHA-256 of "Webhooks fail on 502\0Webhooks fail on 502", the install's mythicalIssueDigest.
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
      return JSON.parse(String(init?.body)).op === "answer" ? json({ code: "answered", class: "never", message: "Already answered", answered_by: "maya" }, 409) : json({ state: "requested", n: 12 })
    })
    try {
      await h.seam.applyTodoProjection(12, fixtures.needs_you.model)
      expect(await h.seam.answerTodo(12, "Keep my late text\nverbatim")).toEqual({ value: "Requested" })
      await waitFor(() => h.todo()?.payload.answeredBy === "maya")
      expect(h.todo().payload.answerDraft).toBe("Keep my late text\nverbatim")
      expect(h.outcomes).toHaveLength(1)
      expect(await h.seam.steerTodo(12, h.todo().payload.answerDraft!)).toEqual({ value: "Requested" })
      await waitFor(() => requests.length === 2)
      expect(requests[1]).toEqual({ url: "https://install.test/api/todos/12", body: { op: "steer", text: "Keep my late text\nverbatim" } })
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
      expect(JSON.parse(String(calls[0]!.body))).toEqual({ title: "An amendment", prompt: "An amendment", acceptance: [] })
    } finally { h.close() }
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
  const h = await harness(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)))
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
    expect(calls).toEqual([{ op: "answer", answer: "Approve", wait: approval.id }])
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
    await h.seam.applyTodoProjection(12, fixtures.merged.model)
    expect(h.todo().payload.requests).toEqual([])
    expect(h.outcomes).toHaveLength(1)
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
  const h = await harness(async () => json(body, 200), memoryStorage(), undefined, false)
  try {
    expect(await h.seam.showTodo(1)).toBeDefined()
    const card = h.store.collections.cards.get("todo:1") as TodoEntry
    expect(card.payload.model).toMatchObject({ n: 1, state: "queued", title: "First TODO", place: 1, prompt_revisions: [{ text: "Add a greeting to JOURNEY.md" }] })
    expect(await h.seam.reviewMerge(1)).toBe("Not in review yet")
  } finally { h.close() }
})
