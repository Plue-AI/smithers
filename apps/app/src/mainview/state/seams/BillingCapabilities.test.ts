import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createBillingSeam } from "./BillingSeam"

for (const overview of [false, true]) for (const plans of [false, true])
for (const checkout of [false, true]) for (const portal of [false, true]) {
  test(`billing routes are independent: ${JSON.stringify({ overview, plans, checkout, portal })}`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const calls: string[] = []
    const seam = createBillingSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal,
      http: async path => {
        calls.push(path)
        if (path === "/api/billing/plans") return Response.json({ plans: [], current_plan_key: "pro" })
        if (path === "/api/billing") return Response.json({ sandbox: { plan_key: "pro", concurrent_sandboxes: 3, concurrent_in_use: 1,
          idle_timeout_secs: 1800, hours_per_day: 4, seconds_used_today: 900, day_resets_at: "2026-09-27T00:00:00Z" } })
        return Response.json({ url: "https://billing.example/session" })
      }
    }, { overview, plans, checkout, portal })
    try {
      const result = await seam.showBillingPlans()
      expect(calls).toEqual(plans ? [...(overview ? ["/api/billing"] : []), "/api/billing/plans"] : [])
      expect(store.collections.cards.has("billing-plans")).toBe(plans)
      if (plans) {
        expect(result).toHaveProperty("value")
        const account = store.collections.billingAccounts.get("billing")
        expect(account?.planKey).toBe("pro")
        expect(account?.sandbox === null).toBe(!overview)
        expect(JSON.stringify(result).includes("Running sandboxes")).toBe(overview)
      }
      calls.length = 0
      await seam.startCheckout("pro")
      expect(calls).toEqual(checkout ? ["/api/billing/checkout"] : [])
      calls.length = 0
      await seam.openBillingPortal()
      expect(calls).toEqual(portal ? ["/api/billing/portal"] : [])
      const hash = (await store.verifyState()).actualHash
      await store.dispose?.()
      const reopened = await createAppStore({ kind: "localStorage", storage })
      try {
        expect((await reopened.verifyState()).actualHash).toBe(hash)
        if (plans) expect(reopened.collections.cards.get("billing-plans")).toMatchObject({ payload: { planKey: "pro", checkout } })
      } finally { await reopened.dispose?.() }
    } finally { await store.dispose?.() }
  })
}

test.each(["/api/billing", "/api/billing/plans"])("a configured %s failure stays visible and publishes no card", async failurePath => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  try {
    const seam = createBillingSeam({ store, dispatch: store.dispatch, baseUrl: "", actor: () => "user", nextOrdinal: store.nextOrdinal,
      http: async path => path === failurePath ? new Response("failure", { status: 503 }) : Response.json({ plans: [], current_plan_key: "pro" })
    }, { overview: true, plans: true, checkout: false, portal: true })
    expect(await seam.showBillingPlans()).toBe("Your plans couldn't be refreshed right now.")
    expect(store.collections.cards.has("billing-plans")).toBe(false)
  } finally { await store.dispose?.() }
})
