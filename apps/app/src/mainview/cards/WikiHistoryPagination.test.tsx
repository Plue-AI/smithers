import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { payloadFor } from "../flows/SlashPayload"
import type { Card } from "../state/AppState"
import { WikiHistoryCardBody } from "./WikiCards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.() })

const history = (slug: string, path: string, space: "public" | "private", page: number, hasNext: boolean): Extract<Card, { kind: "wiki-history" }> => ({
  id: "wiki-history-owner/repo-1", kind: "wiki-history", title: `History · ${path}`, status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "owner/repo", space, pageId: 1, slug, title: "Architecture", path, page, hasNext, revisions: [] }
})

const press = (card: Extract<Card, { kind: "wiki-history" }>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const calls: Array<{ name: string; payload: unknown }> = []
  const root = createRoot(host)
  flushSync(() => root.render(<WikiHistoryCardBody card={card} onRunCommand={(name, args) => {
    const parsed = payloadFor(name, args)
    calls.push({ name, payload: "payload" in parsed ? parsed.payload : parsed })
  }} />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  for (const label of ["Previous page", "Next page"]) {
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)?.click()
  }
  return calls
}

test.each([
  { name: "generated slug under a renamed nested path", slug: "generated-1", path: "Guides/Architecture.md" },
  { name: "imported slug unlike its file name", slug: "sync-arch", path: "Imported/System Design.md" },
  { name: "attachment slug keeps its extension", slug: "home-diagram-png", path: "assets/diagram.png" }
])("page buttons carry the indexed slug, the page and the card's space: $name", ({ slug, path }) => {
  expect(press(history(slug, path, "private", 2, true))).toEqual([
    { name: "wiki.history", payload: { slug, repo: "owner/repo", page: 1, space: "private" } },
    { name: "wiki.history", payload: { slug, repo: "owner/repo", page: 3, space: "private" } }
  ])
})

test("the first page offers only Next and the last page only Previous", () => {
  expect(press(history("generated-1", "A/B.md", "public", 1, true))).toEqual([
    { name: "wiki.history", payload: { slug: "generated-1", repo: "owner/repo", page: 2, space: "public" } }
  ])
  expect(press(history("generated-1", "A/B.md", "public", 4, false))).toEqual([
    { name: "wiki.history", payload: { slug: "generated-1", repo: "owner/repo", page: 3, space: "public" } }
  ])
})

test("the history door accepts a space so a page turn cannot change spaces", () => {
  expect(payloadFor("wiki.history", "generated-1 owner/repo --space private")).toMatchObject({
    payload: { slug: "generated-1", repo: "owner/repo", space: "private" }
  })
})
