import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { addWorldNote, memoryStorage } from "./state/TestFixtures"
import { WorldSurface } from "./WorldSurface"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

/*
 * The pane's editor must sit in the same registry the cards' editors do:
 * that registry is the only thing that pushes an accepted remote revision
 * (or an agent `remember`) into an open editor. A pane left out of it keeps
 * stale text, and the next keystroke writes that stale text over the peer's.
 */
test("the Wiki pane registers its editor for store pushes, not only for heading scrolls", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await addWorldNote(store)
  await store.dispatch({ type: "input.mode.changed", actor: "user", mode: "vim" }).isPersisted.promise
  const documents = [...store.collections.worldDocuments.values()]
  const attached: Array<[id: string, slot: string, editor: unknown]> = []
  let scrollHandle: unknown = undefined
  const controller = {
    store,
    runCommand: () => {},
    changeWorldDocument: () => {},
    attachWikiEditor: (handle: unknown) => { scrollHandle = handle },
    attachWorldEditor: (id: string, slot: string, editor: unknown) => { attached.push([id, slot, editor]) }
  } as unknown as AppController
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerContext value={controller}><WorldSurface documents={documents} /></ControllerContext>))
  for (let attempt = 0; attempt < 40 && host.querySelector("textarea") === null; attempt++) await tick()
  expect(host.querySelector("textarea")).not.toBeNull()
  expect(scrollHandle).toBeDefined()
  expect(attached.filter(([, , editor]) => editor !== null)).toEqual([[documents[0]!.id, "pane", scrollHandle]])
  flushSync(() => root.unmount())
  host.remove()
  await store.dispose?.()
})

/*
 * The wiki spaces (#1922): with a repository's index read, the pane shows the
 * space switch, the tree with its folders and tags from the index, and the
 * open page's backlinks from the index (server-resolved), each row the
 * button door of a registered flow. An attachment shows its bytes.
 */
test("the Wiki pane lists a space's index as a tree with folders, tags and server backlinks, and switches spaces through wiki.space", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "org/repo", org: "org", ownerKind: "user", name: "repo", head: null }] }).isPersisted.promise
  const page = (id: number, slug: string, path: string, extra: Record<string, unknown> = {}) => ({ id, slug, title: slug, path, revision: 1, updatedAt: "2026-09-26T00:00:00Z", tags: [], aliases: [], headings: [], links: [], backlinks: [], ...extra })
  const index = { id: "org/repo#public", repo: "org/repo", space: "public" as const, loadedAt: 1,
    pages: [page(1, "home", "Home.md", { tags: ["guide"], links: [{ target: "Guides/Start", embed: false, pageId: 2 }, { target: "Nowhere", embed: false }], backlinks: [{ pageId: 2, path: "Guides/Start.md", embed: false }] }),
      page(2, "start", "Guides/Start.md"), page(3, "logo", "assets/logo.png", { attachment: { digest: "c".repeat(64), mediaType: "image/png", size: 3 } })],
    folders: ["Guides", "assets"], tags: ["guide"] }
  const wikiIndexes = { get: (repo: string, space: string) => repo === "org/repo" && space === "public" ? index : undefined, subscribe: () => () => {} }
  await store.dispatch({ type: "world.document.upserted", actor: "user", document: { id: "wiki:org/repo:1", path: "org/repo/wiki/home.md", title: "Home", body: "# Home\n\n[[Guides/Start]]", links: ["Guides/Start"], tags: [], sources: [], confidence: 1,
    cloud: { repo: "org/repo", pageId: 1, slug: "home", visibility: "public", path: "Home.md", remoteRevision: 1, remoteAuthor: "will", remoteUpdatedAt: "", state: "", accountLogin: "will", branchId: "main", phase: "live", error: null, pending: [] } } }).isPersisted.promise
  await store.dispatch({ type: "input.mode.changed", actor: "user", mode: "vim" }).isPersisted.promise
  const calls: Array<[string, string | undefined]> = []
  const controller = { store, wikiIndexes, runCommand: (name: string, args?: string) => { calls.push([name, args]) }, changeWorldDocument: () => {}, attachWikiEditor: () => {}, attachWorldEditor: () => {}, submitCommand: async () => ({ status: "executed" }) } as unknown as AppController
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerContext value={controller}><WorldSurface documents={[...store.collections.worldDocuments.values()]} /></ControllerContext>))
  for (let attempt = 0; attempt < 40 && host.querySelector("textarea") === null; attempt++) await tick()
  const text = host.textContent ?? ""
  // The switch: two doors of wiki.space, the shown one pressed.
  expect(host.querySelector('[data-testid="wiki-space-public"]')?.getAttribute("aria-pressed")).toBe("true")
  expect(host.querySelector('[data-testid="wiki-space-private"]')?.getAttribute("data-flow")).toBe("wiki.space")
  ;(host.querySelector('[data-testid="wiki-space-private"]') as HTMLButtonElement).click()
  expect(calls.at(-1)).toEqual(["wiki.space", "private org/repo"])
  // The tree: the index's folders and pages; a page not yet loaded opens through wiki.cloud.open, a loaded one through wiki.select.
  expect([...host.querySelectorAll('[data-slot="file-tree-dir-toggle"]')].map((node) => node.textContent?.trim())).toEqual(["Guides", "assets"])
  expect(host.querySelector('[data-testid="wiki-tree"] [data-flow="wiki.cloud.open"]')).not.toBeNull()
  ;(host.querySelector('[data-testid="wiki-tree"] [data-flow="wiki.cloud.open"]') as HTMLButtonElement).click()
  expect(calls.at(-1)).toEqual(["wiki.cloud.open", "start org/repo --space public"])
  expect(text).toContain("#guide")
  // The open page: its path and revision, the History/Rename/Delete/Attach doors, and the index's backlinks and unresolved link in the rail.
  expect(host.querySelector('[data-testid="wiki-page-path"]')?.textContent).toBe("Home.md")
  expect(host.querySelector('[data-testid="wiki-page-revision"]')?.textContent).toBe("r1")
  expect(host.querySelector('[data-testid="wiki-page-history"]')?.getAttribute("data-flow-args")).toBe("home org/repo")
  expect(host.querySelector('[data-testid="wiki-page-delete"]')?.getAttribute("data-flow")).toBe("wiki.cloud.delete")
  expect(host.querySelector('[data-flow="wiki.attach"]')).not.toBeNull()
  const rail = host.querySelector('[data-testid="wiki-rail"]')!
  expect(rail.textContent).toContain("Guides/Start.md")
  expect(rail.querySelector(".wiki-unresolved")?.textContent).toBe("[[Nowhere]]")
  // The attachment: selected by its page id, shown as an image of its current revision.
  await store.dispatch({ type: "world.document.selected", actor: "user", id: "wiki:org/repo:3" }).isPersisted.promise
  flushSync(() => root.render(<ControllerContext value={controller}><WorldSurface documents={[...store.collections.worldDocuments.values()]} /></ControllerContext>))
  await tick()
  expect(host.querySelector('[data-testid="wiki-attachment"] img')?.getAttribute("src")).toBe("/api/repos/org/repo/wiki/history/3/1/content?visibility=public")
  flushSync(() => root.unmount())
  host.remove()
  await store.dispose?.()
})
