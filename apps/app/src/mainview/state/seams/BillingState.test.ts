import { expect, test } from "bun:test"
import { createAppStore, type AppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import { createBillingSeam, renderPlanLimit } from "./BillingSeam"
import { refusalOf } from "@smthrs/rpc/Refusal"
import type { SeamContext } from "./SeamContext"

const reply = (path: string) => Response.json(path.endsWith("/plans") ? { plans: [], current_plan_key: "free" } : {
  sandbox: { plan_key: "free", concurrent_sandboxes: 1, concurrent_in_use: 1, idle_timeout_secs: 1800,
    hours_per_day: 4, seconds_used_today: 900, day_resets_at: "2026-09-16T00:00:00Z" }
})
const context = (store: AppStore, http: SeamContext["http"] = async path => reply(path)): SeamContext => ({
  store, dispatch: store.dispatch, http, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal
})
const signIn = (store: AppStore, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system",
  state: "signed-in", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise

test("billing reads wait for the account receipt before publishing a card or result, then reopen identically", async () => {
  const storage = memoryStorage(), store = await createAppStore({ kind: "localStorage", storage })
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const ctx = context(store)
  const seam = createBillingSeam({ ...ctx, dispatch: transition => {
    const receipt = store.dispatch(transition)
    if (transition.type !== "billing.plans.loaded") return receipt
    entered.resolve()
    return new Proxy(receipt, { get: (target, property, receiver) => property === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => hold.promise) }
      : Reflect.get(target, property, receiver) })
  } })
  let finished = false
  const reading = seam.showBillingPlans().finally(() => { finished = true })
  try {
    await entered.promise
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(finished).toBe(false)
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    hold.resolve()
    expect(await reading).toHaveProperty("value")
    const proof = await store.verifyState()
    expect(proof.valid).toBe(true)
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    try {
      expect(reopened.collections.cards.get("billing-plans")).toMatchObject({ payload: { planKey: "free" } })
      expect((await reopened.verifyState()).actualHash).toBe(proof.actualHash)
    } finally { await reopened.dispose?.() }
  } finally { hold.resolve(); await reading; await store.dispose?.() }
})

test.each(["plans", "limit"] as const)("failed %s persistence cannot report a saved card", async kind => {
  const storage = memoryStorage()
  let fail = false
  const store = await createAppStore({ kind: "localStorage", storage: { ...storage, setItem: (key, value) => {
    if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("billing disk failure")
    storage.setItem(key, value)
  } } })
  try {
    const before = await store.eventHistory()
    fail = true
    if (kind === "plans") expect(await createBillingSeam(context(store)).showBillingPlans()).toBe("Your plans couldn't be refreshed and saved right now.")
    else await expect(renderPlanLimit(store, refusalOf({ status: 402, body: { code: "plan_limit_exceeded", upgrade_plan_key: "pro" }, message: "Limit reached." }), true, "user")).rejects.toThrow("billing disk failure")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    expect(store.collections.cards.has("billing-plan-limit")).toBe(false)
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect((await store.verifyState()).valid).toBe(true)
  } finally { fail = false; await store.dispose?.() }
})

test.each(["account", "dispose"] as const)("late plan and checkout answers cannot cross %s", async change => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await signIn(store, "first-account")
  let disposed = false
  const hold = Promise.withResolvers<void>()
  const seam = createBillingSeam(context(store, async path => {
    await hold.promise
    return path.endsWith("/checkout") ? Response.json({ url: "https://checkout.stripe.com/old-account" }) : reply(path)
  }), { overview: true, plans: true, checkout: true, portal: true }, () => disposed)
  const plans = seam.showBillingPlans(), checkout = seam.startCheckout("pro")
  try {
    if (change === "account") await signIn(store, "second-account")
    else disposed = true
    hold.resolve()
    expect(await plans).toEqual({ value: "The account changed while plans were loading." })
    expect(await checkout).toBe("The account changed while billing was loading.")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    expect(store.collections.billingAccounts.get("billing")?.planKey).toBeNull()
    expect([...store.collections.messages.values()].some(row => row.text.includes("old-account"))).toBe(false)
  } finally { hold.resolve(); await Promise.allSettled([plans, checkout]); await store.dispose?.() }
})

test.each([[undefined, "pro"], ["pro", "pro"]] as const)("checkout with plan %p asks the server for %p", async (plan, expected) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const bodies: unknown[] = []
  try {
    await signIn(store, "ada")
    const seam = createBillingSeam(context(store, async (path, init) => {
      if (path.endsWith("/checkout")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return Response.json({ url: "https://checkout.stripe.com/c/ok" })
      }
      return reply(path)
    }))
    await seam.startCheckout(plan)
    // An omitted plan must never fall to a server default: Pro is the sold plan.
    expect(bodies).toEqual([{ plan: expected }])
  } finally { await store.dispose?.() }
})
