import { Window } from "happy-dom"
import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore, type PersistenceBackend } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import { createBillingSeam, outOfCreditRefusal, renderCreditExhausted, renderPlanLimit, type BillingCapabilities } from "./BillingSeam"
import { refusalOf, type Refusal, type StoredRefusal } from "@smthrs/rpc/Refusal"
import { isRecord } from "@smthrs/canonical/Record"
import { BillingAccountSchema, CardSchema, MessageSchema } from "../AppState"
import type { SeamContext } from "./SeamContext"

const pending = new Set<Promise<unknown>>()
const retirements = new Set<() => void>()
const releases = new Set<() => void>()
const stores = new Set<AppStore>()
const retiredStores = new WeakSet<AppStore>()
const unexpected: string[] = []
const restorations = new Set<() => Promise<void>>()
const track = <T>(task: Promise<T>): Promise<T> => {
  pending.add(task)
  void task.then(() => pending.delete(task), () => pending.delete(task))
  return task
}
const trackResponse = (response: Response): Response => {
  const json = response.json.bind(response)
  const text = response.text.bind(response)
  const clone = response.clone.bind(response)
  response.json = () => track(json())
  response.text = () => track(text())
  response.clone = () => trackResponse(clone())
  return response
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const drain = async () => {
  do {
    await Promise.allSettled([...pending])
    await tick()
  } while (pending.size > 0)
}
const bounded = async (task: Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Billing fixture work did not settle")), 3000)
    })])
  } finally { clearTimeout(timer) }
}
const createOwnedStore = async (...args: Parameters<typeof createAppStore>) => {
  const store = await createAppStore(...args)
  stores.add(store)
  retirements.add(() => { retiredStores.add(store) })
  return store
}
const closeStore = async (store: AppStore) => {
  if (!stores.has(store)) return
  try {
    if (!store.dispose) throw new Error("Billing store disposal is required")
    await store.dispose()
  } finally { stores.delete(store) }
}

const billingWindow = () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const browser = new Window({ url: "https://app.test" })
  restorations.add(async () => {
    try {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    } finally { await browser.happyDOM.close() }
  })
  Object.defineProperty(globalThis, "window", { value: browser, writable: true, configurable: true })
  const opens: Array<Parameters<typeof browser.open>> = []
  browser.open = (...args) => { opens.push(args); return null }
  return { browser, opens }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const retire of retirements) { try { retire() } catch (error) { failures.push(error) } }
  retirements.clear()
  for (const release of releases) { try { release() } catch (error) { failures.push(error) } }
  releases.clear()
  try { await bounded(drain()) } catch (error) { failures.push(error) }
  for (const store of stores) {
    try { await closeStore(store) } catch (error) { failures.push(error) }
  }
  for (const restore of restorations) { try { await restore() } catch (error) { failures.push(error) } }
  restorations.clear()
  if (unexpected.length) failures.push(new Error(`Unexpected Billing HTTP: ${unexpected.join(", ")}`))
  unexpected.length = 0
  if (failures.length) throw new AggregateError(failures, "Billing fixture cleanup failed")
})

const ownedSeam = (ctx: SeamContext, capabilities?: BillingCapabilities, disposed: () => boolean = () => false) => {
  const real = createBillingSeam({ ...ctx,
    dispatch: transition => { const receipt = ctx.dispatch(transition); track(receipt.isPersisted.promise); return receipt },
    http: (path, init) => track(Promise.resolve().then(async () => {
      const method = init?.method ?? "GET"
      const allowed = (method === "GET" && (path === `${ctx.baseUrl}/api/billing` || path === `${ctx.baseUrl}/api/billing/plans`)) ||
        (method === "POST" && (path === `${ctx.baseUrl}/api/billing/checkout` || path === `${ctx.baseUrl}/api/billing/portal`))
      if (!allowed) {
        unexpected.push(`${method} ${path}`)
        throw new Error("Unexpected Billing HTTP")
      }
      return trackResponse(await ctx.http(path, init))
    }))
  }, capabilities, () => retiredStores.has(ctx.store) || disposed())
  return { showBillingPlans: () => track(real.showBillingPlans()),
    startCheckout: (plan?: string) => track(real.startCheckout(plan)),
    openBillingPortal: () => track(real.openBillingPortal()) }
}

