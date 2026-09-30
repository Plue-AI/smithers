import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage, unavailableAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createCommandIntentLifecycle } from "./commandIntents"
import type { AgentInvocation } from "../../flows/AgentInvocation"

type Store = Awaited<ReturnType<typeof createAppStore>>
const signedIn = (store: Store, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in",
  login, admin: false, scopesPlain: null }).isPersisted.promise
const answered = (store: Store, state: "signed-out" | "unavailable") => store.dispatch({ type: "identity.session.loaded", actor: "system", state,
  login: null, admin: false, scopesPlain: null }).isPersisted.promise
const cleared = (store: Store) => store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise

const harness = async (seed?: (store: Store) => Promise<unknown>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await seed?.(store)
  const ctx = createControllerContext(store, unavailableAgent, { fetchImpl: async () => Response.json({}) })
  const start = ctx.accountEpoch
  const delta = () => ctx.accountEpoch - start
  const tap = () => { ctx.netRing.push({ at: 0, method: "GET", url: "/tap", status: 200, ms: 0 }) }
  return { store, ctx, delta, tap, dispose: async () => { await ctx.dispose(); await store.dispose?.() } }
}

test("the account epoch counts owner changes, never re-probes of the same owner", async () => {
  const t = await harness()
  try {
    await signedIn(t.store, "alice")
    expect(t.delta()).toBe(1)
    expect(t.ctx.accountOwner()).toBe("alice")
    t.tap()
    await signedIn(t.store, "alice")
    expect(t.delta()).toBe(1)
    // An outage keeps the retained owner: availability is not an account change.
    await answered(t.store, "unavailable")
    expect(t.delta()).toBe(1)
    expect(t.ctx.accountOwner()).toBe("alice")
    expect(t.ctx.netRing).toHaveLength(1)
    await answered(t.store, "signed-out")
    expect(t.delta()).toBe(2)
    expect(t.ctx.accountOwner()).toBeNull()
    expect(t.ctx.netRing).toHaveLength(0)
    await signedIn(t.store, "alice")
    await signedIn(t.store, "bob")
    expect(t.delta()).toBe(4)
    // Clearing an identity that has no owner changes nothing.
    await answered(t.store, "signed-out")
    expect(t.delta()).toBe(5)
    t.tap()
    await cleared(t.store)
    expect(t.delta()).toBe(5)
    expect(t.ctx.netRing).toHaveLength(1)
  } finally { await t.dispose() }
})

test("a context over a hydrated owner does not count that owner's boot re-probe", async () => {
  const t = await harness(store => signedIn(store, "alice"))
  try {
    expect(t.ctx.accountOwner()).toBe("alice")
    await signedIn(t.store, "alice")
    expect(t.delta()).toBe(0)
    await cleared(t.store)
    expect(t.delta()).toBe(1)
  } finally { await t.dispose() }
})

test("a completed sign-out ends the account generation once, whether or not cleanup lands", async () => {
  const t = await harness(store => signedIn(store, "alice"))
  try {
    t.tap()
    t.ctx.endAccount()
    expect(t.delta()).toBe(1)
    expect(t.ctx.netRing).toHaveLength(0)
    await cleared(t.store)
    expect(t.delta()).toBe(1)
    await signedIn(t.store, "alice")
    expect(t.delta()).toBe(2)
  } finally { await t.dispose() }
})

test("a failing account-change listener cannot block another listener or account retirement", async () => {
  const t = await harness(store => signedIn(store, "alice"))
  try {
    const observed: Array<string | null | undefined> = []
    t.ctx.onAccountChange(() => { throw new Error("listener failed") })
    t.ctx.onAccountChange(() => { observed.push(t.ctx.accountOwner()) })
    expect(() => t.ctx.endAccount()).not.toThrow()
    // endAccount advances the generation before the durable identity row clears.
    expect(t.ctx.accountOwner()).toBe("alice")
    expect(t.delta()).toBe(1)
    expect(observed).toEqual(["alice"])
    await signedIn(t.store, "bob")
    expect(t.ctx.accountOwner()).toBe("bob")
    expect(t.delta()).toBe(2)
    expect(observed).toEqual(["alice", "bob"])
  } finally { await t.dispose() }
})

test("an accepted command can publish after its signal closes only while its account remains current", async () => {
  const t = await harness(store => signedIn(store, "alice"))
  try {
    const abort = new AbortController()
    const request = { name: "agent.explain", actor: "user" as const, source: "command" as const,
      invocation: { signal: abort.signal } as AgentInvocation }
    const lifecycle = createCommandIntentLifecycle(t.ctx)
    const accepted = await lifecycle.accept(request)
    if (!("receipt" in accepted)) throw new Error(`command acceptance failed: ${accepted.refusal}`)
    expect(lifecycle.canPublish?.(accepted.receipt, request)).toBe(true)
    abort.abort()
    expect(lifecycle.canPublish?.(accepted.receipt, request)).toBe(true)
    expect(t.store.collections.commandIntents.get(accepted.receipt.id)?.status).toBe("accepted")
    const executableRequest = { name: "agent.explain", actor: "user" as const, source: "command" as const }
    const executable = await lifecycle.accept(executableRequest)
    if (!("receipt" in executable)) throw new Error(`command acceptance failed: ${executable.refusal}`)
    expect(lifecycle.canExecute?.(executable.receipt, executableRequest)).toBe(true)
    await signedIn(t.store, "alice")
    expect(lifecycle.canExecute?.(executable.receipt, executableRequest)).toBe(true)
    t.ctx.endAccount()
    expect(t.store.collections.commandIntents.get(accepted.receipt.id)?.status).toBe("accepted")
    expect(lifecycle.canPublish?.(accepted.receipt, request)).toBe(false)
    expect(t.store.collections.commandIntents.get(executable.receipt.id)?.status).toBe("accepted")
    expect(lifecycle.canExecute?.(executable.receipt, executableRequest)).toBe(false)
  } finally { await t.dispose() }
})

test("the controller posts through its supplied reporter and resets evidence on account change", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const sent: unknown[] = []
  const clientErrors = { report: (kind: string, error: unknown) => { sent.push({ kind, error }) }, reported: () => sent.length }
  const ctx = createControllerContext(store, unavailableAgent, { clientErrors })
  try {
    ctx.failures.report("run.pump", Error("unavailable"), "run")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: "operational" })
    expect(ctx.failures.recent()).toHaveLength(1)
    await signedIn(store, "new-owner")
    expect(ctx.failures.recent()).toEqual([])
  } finally { await ctx.dispose(); await store.dispose?.() }
})
