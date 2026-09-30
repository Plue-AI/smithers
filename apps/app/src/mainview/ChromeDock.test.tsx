import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { StorageApi } from "@tanstack/db"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ChromeDock } from "./ChromeDock"
import { ControllerTestProvider } from "./ControllerContext"

import type { AgentPort } from "./runtime/AgentPort"
import type { AppController as AppControllerType,AppServices } from "./state/AppController"
import { createAppController } from "./state/AppController"
import type { AppStore } from "./state/AppStore"
import { createAppStore } from "./state/AppStore"

/*
 * The dock (ChromeDock.tsx): the chrome as a vertical icon rail on the left
 * edge, always on screen. The six buttons keep the factory design session's
 * fixed order and render exactly where their flow registers; the theme
 * toggle closes the column and must be on screen on every tab.
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

const localHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    ...services,
    bootstrap: {
      apiVersion: 1,
      host: "local",
      version: "test",
      buildSha: "test",
      capabilities: [],
      authFlow: "none",
      sandbox: { platform: "darwin", mode: "enforced" }
    }
  })
  return { store, controller }
}

/** The Worker's shell (docs/web-mode/PLAN.md §1): host `cloud`, capabilities from the table the server calls. */
const cloudHarness = async (services: AppServices = {}): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    ...services,
    bootstrap: {
      apiVersion: 1,
      host: "cloud",
      version: "test",
      buildSha: "cloud",
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
      authFlow: "redirect",
      sandbox: null
    }
  })
  return { store, controller }
}