const reply = (path: string) => Response.json(path.endsWith("/plans") ? { plans: [], current_plan_key: "free" } : {
  sandbox: { plan_key: "free", concurrent_sandboxes: 1, concurrent_in_use: 1, idle_timeout_secs: 1800,
    hours_per_day: 4, seconds_used_today: 900, day_resets_at: "2026-09-16T00:00:00Z" }
})
const context = (store: AppStore, http: SeamContext["http"] = async path => reply(path)): SeamContext => ({
  store, dispatch: store.dispatch, http, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal
})
const signIn = (store: AppStore, login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system",
  state: "signed-in", login, admin: false, scopesPlain: null }).isPersisted.promise

test("billing reads wait for the account receipt before publishing a card or result, then reopen identically", async () => {
  const storage = memoryStorage(), store = await createOwnedStore({ kind: "localStorage", storage })
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  releases.add(() => hold.resolve())
  const ctx = context(store)
  const seam = ownedSeam({ ...ctx, dispatch: transition => {
    const receipt = store.dispatch(transition)
    if (transition.type !== "billing.plans.loaded") return receipt
    return new Proxy(receipt, { get: (target, property, receiver) => property === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => { entered.resolve(); return hold.promise }) }
      : Reflect.get(target, property, receiver) })
  } })
  let finished = false
  const reading = track(seam.showBillingPlans().finally(() => { finished = true }))
  try {
    await entered.promise
    await tick()
    expect(finished).toBe(false)
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    hold.resolve()
    expect(await reading).toHaveProperty("value")
    const proof = await store.verifyState()
    expect(proof.valid).toBe(true)
    await closeStore(store)
    const reopened = await createOwnedStore({ kind: "localStorage", storage })
    try {
      expect(reopened.collections.cards.get("billing-plans")).toMatchObject({ payload: { planKey: "free" } })
      expect((await reopened.verifyState()).actualHash).toBe(proof.actualHash)
    } finally { await closeStore(reopened) }
  } finally { hold.resolve() }
})

test.each(["plans", "limit"] as const)("failed %s persistence cannot report a saved card", async kind => {
  const storage = memoryStorage()
  let fail = false
  const store = await createOwnedStore({ kind: "localStorage", storage: { ...storage, setItem: (key, value) => {
    if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("billing disk failure")
    storage.setItem(key, value)
  } } })
  try {
    const before = await store.eventHistory()
    fail = true
    if (kind === "plans") expect(await ownedSeam(context(store)).showBillingPlans()).toBe("Your plans couldn't be refreshed and saved right now.")
    else await expect(renderPlanLimit(store, refusalOf({ status: 402, body: { code: "plan_limit_exceeded", upgrade_plan_key: "pro" }, message: "Limit reached." }), true, "user")).rejects.toThrow("billing disk failure")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    expect(store.collections.cards.has("billing-plan-limit")).toBe(false)
    expect((await store.eventHistory()).head).toEqual(before.head)
    expect((await store.verifyState()).valid).toBe(true)
  } finally { fail = false; await closeStore(store) }
})

test.each(["account", "dispose"] as const)("late plan and checkout answers cannot cross %s", async change => {
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  await signIn(store, "first-account")
  let disposed = false
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  releases.add(() => hold.resolve())
  let requests = 0
  const seam = ownedSeam(context(store, async path => {
    if (++requests === 3) entered.resolve()
    await hold.promise
    return path.endsWith("/checkout") ? Response.json({ url: "https://checkout.stripe.com/old-account" }) : reply(path)
  }), { overview: true, plans: true, checkout: true, portal: true }, () => disposed)
  const plans = seam.showBillingPlans(), checkout = seam.startCheckout("pro")
  try {
    await entered.promise
    if (change === "account") await signIn(store, "second-account")
    else disposed = true
    hold.resolve()
    expect(await plans).toEqual({ value: "The account changed while plans were loading." })
    expect(await checkout).toBe("The account changed while billing was loading.")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
    expect(store.collections.billingAccounts.get("billing")?.planKey).toBeNull()
    expect([...store.collections.messages.values()].some(row => row.text.includes("old-account"))).toBe(false)
  } finally { hold.resolve() }
})

