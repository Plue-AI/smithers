import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The billing checkout seam, driven through the user command path
 * (commands.run — billing.upgrade and billing.portal are trigger:"user").
 * The backend answers a Stripe session as { url } — the field name mirrors
 * multi src/smithersCloud/billing.ts sessionUrl(), which reads body.url and
 * validates it is an absolute http(s) URL. This seam is stricter: https only.
 * Success is stated in the transcript so the link survives a blocked popup;
 * failure comes back as an honest error string, never a throw.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}


const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

interface BillingCall {
  readonly url: string
  readonly method: string
  readonly body: string
}

/** Answers the two billing routes from a table; 404s everything else like the dead backend. */
const billingBackend = (
  routes: Partial<Record<"/api/billing/checkout" | "/api/billing/portal", () => Response>>,
  calls: BillingCall[] = []
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const route = routes[url as keyof typeof routes]
    if (route === undefined) return json(404, { status: "error", message: `no stub for ${url}` })
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" })
    return route()
  }
})

const freshController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, services)
  // Both billing commands require signed-in; park nothing, run for real.
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    // §17.4: the Stripe flows register in the admin plugin only — an MVP
    // account is never offered a checkout it has no plan for.
    admin: true,
    scopesPlain: null
  })
  await settled()
  return { store, controller }
}

const messageTexts = (store: AppStore): string[] =>
  [...store.collections.messages.values()].map((message) => message.text)

describe("billing seam — the success path", () => {
  test("billing.upgrade pro: POSTs {plan}, transcript states the checkout URL", async () => {
    const calls: BillingCall[] = []
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { url: "https://checkout.stripe.com/x" }) }, calls)
    )
    const outcome = await controller.commands.run("billing.upgrade", "pro")
    expect(outcome.status).toBe("executed")
    await settled()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("POST")
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ plan: "pro" })
    expect(messageTexts(store).some((text) => text.includes("Checkout is ready: https://checkout.stripe.com/x"))).toBe(
      true
    )
  })

  test("billing.upgrade without a plan asks for Pro, never a server default", async () => {
    const calls: BillingCall[] = []
    const { controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { url: "https://checkout.stripe.com/x" }) }, calls)
    )
    const outcome = await controller.commands.run("billing.upgrade")
    expect(outcome.status).toBe("executed")
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ plan: "pro" })
  })

  test("billing.portal: POSTs the portal route, transcript states the portal URL", async () => {
    const calls: BillingCall[] = []
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/portal": () => json(200, { url: "https://billing.stripe.com/p" }) }, calls)
    )
    const outcome = await controller.commands.run("billing.portal")
    expect(outcome.status).toBe("executed")
    await settled()
    expect(calls[0]?.url).toBe("/api/billing/portal")
    expect(calls[0]?.method).toBe("POST")
    expect(messageTexts(store).some((text) => text.includes("Your billing portal: https://billing.stripe.com/p"))).toBe(
      true
    )
  })
})

describe("billing seam — the honest failure paths", () => {
  test("a 402 comes back as a failed outcome carrying the server's message", async () => {
    const { controller } = await freshController(
      billingBackend({
        "/api/billing/checkout": () => json(402, { message: "Payment required — top up your balance first." })
      })
    )
    const outcome = await controller.commands.run("billing.upgrade", "pro")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Payment required — top up your balance first.")
  })

  test("a bodyless 500 answers the fallback and whose fault it was", async () => {
    const { controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => new Response("", { status: 500 }) })
    )
    const outcome = await controller.commands.run("billing.upgrade", "pro")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Checkout couldn't start right now. That's a bug in Smithers, not something you did.")
  })

  test("a network throw never escapes: it comes back as an honest string", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith("/api/billing/")) throw new TypeError("network down")
        return json(404, { status: "error", message: `no stub for ${url}` })
      }
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: true,
      scopesPlain: null
    })
    await settled()
    const checkout = await controller.commands.run("billing.upgrade", "pro")
    expect(checkout.status).toBe("failed")
    if (checkout.status === "failed") {
      expect(checkout.error).toBe("Checkout couldn't start — the billing service didn't answer.")
    }
    const portal = await controller.commands.run("billing.portal")
    expect(portal.status).toBe("failed")
    if (portal.status === "failed") {
      expect(portal.error).toBe("The billing portal couldn't start — the billing service didn't answer.")
    }
  })

  test("a body without a url field is an honest failure, not a blank navigation", async () => {
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { session: "cs_123" }) })
    )
    const outcome = await controller.commands.run("billing.upgrade", "pro")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Checkout couldn't start — the billing service didn't return a URL.")
    }
    await settled()
    expect(messageTexts(store).some((text) => text.includes("Checkout is ready"))).toBe(false)
  })

  test("a non-https URL is refused: no transcript link, an honest error", async () => {
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { url: "http://checkout.stripe.com/x" }) })
    )
    const outcome = await controller.commands.run("billing.upgrade", "pro")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Checkout was refused — the billing service answered with a non-https URL.")
    }
    await settled()
    expect(messageTexts(store).some((text) => text.includes("checkout.stripe.com"))).toBe(false)
  })
})
