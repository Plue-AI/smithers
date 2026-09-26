/*
 * The palette's keyboard contract (Search and Command Palette Spec 2026-09-07
 * §3) against the real App: Cmd+K opens on the composer, the arrows wrap,
 * Tab reaches controls, → opens the actions panel and ← walks back, Enter runs
 * the item's open flow and clears the draft, Backspace on an empty query
 * strips the prefix and then closes, Esc closes and leaves the draft, `?`
 * lists the prefixes, and Cmd+Shift+K reopens the last query. The slash tree
 * keeps its own contract (state/SlashTree.test.tsx).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { StorageApi } from "@tanstack/db"
import { afterAll,afterEach,describe,expect,test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "./App"
import { ControllerTestProvider } from "./ControllerContext"
import { runSearchRef } from "@smthrs/ui/run-command"

import type { AgentPort } from "./runtime/AgentPort"
import type { AppController as AppControllerType, AppServices } from "./state/AppController"
import { createAppController } from "./state/AppController"
import type { AppStore } from "./state/AppStore"
import { createAppStore } from "./state/AppStore"

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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface View {
  readonly controller: AppControllerType
  readonly store: AppStore
  readonly host: HTMLElement
  readonly act: (change: () => void) => Promise<void>
}

/** The app signed in with two files and a run already listed, so the palette has rows to walk. */
const mount = async (services: AppServices = {}): Promise<View> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async () => json(404, { status: "error", message: "no backend" }),
    ...services
  })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "files-1",
      kind: "file-list",
      title: "files",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: {
        repo: "smithers",
        localRepoId: "r1",
        path: "src",
        entries: [{ name: "Composer.tsx", kind: "file" }, { name: "Compose.css", kind: "file" }]
      }
    }
  })
  store.dispatch({
    type: "card.upsert",
    actor: "system",
    card: {
      id: "runs-1",
      kind: "run-list",
      title: "runs",
      status: "active",
      createdAt: 2,
      ordinal: 2,
      payload: { repo: "will/flows", runs: [{ runId: "run-compose", flowId: "review", status: "running", createdAt: 1, turns: 1, calls: 1 }] }
    }
  })
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
    controller.dispose()
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

const textarea = (host: HTMLElement): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>("textarea")

const palette = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>("[data-testid='palette']")

const rows = (host: HTMLElement): Array<string> =>
  Array.from(host.querySelectorAll<HTMLElement>("[data-testid='palette'] [role='option']")).map((option) =>
    option.dataset["ref"] ?? option.dataset["flow"] ?? option.dataset["prefix"] ?? ""
  )

const highlighted = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>("[data-testid='palette'] [data-highlighted='true']")

const press = async (view: View, key: string, modifiers: { meta?: boolean; shift?: boolean } = {}): Promise<void> => {
  await view.act(() => {
    textarea(view.host)?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, metaKey: modifiers.meta === true, shiftKey: modifiers.shift === true })
    )
  })
}

/** Every flow the registry's one run path traced, from the transition journal; the recommender's own refresh (system.recommend) is not a palette act. */
const invoked = (store: AppStore): Array<{ name: string; args: string | null }> =>
  [...store.collections.transitions.values()]
    .filter((row) => row.type === "flow.invoked" && !row.payload.includes('"system.recommend"'))
    .sort((left, right) => left.revision - right.revision)
    .map((row) => {
      const payload = JSON.parse(row.payload) as { name?: string; args?: string | null }
      return { name: payload.name ?? "", args: payload.args ?? null }
    })

