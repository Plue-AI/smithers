import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { backend, memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers({ pluginLibrary: true })

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

const localBootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: [],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}


interface View {
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

const mount = (controller: AppControllerType): View => {
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
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await settled()
    flushSync(() => {})
  }
  return { host, act }
}

const byTestId = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const localController = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap: localBootstrap, ...backend({}) })
  await settled()
  return { store, controller }
}

test("the app summons a minimal composer without the optional header, + menu, or surface pill", async () => {
  const { controller } = await localController()
  const view = mount(controller)
  expect(byTestId(view.host, "composer-header")).toBeNull()
  expect(byTestId(view.host, "composer-add")).toBeNull()
  expect(byTestId(view.host, "composer-surface-trigger")).toBeNull()
  expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(true)
  await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="chat.open"]')?.click())
  expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(false)
  expect(view.host.querySelector("textarea")).not.toBeNull()
})

/*
 * The Command-K summon: the composer is a floating card in a transparent
 * layer over the content, never docked at the bottom of the chat and never
 * restored open on load. Command-K toggles it, Escape closes it wherever
 * focus is, and a press on the layer outside the card closes it.
 */
describe("the summoned composer overlays the content", () => {
  const keyDown = (host: HTMLElement, key: string, init: KeyboardEventInit = {}): void => {
    host.querySelector(".app-shell")?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    )
  }
  const overlay = (host: HTMLElement): HTMLElement | null => byTestId(host, "composer-overlay")

  test("the composer rides in a fixed overlay layer, hidden until summoned", async () => {
    const { controller } = await localController()
    const view = mount(controller)
    expect(overlay(view.host)).not.toBeNull()
    expect(overlay(view.host)?.hidden).toBe(true)
    expect(overlay(view.host)?.contains(view.host.querySelector(".composer-wrap") ?? null)).toBe(true)
    /* The layer carries only the composer: nothing underneath it is
     * reparented, hidden, or pushed — the transcript stands full-screen. */
    // The one layer remains outside tab bodies so Chat also works over a terminal.
    expect(view.host.querySelector(".app-main")?.contains(overlay(view.host) ?? null)).toBe(true)
    expect(view.host.querySelector(".tab-body")?.contains(overlay(view.host) ?? null)).toBe(false)
    expect(controller.store.session().paletteOpen).not.toBe(true)
  })

  test("Command-K summons the composer and a second Command-K dismisses it", async () => {
    const { controller } = await localController()
    const view = mount(controller)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    expect(controller.store.session().paletteOpen).toBe(true)
    expect(overlay(view.host)?.hidden).toBe(false)
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(false)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    expect(controller.store.session().paletteOpen).toBe(false)
    expect(overlay(view.host)?.hidden).toBe(true)
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(true)
    // Control-K is the same door (the palette spec's cross-platform chord).
    await view.act(() => keyDown(view.host, "k", { ctrlKey: true }))
    expect(controller.store.session().paletteOpen).toBe(true)
  })

  test("Escape closes the summoned composer wherever focus is, and focus returns to the Chat door", async () => {
    const { controller } = await localController()
    const view = mount(controller)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    expect(controller.store.session().paletteOpen).toBe(true)
    await view.act(() => keyDown(view.host, "Escape"))
    expect(controller.store.session().paletteOpen).toBe(false)
    expect(overlay(view.host)?.hidden).toBe(true)
    // The shell's own close moves focus back to the Chat door it opened through.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(view.host.querySelector('.app-chat-controls [data-flow="chat.open"]'))
  })

  test("a press on the layer outside the card closes the composer", async () => {
    const { controller } = await localController()
    const view = mount(controller)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    expect(controller.store.session().paletteOpen).toBe(true)
    await view.act(() => {
      overlay(view.host)?.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    })
    expect(controller.store.session().paletteOpen).toBe(false)
    expect(overlay(view.host)?.hidden).toBe(true)
  })

  test("the summon chord closes from the input and Escape returns focus after the input handles it", async () => {
    const { controller } = await localController()
    const view = mount(controller)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    const input = view.host.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!
    await view.act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true })))
    expect(controller.store.session().paletteOpen).toBe(false)
    await view.act(() => keyDown(view.host, "k", { metaKey: true }))
    await view.act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(controller.store.session().paletteOpen).toBe(false)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(view.host.querySelector('.app-chat-controls [data-flow="chat.open"]'))
  })
})
