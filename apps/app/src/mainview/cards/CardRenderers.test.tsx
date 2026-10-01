import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { CardSchema } from "@smthrs/rpc/Cards"
import type { Card } from "@smthrs/rpc/Cards"
import type { RepositoryHome } from "@smthrs/rpc/RepositoryHome"
import { CardView } from "../ChatCards"
import { FlowGraphSurface } from "../ViewModules"
import { defaultPill } from "./CardFamily"
import { CARD_FAMILIES, CARD_RENDERERS, RETIRED_CARD_KINDS, pillStatus } from "./CardRenderers"
import { lastRunOf, RepositoryHomeCard, stripHomeHtml } from "./RepositoryHomeCard"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"

/*
 * The renderer map replaced ChatCards.tsx's render switch and pill switch.
 * These tests prove the map covers exactly the wire's card kinds with no kind
 * claimed twice, that the shared error rule still leads the family's pill,
 * and that a card body reaches the shell through its family's entry.
 */

/** Every card kind the wire declares, read off the discriminated union itself. */
const wireKinds = (): ReadonlyArray<string> =>
  CardSchema.options.map((option) => option.shape.kind.value).filter(kind => !(RETIRED_CARD_KINDS as readonly string[]).includes(kind))

const base = { id: "card-x", title: "Card", createdAt: 1, ordinal: 1 } as const

const handlers = {
  maximized: false,
  onDecideApproval: () => {},
  onGrantConfirm: () => {},
  onGrantCancel: () => {},
  onMaximize: () => {},
  onMinimize: () => {},
  onOpenInTab: () => {},
  onConnectGitHub: () => {},
  onRunWorkflow: () => {},
  onStopRun: () => {},
  onRetryRun: () => {},
  onChooseWorkflowRepo: () => {},
  worldDocuments: [],
  onChangeWorldDocument: () => {},
  onRunCommand: () => {}
}

