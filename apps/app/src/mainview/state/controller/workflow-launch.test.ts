import { createFailureController } from "./failures"
import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createWorkflowLaunchController } from "./workflow-launch"

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
