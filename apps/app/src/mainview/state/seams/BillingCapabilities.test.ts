import { afterEach, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createBillingSeam, type BillingCapabilities } from "./BillingSeam"
import type { SeamContext } from "./SeamContext"

const pending = new Set<Promise<unknown>>()
const retirements = new Set<() => void>()
const releases = new Set<() => void>()
const stores = new Set<AppStore>()
const retiredStores = new WeakSet<AppStore>()
const unexpected: string[] = []
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

for (const overview of [false, true]) for (const plans of [false, true])
for (const checkout of [false, true]) for (const portal of [false, true]) {
  test(`billing routes are independent: ${JSON.stringify({ overview, plans, checkout, portal })}`, async () => {
    const storage = memoryStorage()
    const store = await createOwnedStore({ kind: "localStorage", storage })
    const calls: string[] = []
    const seam = ownedSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal,
      http: async path => {
        calls.push(path)
        if (path === "/api/billing/plans") return Response.json({ plans: [], current_plan_key: "pro" })
        if (path === "/api/billing") return Response.json({ sandbox: { plan_key: "pro", concurrent_sandboxes: 3, concurrent_in_use: 1,
          idle_timeout_secs: 1800, hours_per_day: 4, seconds_used_today: 900, day_resets_at: "2026-09-27T00:00:00Z" } })
        return Response.json({ url: "https://billing.example/session" })
      }
    }, { overview, plans, checkout, portal })
    try {
      const beforePlans = (await store.eventHistory()).head
      const result = await seam.showBillingPlans()
      expect(calls).toEqual(plans ? [...(overview ? ["/api/billing"] : []), "/api/billing/plans"] : [])
      expect(store.collections.cards.has("billing-plans")).toBe(plans)
      if (plans) {
        expect(result).toHaveProperty("value")
        const account = store.collections.billingAccounts.get("billing")
        expect(account?.planKey).toBe("pro")
        expect(account?.sandbox === null).toBe(!overview)
        expect(JSON.stringify(result).includes("Running sandboxes")).toBe(overview)
      } else {
        expect(result).toBe("Plans are unavailable on this host.")
        expect((await store.eventHistory()).head).toEqual(beforePlans)
      }
      calls.length = 0
      const priorMessages = [...store.collections.messages.values()].map(row => row.text)
      expect(await seam.startCheckout("pro")).toBeUndefined()
      expect(calls).toEqual(checkout ? ["/api/billing/checkout"] : [])
      expect([...store.collections.messages.values()].map(row => row.text)).toEqual([...priorMessages,
        checkout ? "Checkout is ready: https://billing.example/session" : "Checkout is not open yet."])
      calls.length = 0
      const beforePortal = (await store.eventHistory()).head
      const portalResult = await seam.openBillingPortal()
      expect(calls).toEqual(portal ? ["/api/billing/portal"] : [])
      if (portal) expect(portalResult).toBeUndefined()
      else {
        expect(portalResult).toBe("The billing portal is unavailable on this host.")
        expect((await store.eventHistory()).head).toEqual(beforePortal)
      }
      const hash = (await store.verifyState()).actualHash
      await closeStore(store)
      const reopened = await createOwnedStore({ kind: "localStorage", storage })
      try {
        expect((await reopened.verifyState()).actualHash).toBe(hash)
        if (plans) expect(reopened.collections.cards.get("billing-plans")).toMatchObject({ payload: { planKey: "pro", checkout } })
      } finally { await closeStore(reopened) }
    } finally { await closeStore(store) }
  })
}

test.each(["/api/billing", "/api/billing/plans"])("a configured %s failure stays visible and publishes no card", async failurePath => {
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  try {
    const seam = ownedSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal,
      http: async path => path === failurePath ? new Response("failure", { status: 503 }) : Response.json({ plans: [], current_plan_key: "pro" })
    }, { overview: true, plans: true, checkout: false, portal: true })
    expect(await seam.showBillingPlans()).toBe("Your plans couldn't be refreshed right now.")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
  } finally { await closeStore(store) }
})
