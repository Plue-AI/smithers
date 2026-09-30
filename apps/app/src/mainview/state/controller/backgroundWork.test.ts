import { afterEach, expect, test } from "bun:test"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { workerToastActions } from "../../WorkerToastActions"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"
import { observeBackgroundWork } from "./backgroundWork"
import { createFlowAuthoringController } from "./flowAuthoring"
import { createWorkflowLaunchController } from "./workflow-launch"
import { runCause } from "../RunCause"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const fixture = async (storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { workflowPollMs: 1, toastAutoDismissMs: 10000 })
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  cleanups.push(async () => { await ctx.dispose(); await store.dispose?.() })
  return { store, ctx }
}

for (const kind of ["run-trace", "agent"] as const) test(`a recovered ${kind} failure toast follows corrected details without repeating unchanged observations`, async () => {
  const { store, ctx } = await fixture()
  const base = { id: "corrected-worker", title: "Review", status: "active" as const, ordinal: 1, createdAt: Date.now() - 1000 }
  const card: Card = kind === "run-trace"
    ? { ...base, kind, payload: { repo: "owner/repo", workflow: "review", runId: "run-1", phase: "running", steps: [], result: null, lastSeq: 0 } }
    : { ...base, kind, payload: { cloud: true, displayName: "Review", sessionId: "session-1", repo: "owner/repo", provider: null, workspaceId: null, state: "active", transcript: [] } }
  const resolutions: unknown[] = [], resolve = ctx.resolveToast
  ctx.resolveToast = (key, outcome) => { resolutions.push(outcome); resolve(key, outcome) }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  observeBackgroundWork(ctx)
  await waitFor(() => store.collections.toasts.size === 1)
  // A run-trace toast says the run's stamped fault in words; its verdict prose never reaches it.
  const initial = kind === "run-trace" ? runCause("flows/model/ModelError/transport")! : "Initial failure"
  const permission = kind === "run-trace" ? runCause("flows/model/ModelError/authentication")! : "Permission denied"
  const failure: Card = card.kind === "run-trace"
    ? { ...card, payload: { ...card.payload, phase: "failed", error: "failed — transport: raw verdict", failure: { class: "dependency", tag: "flows/model/ModelError/transport" } } }
    : { ...card, payload: { ...card.payload, state: "failed", error: "Initial failure" } }
  await store.dispatch({ type: "card.upsert", actor: "system", card: failure }).isPersisted.promise
  const toast = () => store.collections.toasts.get(`toast-worker.${card.id}`)
  await waitFor(() => toast()?.status === "failed")
  expect(toast()?.detail).toBe(initial)
  const renamed = { ...failure, title: "Reviewed changes" }
  await store.dispatch({ type: "card.upsert", actor: "system", card: renamed }).isPersisted.promise
  await settle()
  expect(toast()?.title).toBe("Reviewed changes")
  expect(toast()?.detail).toBe(initial)
  expect(resolutions).toHaveLength(2)
  const corrected = (renamed.kind === "run-trace"
    ? { ...renamed, payload: { ...renamed.payload, failure: { class: "user", tag: "flows/model/ModelError/authentication" } } }
    : { ...renamed, payload: { ...renamed.payload, error: "Permission denied" } }) as Card
  await store.dispatch({ type: "card.upsert", actor: "system", card: corrected }).isPersisted.promise
  await settle()
  expect(toast()?.title).toBe("Reviewed changes")
  expect(toast()?.detail).toBe(permission)
  expect(resolutions).toHaveLength(3)
  for (let index = 0; index < 5; index++) {
    await store.dispatch({ type: "card.upsert", actor: "system", card: corrected }).isPersisted.promise
    await settle()
  }
  expect(resolutions).toHaveLength(3)
  await store.dispatch({ type: "toast.dismissed", actor: "user", id: toast()!.id }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: corrected }).isPersisted.promise
  await settle()
  expect(toast()).toBeUndefined()
})

