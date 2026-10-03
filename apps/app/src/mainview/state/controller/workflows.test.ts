import { expect, test } from "bun:test"
import type { RunSummaryRow } from "./gateway"
import { GATEWAY_REFUSED } from "./GatewayFailureCopy"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import { json, loadBox, memoryStorage, scriptedToolAgent, settle, waitFor } from "../TestFixtures"

const createAppController = scopedControllers()
const repo = "owner/launch-test"
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(options: { workflowPreparationTimeoutMs?: number; answer?: (path: string, method: string) => Response | undefined } = {}) {
  const disk = memoryStorage()
  let failNextWrite = false
  const storage = { ...disk, setItem: (key: string, value: string) => {
    if (failNextWrite) { failNextWrite = false; throw new Error("Request write refused") }
    disk.setItem(key, value)
  } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "launch-test", head: null }] }).isPersisted.promise
  await loadBox(store, repo)
  const calls: Array<{ procedure: string; payload: Record<string, unknown>; repo: string; workspaceId?: string }> = []
  let provision = async () => json(200, { status: "ready" })
  let provisions = 0
  let session = (): Response => json(200, { id: 1, username: "owner", is_admin: false })
  let run = async () => json(200, { ok: true, payload: { runId: "run-1" } })
  let status: RunSummaryRow["status"] = "running"
  let summaryRunId = "run-1"
  let failedVerdict = "The check failed."
  const summary = (): RunSummaryRow => ({ runId: summaryRunId, flowId: "review", status, createdAt: 1, updatedAt: status === "running" ? 2 : 3,
    turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 1, outputTokens: 1,
    verdict: status === "failed" ? failedVerdict : status, diagnosis: status })
  const chat = scriptedToolAgent([() => [{ type: "delta", kind: "text", text: "Still here." }, { type: "done", reason: "stop" }]])
  const services = { workflowPollMs: 5, workflowPreparationTimeoutMs: options.workflowPreparationTimeoutMs, toastAutoDismissMs: 60_000, fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/api/user")) return session()
    if (path.endsWith("/api/workflow/provision")) { provisions += 1; return provision() }
    const answered = options.answer?.(new URL(path, "http://app.test").pathname, init?.method ?? "GET")
    if (answered !== undefined) return answered
    if (!path.endsWith("/api/workflow/rpc")) return json(404, {})
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    if (body.procedure === "Plan") return json(200, { ok: true, payload: { planId: "plan-1", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } } })
    if (body.procedure === "Approval.Submit") return json(200, { ok: true, payload: {} })
    if (body.procedure === "Run") return run()
    if (body.procedure === "Projection.Snapshot") return json(200, { ok: true, payload: { rows: body.payload.selector._tag === "run-summary" ? [summary()] : [] } })
    return json(200, { ok: true, payload: { items: [] } })
  } }
  const controller = createAppController(store, chat.agent, services)
  const cards = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
  const toasts = () => [...store.collections.toasts.values()].filter(toast => toast.key.startsWith("flow.request."))
  return { store, storage, controller, services, calls, cards, toasts, chat,
    failNextWrite: () => { failNextWrite = true },
    provisions: () => provisions, session: (fn: typeof session) => { session = fn },
    provision: (fn: typeof provision) => { provision = fn }, run: (fn: typeof run) => { run = fn }, status: (value: RunSummaryRow["status"]) => { status = value },
    summaryRunId: (value: string) => { summaryRunId = value }, failedVerdict: (value: string) => { failedVerdict = value } }
}

