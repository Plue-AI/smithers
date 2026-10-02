import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardView } from "../ChatCards"

import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import type { AppController } from "../state/AppController"
import type { Card, WorldDocument } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { cardActions } from "./CardActions"

/*
 * The transcript re-renders on every streamed token: App reads thirteen
 * collections and rebuilds its entry list each time. Every card under it used
 * to be handed eighteen freshly-allocated arrow functions, so no card could
 * ever bail out — one token re-ran the render function of the targets table,
 * the run timeline and every other body in the conversation.
 *
 * The bindings depend on the controller alone, so they are built once against
 * it, and CardView is memoized. These pin both halves: the object identity
 * that makes the comparison possible, and the bail-out it buys.
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

const newController = async (): Promise<AppController> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent)
  mounted.push(() => controller.dispose())
  return controller
}

const NO_DOCUMENTS: ReadonlyArray<WorldDocument> = []

/**
 * A card that counts every render of the shell around it: `title` is read
 * during CardView's own render and nowhere else, so a read means a render.
 */
const countingCard = (): { readonly card: Card; readonly renders: () => number } => {
  let reads = 0
  const card = {
    id: "card-counted",
    kind: "status",
    get title() {
      reads += 1
      return "Repository status"
    },
    status: "acted",
    createdAt: 1,
    ordinal: 1,
    payload: { progress: 0.5, note: "Halfway there" }
  } as unknown as Card
  // Two reads per render: the header's text and the section's aria-label.
  return { card, renders: () => Math.ceil(reads / 2) }
}

/** A parent that re-renders on demand, exactly as the transcript does under a token. */
const mountUnderParent = (controller: AppController, card: Card): { readonly rerender: () => void } => {
  let bump: (() => void) | undefined
  const Parent = () => {
    const [tick, setTick] = useState(0)
    bump = () => setTick((value) => value + 1)
    return (
      <>
        <span data-testid="tick">{tick}</span>
        <CardView
          card={card}
          maximized={false}
          worldDocuments={NO_DOCUMENTS}
          {...cardActions(controller, card)}
        />
      </>
    )
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<Parent />))
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { rerender: () => flushSync(() => bump?.()) }
}

describe("card bindings are stable for their controller and origin", () => {
  test("card bindings retain their origin and remain stable for unchanged records", async () => {
    const controller = await newController()
    const { card } = countingCard()
    const run = spyOn(controller, "runCommand").mockReturnValue(true)
    try {
      const actions = cardActions(controller, card)
      expect(cardActions(controller, card)).toBe(actions)
      expect(cardActions(controller, { ...card, id: "other-card" })).not.toBe(actions)
      actions.onRunCommand("appearance.theme", "paper")
      expect(run).toHaveBeenLastCalledWith("appearance.theme", "paper", card.id)
      actions.onStopRun("run-1")
      expect(run).toHaveBeenLastCalledWith("flow.run.stop", "run-1", card.id)
    } finally { run.mockRestore() }
  })

  test("the same controller yields the very same binding object", async () => {
    const controller = await newController()
    expect(cardActions(controller)).toBe(cardActions(controller))
  })

  test("a different controller gets its own bindings, bound to its own registry", async () => {
    const first = await newController()
    const second = await newController()
    expect(cardActions(first)).not.toBe(cardActions(second))
  })

  test("every act CardView can raise is bound, including the three frame controls", async () => {
    const controller = await newController()
    const actions = cardActions(controller)
    for (
      const act of [
        "onDecideApproval",
        "onGrantConfirm",
        "onGrantCancel",
        "onMaximize",
        "onMinimize",
        "onFrameBack",
        "onFrameForward",
        "onOpenInTab",
        "onConnectGitHub",
        "onRunWorkflow",
        "onStopRun",
        "onRetryRun",
        "onChooseWorkflowRepo",
        "onChangeWorldDocument",
        "onRunCommand"
      ] as const
    ) {
      expect(typeof actions[act]).toBe("function")
    }
  })
})

describe("an unchanged card does not re-render when the transcript around it does", () => {
  test("a parent update leaves the card's render function alone", async () => {
    const controller = await newController()
    const { card, renders } = countingCard()
    const view = mountUnderParent(controller, card)
    expect(renders()).toBe(1)

    for (let token = 0; token < 12; token += 1) view.rerender()

    expect(renders()).toBe(1)
  })

  test("the card still re-renders when its own props change", async () => {
    const controller = await newController()
    const { card, renders } = countingCard()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const render = (maximized: boolean): void => {
      flushSync(() =>
        root.render(
          <CardView
            card={card}
            maximized={maximized}
            worldDocuments={NO_DOCUMENTS}
            {...cardActions(controller)}
          />
        )
      )
    }
    mounted.push(() => {
      flushSync(() => root.unmount())
      host.remove()
    })
    render(false)
    expect(renders()).toBe(1)

    render(true)

    expect(renders()).toBe(2)
    expect(host.querySelector("[data-testid=\"frame-fork\"]")).not.toBeNull()
  })
})
