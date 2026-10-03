import { Window } from "happy-dom"
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"

import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppController, AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { signupProfileFetch } from "../TestFixtures"
import { createBillingSeam } from "./BillingSeam"
import type { BillingSeam } from "./BillingSeam"
import type { SeamContext } from "./SeamContext"

/*
 * The billing checkout seam, driven through the user command path
 * (commands.run — billing.upgrade and billing.portal are trigger:"user").
 * The backend answers a Stripe session as { url } — the field name mirrors
 * multi src/smithersCloud/billing.ts sessionUrl(), which reads body.url and
 * validates it is an absolute http(s) URL. This seam is stricter: https only.
 * Success is stated in the transcript so the link survives a blocked popup;
 * failure comes back as an honest error string, never a throw.
 */

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

const controllers = new Set<AppController>()
afterEach(async () => {
  const failures: unknown[] = []
  for (const retire of retirements) { try { retire() } catch (error) { failures.push(error) } }
  retirements.clear()
  for (const release of releases) { try { release() } catch (error) { failures.push(error) } }
  releases.clear()
  try { await bounded(drain()) } catch (error) { failures.push(error) }
  for (const controller of controllers) {
    try { await bounded(controller.dispose()) } catch (error) { failures.push(error) }
  }
  controllers.clear()
  for (const store of stores) {
    try { await closeStore(store) } catch (error) { failures.push(error) }
  }
  for (const restore of restorations) { try { await restore() } catch (error) { failures.push(error) } }
  restorations.clear()
  if (unexpected.length) failures.push(new Error(`Unexpected Billing HTTP: ${unexpected.join(", ")}`))
  unexpected.length = 0
  if (failures.length) throw new AggregateError(failures, "Billing fixture cleanup failed")
})

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


interface BillingCall {
  readonly url: string
  readonly method: string
  readonly body: string
}

/**
 * Only declared billing routes are admitted; swallowed unexpected HTTP still
 * fails teardown. A signup-profile response remains available to detect
 * unintended onboarding reads.
 */
const billingBackend = (
  routes: Partial<Record<"/api/billing/checkout" | "/api/billing/portal", () => Response>>,
  calls: BillingCall[] = []
): { readonly services: AppServices; readonly signupReads: string[] } => {
  const profile = signupProfileFetch(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const route = url === "/api/billing/checkout" ? routes["/api/billing/checkout"] : url === "/api/billing/portal" ? routes["/api/billing/portal"] : undefined
    if (route === undefined || (init?.method ?? "GET") !== "POST") {
      unexpected.push(`${init?.method ?? "GET"} ${url}`)
      throw new Error("Unexpected Billing HTTP")
    }
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" })
    return track(Promise.resolve().then(() => trackResponse(route())))
  })
  return { services: { fetchImpl: (input, init) => track(profile.fetchImpl(input, init).then(trackResponse)) }, signupReads: profile.reads }
}

const freshController = async ({ services, signupReads }: ReturnType<typeof billingBackend>) => {
  billingWindow()
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  const lifetime = new AbortController()
  retirements.add(() => lifetime.abort())
  const controller = createAppController(store, unavailableAgent, { ...services, pageLifetime: lifetime.signal })
  controllers.add(controller)
  // Both billing commands require signed-in; park nothing, run for real.
  await track(store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    // §17.4: the Stripe flows register in the admin plugin only — an MVP
    // account is never offered a checkout it has no plan for.
    admin: true,
    scopesPlain: null
  }).isPersisted.promise)
  // Signing in starts no onboarding or billing request.
  await drain()
  expect(signupReads).toEqual([])
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
    const outcome = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(outcome.status).toBe("executed")
    await drain()
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
    const outcome = await track(controller.commands.run("billing.upgrade"))
    expect(outcome.status).toBe("executed")
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ plan: "pro" })
  })

  test("billing.portal: POSTs the portal route, transcript states the portal URL", async () => {
    const calls: BillingCall[] = []
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/portal": () => json(200, { url: "https://billing.stripe.com/p" }) }, calls)
    )
    const outcome = await track(controller.commands.run("billing.portal"))
    expect(outcome.status).toBe("executed")
    await drain()
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
    const outcome = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Payment required — top up your balance first.")
  })

  test("a bodyless 500 answers the fallback and whose fault it was", async () => {
    const { controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => new Response("", { status: 500 }) })
    )
    const outcome = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("Checkout couldn't start right now. That's a bug in Smithers, not something you did.")
  })

  test("a network throw never escapes: it comes back as an honest string", async () => {
    const { controller } = await freshController(billingBackend({
      "/api/billing/checkout": () => { throw new TypeError("network down") },
      "/api/billing/portal": () => { throw new TypeError("network down") }
    }))
    const checkout = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(checkout.status).toBe("failed")
    if (checkout.status === "failed") {
      expect(checkout.error).toBe("Checkout couldn't start — the billing service didn't answer.")
    }
    const portal = await track(controller.commands.run("billing.portal"))
    expect(portal.status).toBe("failed")
    if (portal.status === "failed") {
      expect(portal.error).toBe("The billing portal couldn't start — the billing service didn't answer.")
    }
  })

  test("a body without a url field is an honest failure, not a blank navigation", async () => {
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { session: "cs_123" }) })
    )
    const outcome = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Checkout couldn't start — the billing service didn't return a URL.")
    }
    await drain()
    expect(messageTexts(store).some((text) => text.includes("Checkout is ready"))).toBe(false)
  })

  test("a non-https URL is refused: no transcript link, an honest error", async () => {
    const { store, controller } = await freshController(
      billingBackend({ "/api/billing/checkout": () => json(200, { url: "http://checkout.stripe.com/x" }) })
    )
    const outcome = await track(controller.commands.run("billing.upgrade", "pro"))
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Checkout was refused — the billing service answered with a non-https URL.")
    }
    await drain()
    expect(messageTexts(store).some((text) => text.includes("checkout.stripe.com"))).toBe(false)
  })
})