const mount = (controller: AppControllerType): { host: HTMLElement; act: (change: () => void) => Promise<void> } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <ChromeDock />
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return {
    host,
    act: async (change) => {
      flushSync(change)
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

const persisted = async (store: AppStore, transition: Parameters<AppStore["dispatch"]>[0]): Promise<void> => {
  await store.dispatch(transition).isPersisted.promise
}

/** The canonical row: the accessible name, the registered flow the button runs, and its test id. */
const CHROME = [
  { label: "Wiki", flow: "wiki", testid: "chrome-wiki" },
  { label: "Dispatcher", flow: "triggers.list", testid: "chrome-dispatcher" },
  { label: "Flows", flow: "flows", testid: "chrome-flows" },
  { label: "Secrets", flow: "secrets.list", testid: "chrome-secrets" },
  { label: "History", flow: "history.show", testid: "chrome-history" },
  { label: "Account", flow: "account.show", testid: "chrome-account" }
] as const

/** Every dock button that is one of the six, in DOM order. */
const rendered = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>("[data-testid=chrome-actions] .chrome-icon-action")].filter((button) =>
    CHROME.some((row) => row.testid === button.dataset.testid)
  )

const signedOut = async (store: AppStore): Promise<void> => {
  await persisted(store, {
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    admin: false,
    scopesPlain: null
  })
}

describe("the dock", () => {
  test("host cloud, signed out: all six render in the fixed order, each bound to a registered flow, before the theme toggle", async () => {
    const { store, controller } = await cloudHarness()
    await signedOut(store)
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(CHROME.map((row) => row.label))
    expect(buttons.map((button) => button.dataset.flow)).toEqual(CHROME.map((row) => row.flow))
    expect(buttons.map((button) => button.dataset.testid)).toEqual(CHROME.map((row) => row.testid))
    for (const button of buttons) {
      // Parity: the button names a registered flow and carries its icon; the slash door offers the same entry.
      expect(controller.commands.find(button.dataset.flow ?? "")).toBeDefined()
      expect(button.querySelector("svg")).not.toBeNull()
    }
    // Icon-only: no word reaches a person through the dock, and none of it is "workflow".
    for (const button of host.querySelectorAll("[data-testid=chrome-actions] [data-flow]")) {
      expect(button.getAttribute("aria-label")?.toLowerCase() ?? "").not.toContain("workflow")
    }
    // The theme toggle closes the row; sign-in lives in the header, never the dock.
    const flows = [...host.querySelectorAll<HTMLElement>("[data-testid=chrome-actions] [data-flow]")].map((el) => el.dataset.flow)
    expect(flows.at(-1)).toBe("appearance.dark-mode")
    // The dock carries no first-sight hint: its icons are never covered at launch.
    expect(host.querySelector("[data-testid=chrome-actions] [data-first-sight-hint]")).toBeNull()
    expect(flows).not.toContain("auth.sign-in")
    expect(host.querySelector("[data-testid=chrome-sign-in]")).toBeNull()
  })

  test("every dock icon carries a tooltip that is its accessible name, on the cloud and local hosts (#2168)", async () => {
    for (const harness of [cloudHarness, localHarness]) {
      const { store, controller } = await harness()
      if (harness === cloudHarness) await signedOut(store)
      const { host } = mount(controller)
      const icons = [...host.querySelectorAll<HTMLButtonElement>("[data-testid=chrome-actions] button")]
      expect(icons.length).toBeGreaterThan(1)
      for (const icon of icons) {
        const name = icon.getAttribute("aria-label") ?? ""
        // An icon is a picture: its name is spoken, its tooltip is the same name, and no word is printed beside it.
        expect(name.trim().length).toBeGreaterThan(0)
        expect(icon.getAttribute("title")).toBe(name)
        expect(icon.textContent?.trim()).toBe("")
        expect(icon.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
      }
    }
  })

  test("host local: the row is the canonical list filtered by the registry, so only Wiki and Flows render, in that order", async () => {
    const { controller } = await localHarness()
    const registered = CHROME.filter((row) => controller.commands.find(row.flow) !== undefined)
    expect(registered.map((row) => row.label)).toEqual(["Wiki", "Flows"])
    const { host } = mount(controller)
    const buttons = rendered(host)
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Wiki", "Flows"])
    expect(buttons.map((button) => button.dataset.flow)).toEqual(["wiki", "flows"])
    for (const row of CHROME) {
      if (registered.includes(row)) continue
      expect(host.querySelector(`[data-testid=${row.testid}]`)).toBeNull()
      expect(host.querySelector(`[data-flow="${row.flow}"]`)).toBeNull()
    }
  })

  test("the theme toggle runs its own flow and follows the session theme", async () => {
    const { store, controller } = await localHarness()
    const { host, act } = mount(controller)
    const toggle = host.querySelector<HTMLButtonElement>('[data-flow="appearance.dark-mode"]')
    expect(toggle?.getAttribute("aria-label")).toBe("Toggle light and dark mode")
    const before = store.session().theme
    await act(() => toggle?.click())
    expect(store.session().theme).toBe(before === "dark" ? "light" : "dark")
    // The icon is the toggle's state: the sun offers the light theme back once dark.
    await act(() => host.querySelector<HTMLButtonElement>('[data-flow="appearance.dark-mode"]')?.click())
    expect(store.session().theme).toBe(before)
  })

  test("the dock stays on screen while a card tab owns the view", async () => {
    const { store, controller } = await localHarness()
    await persisted(store, {
      type: "tab.opened",
      actor: "user",
      tab: { id: "t1", kind: "card", title: "Balance", cardId: "balance" }
    })
    await persisted(store, { type: "tab.selected", actor: "user", id: "t1" })
    const { host } = mount(controller)
    expect(store.session().activeTabId).toBe("t1")
    expect(host.querySelector<HTMLElement>("[data-testid=tab-body-main]")?.hidden).toBe(true)
    const dock = host.querySelector<HTMLElement>("[data-testid=chrome-actions]")
    expect(dock).not.toBeNull()
    expect(dock?.closest("[hidden]")).toBeNull()
    expect(host.querySelector<HTMLElement>('[data-flow="appearance.dark-mode"]')?.closest("[hidden]")).toBeNull()
  })
})