test.each([[undefined, "pro"], ["pro", "pro"]] as const)("checkout with plan %p asks the server for %p", async (plan, expected) => {
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  const bodies: unknown[] = []
  try {
    await signIn(store, "ada")
    const seam = ownedSeam(context(store, async (path, init) => {
      if (path.endsWith("/checkout")) {
        bodies.push(JSON.parse(String(init?.body ?? "{}")))
        return Response.json({ url: "https://checkout.stripe.com/c/ok" })
      }
      return reply(path)
    }))
    await seam.startCheckout(plan)
    // An omitted plan must never fall to a server default: Pro is the sold plan.
    expect(bodies).toEqual([{ plan: expected }])
  } finally { await closeStore(store) }
})

const observedCatalog = { current_plan_key: "free", plans: [{ key: "pro" as const, display_name: "Pro", price_cents: 1950, interval: "monthly", checkout_available: true,
  limits: { concurrent_sandboxes: 3, idle_timeout_secs: 14400, hours_per_day: -1, private_repos: -1, storage_bytes: -1, ci_minutes: -1, agent_runs: -1, seats: 1, monthly_credit_cents: 5000 } }] }
const observedOverview = { credit_balance_cents: -5, usage_period_end: "2026-10-01T00:00:00Z",
  sandbox: { plan_key: "pro", concurrent_sandboxes: 3, concurrent_in_use: 2, idle_timeout_secs: 14400, hours_per_day: -1, seconds_used_today: 5400, day_resets_at: "2026-09-27T00:00:00Z" } }
const readFailures = [
  { name: "transport rejection", jsonFailure: true },
  { name: "malformed JSON", jsonFailure: true },
  { name: "body-reader failure", jsonFailure: true },
  { name: "schema-invalid JSON", jsonFailure: false }
]
for (const path of ["/api/billing", "/api/billing/plans"]) test.each(readFailures)(`${path} $name preserves the prior persisted observations and a later valid read recovers`, async ({ name, jsonFailure }) => {
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  let phase: "initial" | "failure" | "recovery" = "initial"
  const calls: string[] = []
  const seam = ownedSeam(context(store, async requested => {
    calls.push(requested)
    if (phase === "failure" && requested === path) {
      if (name === "transport rejection") throw new Error("controlled billing read failed")
      if (name === "malformed JSON") return new Response("{invalid", { headers: { "content-type": "application/json" } })
      if (name === "body-reader failure") return new Response(new ReadableStream<Uint8Array>({ start(reader) { reader.error(new Error("controlled billing body failed")) } }))
      return Response.json(path === "/api/billing" ? { ...observedOverview, credit_balance_cents: 1.5 } : { ...observedCatalog, plans: [{ ...observedCatalog.plans[0], key: "unsupported" }] })
    }
    return Response.json(requested === "/api/billing/plans" ? observedCatalog : { ...observedOverview, credit_balance_cents: phase === "recovery" ? 1000 : -5 })
  }))
  expect(await seam.showBillingPlans()).toEqual({ value: "Current plan: pro. Credit: -$0.05. Running sandboxes: 2 / 3. Sandbox-hours today: 1.5 / unlimited. Resets at 2026-09-27T00:00:00Z. Plans: Pro $19.5." })
  const account = store.collections.billingAccounts.get("billing"), card = store.collections.cards.get("billing-plans")
  expect(account).toMatchObject({ planKey: "pro", plans: observedCatalog.plans, creditBalanceCents: -5, creditResetsAt: "2026-10-01T00:00:00Z",
    sandbox: { concurrentSandboxes: 3, concurrentInUse: 2, idleTimeoutSecs: 14400, hoursPerDay: -1, secondsUsedToday: 5400, dayResetsAt: "2026-09-27T00:00:00Z" } })
  expect(card).toMatchObject({ kind: "billing-plans", title: "Plans", status: "active", payload: { planKey: "pro", plans: observedCatalog.plans, checkout: true,
    sandbox: { concurrentSandboxes: 3, concurrentInUse: 2, idleTimeoutSecs: 14400, hoursPerDay: -1, secondsUsedToday: 5400, dayResetsAt: "2026-09-27T00:00:00Z" } } })
  const priorHead = (await store.eventHistory()).head
  phase = "failure"
  expect(await seam.showBillingPlans()).toBe(jsonFailure ? "Your plans couldn't be refreshed and saved right now." : "Your plans couldn't be refreshed right now.")
  expect(store.collections.billingAccounts.get("billing")).toEqual(account)
  expect(store.collections.cards.get("billing-plans")).toEqual(card)
  expect((await store.eventHistory()).head).toEqual(priorHead)
  phase = "recovery"
  expect(await seam.showBillingPlans()).toEqual({ value: "Current plan: pro. Credit: $10.00. Running sandboxes: 2 / 3. Sandbox-hours today: 1.5 / unlimited. Resets at 2026-09-27T00:00:00Z. Plans: Pro $19.5." })
  expect(store.collections.billingAccounts.get("billing")).toMatchObject({ planKey: "pro", creditBalanceCents: 1000, creditResetsAt: "2026-10-01T00:00:00Z", plans: observedCatalog.plans })
  expect(calls).toEqual(["/api/billing", "/api/billing/plans", "/api/billing", "/api/billing/plans", "/api/billing", "/api/billing/plans"])
  expect((await store.verifyState()).valid).toBe(true)
})

