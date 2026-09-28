import { createFailureController } from "./failures"
import { expect, spyOn, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createWorkflowLaunchController } from "./workflow-launch"
import { workflowLaunchOf } from "../WorkflowLaunch"
import type { ControllerContext } from "./context"
import type { AppStore } from "../AppStore"

/*
 * Equivalent requests are admitted one at a time: a second press waits for
 * the first request to be saved. Sign-out while it waits forgets every card,
 * so neither press may save or acknowledge a request for the account that
 * ended.
 */
test("requests waiting on admission when the account ends save nothing and acknowledge nothing", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { fetchImpl: () => new Promise<Response>(() => {}) })
  const prepared: string[] = []
  const launch = createWorkflowLaunchController(ctx, () => 1, () => new Promise(() => {}), (repo) => {
    prepared.push(repo)
    return new Promise(() => {})
  })
  const args = { repo: "owner/private", binding: { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, workflow: "review", input: { args: "secret" }, actor: "user" as const }
  try {
    const first = launch.start(args)
    const second = launch.start(args)
    store.dispatch({ type: "identity.session.cleared", actor: "user" })
    const answers = await Promise.all([first, second])
    await settle()
    expect(answers).toEqual(["The account changed before the run was requested.", "The account changed before the run was requested."])
    expect([...store.collections.cards.values()].filter(card => card.kind === "run-trace")).toEqual([])
    expect(prepared).toEqual([])
  } finally { await ctx.dispose(); await store.dispose?.() }
})