/** Direct public-seam units below; the original command controls above compose the AppController. */
const sessionFixture = async (answer: () => Response) => {
  const store = await createOwnedStore({ kind: "localStorage", storage: memoryStorage() })
  await track(store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise)
  const calls: BillingCall[] = []
  const ctx: SeamContext = { store, actor: () => "user", nextOrdinal: store.nextOrdinal, baseUrl: "",
    dispatch: transition => { const receipt = store.dispatch(transition); track(receipt.isPersisted.promise); return receipt },
    http: (url, init) => track(Promise.resolve().then(() => {
      const method = init?.method ?? "GET"
      if (method !== "POST" || (url !== "/api/billing/checkout" && url !== "/api/billing/portal")) {
        unexpected.push(`${method} ${url}`)
        throw new Error("Unexpected Billing HTTP")
      }
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : "" })
      return trackResponse(answer())
    })) }
  return { store, calls, seam: createBillingSeam(ctx, undefined, () => retiredStores.has(store)) }
}
const sessionOperations: Array<{ name: string; path: string; body: string; missingUrl: string; announcement: string; run: (seam: BillingSeam) => Promise<string | void> }> = [
  { name: "checkout", path: "/api/billing/checkout", body: '{"plan":"pro"}', missingUrl: "Checkout couldn't start — the billing service didn't return a URL.", announcement: "Checkout is ready: HTTPS://BILLING.EXAMPLE/session", run: seam => seam.startCheckout("pro") },
  { name: "portal", path: "/api/billing/portal", body: "", missingUrl: "The billing portal couldn't start — the billing service didn't return a URL.", announcement: "Your billing portal: HTTPS://BILLING.EXAMPLE/session", run: seam => seam.openBillingPortal() }
]
for (const operation of sessionOperations) test.each([
  { name: "malformed JSON", answer: () => new Response("{not-json", { headers: { "content-type": "application/json" } }) },
  { name: "null JSON", answer: () => Response.json(null) },
  { name: "scalar JSON", answer: () => Response.json(42) },
  { name: "empty URL", answer: () => Response.json({ url: "" }) },
  { name: "nonstring URL", answer: () => Response.json({ url: 7 }) }
])(`${operation.name} $name cannot announce a session and a later valid reply recovers`, async ({ answer }) => {
  let valid = false
  const { opens } = billingWindow()
  const { store, seam, calls } = await sessionFixture(() => valid ? Response.json({ url: "HTTPS://BILLING.EXAMPLE/session" }, { status: 201 }) : answer())
  const before = (await store.eventHistory()).head
  expect(await track(operation.run(seam))).toBe(operation.missingUrl)
  expect(messageTexts(store)).toEqual([])
  expect(opens).toEqual([])
  expect((await store.eventHistory()).head).toEqual(before)
  expect(calls).toEqual([{ url: operation.path, method: "POST", body: operation.body }])
  valid = true
  expect(await track(operation.run(seam))).toBeUndefined()
  expect(messageTexts(store)).toEqual([operation.announcement])
  expect(opens).toEqual([["HTTPS://BILLING.EXAMPLE/session", "_blank", "noopener"]])
  expect(calls).toEqual([
    { url: operation.path, method: "POST", body: operation.body },
    { url: operation.path, method: "POST", body: operation.body }
  ])
})

for (const operation of sessionOperations) test(`${operation.name} accepts the host's 201 HTTPS reply and retains a durable link when the popup is blocked`, async () => {
  const { browser, opens } = billingWindow()
  const { store, seam, calls } = await sessionFixture(() => Response.json({ url: "HTTPS://BILLING.EXAMPLE/session" }, { status: 201 }))
  const messagesAtOpen: string[][] = []
  browser.open = (...args) => { opens.push(args); messagesAtOpen.push(messageTexts(store)); return null }
  expect(await track(operation.run(seam))).toBeUndefined()
  expect(opens).toEqual([["HTTPS://BILLING.EXAMPLE/session", "_blank", "noopener"]])
  expect(messagesAtOpen).toEqual([[operation.announcement]])
  expect(messageTexts(store)).toEqual([operation.announcement])
  expect(calls).toEqual([{ url: operation.path, method: "POST", body: operation.body }])
  expect((await store.verifyState()).valid).toBe(true)
})