describe("CardRenderers", () => {
  test("every wire card kind has exactly one family entry", () => {
    const kinds = wireKinds()
    expect([...Object.keys(CARD_RENDERERS)].sort()).toEqual([...kinds].sort())
    const claimed = CARD_FAMILIES.flatMap((family) => Object.keys(family))
    expect(claimed.length).toBe(kinds.length)
    expect(new Set(claimed).size).toBe(claimed.length)
    for (const entry of Object.values(CARD_RENDERERS)) {
      expect(typeof entry.render).toBe("function")
      expect(typeof entry.pill).toBe("function")
    }
  })

  test("an error card wears failed before its family is asked", () => {
    const completed: Card = {
      ...base,
      kind: "run-trace",
      status: "error",
      payload: { repo: "o/r", runId: "run-1", workflow: "review", phase: "completed", steps: [], result: null, lastSeq: 0 }
    }
    expect(pillStatus(completed)).toBe("failed")
    expect(pillStatus({ ...completed, status: "active" })).toBe("done")
  })

  test("the family's pill rule answers for a non-error card", () => {
    const denied: Card = {
      ...base,
      kind: "approval",
      status: "acted",
      payload: { capability: "deploy:production", decision: "denied" }
    }
    expect(pillStatus(denied)).toBe("denied")
    expect(pillStatus({ ...denied, status: "active", payload: { capability: "deploy:production" } })).toBe(
      "waiting-approval"
    )

    const syncing: Card = {
      ...base,
      kind: "sync-ops",
      status: "active",
      payload: { subject: "Mirror · o/r", source: "github-mirror", runState: null, ops: [] }
    }
    expect(pillStatus(syncing)).toBe("pending")
    expect(pillStatus({ ...syncing, payload: { ...syncing.payload, runState: "succeeded" } })).toBe("succeeded")

    const form: Card = {
      ...base,
      kind: "flow-form",
      status: "active",
      payload: { flow: "repo.open", via: "user", fields: [], draft: {}, given: {} }
    }
    expect(pillStatus(form)).toBe("")
    expect(pillStatus({ ...form, status: "acted" })).toBe("")
    expect(pillStatus({ ...form, status: "error", payload: { ...form.payload, error: "Practice repositories can't take new flows yet." } })).toBe("")

    const halfway: Card = { ...base, kind: "status", status: "active", payload: { progress: 0.5 } }
    expect(pillStatus(halfway)).toBe("running")
    expect(pillStatus({ ...halfway, payload: { progress: 1 } })).toBe("done")
  })

  test("a kind without a family rule is done once acted on and pending until then", () => {
    const chooser: Card = {
      ...base,
      kind: "workflow-repo",
      status: "active",
      payload: { intent: "create", description: "Which repository?", repos: ["o/r"], chosen: null }
    }
    expect(pillStatus(chooser)).toBe("pending")
    expect(pillStatus({ ...chooser, status: "acted" })).toBe("done")
  })

  /*
   * The fallback is the one pill rule no family chose, so a kind reaching it
   * by omission wears Pending forever (§28.3: a settled read badged PENDING is
   * indistinguishable from a hung one). Every kind on it is listed here, so
   * adding a kind without picking its pill fails this test rather than
   * shipping a stuck badge.
   */
  test("only the kinds that genuinely wait on an act fall back to the default pill", () => {
    const onDefault = Object.entries(CARD_RENDERERS)
      .filter(([, entry]) => entry.pill === defaultPill)
      .map(([kind]) => kind)
      .sort()
    expect(onDefault).toEqual(["workflow-repo"])
  })

  test("a settled environment-images listing is done, not pending", () => {
    /* WorkspaceSeam upserts this card with status "active" once the read has settled. */
    const images: Card = {
      ...base,
      kind: "environment-images",
      status: "active",
      payload: { repo: "o/r", images: [] }
    }
    expect(pillStatus(images)).toBe("done")
  })

  test("an agent that exited with no exit code is stopped, not done", () => {
    /* Cards.ts: exitCode is "null when unknown (the tab was closed)" — AgentCardBody reads it "stopped". */
    const agent: Card = {
      ...base,
      kind: "agent",
      status: "active",
      payload: {
        harnessId: "claude",
        displayName: "reviewer",
        tabId: "tab-1",
        sessionId: "sess-1",
        cwd: "/tmp/repo",
        phase: "exited",
        exitCode: null
      }
    }
    expect(pillStatus(agent)).toBe("stopped")
    expect(pillStatus({ ...agent, payload: { ...agent.payload, exitCode: 0 } })).toBe("done")
    expect(pillStatus({ ...agent, payload: { ...agent.payload, exitCode: 1 } })).toBe("failed")
    expect(pillStatus({ ...agent, payload: { ...agent.payload, phase: "running" } })).toBe("running")
  })

  test("the shell mounts the body from the kind's family entry", () => {
    const notifications: Card = {
      ...base,
      kind: "notifications",
      status: "active",
      payload: {
        unread: 1,
        items: [{ id: "n1", title: "Review requested on #12", repo: "o/r", reason: "review_requested", createdAt: null, read: false }]
      }
    }
    const markup = renderToStaticMarkup(<CardView card={notifications} {...handlers} />)
    expect(markup).toContain("data-kind=\"notifications\"")
    expect(markup).toContain("Review requested on #12")

    /* A kind the chat has never drawn renders the shell and an empty body, as the switch did. */
    const serviceLog: Card = {
      ...base,
      kind: "service-log",
      status: "active",
      payload: { workspaceId: "ws-1", repo: "o/r", service: "web", lines: ["ready"], follow: false }
    }
    const shell = renderToStaticMarkup(<CardView card={serviceLog} {...handlers} />)
    expect(shell).toBe("")
  })

  /*
   * CardView destructures a FIXED prop list, so a binding added to CardActions
   * and not to that list reaches no card and fails silently. This holds the
   * two ends together for the dispatcher listings a plan card reads its
   * schedules from.
   */
  test("a binding the shell was given reaches the body: the plan card sees the dispatcher listings", async () => {
    const plan: Card = {
      ...base,
      kind: "flow-plan",
      status: "active",
      payload: {
        repo: "o/r",
        flowId: "review",
        status: "done",
        nodes: [{ id: "a", kind: "step", key: `key1_${"0".repeat(64)}`, dependsOn: [], tier: "sealed", status: "run" }]
      }
    }
    const dispatcher: Extract<Card, { kind: "trigger-list" }> = {
      ...base,
      id: "trigger-list-o/r",
      kind: "trigger-list",
      status: "acted",
      payload: {
        repo: "o/r",
        live: true,
        triggers: [{ id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true }]
      }
    }
    /* The canvas loads asynchronously; exercise the mounted card that receives the shell's binding. */
    GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await FlowGraphSurface.preload()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<CardView card={plan} {...handlers} triggerCatalogs={[dispatcher]} />))
      expect(host.querySelector('[data-node="trigger:nightly"]')).not.toBeNull()
      await act(async () => root.render(<CardView card={plan} {...handlers} />))
      expect(host.querySelector('[data-node="trigger:nightly"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      await GlobalRegistrator.unregister()
    }
  })
})

