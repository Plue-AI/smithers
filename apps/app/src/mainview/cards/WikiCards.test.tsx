import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { useLiveQuery } from "@tanstack/react-db"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { projectWikiGraph, projectWikiLinks } from "../state/WikiProjection"
import { WikiGraphCardBody, WikiLinksCardBody, wikiCardFamily } from "./WikiCards"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type LinksCard = Extract<Card, { kind: "wiki-links" }>
type GraphCard = Extract<Card, { kind: "wiki-graph" }>

const links: LinksCard = {
  id: "wiki-links-plans",
  kind: "wiki-links",
  title: "Links · Plans",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    path: "Plans.md",
    title: "Plans",
    backlinks: [{ path: "World.md", title: "World" }],
    linksOut: [],
    unresolved: ["Ghost"]
  }
}

const mount = (node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(node))
  return { host, unmount: () => flushSync(() => root.unmount()) }
}

describe("WikiLinksCardBody", () => {
  test("bound cards derive changed links from durable documents without rewriting saved cards, and reopen the same view", async () => {
    const rows = new Map<string, string>()
    const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) }, removeItem: (key: string) => { rows.delete(key) } }
    const store = await createAppStore({ kind: "localStorage", storage })
    const note = (id: string, title: string, targets: string[]) => ({ id, path: `${id}.md`, title, body: targets.map(target => `[[${target}]]`).join(" "), links: targets, tags: [], sources: ["user:world-editor"], confidence: 1 })
    const put = async (id: string, title: string, targets: string[]) => {
      await store.dispatch({ type: "world.document.upserted", actor: "user", select: false, document: note(id, title, targets) }).isPersisted.promise
      await new Promise(resolve => setTimeout(resolve, 0))
      flushSync(() => {})
    }
    await put("Plans", "Plans", [])
    await put("World", "First title", ["Plans"])
    await store.dispatch({ type: "card.upsert", actor: "system", card: links }).isPersisted.promise
    const recorded = structuredClone(store.collections.cards.get(links.id))
    const previousDocuments = [...store.collections.worldDocuments.values()]
    const previousProjection = projectWikiLinks(links, previousDocuments)
    const noop = () => {}
    const Bound = () => {
      const { data: worldDocuments } = useLiveQuery(store.collections.worldDocuments)
      return wikiCardFamily["wiki-links"].render(links, { projectionStore: store, worldDocuments, onRunCommand: noop,
        onDecideApproval: noop,
        onConnectGitHub: noop, onRunWorkflow: noop, onStopRun: noop,
        onRetryRun: noop, onChooseWorkflowRepo: noop, onChangeWorldDocument: noop })
    }
    const { host, unmount } = mount(<Bound />)
    try {
      expect(host.querySelector('[data-testid="wiki-open-World.md"]')?.textContent).toBe("First title")
      await put("World", "Renamed", ["Plans"])
      expect(host.querySelector('[data-testid="wiki-open-World.md"]')?.textContent).toBe("Renamed")
      await put("Plans", "Plans", ["Ghost"])
      expect(host.querySelector('[data-testid="wiki-links-unresolved"]')?.textContent).toContain("Ghost")
      await put("Ghost", "Found", [])
      expect(host.querySelector('[data-testid="wiki-links-unresolved"]')).toBeNull()
      expect(host.querySelector('[data-testid="wiki-links-links-out"]')?.textContent).toContain("Found")
      await store.dispatch({ type: "world.document.removed", actor: "user", id: "World" }).isPersisted.promise
      await new Promise(resolve => setTimeout(resolve, 0))
      flushSync(() => {})
      expect(host.querySelector('[data-testid="wiki-open-World.md"]')).toBeNull()
      expect(store.collections.cards.get(links.id)).toEqual(recorded)
      expect(projectWikiLinks(links, previousDocuments)).toEqual(previousProjection)
      const expected = projectWikiLinks(links, [...store.collections.worldDocuments.values()])
      unmount()
      await store.dispose?.()
      const reopened = await createAppStore({ kind: "localStorage", storage })
      try {
        expect(projectWikiLinks(links, [...reopened.collections.worldDocuments.values()])).toEqual(expected)
        expect(reopened.collections.cards.get(links.id)).toEqual(recorded)
      } finally { await reopened.dispose?.() }
    } finally { unmount(); host.remove(); await store.dispose?.() }
  })
  test("every note row is the button door of wiki.open with the note's path as its args; an unresolved target has no door", () => {
    const calls: Array<[string, string | undefined]> = []
    const { host, unmount } = mount(<WikiLinksCardBody card={links} onRunCommand={(name, args) => calls.push([name, args])} />)
    const backlink = host.querySelector<HTMLButtonElement>('[data-testid="wiki-open-World.md"]')
    expect(backlink?.getAttribute("data-flow")).toBe("wiki.open")
    backlink?.click()
    expect(calls).toEqual([["wiki.open", "World.md"]])
    expect(host.querySelector('[data-testid="wiki-links-links-out"]')?.textContent).toContain("No outgoing links yet")
    const unresolved = host.querySelector('[data-testid="wiki-links-unresolved"]')
    expect(unresolved?.textContent).toContain("[[Ghost]]")
    expect(unresolved?.querySelector("button")).toBeNull()
    host.querySelector<HTMLButtonElement>('[data-testid="wiki-links-open"]')?.click()
    expect(calls[1]).toEqual(["wiki.open", "Plans.md"])
    unmount()
  })
})