test("a failed post-launch save keeps the job pending and retries without relaunching", async () => {
  const durable = memoryStorage()
  let failSave = false, rejected = 0
  const store = await createAppStore({ kind: "localStorage", storage: { ...durable, setItem(key, value) {
    if (failSave && value.includes('remote-run')) { failSave = false; rejected++; throw Error("disk unavailable") }
    durable.setItem(key, value)
  } } })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { workflowPollMs: 1, toastDebounceMs: 1, toastAutoDismissMs: 10000 })
  let launches = 0, pumps = 0
  ctx.gateway = { ...ctx.gateway, launch: async () => { launches++; failSave = true; return { status: "ok", value: { runId: "remote-run", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" } } } } as typeof ctx.gateway
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const launch = createWorkflowLaunchController(ctx, () => 1, async () => { pumps++ }, async () => true)
  try {
    await launch.start({ repo: "owner/repo", binding: { workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, workflow: "review", input: {}, actor: "user" })
    for (let i = 0; i < 100 && pumps === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(rejected).toBe(1)
    expect(launches).toBe(1)
    expect(pumps).toBe(1)
    for (let i = 0; i < 100 && store.collections.toasts.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect([...store.collections.toasts.values()].map(toast => toast.status)).toEqual(["running"])
    expect([...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.runId === "remote-run")).toBe(true)
    await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: { repo: "owner/repo", runId: "remote-run", workspaceId: "0b0c0d0e-0000-4000-8000-000000000001" }, summary: { runId: "remote-run", flowId: "review", status: "completed",
        createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
        inputTokens: 0, outputTokens: 0, verdict: "done", diagnosis: "done" }
    } }).isPersisted.promise
    for (let i = 0; i < 100 && [...store.collections.toasts.values()].some(toast => toast.status === "running"); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect([...store.collections.toasts.values()].map(toast => toast.status)).toEqual(["ok"])
  } finally { await ctx.dispose(); await store.dispose?.() }
})

const repo = "owner/repo", workspaceId = "0b0c0d0e-0000-4000-8000-000000000001"
const request = { repo, binding: { workspaceId }, workflow: "review", input: { subject: "Inspect" }, actor: "user" as const }
const deferred = <T>() => Promise.withResolvers<T>()
const whileHeld = async <T>(work: Promise<T>): Promise<T | "blocked"> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<"blocked">(resolve => { timer = setTimeout(() => resolve("blocked"), 2_000) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
const launchFixture = async (config: {
  prepare?: Parameters<typeof createWorkflowLaunchController>[3]
  launch?: (idempotencyKey: string, input: Record<string, unknown>) => ReturnType<ControllerContext["gateway"]["launch"]>
  workflowPreparationTimeoutMs?: number
  pump?: (id: string) => Promise<void>
} = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "owner",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, { workflowPollMs: 1, toastDebounceMs: 1, toastAutoDismissMs: 10_000,
    ...(config.workflowPreparationTimeoutMs === undefined ? {} : { workflowPreparationTimeoutMs: config.workflowPreparationTimeoutMs }) })
  const launched: string[] = [], launchedInputs: Array<Record<string, unknown>> = []
  ctx.gateway = { ...ctx.gateway, launch: async (_repo, _workflow, input, _binding, options) => {
    if (typeof options !== "object" || options === null) throw Error("Expected a durable launch request")
    launched.push(options.idempotencyKey)
    launchedInputs.push(input)
    return config.launch ? config.launch(options.idempotencyKey, input) : { status: "ok", value: { runId: "remote-run", workspaceId } }
  } } as typeof ctx.gateway
  const failures = createFailureController(ctx)
  ctx.withToast = failures.withToast
  ctx.resolveToast = failures.resolveToast
  const controller = createWorkflowLaunchController(ctx, store.nextOrdinal, config.pump ?? (async () => {}), config.prepare ?? (async () => true))
  const cards = () => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
  const toasts = () => [...store.collections.toasts.values()].filter(toast => toast.key.startsWith("flow.request."))
  return { store, ctx, controller, cards, toasts, launched, launchedInputs, close: async () => { await ctx.dispose(); await store.dispose?.() } }
}

const observe = (store: AppStore, status: "completed" | "failed" | "cancelled", verdict: string = status, runId = "remote-run") =>
  store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
    scope: { repo, workspaceId, runId }, summary: { runId, flowId: "review", status,
      createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
      inputTokens: 0, outputTokens: 0, verdict, diagnosis: verdict }
  } }).isPersisted.promise

test("an unresolved preparation acknowledges one durable request and settles only after its remote job", async () => {
  const ready = deferred<true>()
  let preparations = 0
  const t = await launchFixture({ prepare: async () => { preparations++; return ready.promise } })
  try {
    const first = await whileHeld(t.controller.start(request))
    const second = await t.controller.start(request)
    expect(first).toEqual({ value: expect.stringContaining("run-requested workflow=review") })
    expect(second).toEqual(first)
    expect(t.cards()).toHaveLength(1)
    expect(workflowLaunchOf(t.cards()[0])?.input).toEqual(request.input)
    expect(t.cards()[0]?.payload.phase).toBe("launching")
    await waitFor(() => preparations === 1 && t.toasts()[0]?.status === "running")
    expect(t.launched).toEqual([])
    ready.resolve(true)
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run")
    expect(t.launched).toEqual([workflowLaunchOf(t.cards()[0])!.id])
    await waitFor(() => t.toasts()[0]?.status === "running")
    await observe(t.store, "completed", "done")
    await waitFor(() => t.toasts()[0]?.status === "ok")
    expect(t.cards()[0]?.payload.phase).toBe("completed")
  } finally { ready.resolve(true); await t.close() }
})

test("a refused unresolved launch remains retryable under its original idempotency key", async () => {
  const response = deferred<Awaited<ReturnType<ControllerContext["gateway"]["launch"]>>>()
  let refuse = true
  const t = await launchFixture({ launch: () => refuse ? response.promise : Promise.resolve({ status: "ok", value: { runId: "remote-run", workspaceId } }) })
  try {
    const acknowledgment = await whileHeld(t.controller.start(request))
    expect(acknowledgment).toEqual({ value: expect.stringContaining("run-requested workflow=review") })
    await waitFor(() => t.launched.length === 1)
    expect(t.cards()[0]?.payload.phase).toBe("launching")
    expect(await t.controller.start(request)).toEqual(acknowledgment)
    expect(t.launched).toHaveLength(1)
    response.resolve({ status: "error", code: "provider_unavailable", message: "Provider unavailable" })
    await waitFor(() => t.cards()[0]?.payload.phase === "failed")
    const id = t.cards()[0]!.id, original = workflowLaunchOf(t.cards()[0])!
    expect(original.error).toMatchObject({ stage: "launch", code: "provider_unavailable", message: "Provider unavailable" })
    expect(t.toasts()[0]).toMatchObject({ status: "failed", detail: "Provider unavailable" })
    refuse = false
    expect(t.controller.retry(id)).toBe(true)
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run")
    expect(t.cards()).toHaveLength(1)
    expect(t.cards()[0]?.id).toBe(id)
    expect(t.launched).toEqual([original.id, original.id])
    await waitFor(() => t.toasts()[0]?.status === "running")
  } finally { response.resolve({ status: "error", message: "closed" }); await t.close() }
})

test("an old account's unresolved preparation cannot launch or publish after sign-out", async () => {
  const ready = deferred<true>()
  const t = await launchFixture({ prepare: async () => ready.promise })
  try {
    expect(await t.controller.start(request)).toEqual({ value: expect.stringContaining("run-requested workflow=review") })
    expect(t.cards()).toHaveLength(1)
    await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    ready.resolve(true)
    await settle()
    expect(t.ctx.accountOwner()).toBeNull()
    expect(t.launched).toEqual([])
    expect(t.cards()).toEqual([])
    expect(t.toasts().some(toast => toast.status === "ok")).toBe(false)
  } finally { ready.resolve(true); await t.close() }
})

test("prepared input is persisted before launch while the original request still deduplicates", async () => {
  const t = await launchFixture({ prepare: async () => ({ input: { subject: "Inspect", base: "pinned-commit" },
    source: { name: "main", explicit: false, commitId: "pinned-commit" } }) })
  const withSource = { ...request, source: { name: "main", explicit: false } }
  try {
    const first = await t.controller.start(withSource)
    await waitFor(() => t.launched.length === 1)
    expect(t.launchedInputs).toEqual([{ subject: "Inspect", base: "pinned-commit" }])
    expect(workflowLaunchOf(t.cards()[0])).toMatchObject({ inputPrepared: true,
      input: { subject: "Inspect", base: "pinned-commit" }, source: { name: "main", explicit: false, commitId: "pinned-commit" } })
    expect(await t.controller.start(withSource)).toEqual(first)
    expect(t.cards()).toHaveLength(1)
    expect(t.launched).toHaveLength(1)
  } finally { await t.close() }
})

test("a late launch answer from the previous account cannot publish a run into the new account", async () => {
  const answer = deferred<Awaited<ReturnType<ControllerContext["gateway"]["launch"]>>>()
  const t = await launchFixture({ launch: () => answer.promise })
  try {
    expect(await t.controller.start(request)).toEqual({ value: expect.stringContaining("run-requested workflow=review") })
    await waitFor(() => t.launched.length === 1)
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "another",
      allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    answer.resolve({ status: "ok", value: { runId: "old-run", workspaceId } })
    await settle()
    expect(t.ctx.accountOwner()).toBe("another")
    expect(t.cards()).toEqual([])
    expect(t.launched).toHaveLength(1)
    expect(t.toasts().some(toast => toast.status === "ok")).toBe(false)
  } finally { answer.resolve({ status: "error", message: "closed" }); await t.close() }
})

test("preparation that stays unavailable expires, then retry uses the same durable request", async () => {
  let available = false, attempts = 0, now = Date.now()
  const secondAttempt = deferred<void>(), releaseSecond = deferred<void>()
  const t = await launchFixture({ workflowPreparationTimeoutMs: 1_000,
    prepare: async () => {
      attempts++
      if (available) return true
      if (attempts === 2) { secondAttempt.resolve(); await releaseSecond.promise }
      return { code: "workspace_starting", message: "Starting", retryAfterSeconds: 0 }
    } })
  const clock = spyOn(Date, "now").mockImplementation(() => now)
  try {
    const acknowledged = await t.controller.start(request)
    expect(await whileHeld(secondAttempt.promise)).toBeUndefined()
    now += 1_001
    releaseSecond.resolve()
    await settle()
    expect(t.cards()[0]?.payload.phase).toBe("failed")
    const card = t.cards()[0]!, original = workflowLaunchOf(card)!
    expect(acknowledged).toEqual({ value: expect.stringContaining(original.id) })
    expect(original.error).toMatchObject({ stage: "preparation", code: "workspace_preparation_timeout",
      message: "The box did not become ready. Retry the request." })
    expect(attempts).toBe(2)
    expect(t.launched).toEqual([])
    clock.mockRestore()
    available = true
    expect(t.controller.retry(card.id)).toBe(true)
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run")
    expect(t.cards()).toHaveLength(1)
    expect(t.launched).toEqual([original.id])
    expect(workflowLaunchOf(t.cards()[0])?.error).toBeUndefined()
  } finally { releaseSecond.resolve(); clock.mockRestore(); await t.close() }
})

test.each([
  { status: "failed" as const, verdict: "The review found a problem.", toast: "failed" },
  { status: "cancelled" as const, verdict: "Cancelled by owner", toast: "cancelled" }
])("a $status remote job settles its durable request without another launch", async ({ status, verdict, toast }) => {
  const t = await launchFixture()
  try {
    await t.controller.start(request)
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run" && t.toasts()[0]?.status === "running")
    await observe(t.store, status, verdict)
    await waitFor(() => t.cards()[0]?.payload.phase === status)
    await waitFor(() => t.toasts()[0]?.status === toast)
    expect(t.toasts()[0]?.detail).toBe(status === "failed" ? verdict : "Cancelled")
    expect(t.launched).toHaveLength(1)
    expect(t.cards()[0]?.payload.runId).toBe("remote-run")
  } finally { await t.close() }
})

test("different source intent and rerun identities remain separate requests", async () => {
  const ready = deferred<true>()
  const t = await launchFixture({ prepare: async () => ready.promise })
  const implicit = { ...request, source: { name: "main", explicit: false } }
  const explicit = { ...request, source: { name: "main", explicit: true } }
  try {
    const first = await t.controller.start(implicit)
    expect(await t.controller.start(implicit)).toEqual(first)
    const second = await t.controller.start(explicit)
    const third = await t.controller.start({ ...implicit, rerunOf: "prior-request" })
    expect([first, second, third].map(result => typeof result === "string" ? result : result.value)).toEqual([
      expect.stringContaining("run-requested"), expect.stringContaining("run-requested"), expect.stringContaining("run-requested")
    ])
    const ids = t.cards().map(card => workflowLaunchOf(card)?.id)
    expect(new Set(ids).size).toBe(3)
    expect(t.cards()).toHaveLength(3)
    expect(t.launched).toEqual([])
  } finally { ready.resolve(true); await t.close() }
})

test("a resumed persisted request launches once with its original identity", async () => {
  const held = deferred<true>()
  const t = await launchFixture({ prepare: async () => held.promise })
  let secondCtx: ControllerContext | undefined
  try {
    const first = await t.controller.start(request)
    const original = workflowLaunchOf(t.cards()[0])!
    expect(first).toEqual({ value: expect.stringContaining(original.id) })
    await t.ctx.dispose()
    secondCtx = createControllerContext(t.store, unavailableAgent, { workflowPollMs: 1, toastDebounceMs: 1, toastAutoDismissMs: 10_000 })
    const resumedLaunches: string[] = []
    secondCtx.gateway = { ...secondCtx.gateway, launch: async (_repo, _workflow, _input, _binding, options) => {
      if (typeof options !== "object" || options === null) throw Error("Expected a durable launch request")
      resumedLaunches.push(options.idempotencyKey)
      return { status: "ok", value: { runId: "resumed-run", workspaceId } }
    } } as typeof secondCtx.gateway
    const failures = createFailureController(secondCtx)
    secondCtx.withToast = failures.withToast
    secondCtx.resolveToast = failures.resolveToast
    const resumed = createWorkflowLaunchController(secondCtx, t.store.nextOrdinal, async () => {}, async () => true)
    resumed.resume()
    resumed.resume()
    await waitFor(() => t.cards()[0]?.payload.runId === "resumed-run")
    expect(t.cards()).toHaveLength(1)
    expect(t.cards()[0]?.id).toBe(`flow-request-${original.id}`)
    expect(resumedLaunches).toEqual([original.id])
    expect(t.launched).toEqual([])
  } finally { held.resolve(true); await secondCtx?.dispose(); await t.close() }
})

test("a failed observer leaves reconnect evidence while the remote job is still running", async () => {
  const t = await launchFixture({ pump: async () => { throw Error("Observer unavailable") } })
  try {
    await t.controller.start(request)
    await waitFor(() => t.cards()[0]?.payload.observationError !== undefined)
    expect(t.cards()[0]?.payload.observationError).toBe("The run could not be checked. Check again to reconnect.")
    expect(t.cards()[0]?.payload.runId).toBe("remote-run")
    await waitFor(() => t.toasts()[0]?.status === "running")
    expect(t.launched).toHaveLength(1)
    await observe(t.store, "completed", "done")
    await waitFor(() => t.toasts()[0]?.status === "ok")
  } finally { await t.close() }
})

test("disposing during an unresolved launch prevents its late answer from publishing", async () => {
  const answer = deferred<Awaited<ReturnType<ControllerContext["gateway"]["launch"]>>>()
  const t = await launchFixture({ launch: () => answer.promise })
  try {
    await t.controller.start(request)
    await waitFor(() => t.launched.length === 1)
    await t.ctx.dispose()
    answer.resolve({ status: "ok", value: { runId: "late-run", workspaceId } })
    await settle()
    expect(t.cards()[0]?.payload.runId).toBe(`pending-${workflowLaunchOf(t.cards()[0])?.id}`)
    expect(t.cards()[0]?.payload.phase).toBe("launching")
    expect(t.toasts().some(toast => toast.status === "ok")).toBe(false)
  } finally { answer.resolve({ status: "error", message: "closed" }); await t.close() }
})

test("a missing flow names the available alternatives and keeps its request retryable", async () => {
  const t = await launchFixture({ launch: async () => ({ status: "error", code: "flow_not_found", message: "missing" }) })
  t.ctx.gateway = { ...t.ctx.gateway, listFlows: async () => ({ status: "ok", value: [
    { flowId: "review/check", description: null }, { flowId: "review/fix", description: null }
  ] }) } as typeof t.ctx.gateway
  try {
    await t.controller.start(request)
    await waitFor(() => t.cards()[0]?.payload.phase === "failed")
    expect(workflowLaunchOf(t.cards()[0])?.error).toMatchObject({ stage: "launch", code: "flow_not_found",
      message: "There's no flow called review on owner/repo. The workspace has: review/check, review/fix." })
    expect(t.toasts()[0]?.status).toBe("failed")
    expect(t.launched).toHaveLength(1)
    expect(t.cards()).toHaveLength(1)
  } finally { await t.close() }
})

test.each([
  { cause: "registration_refused: Schedule is invalid\ninternal detail", detail: "Schedule is invalid" },
  { cause: undefined, detail: "Generic failure" }
])("registration failure reports $detail from its available evidence", async ({ cause, detail }) => {
  const t = await launchFixture()
  try {
    await t.controller.start({ ...request, triggerRegistration: { requestId: "registration-1", flow: "review", slug: "daily",
      schedule: "0 9 * * *", input: "{}", planId: "plan-1", planDigest: "digest" } })
    const notices = () => [...t.store.collections.toasts.values()].filter(toast => toast.key.startsWith("trigger.register."))
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run" && notices()[0]?.status === "running")
    await t.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: { repo, workspaceId, runId: "remote-run" }, summary: { runId: "remote-run", flowId: "review", status: "failed",
        createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
        inputTokens: 0, outputTokens: 0, verdict: "Generic failure", diagnosis: "failed" },
      journal: { mode: "full", events: [{ kind: "control.run.failed", sequence: 1, occurredAt: 2,
        payload: cause === undefined ? {} : { cause } }] }, journalComplete: true
    } as never }).isPersisted.promise
    await waitFor(() => notices()[0]?.status === "failed")
    expect(notices()[0]?.detail).toBe(detail)
    expect(t.cards()[0]?.payload.runId).toBe("remote-run")
    expect(t.launched).toHaveLength(1)
  } finally { await t.close() }
})