/** A controlled PersistenceBackend port, not real OPFS/SQLite: staged writes commit only after flush. */
type FlushTarget = string | { kind: "account"; planKey: string } | { kind: "card"; id: string }
const flushStore = async (target: FlushTarget) => {
  const committed = new Map<string, string>()
  let staged: Map<string, string> | undefined
  let ready = false
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  void hold.promise.catch(() => {})
  releases.add(() => { ready = false; hold.resolve() })
  const host: PersistenceBackend = { kind: "opfs",
    storage: { getItem: key => (staged ?? committed).get(key) ?? null, setItem: (key, value) => { (staged ?? committed).set(key, value) }, removeItem: key => { (staged ?? committed).delete(key) } },
    storageEventApi: { addEventListener() {}, removeEventListener() {} },
    beginBatch: () => { if (staged) throw new Error("Overlapping Billing persistence batches"); staged = new Map(committed) },
    commitBatch: () => { if (!staged) throw new Error("No Billing persistence batch") },
    abortBatch: () => { staged = undefined },
    flush: async () => {
      const key = typeof target === "string" ? "smithers-mvp.app-messages"
        : target.kind === "account" ? "smithers-mvp.app-billing-accounts" : "smithers-mvp.app-cards"
      const changed = staged?.get(key)
      if (ready && changed !== undefined && changed !== committed.get(key)) {
        const rows: unknown = JSON.parse(changed)
        const matched = isRecord(rows) && Object.values(rows).some(entry => {
          if (!isRecord(entry)) return false
          if (typeof target === "string") {
            const row = MessageSchema.safeParse(entry.data)
            return row.success && row.data.text === target
          }
          if (target.kind === "account") {
            const row = BillingAccountSchema.safeParse(entry.data)
            return row.success && row.data.id === "billing" && row.data.planKey === target.planKey
          }
          const row = CardSchema.safeParse(entry.data)
          return row.success && row.data.id === target.id && row.data.kind === "billing-plans"
        })
        if (matched) { ready = false; entered.resolve(); await hold.promise }
      }
      if (staged) { committed.clear(); for (const [key, value] of staged) committed.set(key, value); staged = undefined }
    },
    close: async () => { staged = undefined }
  }
  const store = await createOwnedStore(host)
  await signIn(store, "will")
  ready = true
  const committedRow = (key: string, id: string): unknown => {
    const value = committed.get(key)
    if (value === undefined) return undefined
    const rows: unknown = JSON.parse(value)
    const entry = isRecord(rows) ? rows[`s:${id}`] : undefined
    return isRecord(entry) ? entry.data : undefined
  }
  return { store, entered: entered.promise, hold, committedBytes: () => [...committed.values()].join("\n"),
    committedAccount: () => BillingAccountSchema.parse(committedRow("smithers-mvp.app-billing-accounts", "billing")),
    committedCard: () => {
      const row = committedRow("smithers-mvp.app-cards", "billing-plans")
      return row === undefined ? undefined : CardSchema.parse(row)
    }, reopen: () => createOwnedStore(host) }
}

