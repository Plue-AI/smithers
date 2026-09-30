import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { memoryStorage, settled, silentAgent } from "./TestFixtures"


/*
 * Wave 10, DOM half: the derived pill row (§2a/§2f), the admin-only
 * reset/devtools absence, the maximize transition's element identity (§2d′),
 * and the pre-model auth gate (§2a″). (The wave's repo-chooser keyboard
 * suite retired with the watch subsystem — lane piper.)
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const createAppController = scopedControllers()

const mount = (controller: AppControllerType): { host: HTMLElement; markup: () => string } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { host, markup: () => host.innerHTML }
}

const act = async (work: () => unknown): Promise<void> => {
  let pending: unknown
  flushSync(() => { pending = work() })
  await pending
  await settled()
  flushSync(() => {})
}

const signedIn = async (store: AppStore, admin = false): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    admin,
    scopesPlain: null
  })
  await settled()
}

describe("wave 10 — the derived pill row (§2a/§2f)", () => {
  test("with no recommendation and no next step the pill row is EMPTY — an empty row is correct", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await signedIn(store)
    // No repo step and no recommendation → no pill. An empty row is correct.
    await settled()
    const { host } = mount(controller)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
  })

  test("signed-out, no pill: sign-in stays callable without permanent chrome", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      admin: false,
      scopesPlain: null
    })
    await settled()
    const { host } = mount(controller)
    expect(host.querySelectorAll(".smithers-suggestion")).toHaveLength(0)
    const signIn = host.querySelector<HTMLElement>("[data-testid=\"chrome-sign-in\"]")
    expect(signIn).toBeNull()
    expect(controller.commands.find("auth.sign-in")).toBeDefined()
    expect(host.querySelector(".smithers-transcript")).not.toBeNull()
  })
})

describe("wave 10 — admin-only affordances are absent, not hidden (§2/§2b)", () => {
  test("non-admin: no reset button, no devtools panel, no trace in the DOM", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await signedIn(store, false)
    const { host } = mount(controller)
    expect(host.querySelector(".corner-reset-btn")).toBeNull()
    expect(host.querySelector(".devtools-panel")).toBeNull()
    // The registry manifest in the DOM carries no admin or admin-reset names.
    const manifest = host.querySelector(".app-shell")?.getAttribute("data-flows") ?? ""
    expect(manifest).not.toContain("admin.")
    expect(manifest).not.toContain("admin.reset")
    /* `/debug.reset` is every user's own fresh-start door (ONBOARDING.md), never the admin reset. */
    expect(manifest).not.toContain("corner-reset")
    // The admin plugin's debug flows; `debug.verbose` is every session's own switch.
    expect(manifest).not.toContain("debug.snapshot")
    expect(manifest).not.toContain("debug.events")
    expect(manifest).not.toContain("debug.seams")
  })

  test("admin: reset stays in the registry and admin.devtools toggles the panel", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await signedIn(store, true)
    const { host } = mount(controller)
    expect(host.querySelector(".corner-reset-btn")).toBeNull()
    expect(controller.commands.find("admin.reset.ask")).toBeDefined()
    expect(host.querySelector(".devtools-panel")).toBeNull()
    await act(() => controller.commands.run("admin.devtools"))
    expect(host.querySelector(".devtools-panel")).not.toBeNull()
    expect(host.querySelector(".devtools-registry")?.textContent).toContain("flow.list")
    await act(() => controller.commands.run("admin.devtools"))
    expect(host.querySelector(".devtools-panel")).toBeNull()
  })
})

describe("wave 10 — the maximize transition (§2d′)", () => {
  test("maximizing keeps the SAME element (no re-mount); Escape minimizes", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent)
    await signedIn(store)
    store.dispatch({
      type: "card.upsert",
      actor: "smithers",
      card: {
        id: "status-one",
        kind: "status",
        title: "A status",
        status: "active",
        createdAt: Date.now(),
        ordinal: 10,
        payload: { note: "halfway" }
      }
    })
    await settled()
    const { host } = mount(controller)
    const card = host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")
    expect(card).not.toBeNull()
    expect(card?.dataset.maximized).toBe("false")

    const button = host.querySelector<HTMLButtonElement>("[data-flow=\"card.maximize\"]")
    expect(button).not.toBeNull()
    await act(() => button?.click())
    const maximizedCard = host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")
    // Element identity persists across the transition — the same node morphed.
    expect(maximizedCard).toBe(card)
    expect(maximizedCard?.dataset.maximized).toBe("true")
    expect(host.querySelector(".card-maximize-backdrop")).not.toBeNull()

    await act(() => controller.commands.run("card.minimize"))
    expect(host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")?.dataset.maximized).toBe("false")
    expect(host.querySelector<HTMLElement>(".smithers-card[data-kind=\"status\"]")).toBe(card)
  })
})

describe("local app: identity is not a gate on the chat (LOCAL-APP.md)", () => {
  test("a signed-out send reaches the turn seam: one startTurn call, no sign-in reply", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let turns = 0
    const countingAgent: AgentPort = {
      available: true,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: () => () => {}
    }
    const controller = createAppController(store, countingAgent)
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      admin: false,
      scopesPlain: null
    })
    await settled()
    controller.send("list my issues")
    await settled()
    expect(turns).toBe(1)
    const reply = [...store.collections.messages.values()].find((message) =>
      message.text.includes("Sign in with GitHub first")
    )
    expect(reply).toBeUndefined()
  })
})