describe("§3 the keyboard contract", () => {
  for (const host of ["local", "cloud"] as const) {
    for (const draft of ["/billing.plans", "/billing.upgrade pro", "/billing.portal"]) {
      test(`${host} palette explains unavailable ${draft} without offering or executing it`, async () => {
        const calls: string[] = []
        const view = await mount({ bootstrap: { apiVersion: 1, host, version: "test", buildSha: "test", capabilities: ["identity"], authFlow: "credentials", sandbox: null },
          fetchImpl: async input => { calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); return json(404, {}) } })
        const name = draft.slice(1).split(" ")[0]!
        const absence = view.controller.commands.explainAbsent(name)
        expect(absence).toEqual({ door: "origin", reason: `/${name} is not available on this origin yet.` })
        await press(view, "k", { meta: true })
        await view.act(() => view.controller.changeDraft(draft))
        expect(view.host.querySelector('[data-testid="palette-refusal"]')?.textContent).toBe(absence!.reason)
        expect(rows(view.host)).not.toContain(name)
        await press(view, "Enter")
        if (draft.includes(" ")) {
          expect([...view.store.collections.toasts.values()].some(toast => toast.detail === absence!.reason)).toBe(true)
          expect(view.store.session().draft).toBe("")
          await press(view, "k", { meta: true })
        } else {
          expect(view.host.querySelector('[data-testid="palette-refusal"]')?.textContent).toBe(absence!.reason)
          expect(view.store.session().draft).toBe(draft)
          expect(invoked(view.store).some(row => row.name === "chat.send")).toBe(false)
        }
        expect(calls.some(path => path.includes("/api/billing"))).toBe(false)
        expect(await view.controller.commands.run(name)).toMatchObject({ status: "unavailable", reason: absence!.reason })
        expect(calls.some(path => path.includes("/api/billing"))).toBe(false)
        // Editing to an unknown or restricted name clears the old availability hint.
        for (const unknown of ["does-not-exist", "admin.health"]) {
          await view.act(() => view.controller.changeDraft(`/${unknown}`))
          expect(view.host.querySelector('[data-testid="palette-refusal"]')?.textContent).toContain(`There is no /${unknown} flow.`)
          expect(rows(view.host)).not.toContain(unknown)
        }
        await view.act(() => view.controller.changeDraft("/account.show"))
        expect(view.host.querySelector('[data-testid="palette-refusal"]')).toBeNull()
        expect(rows(view.host)).toContain("account.show")
      })
    }
  }

  test("the cloud session explanation is shared by the palette without offering a native-only action", async () => {
    const view = await mount({ bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity"], authFlow: "redirect", sandbox: null } })
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/cloud.sign-in"))
    const reason = view.controller.commands.explainAbsent("cloud.sign-in")!.reason
    expect(view.host.querySelector('[data-testid="palette-refusal"]')?.textContent).toBe(reason)
    expect(rows(view.host)).not.toContain("cloud.sign-in")
  })

  test("an unknown /help stays visible with a refusal and never submits a metered turn", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft('/help'))
    await press(view, 'Enter')
    expect(view.store.session().draft).toBe('/help')
    expect(palette(view.host)?.textContent).toContain('There is no /help flow.')
    expect(invoked(view.store).some(row => row.name === 'chat.send')).toBe(false)
  })

  test("opening and reopening Chat focus the composer in the opening render", async () => {
    const view = await mount()
    for (let attempt = 0; attempt < 2; attempt++) {
      const button = view.host.querySelector<HTMLButtonElement>('.app-chat-controls [data-flow="chat.open"]')!
      button.focus()
      // The click records its intent before opening; focus belongs to that
      // opening render after the durable command has been admitted.
      await view.act(() => button.click())
      expect(document.activeElement === textarea(view.host)).toBe(true)
      await view.act(() => view.controller.closePalette())
    }
  })

  for (const draft of ["What does this repository do? Answer in two sentences.", "What is issue 3 about?", "Compose"]) {
    test(`Enter sends prose through chat.send while the overlay is open: ${draft}`, async () => {
      const view = await mount()
      await press(view, "k", { meta: true })
      await view.act(() => view.controller.changeDraft(draft))
      await press(view, "Enter")
      expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: draft })
      expect(invoked(view.store).some(row => row.name.startsWith("search.") || row.name === "files.read")).toBe(false)
    })
  }

  test("Ask Smithers sends a nonempty draft by click and does nothing for an empty draft by either door", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    const before = invoked(view.store)
    await press(view, "Enter")
    await view.act(() => view.host.querySelector<HTMLButtonElement>("[data-ask]")?.click())
    expect(invoked(view.store)).toEqual(before)
    expect(view.store.session().paletteOpen).toBe(true)
    await view.act(() => view.controller.changeDraft("What is issue 3 about?"))
    const ask = view.host.querySelector<HTMLButtonElement>("[data-ask]")
    expect(ask).not.toBeNull()
    await view.act(() => ask?.click())
    expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: "What is issue 3 about?" })
  })

  for (const draft of ["a first line", "/issues", "?"]) {
    test(`Shift+Enter leaves native newline insertion available with the overlay open: ${draft}`, async () => {
      const view = await mount()
      await press(view, "k", { meta: true })
      await view.act(() => view.controller.changeDraft(draft))
      const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })
      await view.act(() => textarea(view.host)?.dispatchEvent(event))
      // Happy DOM has no native text editing; the browser test pins the inserted newline.
      expect(event.defaultPrevented).toBe(false)
      expect(invoked(view.store).some(row => row.name === "chat.send" || row.name.startsWith("search."))).toBe(false)
    })
  }

  test("a 2000-character prose paste produces no path row", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("A sentence about the repository. ".repeat(100).slice(0, 2000)))
    expect(palette(view.host)?.dataset["mode"]).toBe("all")
    expect(view.host.querySelector('[data-kind="file"]')).toBeNull()
  })

  test("only arrow selection grants an unprefixed result Enter; editing resets that choice", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("Compose"))
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("local:r1/src/Composer.tsx")
    await press(view, "Enter")
    expect(invoked(view.store)).toContainEqual({ name: "files.read", args: "src/Composer.tsx r1" })

    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("Compose"))
    await press(view, "ArrowDown")
    await view.act(() => view.controller.changeDraft("Composer.tsx"))
    await press(view, "Enter")
    expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: "Composer.tsx" })
  })

  test("hovering a result does not grant it Enter", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("Compose"))
    await view.act(() => view.host.querySelector('[data-ref="local:r1/src/Composer.tsx"]')?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })))
    expect(highlighted(view.host)?.dataset["ref"]).toBe("local:r1/src/Composer.tsx")
    await press(view, "Enter")
    expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: "Compose" })
    expect(invoked(view.store).some(row => row.name === "files.read")).toBe(false)
  })

  test("IME Enter leaves the draft and open overlay alone", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("Explain this repository."))
    const before = invoked(view.store)
    const event = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })
    await view.act(() => textarea(view.host)?.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(invoked(view.store)).toEqual(before)
    expect(view.store.session().draft).toBe("Explain this repository.")
    expect(palette(view.host)).not.toBeNull()
  })

  test("a menu appearing under a stationary pointer preserves the exact typed flow", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/wiki"))
    const other = view.host.querySelector<HTMLElement>('[data-flow="wiki.cloud"][role="option"]')
    expect(other).not.toBeNull()
    await view.act(() => other!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
    await press(view, "Enter")
    expect(invoked(view.store).map(row => row.name)).toContain("wiki")
    expect(invoked(view.store).some(row => row.name === "wiki.cloud")).toBe(false)
  })

  test("/issues retains the slash path and exact-name precedence", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/issues"))
    await press(view, "Enter")
    // The bare door named outright is the act, not whichever issues.* row the menu led with.
    expect(invoked(view.store).map(row => row.name)).toContain("issues")
    expect(invoked(view.store).some(row => row.name === "chat.send" || row.name.startsWith("search."))).toBe(false)
  })

  /*
   * Will typed `/model` on production and got the Models card AND a form: the
   * menu for "model" led with another `model.*` row and Enter ran that row.
   * A whole name typed outright is that flow.
   */
  test("/model named outright runs the bare door, never the row the menu led with", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/model"))
    const led = highlighted(view.host)?.getAttribute("data-flow")
    expect(led).toStartWith("model.")
    await press(view, "Enter")
    expect(invoked(view.store).map(row => row.name)).toContain("model")
    expect(invoked(view.store).some(row => row.name === led)).toBe(false)
  })

  test("a highlight the person moved is their choice: Enter runs that row, not the outright name", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/model"))
    await press(view, "ArrowDown")
    const chosen = highlighted(view.host)?.getAttribute("data-flow")
    expect(chosen).toStartWith("model.")
    await press(view, "Enter")
    expect(invoked(view.store).map(row => row.name)).toContain(chosen!)
    expect(invoked(view.store).some(row => row.name === "model")).toBe(false)
  })

  test("Escape dismisses the slash overlay, then closes the composer on the next press", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    await view.act(() => view.controller.changeDraft("/issues"))
    await press(view, "Escape")
    expect(palette(view.host)).toBeNull()
    expect(view.store.session().paletteOpen).toBe(true)
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(false)
    await press(view, "Escape")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(true)
    expect(view.store.session().draft).toBe("/issues")
  })

  test("Cmd+K opens the overlay on the composer with the draft as the query; Esc closes it and leaves the draft", async () => {
    const view = await mount()
    expect(palette(view.host)).toBeNull()
    await view.act(() => view.controller.changeDraft("Compose"))
    expect(palette(view.host)).toBeNull()
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteOpen).toBe(true)
    expect(palette(view.host)?.dataset["mode"]).toBe("all")
    // Files (both prefix matches, in listing order), then the flows: the one named compose, the ones whose summaries say it, then the run (contains).
    expect(rows(view.host)).toEqual(["", "local:r1/src/Composer.tsx", "local:r1/src/Compose.css", "model.compose", "chat.send", "model.ask", "model.recall", runSearchRef("run-compose", "runs-1")])
    await press(view, "Escape")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(palette(view.host)).toBeNull()
    expect(view.store.session().draft).toBe("Compose")
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(true)
  })

  test("the arrows move and wrap; Tab and Shift+Tab keep native control navigation", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("Compose"))
    await press(view, "k", { meta: true })
    expect(highlighted(view.host)?.hasAttribute("data-ask")).toBe(true)
    await press(view, "ArrowUp")
    expect(highlighted(view.host)?.dataset["ref"]).toBe(runSearchRef("run-compose", "runs-1"))
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.hasAttribute("data-ask")).toBe(true)
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("local:r1/src/Composer.tsx")
    await press(view, "ArrowDown")
    expect(highlighted(view.host)?.dataset["ref"]).toBe("local:r1/src/Compose.css")
    for (const shiftKey of [false, true]) {
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true })
      await view.act(() => { textarea(view.host)!.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
      expect(highlighted(view.host)?.dataset["ref"]).toBe("local:r1/src/Compose.css")
    }
  })

  test("Escape closes nested actions before closing Chat with its root palette", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("run:compose"))
    await press(view, "k", { meta: true })
    await press(view, "ArrowRight")
    expect(view.store.session().paletteActionsRef).toBe(runSearchRef("run-compose", "runs-1"))
    await press(view, "Escape")
    expect(view.store.session().paletteActionsRef).toBeNull()
    expect(view.store.session().paletteOpen).toBe(true)
    expect(palette(view.host)?.dataset["mode"]).toBe("runs")
    expect(view.store.session().draft).toBe("run:compose")
    await press(view, "Escape")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.host.querySelector<HTMLElement>(".composer-wrap")?.hidden).toBe(true)
    expect(view.store.session().draft).toBe("run:compose")
  })

  test("→ opens the item's actions (registered flows), ← walks back, Enter on an action runs it", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("run:compose"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("runs")
    await press(view, "ArrowRight")
    expect(view.store.session().paletteActionsRef).toBe(runSearchRef("run-compose", "runs-1"))
    const actions = rows(view.host)
    expect(actions[0]).toBe("runs.open")
    expect(actions).toContain("runs.resume")
    expect(actions).toContain("runs.logs")
    expect(view.host.querySelector("[data-testid='palette-chip']")?.textContent).toBe("actions")
    await press(view, "ArrowLeft")
    expect(view.store.session().paletteActionsRef).toBeNull()
    expect(rows(view.host)).toEqual([runSearchRef("run-compose", "runs-1")])
    // The summon chord closes Chat even with an item selected; reopening
    // preserves its query. ArrowRight remains the item's actions door.
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteOpen).toBe(false)
    await press(view, "k", { meta: true })
    await press(view, "ArrowRight")
    expect(view.store.session().paletteActionsRef).toBe(runSearchRef("run-compose", "runs-1"))
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(invoked(view.store).map((row) => row.name)).toContain("runs.resume")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.store.session().draft).toBe("")
  })

  test("Enter runs the highlighted item's bound open flow, notes the recent, clears the draft and remembers the query", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("Composer.tsx"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("path")
    expect(rows(view.host)).toEqual(["local:r1/src/Composer.tsx"])
    // An unprefixed file suggestion must be deliberately selected before Enter opens it.
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(invoked(view.store)).toContainEqual({ name: "files.read", args: "src/Composer.tsx r1" })
    expect(view.store.session().draft).toBe("")
    expect(view.store.session().paletteOpen).toBe(false)
    expect(view.store.session().paletteLastQuery).toBe("Composer.tsx")
    expect(view.store.session().paletteRecents?.[0]).toMatchObject({ kind: "file", ref: "local:r1/src/Composer.tsx", count: 1 })
    // Cmd+Shift+K reopens the last query.
    await press(view, "k", { meta: true, shift: true })
    expect(view.store.session().draft).toBe("Composer.tsx")
    expect(palette(view.host)).not.toBeNull()
  })

  test("Cmd+Enter runs the primary flow when the item has one, and nothing when it has none", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("run:compose"))
    await press(view, "k", { meta: true })
    await press(view, "Enter", { meta: true })
    expect(invoked(view.store)).toContainEqual({ name: "runs.resume", args: "sourceCard=runs-1 run-compose" })
    // A file's primary flow is Implement (§2), which is not registered: Cmd+Enter runs nothing and never invents a flow.
    await view.act(() => view.controller.changeDraft("Composer.tsx"))
    await press(view, "k", { meta: true })
    await press(view, "ArrowDown")
    const before = invoked(view.store).length
    await press(view, "Enter", { meta: true })
    expect(invoked(view.store).length).toBe(before)
    expect(view.store.session().paletteOpen).toBe(true)
  })

  test("Backspace on an empty query removes the prefix, then closes; the mode chip follows the prefix", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("wiki:"))
    await press(view, "k", { meta: true })
    expect(view.host.querySelector("[data-testid='palette-chip']")?.textContent).toBe("wiki:")
    await press(view, "Backspace")
    expect(view.store.session().draft).toBe("")
    expect(view.store.session().paletteOpen).toBe(true)
    await press(view, "Backspace")
    expect(view.store.session().paletteOpen).toBe(false)
  })

  test("? lists every prefix; Enter on a row switches the draft to that prefix", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("?"))
    await press(view, "k", { meta: true })
    expect(palette(view.host)?.dataset["mode"]).toBe("help")
    const listed = Array.from(view.host.querySelectorAll<HTMLElement>("[data-testid='palette'] [role='option'] .slash-menu-name")).map((node) => node.textContent)
    expect(listed).not.toContain("text:")
    expect(listed).toContain("secret:")
    await press(view, "ArrowDown")
    await press(view, "ArrowDown")
    await press(view, "ArrowDown")
    await press(view, "ArrowDown")
    await press(view, "Enter")
    expect(view.store.session().draft).toBe("//")
    expect(palette(view.host)?.dataset["mode"]).toBe("targets")
  })

  test("a mode with no rows runs its flow on Enter (the form law answers a bare prefix)", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("box:"))
    await press(view, "k", { meta: true })
    expect(rows(view.host)).toEqual([])
    await press(view, "Enter")
    expect(invoked(view.store).map((row) => row.name)).toContain("search.boxes")
  })

  test("with the overlay open, Enter on a slash command with arguments is the composer's send, never search.flows", async () => {
    const view = await mount()
    await press(view, "k", { meta: true })
    expect(view.store.session().paletteOpen).toBe(true)
    // `/implement fix it` has no slash rows (the tree lists names, not arguments), so the overlay owns nothing here.
    await view.act(() => view.controller.changeDraft("/implement fix it"))
    expect(palette(view.host)?.dataset["mode"]).toBe("flows")
    expect(rows(view.host)).toEqual([])
    await press(view, "Enter")
    const names = invoked(view.store).map((row) => row.name)
    expect(invoked(view.store)).toContainEqual({ name: "chat.send", args: "/implement fix it" })
    expect(names).not.toContain("search.flows")
    expect(view.store.session().paletteOpen).toBe(false)
  })

  test("the slash tree stays the / mode of the same overlay", async () => {
    const view = await mount()
    await view.act(() => view.controller.changeDraft("/app"))
    expect(palette(view.host)?.dataset["mode"]).toBe("flows")
    expect(rows(view.host)[0]).toBe("")
    expect(view.host.querySelector("[data-testid='palette'] [data-namespace='appearance']")).not.toBeNull()
    await press(view, "ArrowRight")
    expect(view.store.session().draft).toBe("/appearance.")
  })
})