test("an unclassified journal failure keeps its raw verdict on the card and uses the existing failure wording in the toast", async () => {
  const t = await fixture()
  try {
    t.failedVerdict("failed — no cause recorded in the journal")
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.toasts()[0]?.status === "running")
    t.status("failed")
    await waitFor(() => t.toasts()[0]?.status === "failed")
    expect(t.cards()[0]?.payload.error).toBe("failed — no cause recorded in the journal")
    expect(t.toasts()[0]?.detail).toBe("Something on Smithers' side failed. Not your fault, and nothing your request could have changed.")
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("a successful new run replaces the prior failed toast for the same workflow and repository", async () => {
  const t = await fixture()
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
    await waitFor(() => t.toasts()[0]?.status === "running")
    t.status("failed")
    await waitFor(() => t.cards()[0]?.payload.phase === "failed" && t.toasts()[0]?.status === "failed")
    const oldToast = t.toasts()[0]!.id
    t.summaryRunId("run-2")
    t.run(async () => json(200, { ok: true, payload: { runId: "run-2" } }))
    t.status("completed")
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.cards().some(card => card.payload.runId === "run-2" && card.payload.phase === "completed"))
    await waitFor(() => t.store.collections.toasts.get(oldToast)?.status === "ok")
    expect(t.toasts()).toHaveLength(1)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("repeated failed runs of the same work keep one retryable failure notice", async () => {
  const t = await fixture()
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.toasts()[0]?.status === "running")
    t.status("failed")
    await waitFor(() => t.cards()[0]?.payload.phase === "failed" && t.toasts()[0]?.status === "failed")
    const firstToast = t.toasts()[0]!.id
    t.summaryRunId("run-2")
    t.run(async () => json(200, { ok: true, payload: { runId: "run-2" } }))
    t.status("running")
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.cards().some(card => card.payload.runId === "run-2"))
    t.status("failed")
    await waitFor(() => t.cards().some(card => card.payload.runId === "run-2" && card.payload.phase === "failed") && t.toasts()[0]?.status === "failed")
    expect(t.toasts()).toHaveLength(1)
    expect(t.toasts()[0]?.id).toBe(firstToast)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("flow.run persists a request and returns during unresolved preparation; duplicate input and Chat stay usable", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const result = await Promise.race([t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
  expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested") })
  expect(t.cards()).toHaveLength(1)
  expect(t.cards()[0]!.payload.phase).toBe("launching")
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  expect(t.cards()).toHaveLength(1)
  t.controller.send("Are you still here?")
  await waitFor(() => t.chat.requests.length === 1 && t.store.session().phase === "idle")
  await waitFor(() => t.toasts()[0]?.status === "running")
  expect(t.calls).toHaveLength(0)
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
})

test("the shared 300 ms toast spans an unresolved launch and running job, and settles only on completion", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.run(() => gate.promise)
  const result = await Promise.race([t.controller.commands.run("flow.run", `review ${repo}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
  expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested") })
  expect(t.toasts()).toHaveLength(0)
  const id = t.cards()[0]!.id
  await waitFor(() => t.calls.some(call => call.procedure === "Run"))
  await waitFor(() => t.toasts()[0]?.status === "running")
  t.controller.send("Chat during launch")
  await waitFor(() => t.chat.requests.length === 1 && t.store.session().phase === "idle")
  gate.resolve(json(200, { ok: true, payload: { runId: "run-1" } }))
  await waitFor(() => t.cards()[0]?.payload.phase === "running")
  expect(t.cards()[0]!.id).toBe(id)
  expect(t.toasts()[0]?.status).toBe("running")
  t.controller.send("Chat during execution")
  await waitFor(() => t.chat.requests.length === 2 && t.store.session().phase === "idle")
  await t.controller.commands.run("flow.run", `review ${repo}`)
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  t.status("completed")
  await waitFor(() => t.toasts()[0]?.status === "ok")
  expect(t.cards()[0]?.payload.phase).toBe("completed")
})

test("workspace_starting retries the persisted request until the gateway serves it", async () => {
  const t = await fixture()
  let attempts = 0
  t.provision(async () => ++attempts < 3 ? new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }), { status: 503, headers: { "Retry-After": "0" } }) : json(200, { status: "ready" }))
  expect(await t.controller.commands.run("flow.run", `review ${repo}`)).toMatchObject({ status: "executed" })
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(attempts).toBe(3)
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  expect(t.cards()).toHaveLength(1)
})

test("a gateway that never becomes ready fails the durable request and can be retried", async () => {
  const t = await fixture({ workflowPreparationTimeoutMs: 500 })
  t.provision(async () => new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }),
    { status: 503, headers: { "Retry-After": "0" } }))
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.cards()[0]?.payload.phase === "failed" && t.toasts()[0]?.status === "failed")
    const card = t.cards()[0]!
    expect(card.payload.error).toContain("did not become ready")
    expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(0)
    t.provision(async () => json(200, { status: "ready" }))
    await t.controller.commands.run("flow.run.retry", card.id)
    await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
    expect(t.cards()[0]!.id).toBe(card.id)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("a refused launch stays visible and the existing retry flow retries the same request", async () => {
  const t = await fixture()
  t.run(async () => json(200, { ok: false, error: { message: "Provider unavailable", detail: { code: "provider_unavailable" } } }))
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  await waitFor(() => t.cards()[0]?.status === "error")
  const id = t.cards()[0]!.id
  // provider_unavailable is no control code, so the card reads the generic refusal, never the gateway's words.
  expect(t.cards()[0]!.payload.error).toBe(GATEWAY_REFUSED)
  expect(t.cards()[0]!.payload.error).not.toContain("Provider unavailable")
  t.run(async () => json(200, { ok: true, payload: { runId: "run-1" } }))
  await t.controller.commands.run("flow.run.retry", id)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()[0]!.id).toBe(id)
  const plans = t.calls.filter(call => call.procedure === "Plan")
  expect(plans).toHaveLength(2)
  expect(plans[0]!.payload.idempotencyKey).toBeString()
  expect(plans[1]!.payload.idempotencyKey).toBe(plans[0]!.payload.idempotencyKey)
  expect(plans[1]!.payload.input).toEqual({ args: "inspect" })
})

test("workspace_starting during Run retries the same admission instead of failing the request", async () => {
  const t = await fixture()
  let attempts = 0
  t.run(async () => ++attempts === 1
    ? new Response(JSON.stringify({ code: "workspace_starting", message: "Waking up" }), { status: 503, headers: { "Retry-After": "0" } })
    : json(200, { ok: true, payload: { runId: "run-1" } }))
  await t.controller.commands.run("flow.run", `review ${repo} {"args":"inspect"}`)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()).toHaveLength(1)
  expect(t.cards()[0]?.status).toBe("active")
  for (const procedure of ["Plan", "Approval.Submit", "Run"]) {
    const calls = t.calls.filter(call => call.procedure === procedure)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.payload.idempotencyKey).toBe(calls[1]!.payload.idempotencyKey)
  }
})

test("a refused launch whose error cannot be saved records a typed persistence failure and remains retryable", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.run(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.calls.some(call => call.procedure === "Run"))
  await waitFor(() => t.toasts()[0]?.status === "running")
  await t.store.settled?.()
  t.failNextWrite()
  gate.resolve(json(200, { ok: false, error: { message: "Provider unavailable", detail: { code: "provider_unavailable" } } }))
  await waitFor(() => t.toasts()[0]?.status === "failed")
  expect(t.cards()[0]?.payload.input?._workflowLaunch).toMatchObject({ error: {
    stage: "persistence", code: "request_persistence_failed", message: "The run request could not be saved. Try again."
  } })
  t.run(async () => json(200, { ok: true, payload: { runId: "run-1" } }))
  await t.controller.commands.run("flow.run.retry", t.cards()[0]!.id)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
})

test("reload reconnects a launch whose Run response was lost, using the same Plan and Run keys", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.run(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.calls.some(call => call.procedure === "Run"))
  await t.controller.dispose()
  await t.store.settled?.()
  const restored = await createAppStore({ kind: "localStorage", storage: t.storage })
  t.run(async () => json(200, { ok: true, payload: { runId: "run-1" } }))
  createAppController(restored, t.chat.agent, t.services)
  await waitFor(() => [...restored.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.runId === "run-1"))
  for (const procedure of ["Plan", "Run"]) {
    const requests = t.calls.filter(call => call.procedure === procedure)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.payload.idempotencyKey).toBeString()
    expect(requests[1]!.payload.idempotencyKey).toBe(requests[0]!.payload.idempotencyKey)
  }
  gate.resolve(json(200, { ok: true, payload: { runId: "stale-run" } }))
  await settle()
  expect([...restored.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(1)
})

test("reload resumes a pending launch once through the boot's same-owner identity read", async () => {
  const t = await fixture()
  const held = deferred<Response>()
  t.provision(() => held.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.provisions() === 1)
  await t.controller.dispose()
  await t.store.settled?.()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const store = await createAppStore({ kind: "localStorage", storage: t.storage })
  const controller = createAppController(store, t.chat.agent, t.services)
  try {
    await waitFor(() => t.provisions() === 2)
    await controller.loadSession()
    await settle()
    expect(t.provisions()).toBe(2)
    gate.resolve(json(200, { status: "ready" }))
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.runId === "run-1"))
    expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  } finally { await controller.dispose(); await store.dispose?.() }
})

test("reload of a running remote job restores its toast without launching again", async () => {
  const t = await fixture()
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  await t.controller.dispose()
  await t.store.settled?.()
  const store = await createAppStore({ kind: "localStorage", storage: t.storage })
  createAppController(store, t.chat.agent, t.services)
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.key.startsWith("flow.request.") && toast.status === "running"))
  expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  t.status("failed")
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.key.startsWith("flow.request.") && toast.status === "failed"))
  expect([...store.collections.cards.values()].find(card => card.kind === "run-trace")).toMatchObject({ payload: { phase: "failed", error: "The check failed." } })
})

test("late preparation from a different account never launches or replaces the new account's cards", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "different-owner", admin: false, scopesPlain: null }).isPersisted.promise
  gate.resolve(json(200, { status: "ready" }))
  await settle()
  expect(t.calls.filter(call => call.procedure === "Plan" || call.procedure === "Run")).toHaveLength(0)
  expect(t.toasts().some(toast => toast.status === "ok")).toBe(false)
})

test("refreshing the same signed-in identity does not reject an unresolved preparation", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await t.controller.commands.run("flow.run", `review ${repo}`)
  await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null }).isPersisted.promise
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.cards()[0]?.status).toBe("active")
})

/*
 * Window focus, a sibling tab and any 401 re-read the session. A re-read that
 * names the same owner is not an account change: the launch in flight keeps
 * its one request and its toast until the job settles.
 */
test("a same-owner focus re-read mid-preparation sends the launch once and keeps its toast until the job settles", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.provisions() === 1 && t.toasts()[0]?.status === "running")
    const toast = t.toasts()[0]!.id
    await t.controller.loadSession()
    await settle()
    expect(t.provisions()).toBe(1)
    expect(t.toasts().map(row => [row.id, row.status])).toEqual([[toast, "running"]])
    gate.resolve(json(200, { status: "ready" }))
    await waitFor(() => t.cards()[0]?.payload.phase === "running")
    await t.controller.loadSession()
    await settle()
    expect(t.provisions()).toBe(1)
    expect(t.calls.filter(call => call.procedure === "Plan")).toHaveLength(1)
    expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
    expect(t.toasts().map(row => [row.id, row.status])).toEqual([[toast, "running"]])
    t.status("completed")
    await waitFor(() => t.toasts()[0]?.status === "ok")
    expect(t.toasts()[0]?.id).toBe(toast)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("an unavailable focus re-read keeps the admitted launch, which completes once", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  t.session(() => json(503, { status: "error" }))
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.provisions() === 1)
    await t.controller.loadSession()
    expect(t.store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
    gate.resolve(json(200, { status: "ready" }))
    await waitFor(() => t.cards()[0]?.payload.phase === "running")
    t.status("completed")
    await waitFor(() => t.cards()[0]?.payload.phase === "completed")
    await settle()
    expect(t.toasts().filter(toast => toast.status !== "ok")).toEqual([])
    expect(t.provisions()).toBe(1)
    expect(t.calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("a focus re-read naming another owner supersedes the launch without preparing again", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  try {
    await t.controller.commands.run("flow.run", `review ${repo}`)
    await waitFor(() => t.provisions() === 1 && t.toasts()[0]?.status === "running")
    t.session(() => json(200, { id: 2, username: "different-owner", is_admin: false }))
    await t.controller.loadSession()
    gate.resolve(json(200, { status: "ready" }))
    await settle()
    expect(t.provisions()).toBe(1)
    expect(t.calls.filter(call => call.procedure === "Plan" || call.procedure === "Run")).toHaveLength(0)
    expect(t.toasts()).toHaveLength(0)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("simultaneous equivalent inputs across the user and agent bindings share one launch", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  await Promise.all([
    t.controller.runWorkflow("review", repo, { args: "inspect", count: 1 }),
    t.controller.commands.runForAgent("flow.run", `review ${repo} {"count":1,"args":"inspect"}`)
  ])
  expect(t.cards()).toHaveLength(1)
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.filter(call => call.procedure === "Plan")).toHaveLength(1)
})

test("an agent's first flow command keeps the user's in-flight plan and shares its request", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const plan = () => {
    const card = [...t.store.collections.cards.values()].find(candidate => candidate.kind === "flow-plan")
    return card?.kind === "flow-plan" ? card.payload : undefined
  }
  try {
    await t.controller.commands.run("flow.plan", `review ${repo}`)
    expect(plan()?.status).toBe("pending")
    await t.controller.commands.runForAgent("flow.run", `other ${repo}`)
    expect(plan()?.status).toBe("pending")
    expect(await t.controller.commands.runForAgent("flow.plan", `review ${repo}`))
      .toMatchObject({ status: "executed", value: `plan-requested flow=review repo=${repo}` })
    gate.resolve(json(200, { status: "ready" }))
    await waitFor(() => plan()?.status !== "pending")
    expect(plan()?.error).not.toBe("The app restarted before this plan came back.")
    expect(t.calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "review")).toHaveLength(1)
  } finally { await t.controller.dispose(); await t.store.dispose?.() }
})

test("a persisted request launches its admitted input even if the caller later changes its object", async () => {
  const t = await fixture()
  const gate = deferred<Response>()
  t.provision(() => gate.promise)
  const input = { args: "inspect", nested: { count: 1 }, _workflowLaunch: "flow-owned value" }
  await t.controller.runWorkflow("review", repo, input)
  input.args = "changed after admission"
  input.nested.count = 9
  gate.resolve(json(200, { status: "ready" }))
  await waitFor(() => t.cards()[0]?.payload.runId === "run-1")
  expect(t.calls.find(call => call.procedure === "Plan")?.payload.input).toEqual({ args: "inspect", nested: { count: 1 }, _workflowLaunch: "flow-owned value" })
})
