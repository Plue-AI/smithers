import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Profiler } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import * as VaultAdapter from "../wiki/VaultAdapter"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { addWorldNote, memoryStorage, unavailableAgent, waitFor } from "./TestFixtures"

/*
 * The composer hot path.
 *
 * The draft changes on every keystroke. It used to be read by the shell, so
 * one character re-rendered App — and App renders the whole transcript, every
 * message, every card. The shell now projects the session WITHOUT the draft
 * and the composer subscribes to the draft itself, so typing re-renders the
 * composer subtree and nothing above it.
 *
 * These tests pin that as a render COUNT, not a description: `data-flows` is
 * built from `controller.commands.all()` during App's render, so counting that
 * call counts App renders. Putting `draft` back into the shell's projection
 * fails here immediately.
 */

GlobalRegistrator.register()

/*
 * bun test shares one process across files, so the DOM globals registered
 * above would leak into every file that runs after this one. Registration is
 * confined to this file's run, exactly as ChatShell.test.tsx does it.
 */
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

interface Counted {
  readonly controller: AppControllerType
  /** How many times App has rendered since mount. */
  readonly renders: () => number
  /** How many commits the shell's tree has made since mount, whoever rendered in them. */
  readonly commits: () => number
  readonly host: HTMLElement
  readonly act: (change: () => unknown) => Promise<void>
}

/** Mount App behind a controller whose registry read counts the shell's renders. */
const mountCounted = async (): Promise<Counted> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await addWorldNote(store)
  const real = createAppController(store, unavailableAgent)
  await store.settled?.()
  let count = 0
  const controller: AppControllerType = {
    ...real,
    commands: {
      ...real.commands,
      all: () => {
        count += 1
        return real.commands.all()
      }
    }
  }
  let commits = 0
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <Profiler id="shell" onRender={() => { commits += 1 }}>
          <App />
        </Profiler>
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  const act = async (change: () => unknown): Promise<void> => {
    let pending: unknown
    flushSync(() => { pending = change() })
    await pending
    // Collection subscriptions land on a microtask; flush what they queued.
    await new Promise((resolve) => setTimeout(resolve, 0))
    flushSync(() => {})
  }
  await act(() => {})
  return { controller, renders: () => count, commits: () => commits, host, act }
}

const textarea = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>("textarea")

describe("the composer hot path: typing never re-renders the transcript", () => {
  test("Alt+Enter queues while busy and edit/remove controls use persisted state", async () => {
    const view = await mountCounted()
    await view.act(() => view.controller.store.dispatch({ type: "message.submitted", actor: "user", turnId: "held", text: "in flight" }))
    await view.act(() => view.controller.changeDraft("follow-up"))
    await view.act(() => textarea(view.host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true, cancelable: true })))
    await waitFor(() => view.controller.store.session().queuedPrompts?.length === 1)
    await view.act(() => {})
    expect(view.controller.store.session()).toMatchObject({ draft: "", phase: "responding" })
    expect(view.host.querySelector('[aria-label="Queued prompts"]')?.textContent).toContain("follow-up")
    await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="chat.queue.edit"]')!.click())
    await waitFor(() => view.controller.store.session().draft === "follow-up")
    await view.act(() => {})
    expect(textarea(view.host)?.value).toBe("follow-up")
    expect(view.controller.store.session().queuedPrompts).toEqual([])
    await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="chat.queue"]')!.click())
    await waitFor(() => view.controller.store.session().queuedPrompts?.length === 1)
    await view.act(() => {})
    await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="chat.queue.remove"]')!.click())
    await waitFor(() => view.controller.store.session().queuedPrompts?.length === 0)
    expect(view.controller.store.session().phase).toBe("responding")
  })

  test("a run of keystrokes re-renders the shell zero times", async () => {
    const view = await mountCounted()
    const before = view.renders()

    for (const draft of ["w", "wr", "wri", "writ", "write"]) {
      await view.act(() => view.controller.changeDraft(draft))
    }

    // The composer took every character...
    expect(textarea(view.host)?.value).toBe("write")
    expect(view.controller.store.session().draft).toBe("write")
    // ...and the shell above it never rendered again.
    expect(view.renders()).toBe(before)
  })

  test("the shell still re-renders for the session state it does read", async () => {
    const view = await mountCounted()
    const before = view.renders()

    // A surface change is not the hot path: the shell reads `surface`, so it
    // must still project it. This is the other half of the projection —
    // dropping a field the shell needs has to fail as loudly as keeping the
    // draft it does not.
    await view.act(() => view.controller.store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }))

    expect(view.renders()).toBeGreaterThan(before)
    expect(view.host.querySelector(".world-surface")).not.toBeNull()
  })

  test("typing leaves the transcript's rendered messages untouched", async () => {
    const view = await mountCounted()
    await view.act(async () => {
      await view.controller.commands.run("chat.send", "a message worth keeping")
      await waitFor(() => [...view.controller.store.collections.transitions.values()]
        .some(record => record.type === "message.response.failed"))
      await view.controller.store.settled?.()
    })
    const before = view.host.querySelector(".smithers-transcript")?.innerHTML
    const renders = view.renders()

    await view.act(() => view.controller.changeDraft("/"))
    await view.act(() => view.controller.changeDraft(""))

    expect(view.host.querySelector(".smithers-transcript")?.innerHTML).toBe(before)
    expect(view.renders()).toBe(renders)
  })


})

