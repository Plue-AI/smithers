import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"

import type { AgentPort } from "../runtime/AgentPort"
import type { FrameHistoryPort, FrameLocation } from "../runtime/FrameHistory"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { TabBodies } from "./TabBodies"

/*
 * A card tab is the SAME card, so it owes the same acts.
 *
 * The tab used to keep its own copy of App.tsx's CardView bindings, and the
 * copy had lost three of them: onFrameBack, onFrameForward and onForkFrame.
 * CardView renders those controls unconditionally on a maximized card and
 * their handlers are optional, so in a card tab all three were dead buttons —
 * no test ever maximized a card inside a tab and pressed them. Both surfaces
 * now spread cards/CardActions.ts, and this is the second mount that proves
 * it: open the tab, maximize, press each control, read the store.
 */

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


const silentAgent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

/** An in-memory history: the real port's shape, with each navigation counted. */
const recordingHistory = (): FrameHistoryPort & { readonly calls: { back: number; forward: number } } => {
  const stack: Array<FrameLocation> = []
  const calls = { back: 0, forward: 0 }
  let index = -1
  const listeners = new Set<(location: FrameLocation | undefined) => void>()
  const announce = (): void => {
    for (const listener of listeners) listener(stack[index])
  }
  return {
    current: () => stack[index],
    push: (location) => {
      stack.splice(index + 1)
      stack.push(location)
      index = stack.length - 1
    },
    replace: (location) => {
      if (index < 0) {
        stack.push(location)
        index = 0
        return
      }
      stack[index] = location
    },
    back: () => {
      calls.back += 1
      if (index <= 0) return
      index -= 1
      announce()
    },
    forward: () => {
      calls.forward += 1
      if (index >= stack.length - 1) return
      index += 1
      announce()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    calls
  }
}

interface Opened {
  readonly controller: AppController
  readonly history: ReturnType<typeof recordingHistory>
  readonly host: HTMLElement
  readonly act: (change: () => unknown) => Promise<void>
}

const CARD_ID = "card-tabbed"

/** A controller holding one card, with that card open in its own tab and the tab bodies mounted. */
const openCardTab = async (): Promise<Opened> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const history = recordingHistory()
  const controller = createAppController(store, silentAgent, { frameHistory: history })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: CARD_ID,
      kind: "status",
      title: "Repository status",
      status: "acted",
      createdAt: 1,
      ordinal: 1,
      payload: { progress: 0.5, note: "Halfway there" }
    }
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <TabBodies />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    controller.dispose()
    host.remove()
  })
  const act = async (change: () => unknown): Promise<void> => {
    let pending: unknown
    flushSync(() => { pending = change() })
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => controller.runCommand("tab.card", CARD_ID))
  return { controller, history, host, act }
}

const button = (host: HTMLElement, testId: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`.card-tab [data-testid="${testId}"]`)

const press = async (view: Opened, testId: string): Promise<void> => {
  const target = button(view.host, testId)
  expect(target).not.toBeNull()
  await view.act(() => target?.dispatchEvent(new MouseEvent("click", { bubbles: true })))
}

describe("a card tab carries every act the transcript's copy carries", () => {
  test("the tab renders the card, and maximizing it reveals the two frame controls", async () => {
    const view = await openCardTab()
    expect(view.host.querySelector(`.card-tab [data-testid="card-${CARD_ID}"]`)).not.toBeNull()
    // Not maximized: the frame controls are not rendered at all.
    expect(button(view.host, "frame-back")).toBeNull()

    await press(view, `card-maximize-${CARD_ID}`)

    expect(view.controller.store.session().maximizedCardId).toBe(CARD_ID)
    for (const control of ["frame-back", "frame-forward"]) {
      expect(button(view.host, control)).not.toBeNull()
    }
    // Forking a frame is a client time-travel control the MVP cut retired (#3385).
    expect(button(view.host, "frame-fork")).toBeNull()
  })

  test("frame back inside the tab walks the session out of the card frame", async () => {
    const view = await openCardTab()
    const rootFrame = view.controller.store.session().activeFrameId
    await press(view, `card-maximize-${CARD_ID}`)
    const cardFrame = view.controller.store.session().activeFrameId
    expect(cardFrame).not.toBe(rootFrame)

    await press(view, "frame-back")

    expect(view.history.calls.back).toBe(1)
    expect(view.controller.store.session().activeFrameId).toBe(rootFrame)
    // Leaving the card frame is what puts the card back: the tab still shows it, embedded.
    expect(view.controller.store.session().maximizedCardId).toBeNull()
    expect(view.host.querySelector(`.card-tab [data-testid="card-${CARD_ID}"]`)).not.toBeNull()
  })

  test("frame forward inside the tab is bound to the history port, and returns to the card frame", async () => {
    /*
     * Back minimizes the card, so its own Forward button leaves with it —
     * the press has to be made from the frame it is offered in. Pressing it
     * there reaches the port (an unbound button reaches nothing), and the
     * port's forward walks the session back into the card frame.
     */
    const view = await openCardTab()
    const rootFrame = view.controller.store.session().activeFrameId
    await press(view, `card-maximize-${CARD_ID}`)
    const cardFrame = view.controller.store.session().activeFrameId

    await press(view, "frame-forward")
    expect(view.history.calls.forward).toBe(1)

    await press(view, "frame-back")
    expect(view.controller.store.session().activeFrameId).toBe(rootFrame)
    await view.act(() => view.history.forward())
    expect(view.controller.store.session().activeFrameId).toBe(cardFrame)
    expect(view.controller.store.session().maximizedCardId).toBe(CARD_ID)
  })

})