describe("wiki history card (#1922)", () => {
  test("lists every revision newest first, each a link to that revision's own scoped bytes, with the space and the deletion marked", () => {
    const card: Card = { ...base, kind: "wiki-history", status: "active", payload: {
      repo: "org/repo", space: "private", pageId: 7, slug: "home", title: "Home", path: "Home.md", page: 1, hasNext: true,
      revisions: [
        { revision: 3, title: "Home", path: "Home.md", author: "will", at: "2026-09-26T03:00:00Z", deleted: true, digest: "a".repeat(64) },
        { revision: 2, title: "Home", path: "Old/Home.md", author: "ada", at: "2026-09-26T02:00:00Z", deleted: false, digest: "b".repeat(64), attachment: { digest: "b".repeat(64), mediaType: "image/png", size: 12 } }
      ]
    } }
    const markup = renderToStaticMarkup(<CardView card={card} {...handlers} />)
    expect(markup).toContain('data-testid="wiki-history"')
    expect(markup).toContain('data-space="private"')
    expect(markup).toContain('href="/api/repos/org/repo/wiki/history/7/3/content?visibility=private"')
    expect(markup).toContain('href="/api/repos/org/repo/wiki/history/7/2/content?visibility=private"')
    expect(markup.indexOf("r3")).toBeLessThan(markup.indexOf("r2"))
    expect(markup).toContain("deleted")
    expect(markup).toContain("Old/Home.md")
    expect(markup).toContain("image/png · 12 B")
    expect(markup).toContain('data-flow="wiki.history"')
    expect(markup).toContain("Next page")
    expect(markup).not.toContain("Previous page")
  })
})

