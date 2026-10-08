import { expect, test } from "bun:test"
import { fixtures } from "@smthrs/rpc/fixtures/Confirm"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import type { TopicSnapshot } from "../../runtime/LiveChannel"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, waitFor } from "../TestFixtures"
import { createConfirmationSeam } from "./ConfirmationSeam"
import type { SeamContext } from "./SeamContext"

const id = "10000000-0000-4000-8000-000000000001"
const pending: MemberConfirmation = { id, state: "pending", command: "todo.drop", revision: "item:2", expires_at: "2099-01-01T00:00:00Z",
  payload: { input: { op: "drop" }, card: { ...fixtures.one_click.model, action: { tag: "todo.drop", verb: "Drop" }, subject: { kind: "todo", ref: "T12", revision: "item:2" } } } }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const harness = async (http: SeamContext["http"], actor: "user" | "smithers" = "user", ready = true) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", memberId: 17, admin: false, scopesPlain: null }).isPersisted.promise
  let snapshot: TopicSnapshot = { topic: "confirmations:17", data: [pending] }
  const listeners = new Set<() => void>(), topics: string[] = [], observed: MemberConfirmation[] = [], outcomes: unknown[] = []
  const context: SeamContext = { store, dispatch: store.dispatch, http, baseUrl: "https://install.test", actor: () => actor, nextOrdinal: store.nextOrdinal,
    resolveToast: (key, result) => { outcomes.push({ key, ...result }); store.dispatch({ type: "toast.resolved", actor: "system", key, status: result.status, detail: result.detail }) } }
  const seam = createConfirmationSeam(context, { ready, debounceMs: 1,
    live: { getSnapshot: () => snapshot, subscribe: (topic, listener) => { topics.push(topic); listeners.add(listener); return () => { listeners.delete(listener) } } },
    observe: async row => { observed.push(row) } })
  return { seam, store, topics, observed, outcomes, context, listeners,
    publish: (next: TopicSnapshot) => { snapshot = next; for (const listener of [...listeners]) listener() } }
}

test("a person press returns before HTTP, deduplicates, and never settles work from admission", async () => {
  const request = deferred<Response>(), calls: { path: string; init?: RequestInit }[] = []
  const h = await harness((path, init) => { calls.push({ path, init }); return request.promise })
  try {
    expect(h.topics).toEqual(["confirmations:17"])
    expect(h.seam.decide(id, "approved")).toBeUndefined()
    h.seam.decide(id, "approved"); h.seam.decide(id, "denied")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe(`https://install.test/api/confirmations/${id}/approve`)
    expect(calls[0]!.init?.credentials).toBe("same-origin")
    expect(new Headers(calls[0]!.init?.headers).get("Idempotency-Key")).toBe(`confirmation:${id}:approved`)
    await waitFor(() => h.store.collections.toasts.size === 1)
    request.resolve(Response.json({ id, state: "approved" }))
    await settle()
    expect(h.outcomes).toEqual([])
    expect(h.observed).toEqual([])
    expect(h.store.collections.cards.size).toBe(0)
    const approved: MemberConfirmation = { ...pending, state: "approved", payload: { ...pending.payload, effect: { todo: 12, request: `confirmation:${id}` } } }
    h.publish({ topic: "confirmations:17", data: [approved] })
    await waitFor(() => h.observed.length === 1)
    expect(h.observed[0]).toEqual(approved)
    expect(h.outcomes).toEqual([])
  } finally { h.seam.dispose() }
})