for (const status of ["failed", "cancelled"] as const) test(`one debounced toast spans launch and execution through ${status}, with real controls`, async () => {
  const { store, ctx } = await fixture()
  const remote = Promise.withResolvers<{ status: "ok"; value: { runId: string; workspaceId: string } }>()
  let launches = 0
  ctx.gateway = { ...ctx.gateway, launch: async () => { launches++; return remote.promise } } as typeof ctx.gateway
  observeBackgroundWork(ctx)
  const launch = createWorkflowLaunchController(ctx, store.nextOrdinal, async () => {}, async () => true)
  const request = { repo: "owner/repo", binding: { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, workflow: "review", input: {}, actor: "user" as const }
  const result = await launch.start(request)
  expect(result).toMatchObject({ value: expect.stringContaining("run-requested") })
  await launch.start(request)
  expect(launches).toBe(1)
  expect(store.collections.toasts.size).toBe(0)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "chat remains usable" }).isPersisted.promise
  expect(store.session()).toMatchObject({ draft: "chat remains usable", phase: "idle" })
  await waitFor(() => store.collections.toasts.size === 1)
  const toast = [...store.collections.toasts.values()][0]!
  expect(toast.status).toBe("running")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toEqual(["Open tab"])
  remote.resolve({ status: "ok", value: { runId: "run-1", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" } })
  await waitFor(() => [...store.collections.cards.values()].some(c => c.kind === "run-trace" && c.payload.runId === "run-1"))
  await settle()
  expect(store.collections.toasts.size).toBe(1)
  expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toContain("Stop")
  await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
    scope: { repo: "owner/repo", runId: "run-1", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, summary: { runId: "run-1", flowId: "review", status,
      createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
      inputTokens: 0, outputTokens: 0, verdict: "offline", diagnosis: "offline" }
  } }).isPersisted.promise
  await waitFor(() => store.collections.toasts.get(toast.id)?.status === status)
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toEqual(["Open tab", "Run again"])
  expect(launches).toBe(1)
})

test("recovered workers get controls, failures stay visible, and quick work stays below the debounce", async () => {
  const { store, ctx } = await fixture()
  const card: Card = { id: "restored-worker", kind: "run-trace", title: "Review", status: "active", ordinal: 1, createdAt: Date.now() - 1000,
    payload: { repo: "owner/repo", workflow: "review", runId: "run-1", phase: "running", steps: [], result: null, lastSeq: 0 } }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  observeBackgroundWork(ctx)
  await waitFor(() => store.collections.toasts.size === 1)
  const toast = [...store.collections.toasts.values()][0]!
  expect(toast.sourceCard).toBe(card.id)
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...card.payload, phase: "failed", error: "offline" } } }).isPersisted.promise
  await waitFor(() => store.collections.toasts.get(toast.id)?.status === "failed")
  const fast = { ...card, id: "fast", createdAt: Date.now() }
  await store.dispatch({ type: "card.upsert", actor: "system", card: fast }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: { ...fast, payload: { ...fast.payload, phase: "completed" } } }).isPersisted.promise
  await new Promise(resolve => setTimeout(resolve, 320))
  expect([...store.collections.toasts.values()].map(t => t.sourceCard)).toEqual([card.id])
  // An untyped failure is Smithers'; its prose ("offline") is never the toast.
  expect(store.collections.toasts.get(toast.id)?.detail).toBe(REFUSAL_COPY.infra.lead)
})

for (const kind of ["run-trace", "agent"] as const) test(`a recovered ${kind} cancellation settles neutrally`, async () => {
  const { store, ctx } = await fixture()
  const base = { id: "cancelled-worker", title: "Review", status: "active" as const, ordinal: 1, createdAt: Date.now() - 1000 }
  const card: Card = kind === "run-trace"
    ? { ...base, kind, payload: { repo: "owner/repo", workflow: "review", runId: "run-1", phase: "running", steps: [], result: null, lastSeq: 0 } }
    : { ...base, kind, payload: { cloud: true, displayName: "Review", sessionId: "session-1", repo: "owner/repo", provider: null, workspaceId: null, state: "active", transcript: [] } }
  await store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  observeBackgroundWork(ctx)
  await waitFor(() => store.collections.toasts.size === 1)
  const stopped: Card = card.kind === "run-trace"
    ? { ...card, payload: { ...card.payload, phase: "cancelled" } }
    : { ...card, payload: { ...card.payload, state: "cancelled" } }
  await store.dispatch({ type: "card.upsert", actor: "system", card: stopped }).isPersisted.promise
  await waitFor(() => [...store.collections.toasts.values()][0]?.status !== "running")
  expect([...store.collections.toasts.values()][0]).toMatchObject({ status: "cancelled", detail: "Cancelled" })
})