describe("factory homepage", () => {
  const home = (blocks: Extract<RepositoryHome, { kind: "blocks" }>["blocks"]): Extract<Card, { kind: "factory.home" }> => ({
    ...base, status: "active", kind: "factory.home", payload: {
      repo: "org/repo", home: { kind: "blocks", blocks },
      flows: [{ id: "review", summary: "Review", description: "Review code", featured: true }]
    }
  })

  test("renders text, links, flows, markdown, and safe README content", () => {
    const card = home([
      { type: "text", text: "Welcome" },
      { type: "links", links: [{ label: "Source", url: "https://example.com" }] },
      { type: "flows", title: "Try first" },
      { type: "markdown", path: "README.md", markdown: "# Intro\n<script>alert(1)</script>[unsafe](javascript:alert(1))" }
    ])
    const markup = renderToStaticMarkup(<RepositoryHomeCard card={card} onRunCommand={() => {}} />)
    expect(markup).toContain("Welcome")
    expect(markup).toContain("https://example.com")
    expect(markup).toContain('data-flow="review"')
    expect(markup).toContain("Intro")
    expect(markup).not.toContain("<script")
    expect(markup).not.toContain("alert(1)</script>")
    expect(markup).not.toContain('href="javascript:')
    expect(stripHomeHtml("<b>Hi</b><!-- x -->")).toBe("Hi")
    expect(stripHomeHtml("<p>a</p>\n```ts\nconst x: Array<string> = []\n```\n<i>b</i>")).toBe("a\n```ts\nconst x: Array<string> = []\n```\nb")
    const readme = { ...card, payload: { ...card.payload, home: { kind: "readme" as const, markdown: "# README <img src=x>" } } }
    expect(renderToStaticMarkup(<RepositoryHomeCard card={readme} onRunCommand={() => {}} />)).not.toContain("<img")
    const error = { ...card, payload: { ...card.payload, home: { kind: "error" as const, message: "Homepage unavailable" } } }
    expect(renderToStaticMarkup(<RepositoryHomeCard card={error} onRunCommand={() => {}} />)).toContain('role="alert"')
  })

  test("a featured flow's button carries the repository the home shows (#3336)", () => {
    const card = home([{ type: "flows", title: "Try first" }])
    const markup = renderToStaticMarkup(<RepositoryHomeCard card={card} onRunCommand={() => {}} />)
    expect(markup).toContain('data-flow="review" data-flow-args="org/repo"')
  })

  test("app blocks render the app home: the heading, then one tile per app bound to its flow (D-18)", () => {
    const card = home([
      { type: "prompt", placeholder: "Ask Smithers…" },
      { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
      { type: "app", flow: "pr-triage", title: "Review a PR", picture: "review" },
      { type: "text", text: "After" },
      { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" },
      { type: "app", flow: "triggers.register", title: "Run it every night", picture: "schedule" }
    ])
    const markup = renderToStaticMarkup(<RepositoryHomeCard card={{ ...card, payload: { ...card.payload, home: { kind: "blocks", blocks: card.payload.home.kind === "blocks" ? card.payload.home.blocks.slice(1) : [] } } }} onRunCommand={() => {}} />)
    // Every app block lands in the one grid, wherever it sits among the blocks; the grid sits where the first one does.
    expect(markup.match(/data-testid="app-tile"/g)).toHaveLength(4)
    expect(markup.match(/data-testid="home-apps"/g)).toHaveLength(1)
    for (const title of ["Fix an issue", "Review a PR", "Ask the codebase", "Run it every night"]) expect(markup.indexOf(title)).toBeLessThan(markup.indexOf("After"))
    for (const [flow, title, picture] of [["issue.implement", "Fix an issue", "issue"], ["pr-triage", "Review a PR", "review"], ["wiki.ask", "Ask the codebase", "wiki"], ["triggers.register", "Run it every night", "schedule"]]) {
      expect(markup).toContain(`data-flow="${flow}"`)
      expect(markup).toContain(`<span class="app-tile-title">${title}</span>`)
      expect(markup).toContain(`data-picture="${picture}"`)
    }
    // A repository flow id is its slash leaf on the tile.
    const nested = home([{ type: "app", flow: "checks/wiki", title: "Check the wiki", picture: "wiki" }])
    expect(renderToStaticMarkup(<RepositoryHomeCard card={nested} onRunCommand={() => {}} />)).toContain('data-flow="checks.wiki"')
    // The pictures are drawings, never read aloud; the tile's name is its title.
    expect(markup).toContain('data-picture="issue" aria-hidden="true"')
    // Words on the home: the heading, the placeholder, the titles — the pictures' marks aside.
    expect(markup).not.toContain("Learn how to")
  })

  test("a tile shows the app's last result where one exists, otherwise its picture", () => {
    const run = (id: string, workflow: string, phase: "completed" | "running", createdAt: number): Card => ({
      ...base, id, kind: "run-trace", status: "active", createdAt, ordinal: createdAt, title: `${workflow} on org/repo`,
      payload: { repo: "org/repo", runId: id, workflow, phase, lastSeq: 0, input: {} } as Extract<Card, { kind: "run-trace" }>["payload"]
    })
    const cards = new Map<string, Card>([
      ["r1", run("r1", "coding/request", "completed", 1)],
      ["r2", run("r2", "coding/request", "running", 2)],
      ["r3", run("r3", "pr-triage", "completed", 3)],
      ["other", run("other", "coding/request", "completed", 9)]
    ])
    ;(cards.get("other") as Extract<Card, { kind: "run-trace" }> & { payload: { repo: string } }).payload.repo = "org/elsewhere"
    const controller = {
      store: { collections: { cards: { values: () => cards.values(), subscribeChanges: () => ({ unsubscribe: () => {} }) } } },
      commands: { find: (name: string) => name === "issue.implement" ? { metadata: { workflow: "coding/request" } } : undefined },
      stackSnapshots: { get: () => undefined, subscribe: () => () => {} }
    } as unknown as AppController
    const card = home([
      { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
      { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" }
    ])
    const markup = renderToStaticMarkup(<ControllerTestProvider controller={controller}><RepositoryHomeCard card={card} onRunCommand={() => {}} /></ControllerTestProvider>)
    // The newest run of the workflow the flow launches, on this repository: r2, not r1 and not the other repository's.
    expect(markup.match(/data-testid="app-tile-preview"/g)).toHaveLength(1)
    expect(markup).toContain("coding/request on org/repo")
    expect(markup).toContain('data-status="running"')
    expect(markup).toContain(">Running<")
    expect(markup).not.toContain("#42")
    // No run of wiki.ask: the wiki tile keeps its picture.
    expect(markup).toContain('data-picture="wiki" aria-hidden="true"')
    expect(lastRunOf(cards.values(), "org/repo", "pr-triage")?.id).toBe("r3")
    expect(lastRunOf(cards.values(), "org/repo", "release")).toBeUndefined()
  })

  test("a tile with no run and no Wiki claims no state (#2330)", () => {
    const controller = { stackSnapshots: { get: () => ({ stack: { repository: "org/repo", state: "active" as const, generation: 1, mainBehind: false,
      changes: [], items: [], lanes: [], limits: { maxParallel: 1 } }, error: null }), subscribe: () => () => {} }, commands: { find: () => undefined },
      store: { collections: { cards: { values: () => [], subscribeChanges: () => ({ unsubscribe: () => {} }) } } } } as unknown as AppController
    const card = home([
      { type: "app", flow: "issue.implement", title: "Fix an issue", picture: "issue" },
      { type: "app", flow: "pr-triage", title: "Review a PR", picture: "review" },
      { type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" },
      { type: "app", flow: "triggers.register", title: "Run it every night", picture: "schedule" }
    ])
    // Signed out (no controller) and signed in with a stack that has no Wiki: pictures only.
    for (const markup of [
      renderToStaticMarkup(<RepositoryHomeCard card={card} onRunCommand={() => {}} />),
      renderToStaticMarkup(<ControllerTestProvider controller={controller}><RepositoryHomeCard card={card} onRunCommand={() => {}} /></ControllerTestProvider>)
    ]) {
      expect(markup.match(/data-picture=/g)).toHaveLength(4)
      for (const claim of ["✓", "…", "ready", "Approve", "current", "app-stamp", "app-tile-wiki", "app-tile-preview"]) expect(markup).not.toContain(claim)
    }
  })

  test("the wiki tile wears the repository Wiki's state once the stack answers", () => {
    const stack = { repository: "org/repo", state: "active" as const, generation: 1, mainBehind: false, changes: [],
      items: [], lanes: [{ index: 0, state: "idle" as const }], limits: { maxParallel: 1 }, wiki: { state: "current" as const, pages: 12, edited: 0 } }
    const controller = { stackSnapshots: { get: () => ({ stack, error: null }), subscribe: () => () => {} }, commands: { find: () => undefined },
      store: { collections: { cards: { values: () => [], subscribeChanges: () => ({ unsubscribe: () => {} }) } } } } as unknown as AppController
    const card = home([{ type: "app", flow: "wiki.ask", title: "Ask the codebase", picture: "wiki" }])
    const markup = renderToStaticMarkup(<ControllerTestProvider controller={controller}><RepositoryHomeCard card={card} onRunCommand={() => {}} /></ControllerTestProvider>)
    expect(markup).toContain('data-testid="app-tile-wiki"')
    expect(markup).toContain("current · main")
  })

  test("a stack block renders the live stack, and nothing before a read or signed out", () => {
    const card = home([{ type: "stack", title: "Stack" }])
    expect(renderToStaticMarkup(<RepositoryHomeCard card={card} onRunCommand={() => {}} />)).not.toContain("home-stack")
    const stack = { repository: "org/repo", state: "active" as const, generation: 1, mainBehind: false, changes: [],
      items: [], lanes: [{ index: 0, state: "idle" as const }], limits: { maxParallel: 1 } }
    const controller = { stackSnapshots: { get: () => ({ stack, error: null }), subscribe: () => () => {} } } as unknown as AppController
    const markup = renderToStaticMarkup(<ControllerTestProvider controller={controller}>
      <RepositoryHomeCard card={card} onRunCommand={() => {}} /></ControllerTestProvider>)
    expect(markup).toContain("<h2>Stack</h2>")
    expect(markup).toContain("0/1 lanes")
    expect(markup).toContain('data-flow="history.backfill"')
  })

  test("prompt submits through chat.send and flow button uses the repository slash leaf", async () => {
    GlobalRegistrator.register()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    store.dispatch({ type: "composer.changed", actor: "user", draft: "Change it" })
    const controller = { store, changeDraft: (draft: string) => { store.dispatch({ type: "composer.changed", actor: "user", draft }) } } as unknown as AppController
    const calls: Array<[string, string | undefined]> = []
    const host = document.createElement("div")
    const root = createRoot(host)
    act(() => root.render(<ControllerTestProvider controller={controller}><RepositoryHomeCard
      card={home([{ type: "prompt", title: "What should we work on?", placeholder: "Change it…" }, { type: "flows" }])}
      onRunCommand={(name, args) => calls.push([name, args])} /></ControllerTestProvider>))
    // The prompt's title is the home's heading, over the composer.
    expect(host.querySelector("h1.factory-home-heading")?.textContent).toBe("What should we work on?")
    expect(host.querySelector("h1")?.compareDocumentPosition(host.querySelector("form")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    act(() => host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    act(() => host.querySelector<HTMLButtonElement>('[data-flow="review"]')?.click())
    expect(calls).toEqual([["chat.send", "Change it"], ["review", "org/repo"]])
    act(() => root.render(<ControllerTestProvider controller={controller}><RepositoryHomeCard
      card={home([{ type: "prompt", flow: "review" }])}
      onRunCommand={(name, args) => calls.push([name, args])} /></ControllerTestProvider>))
    act(() => host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(calls.at(-1)).toEqual(["chat.send", "/review Change it"])
    act(() => root.unmount())
    await GlobalRegistrator.unregister()
  })
})

test("repository chooser exposes one keyboard stop and the highlighted repository", async () => {
  GlobalRegistrator.register()
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const selected: string[] = []
  const card: Card = { ...base, kind: "workflow-repo", status: "active", payload: { intent: "create", repos: ["a/one", "b/two"], chosen: null, description: "Choose a repository" } }
  try {
    await act(async () => root.render(<CardView card={card} {...handlers} onChooseWorkflowRepo={repo => selected.push(repo)} />))
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map(option => option.tabIndex)).toEqual([-1, -1])
    list.focus()
    expect(list.getAttribute("aria-activedescendant")).toBe(options[0]!.id)
    await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(list)
    expect(list.getAttribute("aria-activedescendant")).toBe(options[1]!.id)
    await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })) })
    expect(selected).toEqual(["b/two"])
  } finally { await act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister() }
})
