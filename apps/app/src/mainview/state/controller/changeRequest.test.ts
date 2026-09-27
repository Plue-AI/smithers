import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { json, memoryStorage, scriptedToolAgent, waitFor } from "../TestFixtures"
import { scopedControllers } from "../ControllerTestScope"
import { launchSourceOf, workflowLaunchOf } from "../WorkflowLaunch"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createWorkflowLaunchController } from "./workflow-launch"
import type { RunSummaryRow } from "./gateway"
import { CODING_REQUEST_EVENTS, CODING_REQUEST_ID } from "../../cards/fixtures/CodingVibe"
import { blockedCodingJournal } from "../../cards/fixtures/CodingJournal"
import { unavailableAgent } from "../TestFixtures"

/*
 * change.request (#1723): a change typed in chat is one durable request that
 * runs coding/request and, only once its own journal proves it validated,
 * continues into coding/vibe, which lands it.
 */
const repo = "owner/repo", workspaceId = "11111111-1111-4111-8111-111111111111"
const summary = (runId: string, flowId: string, status: RunSummaryRow["status"]): RunSummaryRow => ({ runId, flowId, status, createdAt: 1, updatedAt: 2,
  turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status })
const observe = (store: AppStore, runId: string, flowId: string, status: RunSummaryRow["status"], events?: ReadonlyArray<Record<string, unknown>>) =>
  store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
    scope: { repo, workspaceId, runId }, summary: summary(runId, flowId, status),
    ...(events === undefined ? {} : { journal: { mode: "full", events: [...events] }, journalComplete: true })
  } as never }).isPersisted.promise
const runCards = (store: AppStore) => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
const toasts = (store: AppStore) => [...store.collections.toasts.values()]

async function launchFixture(launch: (workflow: string) => Promise<{ status: "ok"; value: { runId: string } } | { status: "error"; message: string; code?: string }>) {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { workflowPollMs: 1, toastDebounceMs: 1, toastAutoDismissMs: 60_000 })
  const launched: string[] = []
  ctx.gateway = { ...ctx.gateway, launch: async (_repo: string, workflow: string) => { launched.push(workflow); return launch(workflow) },
    listFlows: async () => ({ status: "ok", value: [] }) } as unknown as typeof ctx.gateway
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const controller = createWorkflowLaunchController(ctx, () => 1, async () => {}, async () => true)
  const start = () => controller.start({ repo, binding: { workspaceId }, workflow: "coding/request", input: { prompt: "Fix the typo" }, actor: "user", then: "coding/vibe" })
  return { store, ctx, controller, launched, start, dispose: async () => { await ctx.dispose(); await store.dispose?.() } }
}

test("a validated coding/request continues into one coding/vibe with its execution, and only vibe's completion lands the change", async () => {
  const t = await launchFixture(async workflow => ({ status: "ok", value: { runId: workflow === "coding/request" ? "run-1" : "vibe-run" } }))
  try {
    expect(await t.start()).toEqual({ value: expect.stringContaining("run-requested workflow=coding/request") })
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "run-1"))
    await observe(t.store, "run-1", "coding/request", "running")
    await waitFor(() => toasts(t.store).some(toast => toast.status === "running"))
    expect(t.launched).toEqual(["coding/request"])
    await observe(t.store, "run-1", "coding/request", "completed", CODING_REQUEST_EVENTS)
    await waitFor(() => t.launched.length === 2)
    expect(t.launched).toEqual(["coding/request", "coding/vibe"])
    const vibe = runCards(t.store).find(card => card.payload.workflow === "coding/vibe")!
    expect(workflowLaunchOf(vibe)?.input).toEqual({ requestExecutionId: CODING_REQUEST_ID })
    await waitFor(() => vibe.id === `flow-request-${workflowLaunchOf(runCards(t.store).find(card => card.payload.runId === "run-1"))?.next}`)
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "vibe-run"))
    // The request validated; landing is still pending, so the vibe toast is running.
    await waitFor(() => toasts(t.store).some(toast => toast.status === "running" && toast.title.startsWith("coding/vibe")))
    await observe(t.store, "vibe-run", "coding/vibe", "completed")
    await waitFor(() => toasts(t.store).every(toast => toast.status === "ok"))
    // A second observer of the same completed request resumes, never relaunches.
    t.controller.resume()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(t.launched).toEqual(["coding/request", "coding/vibe"])
  } finally { await t.dispose() }
})