for (const status of ["completed", "failed", "cancelled"] as const) test(`authoring owns one toast from held launch through ${status}`, async () => {
  const { store, ctx } = await fixture()
  const remote = Promise.withResolvers<{ status: "ok"; value: { runId: string; workspaceId: string } }>()
  let launches = 0
  ctx.gateway = { ...ctx.gateway, launch: async () => { launches++; return remote.promise } } as typeof ctx.gateway
  observeBackgroundWork(ctx)
  const author = createFlowAuthoringController(ctx, store.nextOrdinal, async () => true, async () => {})
  await author.request("Review my changes", "owner/repo", { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, "user")
  await author.request("Review my changes", "owner/repo", { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, "user")
  expect(launches).toBe(1)
  expect(store.collections.toasts.size).toBe(0)
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "still chatting" }).isPersisted.promise
  expect(store.session()).toMatchObject({ draft: "still chatting", phase: "idle" })
  await waitFor(() => store.collections.toasts.size > 0)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(store.collections.toasts.size).toBe(1)
  const toast = [...store.collections.toasts.values()][0]!
  expect(toast.key).toStartWith("flow.author:")
  expect(toast.sourceCard).toBe([...store.collections.cards.values()].find(c => c.kind === "run-trace")?.id)
  remote.resolve({ status: "ok", value: { runId: "author-1", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" } })
  await waitFor(() => [...store.collections.cards.values()].some(c => c.kind === "run-trace" && c.payload.runId === "author-1"))
  await settle()
  expect(store.collections.toasts.size).toBe(1)
  expect(store.collections.toasts.get(toast.id)?.status).toBe("running")
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toContain("Stop")
  await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
    scope: { repo: "owner/repo", runId: "author-1", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, summary: { runId: "author-1", flowId: "create-flow", status,
      createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
      inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status }
  } }).isPersisted.promise
  await waitFor(() => store.collections.toasts.get(toast.id)?.status !== "running")
  expect(store.collections.toasts.get(toast.id)?.status).toBe(status === "completed" ? "ok" : status)
  expect(store.collections.toasts.size).toBe(1)
})

test("reloaded authoring adopts its recovered worker toast without relaunching", async () => {
  const storage = memoryStorage()
  const first = await fixture(storage)
  first.ctx.gateway = { ...first.ctx.gateway, launch: async () => ({ status: "ok", value: { runId: "author-1", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" } }) } as typeof first.ctx.gateway
  const author = createFlowAuthoringController(first.ctx, first.store.nextOrdinal, async () => true, async () => {})
  await author.request("Review my changes", "owner/repo", { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, "user")
  await waitFor(() => [...first.store.collections.cards.values()].some(c => c.kind === "run-trace" && c.payload.runId === "author-1"))
  await first.ctx.dispose()
  await first.store.dispose?.()

  const { store, ctx } = await fixture(storage)
  let launches = 0
  ctx.gateway = { ...ctx.gateway, launch: async () => { launches++; throw Error("must reconnect") } } as typeof ctx.gateway
  observeBackgroundWork(ctx)
  await waitFor(() => store.collections.toasts.size === 1)
  expect([...store.collections.toasts.values()][0]?.key).toStartWith("worker.")
  const resumed = createFlowAuthoringController(ctx, store.nextOrdinal, async () => true, async () => {})
  resumed.resume()
  await waitFor(() => [...store.collections.toasts.values()].some(t => t.key.startsWith("flow.author:")))
  expect([...store.collections.toasts.values()]).toEqual([expect.objectContaining({ status: "running", sourceCard: expect.any(String) })])
  expect(launches).toBe(0)
})

test("a refused authoring launch keeps one failure toast and retries the same request", async () => {
  const { store, ctx } = await fixture()
  const remote = Promise.withResolvers<{ status: "error"; message: string }>()
  const keys: unknown[] = []
  ctx.gateway = { ...ctx.gateway, launch: async (...args: Parameters<typeof ctx.gateway.launch>) => { keys.push(args[4]); return remote.promise } } as typeof ctx.gateway
  observeBackgroundWork(ctx)
  const author = createFlowAuthoringController(ctx, store.nextOrdinal, async () => true, async () => {})
  await author.request("Review my changes", "owner/repo", { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, "user")
  await waitFor(() => store.collections.toasts.size > 0)
  remote.resolve({ status: "error", message: "Workspace unavailable" })
  await waitFor(() => [...store.collections.toasts.values()].some(t => t.status === "failed"))
  const toast = [...store.collections.toasts.values()][0]!
  expect(store.collections.toasts.size).toBe(1)
  expect(toast.detail).toBe("Workspace unavailable")
  expect(typeof toast.sourceCard).toBe("string")
  ctx.gateway = { ...ctx.gateway, launch: async (...args: Parameters<typeof ctx.gateway.launch>) => { keys.push(args[4]); return { status: "ok", value: { runId: "author-retry", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" } } } } as typeof ctx.gateway
  author.resume(toast.sourceCard)
  await waitFor(() => store.collections.toasts.get(toast.id)?.status === "running")
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(store.collections.toasts.size).toBe(1)
  expect(workerToastActions(store.collections.cards.get(toast.sourceCard!)).map(a => a.label)).toContain("Stop")
})