test("a completed change request without validation never starts its follow-up", async () => {
  const t = await launchFixture()
  try {
    await t.controller.start({ ...request, workflow: "coding/request", then: "coding/vibe" })
    await waitFor(() => t.cards()[0]?.payload.runId === "remote-run" && t.toasts()[0]?.status === "running")
    await t.store.dispatch({ type: "gateway.run.observed", actor: "system", observation: {
      scope: { repo, workspaceId, runId: "remote-run" }, summary: { runId: "remote-run", flowId: "coding/request", status: "completed",
        createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
        inputTokens: 0, outputTokens: 0, verdict: "done", diagnosis: "done" },
      journal: { mode: "full", events: [] }, journalComplete: true
    } }).isPersisted.promise
    await waitFor(() => t.toasts()[0]?.status === "failed")
    expect(t.toasts()[0]?.detail).toBe("The run finished without a validated change.")
    expect(t.cards()).toHaveLength(1)
    expect(t.cards()[0]?.payload.phase).toBe("completed")
    expect(t.launched).toHaveLength(1)
  } finally { await t.close() }
})

test("a persisted request without its old workspace binding fails visibly instead of launching elsewhere", async () => {
  const held = deferred<true>()
  const t = await launchFixture({ prepare: async () => held.promise })
  let resumedCtx: ControllerContext | undefined
  try {
    await t.controller.start(request)
    await t.ctx.dispose()
    const card = t.cards()[0]!
    const { workspaceId: _oldWorkspace, ...oldRequest } = workflowLaunchOf(card)!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card,
      payload: { ...card.payload, input: { ...card.payload.input, _workflowLaunch: oldRequest } } } }).isPersisted.promise
    resumedCtx = createControllerContext(t.store, unavailableAgent, { workflowPollMs: 1, toastDebounceMs: 1 })
    const failures = createFailureController(resumedCtx)
    resumedCtx.withToast = failures.withToast
    resumedCtx.resolveToast = failures.resolveToast
    const resumed = createWorkflowLaunchController(resumedCtx, t.store.nextOrdinal, async () => {}, async () => true)
    resumed.resume()
    await waitFor(() => t.cards()[0]?.payload.phase === "failed")
    expect(workflowLaunchOf(t.cards()[0])?.error).toMatchObject({ stage: "preparation", code: "box_gone" })
    expect(t.cards()[0]?.payload.error).toContain("box")
    expect(t.launched).toEqual([])
  } finally { held.resolve(true); await resumedCtx?.dispose(); await t.close() }
})