test("a request that completes without validation fails visibly, starts no vibe, and a new submission retries", async () => {
  const t = await launchFixture(async () => ({ status: "ok", value: { runId: "run-1" } }))
  try {
    await t.start()
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "run-1"))
    await observe(t.store, "run-1", "coding/request", "completed", blockedCodingJournal())
    await waitFor(() => toasts(t.store).some(toast => toast.status === "failed"))
    expect(toasts(t.store).find(toast => toast.status === "failed")?.detail).toContain("The required fast check failed.")
    expect(t.launched).toEqual(["coding/request"])
    expect(runCards(t.store).some(card => card.payload.workflow === "coding/vibe")).toBe(false)
    // The finished request is not in flight: the same words make a new request.
    const again = await t.start()
    expect(again).toEqual({ value: expect.stringContaining("run-requested") })
    await waitFor(() => t.launched.length === 2)
    expect(runCards(t.store).filter(card => card.payload.workflow === "coding/request")).toHaveLength(2)
  } finally { await t.dispose() }
})

test("a refused vibe launch stays visible on its own card and the retry door relaunches it", async () => {
  let refuse = true
  const t = await launchFixture(async workflow => workflow === "coding/vibe" && refuse
    ? { status: "error", code: "launch_unavailable", message: "The workspace refused the landing." }
    : { status: "ok", value: { runId: workflow === "coding/request" ? "run-1" : "vibe-run" } })
  try {
    await t.start()
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "run-1"))
    await observe(t.store, "run-1", "coding/request", "completed", CODING_REQUEST_EVENTS)
    await waitFor(() => runCards(t.store).some(card => card.payload.workflow === "coding/vibe" && card.status === "error"))
    const vibe = runCards(t.store).find(card => card.payload.workflow === "coding/vibe")!
    expect(vibe.payload.error).toBe("The workspace refused the landing.")
    // Never reported as landed: the request's toast states only that it completed.
    expect(toasts(t.store).filter(toast => toast.status === "ok").map(toast => toast.title)).toEqual(["coding/request completed"])
    expect(toasts(t.store).find(toast => toast.status === "failed")).toMatchObject({
      title: "coding/vibe", detail: "The workspace refused the landing." })
    refuse = false
    expect(t.controller.retry(vibe.id)).toBe(true)
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "vibe-run"))
    expect(t.launched).toEqual(["coding/request", "coding/vibe", "coding/vibe"])
  } finally { await t.dispose() }
})

test("a landing the plan card's Vibe button already requested is adopted, never launched twice", async () => {
  const t = await launchFixture(async workflow => ({ status: "ok", value: { runId: workflow === "coding/request" ? "run-1" : "vibe-run" } }))
  try {
    await t.start()
    await waitFor(() => runCards(t.store).some(card => card.payload.runId === "run-1"))
    await t.controller.start({ repo, binding: { workspaceId }, workflow: "coding/vibe", input: { requestExecutionId: CODING_REQUEST_ID }, actor: "user" })
    await waitFor(() => t.launched.length === 2)
    await observe(t.store, "run-1", "coding/request", "completed", CODING_REQUEST_EVENTS)
    await waitFor(() => workflowLaunchOf(runCards(t.store).find(card => card.payload.runId === "run-1"))?.next !== undefined)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(t.launched).toEqual(["coding/request", "coding/vibe"])
    expect(runCards(t.store).filter(card => card.payload.workflow === "coding/vibe")).toHaveLength(1)
  } finally { await t.dispose() }
})

