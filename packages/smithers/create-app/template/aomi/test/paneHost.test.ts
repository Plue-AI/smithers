// @vitest-environment happy-dom
import { definePane } from "@smthrs/create-app/ui"
import type { AppCard, PaneCard, PaneContext } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"
import { act, createElement, useEffect, useState } from "react"
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import BuildPage from "../app/build/page.tsx"
import { RegistryContext } from "../src/shell/registry.ts"
import { actions } from "../src/shell/store.ts"
import type { TranscriptEntry } from "../src/shell/store.ts"
import { PaneHost } from "../src/ui/PaneHost.tsx"

// Keep the real page, host, registry and store subscriptions. Only seed the
// transcript and replace design-system controls unrelated to pane lifecycle.
const transcript = vi.hoisted(() => ({
  entries: [] as Array<TranscriptEntry>,
  cards: {} as Record<string, AppCard>
}))
vi.mock("../src/shell/store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell/store.ts")>()
  return {
    ...actual,
    useAppState: () => ({ ...actual.useAppState(), ...transcript }),
    useStarted: () => actual.useStarted() || transcript.entries.length > 0
  }
})
vi.mock("@smthrs/ui", async () => {
  const { createElement } = await import("react")
  const container = ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children)
  const hidden = () => null
  return {
    Card: container, CardContent: container, CardHeader: container, CardTitle: container,
    ChatTranscript: container, ChatMessage: container, CollapsiblePanel: container,
    Badge: container, Select: container,
    Button: ({ children, onClick }: { readonly children?: ReactNode; readonly onClick?: () => void }) =>
      createElement("button", { onClick }, children),
    EmptyState: ({ title, description }: { readonly title?: string; readonly description?: string }) =>
      createElement("div", { "data-empty": true }, createElement("strong", null, title), createElement("p", null, description)),
    ChatComposer: hidden, FileTree: hidden, StatusPill: hidden,
    SelectContent: hidden, SelectItem: hidden, SelectTrigger: hidden, SelectValue: hidden,
    Dialog: hidden, DialogContent: hidden, DialogDescription: hidden, DialogHeader: hidden, DialogTitle: hidden,
    formatRelativeTime: () => "now"
  }
})

const card: PaneCard = { kind: "pane", id: "plan", name: "plan", props: {}, fullscreen: false }
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  actions.restoreCard()
  transcript.entries = []
  transcript.cards = {}
  vi.unstubAllGlobals()
})

const button = (text: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === text)
  expect(found, `button ${text}`).toBeDefined()
  return found!
}

describe("PaneHost fullscreen", () => {
  test("the pane definition enables maximize even when the wire card reports false", async () => {
    const onMaximize = vi.fn()
    const pane = definePane({ props: Schema.Struct({}), fullscreen: true, render: () => "Plan" })
    await act(() => root.render(createElement(PaneHost, { card, panes: { plan: pane }, onMaximize })))
    await act(() => button("Maximize").click())
    expect(onMaximize).toHaveBeenCalledExactlyOnceWith(card.id)
  })

  test("a wire flag cannot enable maximize for an embedded-only definition", async () => {
    const pane = definePane({ props: Schema.Struct({}), render: () => "Plan" })
    await act(() => root.render(createElement(PaneHost, {
      card: { ...card, fullscreen: true }, panes: { plan: pane }, onMaximize: vi.fn()
    })))
    expect(container.textContent).not.toContain("Maximize")
  })

  test("BuildPage maximizes and restores one mounted pane, preserving its local state", async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function Counter({ context }: { readonly context: PaneContext }) {
      const [count, setCount] = useState(0)
      useEffect(() => {
        mounted()
        return () => { unmounted() }
      }, [])
      return createElement("button", {
        "data-pane": true,
        "data-fullscreen": context.fullscreen,
        onClick: () => setCount((value) => value + 1)
      }, `Count ${count}`)
    }
    const render = vi.fn((_: {}, context: PaneContext) => createElement(Counter, { context }))
    const pane = definePane({ props: Schema.Struct({}), title: "Plan", fullscreen: true, render })
    // Use a true wire flag here to reproduce the duplicate-instance defect
    // independently of the false-wire-flag regression above.
    transcript.cards = { [card.id]: { ...card, fullscreen: true } }
    transcript.entries = [{ kind: "card", id: "entry-plan", cardId: card.id }]
    await act(() => root.render(createElement(RegistryContext.Provider, {
      value: { panes: { plan: pane }, flows: [] }
    }, createElement(BuildPage))))
    const counter = button("Count 0")
    await act(() => counter.click())
    expect(render).toHaveBeenCalledTimes(1)

    await act(() => button("Maximize").click())
    expect(render).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll("[data-pane]")).toHaveLength(1)
    expect(container.querySelector('[role="dialog"]')?.contains(counter)).toBe(true)
    expect(counter.dataset.fullscreen).toBe("true")
    expect(button("Count 1")).toBe(counter)
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()

    await act(() => button("Restore").click())
    expect(render).toHaveBeenCalledTimes(3)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(button("Count 1")).toBe(counter)
    expect(counter.dataset.fullscreen).toBe("false")
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  })
})

describe("PaneHost rejected props", () => {
  test("shows one plain sentence and keeps the schema text behind a collapsed Details control", async () => {
    const pane = definePane({ props: Schema.Struct({ steps: Schema.Array(Schema.String) }), render: () => "Plan" })
    await act(() => root.render(createElement(PaneHost, {
      card: { ...card, props: { steps: 42 } }, panes: { plan: pane }
    })))
    const notice = container.querySelector("[data-empty]")
    expect(notice?.textContent).toBe("Pane props rejectedThis card sent data the pane cannot show.")
    const details = container.querySelector("details")
    expect(details?.open).toBe(false)
    expect(details?.querySelector("summary")?.textContent).toBe("Details")
    const raw = details?.querySelector("pre")?.textContent ?? ""
    expect(raw).toContain("steps")
    // The raw schema text appears only inside the collapsed control.
    expect(notice?.textContent).not.toContain("steps")
    expect(container.textContent?.replace(raw, "")).not.toContain("steps")
  })
})