test("a refused press stays retryable with the same key and endpoint", async () => {
  const keys: string[] = []
  const h = await harness(async (_path, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key")!)
    return Response.json({ class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable" }, { status: 503 })
  })
  try {
    h.seam.decide(id, "approved"); await waitFor(() => h.outcomes.length === 1)
    h.seam.decide(id, "approved"); await waitFor(() => h.outcomes.length === 2)
    expect(keys).toEqual([`confirmation:${id}:approved`, `confirmation:${id}:approved`])
    expect(h.outcomes[0]).toMatchObject({ status: "failed", action: { flow: "approval.approve", args: `confirmation:${id}` } })
    expect(h.observed).toEqual([])
  } finally { h.seam.dispose() }
})

test("Cancel uses deny and settles cancellation without observing a TODO", async () => {
  const paths: string[] = []
  const h = await harness(async path => { paths.push(path); return Response.json({ id, state: "rejected" }) })
  try {
    h.seam.decide(id, "denied"); await waitFor(() => h.outcomes.length === 1)
    expect(paths).toEqual([`https://install.test/api/confirmations/${id}/deny`])
    expect(h.outcomes[0]).toMatchObject({ status: "cancelled", detail: "Cancelled" })
    expect(h.observed).toEqual([])
  } finally { h.seam.dispose() }
})

test.each(["smithers", "unavailable", "foreign", "forbidden"] as const)("%s cannot send a confirmation press", async kind => {
  let calls = 0
  const h = await harness(async () => { calls++; return Response.json({}) }, kind === "smithers" ? "smithers" : "user", kind !== "unavailable")
  try {
    if (kind === "forbidden") h.publish({ topic: "confirmations:17", error: "forbidden" })
    h.seam.decide(kind === "foreign" ? "10000000-0000-4000-8000-000000000002" : id, "approved")
    await settle()
    expect(calls).toBe(0)
  } finally { h.seam.dispose() }
})

test("account change aborts a press and fences its late reply", async () => {
  const request = deferred<Response>(); let signal: AbortSignal | null | undefined
  const h = await harness(async (_path, init) => { signal = init?.signal; return request.promise })
  try {
    h.seam.decide(id, "approved")
    await h.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", memberId: 23, admin: false, scopesPlain: null }).isPersisted.promise
    expect(signal?.aborted).toBe(true)
    request.resolve(Response.json({ id, state: "approved" })); await settle()
    expect(h.outcomes).toEqual([])
    expect(h.observed).toEqual([])
    expect(h.topics).toEqual(["confirmations:17", "confirmations:23"])
  } finally { h.seam.dispose() }
})

test("another tab's decision wins over an unresolved press and cannot resurrect its toast", async () => {
  const request = deferred<Response>()
  const h = await harness(async () => request.promise)
  try {
    h.seam.decide(id, "approved")
    h.publish({ topic: "confirmations:17", data: [{ ...pending, state: "rejected" }] })
    await waitFor(() => h.outcomes.length === 1)
    request.resolve(Response.json({ id, state: "approved" })); await settle()
    expect(h.outcomes).toHaveLength(1)
    expect(h.outcomes[0]).toMatchObject({ status: "cancelled" })
    expect(h.store.collections.toasts.size).toBe(0)
  } finally { h.seam.dispose() }
})

test.each([{}, { id: "another", state: "approved" }, { id, state: "pending" }])("malformed admission %p cannot settle a press", async body => {
  const h = await harness(async () => Response.json(body))
  try { h.seam.decide(id, "approved"); await waitFor(() => h.outcomes.length === 1); expect(h.outcomes[0]).toMatchObject({ status: "failed" }); expect(h.observed).toEqual([]) }
  finally { h.seam.dispose() }
})

test("202 admission keeps the mounted card's press running until the private subject observation", async () => {
  const { memberConfirmCardProps } = await import("../../cards/ApprovalCard")
  let calls = 0
  const h = await harness(async (_path, init) => {
    calls++
    expect(JSON.parse(String(init?.body))).toEqual({ subject: { kind: "todo", ref: "T12", revision: "item:2" }, revision: "item:2" })
    return Response.json({ id, state: "pending" }, { status: 202 })
  })
  try {
    const props = memberConfirmCardProps(pending, (tag, input) => {
      expect(String(tag)).toBe("approval.approve")
      expect(input as unknown).toEqual({ cardId: `confirmation:${id}` })
      h.seam.decide(id, "approved")
    })
    props.onAction("approval.approve")
    await waitFor(() => h.store.collections.toasts.size === 1)
    await settle()
    props.onAction("approval.approve")
    expect(calls).toBe(1)
    expect(h.outcomes).toEqual([])
    expect(h.observed).toEqual([])
    h.publish({ topic: "confirmations:17", data: [{ ...pending, state: "approved", payload: { ...pending.payload, effect: { todo: 12, request: `confirmation:${id}` } } }] })
    await waitFor(() => h.observed.length === 1)
    // The existing TODO observer, not the admission response, owns completion.
    expect(h.outcomes).toEqual([])
  } finally { h.seam.dispose() }
})

test.each(["todo", "branch", "flow", "agent", "wiki"] as const)("%s press carries the exact subject and bound revision", async kind => {
  let body: unknown
  const h = await harness(async (_path, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id, state: "pending" }, { status: 202 }) })
  try {
    h.publish({ topic: "confirmations:17", data: [{ ...pending, payload: { ...pending.payload, card: { ...pending.payload.card, subject: { kind, ref: "subject", revision: "revision-2" } } } }] })
    h.seam.decide(id, "approved")
    await waitFor(() => body !== undefined)
    expect(body).toEqual({ subject: { kind, ref: "subject", revision: "revision-2" }, revision: "item:2" })
  } finally { h.seam.dispose() }
})


