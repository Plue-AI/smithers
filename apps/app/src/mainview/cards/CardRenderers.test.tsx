import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { CardSchema, LEGACY_CARD_KINDS } from "@smthrs/rpc/Cards"
import type { Card } from "@smthrs/rpc/Cards"
import { CardView } from "../ChatCards"
import { FlowGraphSurface } from "../ViewModules"
import { defaultPill, type CardOf } from "./CardFamily"
import { renderCardBody, CARD_FAMILIES, CARD_RENDERERS, cardRenderer, pillStatus } from "./CardRenderers"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createDesignWorld } from "../state/seams/DesignWorld"
import { BEN, MAYA } from "../state/seams/DesignWorld/world"
import { designMembersRoster, designViewerRole } from "../state/seams/DesignWorld/settings"

/*
 * The renderer map replaced ChatCards.tsx's render switch and pill switch.
 * These tests prove the map covers exactly the wire's card kinds with no kind
 * claimed twice, that the shared error rule still leads the family's pill,
 * and that a card body reaches the shell through its family's entry.
 */

/** Every card kind the wire declares, read off the discriminated union itself. */
const wireKinds = (): ReadonlyArray<string> =>
  CardSchema.options.map((option) => option.shape.kind.value).filter(kind => !["retired", "balance", "billing-plans", "stack", "factory.home"].includes(kind))

const base = { id: "card-x", title: "Card", createdAt: 1, ordinal: 1 } as const

const handlers = {
  maximized: false,
  onDecideApproval: () => {},
  onMaximize: () => {},
  onMinimize: () => {},
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

  test("retired kinds have no renderer or family registration", () => {
    const registered = CARD_FAMILIES.flatMap(family => Object.keys(family))
    for (const kind of [...LEGACY_CARD_KINDS, "retired"]) {
      expect(CARD_RENDERERS).not.toHaveProperty(kind)
      expect(registered).not.toContain(kind)
    }
  })

  test.each(["admin-health", "agent", "connect", "grant-confirm", "notifications", "registration", "repository-setup"])(
    "%s restores as a titled tombstone without its saved body or controls", kind => {
      expect(CARD_RENDERERS).not.toHaveProperty(kind)
      expect(CARD_FAMILIES.flatMap(family => Object.keys(family))).not.toContain(kind)
      const stored = { ...base, kind, status: "active", title: "Old action", body: "Private old markup",
        payload: { secret: "Private old payload", action: { flow: "signup.finish" } } }
      const html = renderToStaticMarkup(<CardView card={CardSchema.parse(stored)} {...handlers} />)
      expect(html).toContain("Old action")
      expect(html).not.toContain("Private old markup")
      expect(html).not.toContain("Private old payload")
      expect(html).not.toContain("button")
    }
  )

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
    expect(pillStatus(denied)).toBe("")
    expect(pillStatus({ ...denied, status: "active", payload: { capability: "deploy:production" } })).toBe(
      ""
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



  test("the shell mounts the body from the kind's family entry", () => {
    const status: Card = {
      ...base,
      kind: "status",
      status: "active",
      payload: { progress: 0.5, note: "Building change" }
    }
    const markup = renderToStaticMarkup(<CardView card={status} {...handlers} />)
    expect(markup).toContain('data-kind="status"')
    expect(markup).toContain('Building change')

    /* A kind the chat has never drawn renders the shell and an empty body, as the switch did. */
    const serviceLog = CardSchema.parse({
      ...base,
      kind: "service-log",
      status: "active",
      payload: { workspaceId: "ws-1", repo: "o/r", service: "web", lines: ["ready"], follow: false }
    })
    const shell = renderToStaticMarkup(<CardView card={serviceLog} {...handlers} />)
    expect(shell).toContain("Card")
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

/*
 * The subject cards (settings, members, commands) read the seeded design world
 * through the controller until their seams answer: the owner sees Settings,
 * the roster lists the seeded people, and /help lists only registered flows.
 */
describe("subject card bodies", () => {
  const unanswered = { get: () => ({}), subscribe: () => () => {} }
  const controller = (viewer: string, find: (name: string) => unknown) => {
    const design = createDesignWorld({ viewer })
    return { design, installSnapshots: unanswered, membersRoster: designMembersRoster(design), membersRole: () => designViewerRole(design),
      commands: { find, submit: async () => ({ status: "done" }) } } as unknown as AppController
  }
  const body = <K extends "settings" | "members" | "commands">(kind: K, viewer: string, find: (name: string) => unknown = () => undefined) =>
    renderToStaticMarkup(<ControllerTestProvider controller={controller(viewer, find)}>
      {cardRenderer(kind).render(CardSchema.parse({ ...base, kind, status: "active", payload: {} }) as CardOf<K>, handlers)}</ControllerTestProvider>)

  test("settings renders the seeded install for the owner and nothing for a maintainer", () => {
    expect(body("settings", MAYA)).toContain("Machines")
    expect(body("settings", BEN)).toBe("")
  })
  test("members lists the seeded roster off an install", () => {
    const markup = body("members", MAYA)
    expect(markup).toContain('data-login="mayachen"')
    expect(markup).toContain('data-login="benortiz"')
  })
  test("commands lists only the flows the registry holds", () => {
    const find = (name: string) => name === "help" || name === "members"
      ? { binding: { descriptor: { modelInvocable: name === "help" } }, metadata: {} } : undefined
    const markup = body("commands", MAYA, find)
    expect(markup).toContain("/help")
    expect(markup).toContain("/members")
    expect(markup).not.toContain("/settings")
  })
})

// T-UI-16: production family entries grant no S2 execution authority.
test("legacy File and Diff render with live controls dark", async () => {
  GlobalRegistrator.register()
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host), calls: unknown[] = []
  const cards: Card[] = [
    { ...base, kind: "file", status: "active", payload: { repo: "o/r", path: "src/a.ts", content: "export const value = 1\n", truncated: false } },
    { ...base, kind: "diff", status: "active", payload: { repo: "o/r", changeId: "change-1", from: "base", to: "next", pin: { changeId: "change-1", commitId: null, seq: null }, files: [] } },
  ]
  try {
    for (const card of cards) {
      await act(async () => root.render(renderCardBody(card, { ...handlers, onRunCommand: (...args) => { calls.push(args) } })))
      if (card.kind === "file") {
        // #3628 (6451c97b21) restored CodeMirror for the same read-only card.
        for (let tick = 0; tick < 300 && !host.querySelector(".cm-content"); tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
        expect(host.querySelector(".cm-content")).not.toBeNull()
        expect(host.querySelector(".cm-content")?.getAttribute("aria-readonly")).toBe("true")
      }
      expect(host.querySelector(".code-file-notice")).toBeNull()
      expect(host.querySelector('button[data-flow^="file."]')).toBeNull()
      const region = host.querySelector(".cm-content") ?? host
      await act(async () => {
        region.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }))
        region.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }))
        region.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true }))
      })
      expect(calls).toEqual([])
    }
  } finally { await act(async () => root.unmount()); host.remove(); await GlobalRegistrator.unregister() }
})
