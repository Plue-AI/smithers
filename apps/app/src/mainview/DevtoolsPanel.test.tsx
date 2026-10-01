/*
 * The dev-tools panel's render cost (ui-cards-tabs performance/2, api-design/3).
 * The panel subscribes to transitions, so every dispatch re-renders it — every
 * streamed token, for the life of an admin session. These tests pin the two
 * reads that must NOT repeat with those renders: the
 * per-collection row dumps, and the network tap.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "./ControllerContext"
import { DevtoolsPanel } from "./DevtoolsPanel"

import type { AgentPort } from "./runtime/AgentPort"
import { createAppController } from "./state/AppController"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import type { AppStore } from "./state/AppStore"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
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

interface View {
  readonly controller: AppController
  readonly store: AppStore
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

const mount = async (onWorldRowsRead?: () => void): Promise<View> => {
  const source = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  // Instrument the reader supplied to this view without mutating the public
  // collection facade or weakening its write boundary.
  const worldDocuments = onWorldRowsRead === undefined ? source.collections.worldDocuments : new Proxy(source.collections.worldDocuments, {
    get: (target, property) => property === "values" ? () => { onWorldRowsRead(); return target.values() } : Reflect.get(target, property)
  })
  const store: AppStore = { ...source, collections: { ...source.collections, worldDocuments } }
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <DevtoolsPanel />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  const act = async (change: () => void): Promise<void> => {
    flushSync(change)
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => {})
  return { controller, store, host, act }
}

/** Re-render the panel the way a streamed turn does: one transition per token. */
const streamTokens = async (view: View, count: number): Promise<void> => {
  for (let token = 0; token < count; token += 1) {
    await view.act(() => view.store.dispatch({ type: "message.appended", actor: "system", text: `token ${token}` }))
  }
}

const dumpFor = (host: HTMLElement, name: string): HTMLDetailsElement => {
  const found = Array.from(host.querySelectorAll<HTMLDetailsElement>("[aria-label='Store collections'] details")).find(
    (details) => details.querySelector("code")?.textContent === name
  )
  if (found === undefined) throw new Error(`no dump for ${name}`)
  return found
}

describe("the dev-tools panel's per-dispatch render cost", () => {

  test("a closed collection dump copies no rows, and opening it dumps them", async () => {
    let copies = 0
    const view = await mount(() => { copies += 1 })
    copies = 0
    await streamTokens(view, 5)
    expect(copies).toBe(0)
    const details = dumpFor(view.host, "worldDocuments")
    expect(details.querySelector("pre")).toBeNull()
    await view.act(() => {
      details.open = true
      details.dispatchEvent(new Event("toggle", { bubbles: false }))
    })
    expect(copies).toBeGreaterThan(0)
    expect(details.querySelector("pre")).not.toBeNull()
  })

  test("the network tap is read as rows, never as a JSON string the panel parses back", async () => {
    const view = await mount()
    let serialized = 0
    const tap = view.controller as unknown as { netTap: () => string }
    const original = tap.netTap.bind(view.controller)
    tap.netTap = () => {
      serialized += 1
      return original()
    }
    await view.controller.tappedFetch("https://tap.test/api/thing", { method: "POST" })
    await streamTokens(view, 2)
    expect(serialized).toBe(0)
    const entries = view.controller.netTapEntries()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]?.method).toBe("POST")
    // The serialized read stays for the human who types /debug.net; it is the same rows.
    expect(JSON.parse(original())).toEqual(entries as never)
    const rendered = view.host.querySelector("[aria-label='Network tap']")?.textContent ?? ""
    expect(rendered).toContain("/api/thing")
  })
})

describe("the dev-tools panel's reset door", () => {
  test("the header's Reset conversation button binds admin.reset.ask, the confirm, never admin.reset", async () => {
    const view = await mount()
    const reset = view.host.querySelector<HTMLButtonElement>('button[aria-label="Reset conversation"]')
    expect(reset?.dataset.flow).toBe("admin.reset.ask")
    await view.act(() => view.store.dispatch({ type: "message.appended", actor: "system", text: "kept" }))
    await view.act(() => reset!.click())
    // Asking discards nothing: the transcript survives the click.
    expect([...view.store.collections.messages.values()].some(message => message.text === "kept")).toBe(true)
  })
})