/*
 * The streaming hot path.
 *
 * A message delta has to re-render the shell, because the shell renders the
 * transcript. It must not re-derive what the transcript does not show: every
 * token used to walk the flow registry twice (the manifest and the opening
 * read's flow count) and resolve the open note's links by parsing every
 * note's body, with the Wiki pane closed.
 */
const appendMessage = (view: Counted, text: string): Promise<void> =>
  view.act(() => view.controller.store.dispatch({ type: "message.appended", actor: "system", text }))

describe("the streaming hot path: a message delta re-derives only what the transcript shows", () => {
  test("the shell reads the flow registry once per render", async () => {
    const view = await mountCounted()
    const reads = view.renders()
    const commits = view.commits()

    await appendMessage(view, "one delta")

    expect(view.host.querySelector(".smithers-transcript")?.textContent).toContain("one delta")
    expect(view.commits()).toBeGreaterThan(commits)
    expect(view.renders() - reads).toBe(view.commits() - commits)
  })

  test("with the Wiki closed a delta resolves no note links; with it open, only a note change does", async () => {
    const links = spyOn(VaultAdapter, "linksOf")
    try {
      const view = await mountCounted()
      expect(view.controller.store.collections.worldDocuments.size).toBeGreaterThan(0)
      links.mockClear()

      await appendMessage(view, "a delta with the Wiki closed")

      expect(view.host.querySelector(".smithers-transcript")?.textContent).toContain("a delta with the Wiki closed")
      expect(links).not.toHaveBeenCalled()

      // Open, the rail is derived for the open note...
      await view.act(() => view.controller.store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }))
      expect(view.host.querySelector("[data-testid=wiki-rail]")).not.toBeNull()
      expect(links).toHaveBeenCalled()
      links.mockClear()

      // ...and a delta beside it leaves that derivation alone.
      await appendMessage(view, "a delta with the Wiki open")

      expect(view.host.querySelector(".smithers-transcript")?.textContent).toContain("a delta with the Wiki open")
      expect(view.host.querySelector("[data-testid=wiki-rail]")).not.toBeNull()
      expect(links).not.toHaveBeenCalled()
    } finally {
      links.mockRestore()
    }
  })

  test("in graph mode a delta rebuilds no graph", async () => {
    const graph = spyOn(VaultAdapter, "linkGraphOf")
    try {
      const view = await mountCounted()
      await view.act(() => view.controller.store.dispatch({ type: "surface.changed", actor: "user", surface: "world" }))
      await view.act(() => view.controller.store.dispatch({ type: "wiki.pane.changed", actor: "user", pane: "graph", path: null }))
      expect(view.host.querySelector("[data-testid=wiki-graph-pane]")).not.toBeNull()
      expect(view.host.querySelector("[data-testid=wiki-pane-graph-scope]")?.textContent).toBe("All")
      expect(view.host.querySelector("[data-testid=wiki-rail]")).toBeNull()
      expect(graph).toHaveBeenCalled()
      graph.mockClear()

      await appendMessage(view, "a delta beside the graph")

      expect(view.host.querySelector(".smithers-transcript")?.textContent).toContain("a delta beside the graph")
      expect(view.host.querySelector("[data-testid=wiki-graph-pane]")).not.toBeNull()
      expect(graph).not.toHaveBeenCalled()
    } finally {
      graph.mockRestore()
    }
  })
})

/*
 * The connect menu's open state belongs to the store.
 *
 * It used to be a `useState` inside ComposerConnect, which made the component
 * the authority on whether it was open — nothing else could open it, close it,
 * or read it, and no journal entry recorded that it had happened. It is a
 * session field now, written only through the `connect-menu.toggled`
 * transition. These tests pin all three halves of that: the store round-trip
 * the projection follows, and the two dismissals (an outside press, Escape)
 * that have to reach the store rather than a local setter.
 */