test("moving the active option scrolls only the palette list and keeps input focus", async () => {
  const view = await mount()
  await view.act(() => view.controller.changeDraft("Compose"))
  await press(view, "k", { meta: true })
  const body = view.host.querySelector<HTMLElement>(".slash-menu-body")!
  body.getBoundingClientRect = () => ({ top: 100, bottom: 180, height: 80 } as DOMRect)
  const options = [...body.querySelectorAll<HTMLElement>('[role="option"]')]
  options.forEach((option, index) => {
    option.getBoundingClientRect = () => ({ top: 100 + index * 40 - body.scrollTop, bottom: 140 + index * 40 - body.scrollTop, height: 40 } as DOMRect)
  })
  textarea(view.host)!.focus()
  await press(view, "ArrowDown")
  expect(body.scrollTop).toBe(0)
  await press(view, "ArrowDown")
  expect(body.scrollTop).toBe(40)
  await press(view, "ArrowUp")
  await press(view, "ArrowUp")
  expect(body.scrollTop).toBe(0)
  expect(document.activeElement).toBe(textarea(view.host))
})

for (const touch of [false, true]) test(`Ask Smithers carries its name alone on a ${touch ? "touch" : "keyboard"} pointer`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints")
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touch ? 1 : 0 })
  mounted.push(() => { if (descriptor) Object.defineProperty(navigator, "maxTouchPoints", descriptor); else Reflect.deleteProperty(navigator, "maxTouchPoints") })
  const view = await mount()
  await press(view, "k", { meta: true })
  const ask = view.host.querySelector<HTMLButtonElement>("[data-ask]")
  expect(ask?.textContent).toBe("Ask Smithers")
  expect(ask?.getAttribute("role")).toBe("option")
  expect(view.host.textContent).not.toContain("Type a question or a task")
})
