import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController as AppControllerType } from "./AppController"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { addWorldNote, memoryStorage, settled, settle, unavailableAgent } from "./TestFixtures"


/*
 * The chat-first contract: World and Connectors are embedded panes inside the
 * persistent chat shell, never full-screen takeovers. These tests pin all three
 * halves — the state/command half (opening a pane never touches messages or the
 * draft, and `chat` is the registered back-to-conversation command), the render
 * half (transcript and composer stay mounted alongside the pane), and the
 * identity half (the transcript and composer DOM nodes are the SAME nodes across
 * the transition, so nothing about the conversation is torn down and rebuilt).
 */

GlobalRegistrator.register()

/*
 * bun test shares one process across test files, so the DOM globals registered
 * above would otherwise leak into every file that runs after this one and
 * silently flip `typeof window`/`typeof document` branches (AppStore's theme
 * detection reads both). Registration is confined to this file's run.
 */
afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`,
  // so the globals have to outlive the last teardown by a tick or two.
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

interface Mount {
  readonly host: HTMLElement
  readonly markup: () => string
  /** Run a state change and flush React, the way a real click does. */
  readonly act: (change: () => unknown) => Promise<void>
}

/** Client-render the app into a fresh DOM node and keep the root live. */
const mount = (controller: AppControllerType): Mount => {
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
  return {
    host,
    markup: () => host.innerHTML,
    act: async (change) => {
      let pending: unknown
      flushSync(() => { pending = change() })
      await pending
      // Collection subscriptions land on a microtask; flush what they queued.
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync(() => {})
    }
  }
}

/** The one-shot render the markup-only assertions use. */
const renderApp = (controller: AppControllerType): string => mount(controller).markup()

const harness = async (): Promise<{ store: AppStore; controller: AppControllerType }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await addWorldNote(store)
  const controller = createAppController(store, unavailableAgent)

  return { store, controller }
}

describe("chat-first shell: panes never replace the conversation", () => {
  test("opening World or Connectors changes only the pane, never the messages or draft", async () => {
    const { store, controller } = await harness()
    const before = [...store.collections.messages.values()].map((message) => message.id)
    controller.changeDraft("a draft that must survive")

    expect((await controller.commands.run("world")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("world-embedded")?.kind).toBe("world")
    expect([...store.collections.messages.values()].map((message) => message.id)).toEqual(before)
    expect(store.session().draft).toBe("a draft that must survive")

    expect((await controller.commands.run("connect")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
    expect(store.collections.cards.get("connect-embedded")?.kind).toBe("connect")
    expect([...store.collections.messages.values()].map((message) => message.id)).toEqual(before)
    expect(store.session().draft).toBe("a draft that must survive")
  })

  test("the back-to-conversation affordance is the registered `chat` command", async () => {
    const { store, controller } = await harness()
    expect(controller.commands.find("chat")).toBeDefined()

    store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })
    expect(store.session().surface).toBe("world")
    expect((await controller.commands.run("chat")).status).toBe("executed")
    expect(store.session().surface).toBe("chat")
  })

  test("with the World pane open the transcript and composer still render, with content intact", async () => {
    const { store, controller } = await harness()
    // Wave 14 §1: nothing is seeded into the transcript, so "content intact"
    // is pinned against a real turn the session actually holds.
    await store.dispatch({
      type: "message.submitted",
      actor: "user",
      turnId: "turn-shell",
      text: "a turn that must survive the pane"
    }).isPersisted.promise
    controller.changeDraft("draft stays in the composer")
    // Previously persisted pane navigation remains renderable; the Wiki flow now embeds.
    store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })

    const markup = renderApp(controller)
    expect(markup).toContain("world-surface")
    expect(markup).toContain("smithers-transcript")
    expect(markup).toContain("smithers-composer")
    expect(markup).toContain("draft stays in the composer")
    expect(markup).toContain("a turn that must survive the pane")
    expect(store.session().surface).toBe("world")
  })

  test("with the embedded Connect card open the transcript and composer still render", async () => {
    const { controller } = await harness()
    await controller.commands.run("connect")

    const markup = renderApp(controller)
    expect(markup).toContain("connect-store-list")
    expect(markup).toContain("smithers-transcript")
    expect(markup).toContain("smithers-composer")
  })

  test("closing the pane returns to the conversation with nothing lost", async () => {
    const { store, controller } = await harness()
    controller.changeDraft("still here")
    await controller.commands.run("connect")
    await controller.commands.run("chat")

    const markup = renderApp(controller)
    expect(store.session().surface).toBe("chat")
    expect(markup).not.toContain("connectors-surface")
    expect(markup).not.toContain("world-surface")
    expect(markup).toContain("smithers-composer")
    expect(markup).toContain("still here")
  })

  test("a sent message stays in the transcript across pane open and close", async () => {
    const { controller } = await harness()
    controller.send("remember this message")
    await settled()

    await controller.commands.run("world")
    const openMarkup = renderApp(controller)
    expect(openMarkup).toContain("remember this message")
    expect(openMarkup).toContain("world-card-workspace")

    await controller.commands.run("chat")
    const closedMarkup = renderApp(controller)
    expect(closedMarkup).toContain("remember this message")
    expect(closedMarkup).not.toContain("world-surface")
  })

  /*
   * The bug this shell exists to prevent: "still rendered" is not the contract
   * — "never unmounted" is. A takeover that happened to re-render an identical
   * transcript would satisfy every markup assertion above and still throw away
   * scroll position, composer focus, and in-flight editor state. Node identity
   * across a live transition is the only assertion that catches it.
   */
  test("opening and closing panes never unmounts the transcript or the composer", async () => {
    const { store, controller } = await harness()
    controller.send("a message that must outlive every pane")
    await settled()

    const view = mount(controller)
    const transcript = view.host.querySelector(".smithers-transcript")
    const composer = view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")
    expect(transcript).not.toBeNull()
    expect(composer).not.toBeNull()

    for (const pane of ["connect", "world"] as const) {
      await view.act(() => {
        if (pane === "world") store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })
        else store.dispatch({ type: "surface.changed", actor: "user", surface: "connectors" })
      })
      expect(store.session().surface).toBe(pane === "connect" ? "connectors" : "world")
      expect(view.host.querySelector(".embedded-pane")).not.toBeNull()
      // The very same nodes, not equivalent replacements.
      expect(view.host.querySelector(".smithers-transcript")).toBe(transcript)
      expect(view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")).toBe(composer)
      expect(view.markup()).toContain("a message that must outlive every pane")

      await view.act(() => void controller.commands.run("chat"))
      expect(store.session().surface).toBe("chat")
      expect(view.host.querySelector(".embedded-pane")).toBeNull()
      expect(view.host.querySelector(".smithers-transcript")).toBe(transcript)
      expect(view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")).toBe(composer)
      expect(view.markup()).toContain("a message that must outlive every pane")
    }
  })

  test("a draft typed into the live composer survives opening and closing a pane", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)

    await view.act(() => controller.changeDraft("half-written thought"))
    const composer = view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")
    expect(composer?.value).toBe("half-written thought")

    await view.act(() => void controller.commands.run("world"))
    expect(view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")).toBe(composer)
    expect(composer?.value).toBe("half-written thought")
    expect(store.session().draft).toBe("half-written thought")

    await view.act(() => void controller.commands.run("chat"))
    expect(composer?.value).toBe("half-written thought")
    expect(store.session().draft).toBe("half-written thought")
  })

  test("the pane's close affordance is a real, registered, back-to-conversation button", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)
    await view.act(() => { store.dispatch({ type: "surface.changed", actor: "user", surface: "connectors" }) })

    const close = view.host.querySelector<HTMLButtonElement>(
      ".embedded-pane [data-flow=\"chat\"]"
    )
    expect(close).not.toBeNull()
    expect(controller.commands.find(close?.dataset.flow ?? "")).toBeDefined()

    // Clicking the affordance itself — not the command behind it — closes it.
    await view.act(() => close?.click())
    expect(store.session().surface).toBe("chat")
    expect(view.host.querySelector(".embedded-pane")).toBeNull()
    expect(view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")).not.toBeNull()
  })

  test("the summoned composer's slash door embeds cards without leaving the conversation", async () => {
    const { store, controller } = await harness()
    const view = mount(controller)
    await view.act(() => view.host.querySelector<HTMLButtonElement>('[data-flow="chat.open"]')?.click())
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(false)
    expect(view.host.querySelector(".composer-menu-trigger")).toBeNull()
    const before = [...store.collections.messages.values()]
    for (const [command, paneClass] of [["connect", "connect-store-list"], ["wiki", "world-card-workspace"]] as const) {
      await view.act(() => controller.send(`/${command}`))
      expect(store.session().surface).toBe("chat")
      expect(view.host.querySelector(`.${paneClass}`)).not.toBeNull()
      await view.act(() => controller.send(`/${command}`))
      expect(store.session().surface).toBe("chat")
      expect(view.host.querySelector(`.${paneClass}`)).not.toBeNull()
      expect([...store.collections.messages.values()]).toEqual(before)
      expect(view.host.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")).not.toBeNull()
      expect(view.host.querySelector(".smithers-transcript")).not.toBeNull()
    }
  })})

test("subagents are one card grid in the transcript, opened, filtered and left by keyboard", async () => {
  const { store, controller } = await harness()
  const agent = (id: string, title: string, state: string, createdAt: number) => ({
    id, kind: "agent" as const, title, status: "active" as const, createdAt, ordinal: createdAt,
    payload: { cloud: true as const, displayName: title, sessionId: id, repo: "owner/repo", provider: "codex" as const,
      workspaceId: null, state, transcript: [
        { id: 1, role: "user", sequence: 1, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "the request" }] },
        { id: 2, role: "assistant", sequence: 2, createdAt: "2026-09-14T09:00:02Z", parts: [
          { type: "tool_call", text: `{"name":"Read","arguments":{"path":"auth/login.ts"}}` },
          { type: "tool_result", text: "ok" },
          { type: "text", text: "second row" }
        ] }
      ] }
  })
  await store.dispatch({ type: "card.upsert", actor: "system", card: agent("agent-session-one", "Delegate", "active", 10) }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: agent("agent-session-two", "Docs", "completed", 11) }).isPersisted.promise
  const view = mount(controller)
  // One header and grid; the agent card bodies are the agents' own tabs, never a second copy in chat.
  expect(view.host.querySelectorAll(".subagent-batch")).toHaveLength(1)
  expect(view.host.querySelector(".subagent-header")?.textContent).toMatch(/^[◐◓◑◒] Running 2 subagents\(1\/2\)/)
  expect(view.host.querySelector("[data-testid=agent-session-transcript]")).toBeNull()
  expect(view.host.querySelector("[data-testid=card-agent-session-one]")).toBeNull()
  const one = view.host.querySelector<HTMLElement>("[data-testid=subagent-agent-session-one]")!
  expect([...one.querySelectorAll(".subagent-activity-row")].map(row => row.textContent)).toEqual(["├ Read auth/login.ts✓", "└ second row"])
  expect(one.querySelector(".subagent-stop")?.getAttribute("data-flow")).toBe("agent.session.stop")
  expect(view.host.querySelector("[data-testid=subagent-agent-session-two] .subagent-stop")).toBeNull()
  expect(view.host.querySelector(".subagent-finished")?.textContent).toBe("◉ Docs finished")
  const key = (name: string, init: KeyboardEventInit = {}) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }))
  // Arrows move between cards; Enter opens the cloud session's own tab, which wears the breadcrumb.
  await view.act(() => one.focus())
  await view.act(() => key("ArrowRight"))
  expect(document.activeElement?.getAttribute("data-testid")).toBe("subagent-agent-session-two")
  await view.act(() => key("ArrowLeft"))
  await view.act(() => key("Enter"))
  await settle(3)
  await view.act(() => {})
  const tab = [...store.collections.tabs.values()].find(each => each.kind === "card" && each.cardId === "agent-session-one")
  expect(tab).toBeDefined()
  expect(store.session().activeTabId).toBe(tab?.id)
  const crumb = view.host.querySelector<HTMLElement>(`[data-testid="tab-body-${tab?.id}"] [data-testid=subagent-crumb]`)!
  expect(crumb.textContent).toBe("▌ Subagent · DelegateBack (ctrl+y)")
  expect(crumb.dataset.laneColor).toBe("0")
  await view.act(() => crumb.querySelector<HTMLButtonElement>("button")!.focus())
  await view.act(() => key("y", { ctrlKey: true }))
  await settle(3)
  expect(store.session().activeTabId).toBe("main")
  // The filter hides a subagent's card by its source.
  await view.act(() => view.host.querySelector<HTMLButtonElement>(".chat-filter-trigger")?.click())
  await settle(3)
  expect(view.host.querySelector(".chat-filter-menu")).not.toBeNull()
  await view.act(() => view.host.querySelector<HTMLButtonElement>(".chat-filter-menu button")?.focus())
  await view.act(() => key("ArrowDown"))
  await view.act(() => key("ArrowDown"))
  expect(document.activeElement?.textContent).toContain("Delegate")
  await view.act(() => key(" "))
  await settle(3)
  await view.act(() => {})
  expect(store.session().chatFilter?.sources).toContain("agent-session-one")
  expect(view.host.querySelector("[data-testid=subagent-agent-session-one]")).toBeNull()
  expect(view.host.querySelector("[data-testid=subagent-agent-session-two]")).not.toBeNull()
  await view.act(() => key("Escape"))
  await settle(3)
  expect(store.session().chatFilterMenuOpen).toBe(false)
})