describe("WikiGraphCardBody", () => {
  const graph = (notes: GraphCard["payload"]["notes"], path: string | null = null): GraphCard => ({
    id: "wiki-graph",
    kind: "wiki-graph",
    title: "Wiki graph",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: {
      path,
      notes,
      links: notes.flatMap((note) => note.linksOut.map((target) => ({ source: note.path, target })))
    }
  })

  test("graph decoration uses the supplied document revision; missing focus never expands scope", () => {
    const document = { id: "Plans", path: "Plans.md", title: "Plans", body: "[[Ghost]]", links: ["Ghost"], tags: [], sources: [], confidence: 1, updatedAt: 1, updatedBy: "user" as const, revision: 1 }
    const card = graph([], "Plans.md")
    const projected = projectWikiGraph(card, [document])
    expect(projected.payload.notes).toHaveLength(2)
    expect(projected.payload.notes.find(note => note.path === "Ghost.md")?.missing).toBe(true)
    expect(projected.payload.links).toEqual([{ source: "Plans.md", target: "Ghost.md" }])
    expect(projectWikiGraph(card, [])?.payload.notes).toEqual([])
    expect(card.payload.notes).toEqual([])
    const { host, unmount } = mount(<WikiGraphCardBody card={projected} worldDocuments={[]} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid="wiki-graph-empty"]')).not.toBeNull()
    unmount()
  })

  test("an empty Wiki says so instead of drawing nothing", () => {
    const { host, unmount } = mount(<WikiGraphCardBody card={graph([])} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid="wiki-graph-empty"]')?.textContent).toContain("empty so far")
    unmount()
  })

  test("the scope line counts notes, links and unresolved targets, and Refresh re-runs wiki.graph with the same focus", () => {
    const calls: Array<[string, string | undefined]> = []
    const notes: GraphCard["payload"]["notes"] = [
      { path: "Plans.md", title: "Plans", linksOut: ["World.md", "Ghost.md"], backlinks: [], missing: false },
      { path: "World.md", title: "World", linksOut: [], backlinks: ["Plans.md"], missing: false },
      { path: "Ghost.md", title: "Ghost", linksOut: [], backlinks: ["Plans.md"], missing: true }
    ]
    const { host, unmount } = mount(<WikiGraphCardBody card={graph(notes, "Plans.md")} onRunCommand={(name, args) => calls.push([name, args])} />)
    expect(host.querySelector('[data-testid="wiki-graph-scope"]')?.textContent).toBe("Around Plans.md · 2 notes · 2 links · 1 unresolved")
    host.querySelector<HTMLButtonElement>('[data-testid="wiki-graph-rerun"]')?.click()
    expect(calls).toEqual([["wiki.graph", "Plans.md"]])
    unmount()
  })

  /*
   * Spec 07 §2: a scope pill names a kind of wiki content, never a surface
   * and never a store. The unfocused graph therefore reads "All", covering
   * the pages the //:wiki target generates plus the person's own notes, and
   * never "the whole Wiki", which named the store. The focused scope still
   * names a note.
   */
  test("the unfocused scope reads All, not the store's name", () => {
    const notes: GraphCard["payload"]["notes"] = [
      { path: "Plans.md", title: "Plans", linksOut: ["World.md"], backlinks: [], missing: false },
      { path: "World.md", title: "World", linksOut: [], backlinks: ["Plans.md"], missing: false }
    ]
    const { host, unmount } = mount(<WikiGraphCardBody card={graph(notes)} onRunCommand={() => {}} />)
    const scope = host.querySelector('[data-testid="wiki-graph-scope"]')?.textContent
    expect(scope).toBe("All · 2 notes · 1 link")
    expect(scope).not.toContain("whole")
    unmount()
  })
})