for (const operation of ["checkout", "portal"]) test(`${operation} waits for actual message flush before opening its HTTPS session`, async () => {
  const { opens } = billingWindow()
  const h = await flushStore(operation === "checkout" ? "Checkout is ready: https://billing.example/held" : "Your billing portal: https://billing.example/held")
  const calls: Array<{ path: string; init: RequestInit | undefined }> = []
  const seam = ownedSeam(context(h.store, async (path, init) => { calls.push({ path, init }); return Response.json({ url: "https://billing.example/held" }, { status: 201 }) }))
  let completed = false
  const work = track((operation === "checkout" ? seam.startCheckout("pro") : seam.openBillingPortal()).finally(() => { completed = true }))
  await h.entered
  await tick()
  expect(completed).toBe(false)
  expect(opens).toEqual([])
  expect(h.committedBytes()).not.toContain("https://billing.example/held")
  expect(calls).toEqual(operation === "checkout"
    ? [{ path: "/api/billing/checkout", init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"plan":"pro"}' } }]
    : [{ path: "/api/billing/portal", init: { method: "POST" } }])
  h.hold.resolve()
  expect(await work).toBeUndefined()
  expect(opens).toEqual([["https://billing.example/held", "_blank", "noopener"]])
  expect([...h.store.collections.messages.values()].map(row => row.text)).toEqual(operation === "checkout" ? ["Checkout is ready: https://billing.example/held"] : ["Your billing portal: https://billing.example/held"])
  expect(h.committedBytes()).toContain("https://billing.example/held")
  expect((await h.store.verifyState()).valid).toBe(true)
})

test("a refused actual checkout-message flush cannot open or persist a session", async () => {
  const { opens } = billingWindow()
  const h = await flushStore("Checkout is ready: https://billing.example/unsaved")
  const priorHead = (await h.store.eventHistory()).head
  const seam = ownedSeam(context(h.store, async () => Response.json({ url: "https://billing.example/unsaved" }, { status: 201 })))
  const work = seam.startCheckout("pro")
  await h.entered
  await tick()
  expect(opens).toEqual([])
  h.hold.reject(new Error("controlled billing flush failed"))
  await expect(work).rejects.toThrow("controlled billing flush failed")
  expect(opens).toEqual([])
  expect([...h.store.collections.messages.values()].map(row => row.text)).toEqual([])
  expect(h.committedBytes()).not.toContain("https://billing.example/unsaved")
  expect((await h.store.eventHistory()).head).toEqual(priorHead)
  expect((await h.store.verifyState()).valid).toBe(true)
})

for (const change of ["account", "dispose"]) test(`a portal reply held during body reading cannot cross ${change}`, async () => {
  const { opens } = billingWindow()
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  await signIn(store, "first-account")
  const hold = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  releases.add(() => hold.resolve())
  let disposed = false
  const calls: Array<{ path: string; init: RequestInit | undefined }> = []
  const seam = ownedSeam(context(store, async (path, init) => {
    calls.push({ path, init })
    return new Response(new ReadableStream<Uint8Array>({ async pull(reader) {
      entered.resolve(); await hold.promise
      reader.enqueue(new TextEncoder().encode('{"url":"https://billing.example/original-account"}')); reader.close()
    } }, { highWaterMark: 0 }), { status: 201, headers: { "content-type": "application/json" } })
  }), undefined, () => disposed)
  const work = seam.openBillingPortal()
  await entered.promise
  if (change === "account") await signIn(store, "second-account")
  else disposed = true
  const postChangeHead = (await store.eventHistory()).head
  hold.resolve()
  expect(await work).toBe("The account changed while billing was loading.")
  expect([...store.collections.messages.values()].map(row => row.text)).toEqual([])
  expect(opens).toEqual([])
  expect(calls).toEqual([{ path: "/api/billing/portal", init: { method: "POST" } }])
  expect((await store.eventHistory()).head).toEqual(postChangeHead)
})

const observedSandbox = { concurrentSandboxes: 3, concurrentInUse: 2, idleTimeoutSecs: 14400,
  hoursPerDay: -1, secondsUsedToday: 5400, dayResetsAt: "2026-09-27T00:00:00Z" }
const limitRefusal: Refusal = { code: "plan_limit_exceeded", rawCode: "plan_limit_exceeded", fault: "user",
  message: "Limit reached.", status: 402, retryAfter: null, origin: "plue", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro" }
const limitStored = { code: "plan_limit_exceeded", fault: "user", message: "Limit reached.", status: 402,
  retryAfterSeconds: null, origin: "plue", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro" } satisfies StoredRefusal
const creditRefusal: Refusal = { code: "out_of_credit", rawCode: "out_of_credit", fault: "user",
  message: "Model credit spent.", status: 402, retryAfter: null, origin: "plue" }

const assertReopened = async (store: AppStore, reopen: () => Promise<AppStore>) => {
  const cards = [...store.collections.cards.values()]
  const account = store.collections.billingAccounts.get("billing")
  const messages = [...store.collections.messages.values()]
  const proof = await store.verifyState()
  expect(proof.valid).toBe(true)
  await closeStore(store)
  const reopened = await reopen()
  try {
    expect([...reopened.collections.cards.values()]).toEqual(cards)
    expect(reopened.collections.billingAccounts.get("billing")).toEqual(account)
    expect([...reopened.collections.messages.values()]).toEqual(messages)
    expect((await reopened.verifyState()).actualHash).toBe(proof.actualHash)
  } finally { await closeStore(reopened) }
}

const seedObservedBilling = (store: AppStore) => track(store.dispatch({ type: "billing.plans.loaded", actor: "system",
  planKey: "pro", sandbox: observedSandbox, plans: observedCatalog.plans, creditBalanceCents: -5,
  creditResetsAt: "2026-10-01T00:00:00Z" }).isPersisted.promise)

test("outOfCreditRefusal carries the supplied message and the Pro upgrade verdict", () => {
  expect(outOfCreditRefusal("Model credit spent.")).toEqual({ code: "out_of_credit", rawCode: "out_of_credit",
    fault: "user", message: "Model credit spent.", status: 402, retryAfter: null, origin: "plue", upgrade_plan_key: "pro" })
})

test.each([
  { name: "initialized defaults", populated: false, planKey: undefined, actor: "user", checkout: false,
    id: "billing-plan-limit", title: "Sandbox limit", expectedPlan: null },
  { name: "refusal plan overrides observed plan", populated: true, planKey: "free", actor: "smithers", checkout: true,
    id: "limit-for-repository", title: "Repository limit", expectedPlan: "free" },
  { name: "missing refusal plan inherits observed plan", populated: true, planKey: undefined, actor: "system", checkout: false,
    id: "billing-plan-limit", title: "Sandbox limit", expectedPlan: "pro" }
] as const)("renderPlanLimit preserves $name with a durable actor receipt", async row => {
  const storage = memoryStorage(), store = await createOwnedStore({ kind: "localStorage", storage })
  await track(signIn(store, "will"))
  if (row.populated) await seedObservedBilling(store)
  const account = store.collections.billingAccounts.get("billing")
  const refusal: Refusal = { ...limitRefusal, ...(row.planKey === undefined ? {} : { plan_key: row.planKey }) }
  const original = structuredClone(refusal), ordinal = store.nextOrdinal()
  const result = await track(renderPlanLimit(store, refusal, row.checkout, row.actor,
    row.id === "billing-plan-limit" ? undefined : { id: row.id, title: row.title }))
  expect(result).toBe("plan_limit_exceeded — Limit reached. Your plan is at its sandbox limit.")
  expect(refusal).toEqual(original)
  const card = store.collections.cards.get(row.id)
  expect(card).toMatchObject({ id: row.id, kind: "billing-plans", title: row.title, status: "active", ordinal })
  if (card?.kind !== "billing-plans") throw new Error("Missing plans card")
  expect(card.payload).toEqual({ planKey: row.expectedPlan, sandbox: row.populated ? observedSandbox : null,
    plans: row.populated ? observedCatalog.plans : [], checkout: row.checkout,
    refusal: { ...limitStored, ...(row.planKey === undefined ? {} : { plan_key: row.planKey }) } })
  expect(store.collections.billingAccounts.get("billing")).toEqual(account)
  expect(store.collections.cards.size).toBe(1)
  expect((await store.eventHistory()).events.filter(event => event.type === "card.upsert").map(event => event.actor)).toEqual([row.actor])
  expect(store.session().maximizedCardId).toBeNull()
  await assertReopened(store, () => createOwnedStore({ kind: "localStorage", storage }))
})

test.each([undefined, null, "pro"] as const)("renderCreditExhausted with upgrade %p retains the durable Pro door", async upgrade => {
  const storage = memoryStorage(), store = await createOwnedStore({ kind: "localStorage", storage })
  await track(signIn(store, "will"))
  await seedObservedBilling(store)
  const refusal: Refusal = { ...creditRefusal, upgrade_plan_key: upgrade }
  const original = structuredClone(refusal), account = store.collections.billingAccounts.get("billing"), ordinal = store.nextOrdinal()
  expect(await track(renderCreditExhausted(store, refusal, true, "smithers"))).toBe("out_of_credit — Model credit spent. Out of credit.")
  expect(refusal).toEqual(original)
  const card = store.collections.cards.get("billing-credit-exhausted")
  expect(card).toMatchObject({ id: "billing-credit-exhausted", kind: "billing-plans", title: "Out of model credit", status: "active", ordinal })
  if (card?.kind !== "billing-plans") throw new Error("Missing credit plans card")
  expect(card.payload).toEqual({ planKey: "pro", sandbox: observedSandbox, plans: observedCatalog.plans, checkout: true,
    refusal: { code: "out_of_credit", message: "Model credit spent.", status: 402, retryAfterSeconds: null, fault: "user", origin: "plue", upgrade_plan_key: "pro" } })
  expect(store.collections.billingAccounts.get("billing")).toEqual(account)
  expect(store.collections.cards.has("billing-plan-limit")).toBe(false)
  expect((await store.eventHistory()).events.filter(event => event.type === "card.upsert").map(event => event.actor)).toEqual(["smithers"])
  await assertReopened(store, () => createOwnedStore({ kind: "localStorage", storage }))
})

for (const checkout of [true, false]) test(`Max is not for sale with checkout ${checkout}, before any host refusal or request`, async () => {
  const { opens } = billingWindow()
  const storage = memoryStorage(), store = await createOwnedStore({ kind: "localStorage", storage })
  await track(signIn(store, "will"))
  const account = store.collections.billingAccounts.get("billing")
  const calls: string[] = []
  const seam = ownedSeam(context(store, async path => {
    calls.push(path); unexpected.push(path); throw new Error("Max must not request billing")
  }), { overview: true, plans: true, checkout, portal: true })
  expect(await seam.startCheckout("max")).toBeUndefined()
  expect([...store.collections.messages.values()].map(row => row.text)).toEqual(["Max is not for sale. Upgrade to Pro."])
  expect((await store.eventHistory()).events.filter(event => event.type === "message.appended").map(event => event.actor)).toEqual(["user"])
  expect(calls).toEqual([])
  expect(opens).toEqual([])
  expect(store.collections.cards.size).toBe(0)
  expect(store.collections.billingAccounts.get("billing")).toEqual(account)
  await assertReopened(store, () => createOwnedStore({ kind: "localStorage", storage }))
})

test("checkout capability refusal waits for the actual message flush", async () => {
  const { opens } = billingWindow()
  const h = await flushStore("Checkout is not open yet.")
  const calls: string[] = []
  const seam = ownedSeam(context(h.store, async path => {
    calls.push(path); unexpected.push(path); throw new Error("Disabled checkout must not request billing")
  }), { overview: true, plans: true, checkout: false, portal: true })
  let completed = false
  const work = track(seam.startCheckout("pro").finally(() => { completed = true }))
  await bounded(h.entered)
  await tick()
  expect(completed).toBe(false)
  expect(h.committedBytes()).not.toContain("Checkout is not open yet.")
  expect(calls).toEqual([])
  expect(opens).toEqual([])
  h.hold.resolve()
  expect(await work).toBeUndefined()
  expect([...h.store.collections.messages.values()].map(row => row.text)).toEqual(["Checkout is not open yet."])
  expect(h.committedBytes()).toContain("Checkout is not open yet.")
  expect((await h.store.eventHistory()).events.filter(event => event.type === "message.appended").map(event => event.actor)).toEqual(["user"])
  expect(h.store.collections.cards.size).toBe(0)
  await assertReopened(h.store, h.reopen)
})

for (const operation of ["checkout", "portal"] as const) test(`${operation} rejects a malformed absolute URL without committing or opening`, async () => {
  const { opens } = billingWindow()
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  await track(signIn(store, "will"))
  const calls: Array<{ path: string; init: RequestInit | undefined }> = []
  const ctx = context(store, async (path, init) => {
    if (path !== `/api/billing/${operation}` || init?.method !== "POST") {
      unexpected.push(`${init?.method ?? "GET"} ${path}`); throw new Error("Unexpected malformed-URL request")
    }
    calls.push({ path, init })
    return trackResponse(Response.json({ url: "not an absolute URL" }))
  })
  // This fully awaited case qualifies the public factory's default disposal callback.
  const seam = operation === "checkout" ? createBillingSeam({ ...ctx,
    dispatch: transition => { const receipt = store.dispatch(transition); track(receipt.isPersisted.promise); return receipt },
    http: (path, init) => track(ctx.http(path, init))
  }) : ownedSeam(ctx)
  const before = await store.eventHistory(), account = store.collections.billingAccounts.get("billing")
  expect(await track(operation === "checkout" ? seam.startCheckout("pro") : seam.openBillingPortal())).toBe(operation === "checkout"
    ? "Checkout was refused — the billing service answered with a non-https URL."
    : "The billing portal was refused — the billing service answered with a non-https URL.")
  expect(calls).toEqual(operation === "checkout"
    ? [{ path: "/api/billing/checkout", init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"plan":"pro"}' } }]
    : [{ path: "/api/billing/portal", init: { method: "POST" } }])
  expect(opens).toEqual([])
  expect([...store.collections.messages.values()]).toEqual([])
  expect([...store.collections.cards.values()]).toEqual([])
  expect(store.collections.billingAccounts.get("billing")).toEqual(account)
  expect(await store.eventHistory()).toEqual(before)
})

for (const phase of ["account", "card"] as const) test(`disposal after the actual ${phase} flush preserves committed truth and refuses successful plans`, async () => {
  const h = await flushStore(phase === "account" ? { kind: "account", planKey: "pro" } : { kind: "card", id: "billing-plans" })
  const calls: string[] = []
  let disposed = false, completed = false
  const seam = ownedSeam(context(h.store, async path => {
    calls.push(path)
    return Response.json(path === "/api/billing/plans" ? observedCatalog : observedOverview)
  }), undefined, () => disposed)
  const before = await h.store.eventHistory()
  const work = track(seam.showBillingPlans().finally(() => { completed = true }))
  await bounded(h.entered)
  await tick()
  expect(completed).toBe(false)
  expect(h.committedAccount().planKey).toBe(phase === "account" ? null : "pro")
  expect(h.committedCard()).toBeUndefined()
  disposed = true
  h.hold.resolve()
  expect(await work).toBe("The account changed while plans were loading.")
  expect(calls).toEqual(["/api/billing", "/api/billing/plans"])
  expect(h.committedAccount()).toMatchObject({ planKey: "pro", sandbox: observedSandbox, plans: observedCatalog.plans,
    creditBalanceCents: -5, creditResetsAt: "2026-10-01T00:00:00Z" })
  expect(BillingAccountSchema.parse(h.store.collections.billingAccounts.get("billing"))).toEqual(h.committedAccount())
  if (phase === "account") {
    expect(h.committedCard()).toBeUndefined()
    expect(h.store.collections.cards.has("billing-plans")).toBe(false)
  } else {
    const committedCard = h.committedCard()
    if (committedCard === undefined) throw new Error("Missing committed plans card")
    expect(committedCard).toMatchObject({ kind: "billing-plans", title: "Plans", status: "active",
      payload: { planKey: "pro", sandbox: observedSandbox, plans: observedCatalog.plans, checkout: true } })
    expect(CardSchema.parse(h.store.collections.cards.get("billing-plans"))).toEqual(committedCard)
  }
  const after = await h.store.eventHistory()
  expect(after.events.filter(event => event.sequence > before.head.sequence).map(event => [event.type, event.actor])).toEqual(phase === "account"
    ? [["billing.plans.loaded", "user"]] : [["billing.plans.loaded", "user"], ["card.upsert", "user"]])
  expect([...h.store.collections.messages.values()]).toEqual([])
  await assertReopened(h.store, h.reopen)
})
