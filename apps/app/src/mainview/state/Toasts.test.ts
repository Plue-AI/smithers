import { afterEach,describe,expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

const pendingResponses: Array<(response: Response) => void> = []
afterEach(() => {
  // A failed intermediate assertion must still release every transport gate.
  for (const resolve of pendingResponses.splice(0)) resolve(new Response(null, { status: 503 }))
})

/*
 * The 300ms toast law (2026-08-09): background work not settled within 300ms
 * states what is running on the shared corner stack; work under 300ms never
 * flashes anything; a settled toast resolves into the result; a failure toast
 * is honest and stays until dismissed.
 */

const balanceJson = new Response(
  JSON.stringify({
    user: "will",
    balance: { totalUsd: "500", totalNanos: 0, lifetimeChargedUsd: "0", chargeCount: 0 },
    state: "ok",
    allowedToStartWork: true,
    credits: []
  }),
  { status: 200, headers: { "content-type": "application/json" } }
)

describe("the 300ms toast law", () => {
  test("work settled under 300ms never flashes a toast", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => balanceJson.clone(),
      toastDebounceMs: 300
    })
    await controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.size).toBe(0)
  })

  test("work not settled within 300ms states what is running, then resolves", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
          pendingResponses.push(resolve)
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    const running = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(running?.status).toBe("running")
    expect(running?.title).toBe("Refreshing your balance…")

    release(balanceJson.clone())
    await pending
    const resolvedToast = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(resolvedToast?.status).toBe("ok")
    expect(store.collections.billingAccounts.get("billing")?.totalUsd).toBe("500")
  })

  test("a failure resolves the toast honestly and it stays until dismissed", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
          pendingResponses.push(resolve)
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")

    release(new Response(JSON.stringify({ status: "error" }), { status: 503 }))
    await pending
    const failed = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(failed?.status).toBe("failed")
    expect(failed?.detail).toBe("Your balance couldn't be refreshed right now.")

    // It never auto-dismisses: the user clears it through the command.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeDefined()
    expect(controller.commands.find("toast.dismiss")).toBeDefined()
    controller.runCommand("toast.dismiss", "toast-billing.balance.refresh")
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeUndefined()
  })

  test("a settled toast states its result, never the running sentence", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
          pendingResponses.push(resolve)
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.title).toBe(
      "Refreshing your balance…"
    )
    release(balanceJson.clone())
    await pending
    const done = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(done?.status).toBe("ok")
    // The done toast lingers for a few seconds — it must not still read as running.
    expect(done?.title).toBe("Balance is up to date")
  })

  test("a re-run's running toast outlives the previous run's auto-dismiss", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
          pendingResponses.push(resolve)
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 20
    })
    const first = controller.refreshBalance()
    await settled()
    release(balanceJson.clone())
    await first
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("ok")

    // A second run claims the slot before the first run's dismissal fires.
    const second = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    await new Promise((resolve) => setTimeout(resolve, 40))
    // The stale timer must not have swallowed the notice for work still in flight.
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    release(balanceJson.clone())
    await second
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("ok")
  })

  test("a flow that fails resolves honestly instead of leaving a toast running", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
          pendingResponses.push(resolve)
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    // A real Response can fail while its body is read at the transport boundary.
    // The toast must still settle instead of hanging on "running".
    release(new Response(new ReadableStream({
      start(stream) { stream.error(new Error("transport body read refused")) }
    }), { status: 503 }))
    await pending
    await settled()
    const toast = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(toast?.status).toBe("failed")
    expect(toast?.detail).toContain("couldn't be refreshed")
  })

  test("toasts are notifications, not state: they never survive a restart", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    first.dispatch({ type: "toast.shown", actor: "system", key: "repos.first-run", title: "Reading your repositories…" })
    expect(first.collections.toasts.size).toBe(1)
    // isPersisted settles before a fresh store can preload the row.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.toasts.size).toBe(0)
    const journal = [...reopened.collections.transitions.values()]
    expect(journal.some((record) => record.type === "toast.dismissed" && record.actor === "system")).toBe(true)
  })
})


describe("tutorial toast selection", () => {
})

/*
 * A balance read still in flight when its controller closes answers into a
 * store the next owner may already hold. The late reply writes nothing,
 * whatever it says.
 */
describe("a late balance reply after dispose", () => {
  for (const outcome of ["success", "refusal", "network"] as const) {
    test(`a late ${outcome} writes nothing into the store`, async () => {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      let resolve!: (response: Response) => void
      let reject!: (error: Error) => void
      const held = new Promise<Response>((yes, no) => { resolve = yes; reject = no; pendingResponses.push(yes) })
      const controller = createAppController(store, silentAgent, {
        fetchImpl: () => held,
        toastDebounceMs: 0
      })
      const pending = controller.refreshBalance()
      await settled()
      await controller.dispose()
      // Record every write the late reply attempts, including one the closed
      // owner would refuse by throwing.
      const attempted: string[] = []
      const dispatch = store.dispatch
      ;(store as { dispatch: typeof dispatch }).dispatch = (event) => {
        attempted.push(event.type)
        return dispatch(event)
      }
      if (outcome === "network") reject(new Error("late transport refusal"))
      else resolve(outcome === "success" ? balanceJson.clone() : new Response(null, { status: 503 }))
      await pending
      expect(attempted).toEqual([])
    })
  }
})