const createAppController = scopedControllers()
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("change.request returns before an unresolved launch, keeps Chat usable, dedupes a repeat, and holds its toast", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: repo, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: `${repo}#workspace:${workspaceId}` }).isPersisted.promise
  const gate = deferred<Response>()
  const procedures: Array<{ procedure: string; workspaceId?: string; payload: Record<string, unknown> }> = []
  const chat = scriptedToolAgent([() => [{ type: "delta", kind: "text", text: "Still here." }, { type: "done", reason: "stop" }]])
  const controller = createAppController(store, chat.agent, { workflowPollMs: 5, toastAutoDismissMs: 60_000, fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/api/auth/session")) return json(200, { login: "owner", allowlisted: true, admin: false })
    if (path.endsWith("/api/workflow/provision")) return json(200, { status: "ready" })
    // A backend without the route: the change starts from the workspace as it is.
    if (path.endsWith(`/workspaces/${workspaceId}/user-source`)) return json(404, {})
    if (!path.endsWith("/api/workflow/rpc")) return json(404, {})
    const body = JSON.parse(String(init?.body))
    procedures.push(body)
    if (body.procedure === "Plan") return gate.promise
    return json(200, { ok: true, payload: { rows: [], items: [] } })
  } })
  try {
    const result = await Promise.race([controller.commands.run("change.request", `Fix the README typo ${repo}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested workflow=coding/request") })
    const cards = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
    expect(cards()).toHaveLength(1)
    expect(workflowLaunchOf(cards()[0])).toMatchObject({ workflow: "coding/request", input: { prompt: "Fix the README typo" }, then: "coding/vibe", workspaceId })
    await controller.commands.run("change.request", `Fix the README typo ${repo}`)
    expect(cards()).toHaveLength(1)
    controller.send("Are you still here?")
    await waitFor(() => chat.requests.length === 1 && store.session().phase === "idle")
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.status === "running"))
    await waitFor(() => procedures.some(call => call.procedure === "Plan"))
    expect(procedures.filter(call => call.procedure === "Plan")).toEqual([expect.objectContaining({ workspaceId, payload: expect.objectContaining({ flowId: "coding/request", input: { prompt: "Fix the README typo" } }) })])
  } finally {
    gate.resolve(json(503, { message: "closing" }))
    await controller.dispose(); await store.dispose?.()
  }
})

const sourceBase = { commitId: "c".repeat(40), ref: `refs/smithers/workspaces/${workspaceId}/sources/${"c".repeat(40)}` }

test("change.request starts from the caller's pushed ref: pinned once as coding/request's base, named on the card", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: repo, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: `${repo}#workspace:${workspaceId}` }).isPersisted.promise
  const gate = deferred<Response>()
  const pin = deferred<Response>()
  const plans: Array<Record<string, unknown>> = []
  const pins: Array<Record<string, unknown>> = []
  const controller = createAppController(store, scriptedToolAgent([]).agent, { workflowPollMs: 5, toastAutoDismissMs: 60_000, fetchImpl: async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith("/api/auth/session")) return json(200, { login: "owner", allowlisted: true, admin: false })
    if (path.endsWith("/api/workflow/provision")) return json(200, { status: "ready" })
    if (path.endsWith(`/api/repos/owner/repo/workspaces/${workspaceId}/user-source`)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      pins.push(body)
      return body.name === "spike" ? pin.promise : json(404, { code: "user_ref_missing", message: "refs/smithers/users/7/gone does not exist or expired" })
    }
    if (!path.endsWith("/api/workflow/rpc")) return json(404, {})
    const body = JSON.parse(String(init?.body))
    if (body.procedure === "Plan") { plans.push(body.payload); return gate.promise }
    return json(200, { ok: true, payload: { rows: [], items: [] } })
  } })
  const cards = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
  try {
    // The command returns while the pin is still unresolved.
    const result = await Promise.race([controller.commands.run("change.request", `Fix the README from: the notes from:spike ${repo}`), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested workflow=coding/request") })
    expect(workflowLaunchOf(cards()[0])).toMatchObject({ input: { prompt: "Fix the README from: the notes" }, source: { name: "spike", explicit: true } })
    await waitFor(() => pins.length === 1)
    expect(pins).toEqual([{ name: "spike" }])
    pin.resolve(json(200, { name: "spike", base: sourceBase }))
    await waitFor(() => plans.length === 1)
    expect(plans[0]).toMatchObject({ flowId: "coding/request", input: { prompt: "Fix the README from: the notes", base: sourceBase } })
    const launched = cards()[0]!
    expect(workflowLaunchOf(launched)?.source).toEqual({ name: "spike", explicit: true, commitId: sourceBase.commitId })
    expect(launchSourceOf(launched)).toBe("spike")
    // Asking again is the same request: no second pin, no second card.
    await controller.commands.run("change.request", `Fix the README from: the notes from:spike ${repo}`)
    expect(cards()).toHaveLength(1)
    expect(pins).toHaveLength(1)

    // A named ref the caller never pushed fails visibly on its card.
    await controller.commands.run("change.request", `Tidy the docs from:gone ${repo}`)
    await waitFor(() => cards().some(card => card.status === "error"))
    const failed = cards().find(card => card.status === "error")!
    expect(workflowLaunchOf(failed)?.error).toMatchObject({ stage: "preparation", code: "user_ref_missing" })
    expect(launchSourceOf(failed)).toBeUndefined()
    expect(plans).toHaveLength(1)

    // A name git would refuse never becomes a request: the form asks again.
    const before = cards().length
    expect(await controller.commands.run("change.request", `Tidy the docs from:../x ${repo}`)).toMatchObject({ status: "form" })
    expect(cards()).toHaveLength(before)
  } finally {
    gate.resolve(json(503, { message: "closing" }))
    await controller.dispose(); await store.dispose?.()
  }
})

test("change.request without a selected Cloud workspace names the door instead of launching", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: repo, org: "owner", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
  const chat = scriptedToolAgent([])
  const controller = createAppController(store, chat.agent, { fetchImpl: async () => json(404, {}) })
  try {
    const result = await controller.commands.run("change.request", `Fix the README typo ${repo}`)
    expect(JSON.stringify(result)).toContain("/box.open")
    expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toHaveLength(0)
  } finally { await controller.dispose(); await store.dispose?.() }
})