test("retry replaces failure with running progress and keeps a successful admission deduplicated", async () => {
  const retry = deferred<Response>()
  let calls = 0
  const h = await harness(async () => ++calls === 1
    ? Response.json({ message: "Confirmation unavailable" }, { status: 503 })
    : retry.promise)
  try {
    h.seam.decide(id, "approved")
    await waitFor(() => h.outcomes.length === 1)
    expect(h.store.collections.toasts.get(`toast-todo.request.confirmation:${id}`)?.status).toBe("failed")
    h.seam.decide(id, "approved")
    await waitFor(() => h.store.collections.toasts.get(`toast-todo.request.confirmation:${id}`)?.status === "running")
    retry.resolve(Response.json({ id, state: "approved" }))
    await settle()
    h.seam.decide(id, "approved")
    expect(calls).toBe(2)
    expect(h.outcomes).toHaveLength(1)
    h.publish({ topic: "confirmations:17", data: [{ ...pending, state: "approved", payload: { ...pending.payload, effect: { todo: 12, request: `confirmation:${id}` } } }] })
    await waitFor(() => h.observed.length === 1)
    expect(h.outcomes).toHaveLength(1)
  } finally { h.seam.dispose() }
})

test("Merge admission stays pending, observes its subject, and a definitive refusal permits a fresh press", async () => {
  const keys: string[] = []
  const h = await harness(async (_path, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")!); return Response.json({ id, state: "pending" }, { status: 202 }) })
  const row: MemberConfirmation = { ...pending, command: "merge", payload: { input: { reviewed_head_sha: "h2" }, card: fixtures.review_merge.model } }
  try {
    h.publish({ topic: "confirmations:17", data: [row] })
    h.seam.decide(id, "approved")
    await waitFor(() => h.store.collections.toasts.size === 1)
    const admitted = { ...row, payload: { ...row.payload, effect: { todo: 12, request: `confirmation:${id}` } } }
    h.publish({ topic: "confirmations:17", data: [admitted] })
    await waitFor(() => h.observed.some(item => item.payload.effect))
    expect(h.outcomes).toEqual([])
    h.seam.decide(id, "approved"); expect(keys).toHaveLength(1)
    const refused: MemberConfirmation = { ...row, payload: { ...row.payload, merge_attempt: 1, card: { ...row.payload.card, review: { ...row.payload.card.review!, merge: { state: "ready", detail: "GitHub refused this press", on_github: true } } } } }
    h.publish({ topic: "confirmations:17", data: [refused] })
    await waitFor(() => h.outcomes.length === 1)
    expect(h.outcomes[0]).toMatchObject({ status: "failed", detail: "GitHub refused this press" })
    h.seam.decide(id, "approved")
    await waitFor(() => keys.length === 2)
    expect(keys).toEqual([`confirmation:${id}:approved:0`, `confirmation:${id}:approved:1`])
  } finally { h.seam.dispose() }
})


test("Wiki Delete keeps progress through the press and settles from its committed private receipt", async () => {
  const request = deferred<Response>()
  const h = await harness(async () => request.promise)
  const wiki: MemberConfirmation = { ...pending, command: "wiki.delete", revision: "7:2", payload: { input: { owner: "ben", repo: "app" },
    card: { ...pending.payload.card, action: { tag: "wiki.delete", verb: "Delete" }, subject: { kind: "wiki", ref: "home", revision: "7:2" } } } }
  try {
    h.publish({ topic: "confirmations:17", data: [wiki] })
    h.seam.decide(id, "approved")
    await waitFor(() => h.store.collections.toasts.size === 1)
    expect(h.outcomes).toEqual([])
    request.resolve(Response.json({ id, state: "approved" }))
    await settle()
    expect(h.outcomes).toEqual([])
    h.publish({ topic: "confirmations:17", data: [{ ...wiki, state: "approved", payload: { ...wiki.payload,
      card: { ...wiki.payload.card, receipt: { ...fixtures.done.model.receipt!, text: "Deleted" } } } }] })
    await waitFor(() => h.outcomes.length === 1)
    expect(h.outcomes).toEqual([{ key: `todo.request.confirmation:${id}`, status: "ok", detail: "Deleted" }])
    expect(h.store.collections.toasts.get(`toast-todo.request.confirmation:${id}`)?.status).toBe("ok")
  } finally { h.seam.dispose() }
})

test.each(["completed", "failed", "cancelled", "uncertain"] as const)("issue comment %s settles only from the private worker projection and survives reload", async state => {
  const request = deferred<Response>()
  const h = await harness(async () => request.promise)
  const row: MemberConfirmation = { ...pending, command: "issue.comment", payload: { input: { body: "Ready" }, card: fixtures.issue.model } }
  const effect = { issue_comment: "20000000-0000-4000-8000-000000000001", request: `confirmation:${id}`, state: "running" as const }
  const running: MemberConfirmation = { ...row, state: "approved", payload: { ...row.payload, effect } }
  try {
    h.publish({ topic: "confirmations:17", data: [row] })
    h.seam.decide(id, "approved"); h.seam.decide(id, "approved")
    await waitFor(() => h.store.collections.toasts.size === 1)
    request.resolve(Response.json({ id, state: "approved" })); await settle()
    expect(h.outcomes).toEqual([])
    h.publish({ topic: "confirmations:17", data: [running] }); await settle()
    expect(h.outcomes).toEqual([])
    expect(h.observed).toEqual([])
    const recovered = await harness(async () => { throw Error("Reload must not launch another comment") })
    try {
      recovered.publish({ topic: "confirmations:17", data: [running] })
      await waitFor(() => recovered.store.collections.toasts.size === 1)
      expect(recovered.outcomes).toEqual([])
      const terminal: MemberConfirmation = { ...running, payload: { ...running.payload, effect: { ...effect, state } } }
      for (const target of [h, recovered]) {
        target.publish({ topic: "confirmations:17", data: [terminal] })
        await waitFor(() => target.outcomes.length === 1)
        expect(target.outcomes[0]).toMatchObject({ status: state === "completed" ? "ok" : state === "cancelled" ? "cancelled" : "failed" })
        target.publish({ topic: "confirmations:17", data: [terminal] }); await settle()
        expect(target.outcomes).toHaveLength(1)
      }
    } finally { recovered.seam.dispose() }
  } finally { h.seam.dispose() }
})
