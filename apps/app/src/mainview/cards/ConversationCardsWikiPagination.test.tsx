import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { payloadFor } from "../flows/SlashPayload"
import type { Card } from "../state/AppState"
import { WorldCardBody } from "./ConversationCards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.() })

const card = (space: "public" | "private" | undefined, page: number, count: number): Extract<Card, { kind: "world" }> => ({
  id: "wiki-index-owner-repo", kind: "world", title: "Wiki", status: "active", createdAt: 1, ordinal: 1,
  payload: {
    documents: Array.from({ length: count }, (_, number) => ({
      id: `wiki:owner/repo:${number + 1}`, path: `Page-${number + 1}.md`, title: `Page ${number + 1}`, confidence: 1
    })),
    index: { repo: "owner/repo", page, hasNext: count === 50, ...(space === undefined ? {} : { space }) },
    view: "outline"
  }
} as Extract<Card, { kind: "world" }>)

const mount = (wikiCard: Extract<Card, { kind: "world" }>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const calls: Array<{ name: string; payload: unknown }> = []
  const root = createRoot(host)
  flushSync(() => root.render(<WorldCardBody card={wikiCard} worldDocuments={[]}
    onChangeWorldDocument={() => {}} onRunCommand={(name, args) => {
      const parsed = payloadFor(name, args)
      calls.push({ name, payload: "payload" in parsed ? parsed.payload : parsed })
    }} />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return { host, calls }
}

test("private index page buttons carry the card's repository and space", () => {
  const { host, calls } = mount(card("private", 2, 50))
  for (const label of ["Previous page", "Next page"]) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === label)
    expect(button?.dataset.flow).toBe("wiki.cloud")
    button!.click()
  }
  expect(calls).toEqual([
    { name: "wiki.cloud", payload: { repo: "owner/repo", page: 1, space: "private" } },
    { name: "wiki.cloud", payload: { repo: "owner/repo", page: 3, space: "private" } }
  ])
})

test("an empty private index page keeps its space on the Previous door", () => {
  const { host, calls } = mount(card("private", 3, 0))
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Previous page")
  expect(button?.dataset.flow).toBe("wiki.cloud")
  button!.click()
  expect(calls).toEqual([{ name: "wiki.cloud", payload: { repo: "owner/repo", page: 2, space: "private" } }])
})

test("public index pagination carries the public space", () => {
  const { host, calls } = mount(card("public", 1, 50))
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Next page")
  expect(button?.dataset.flow).toBe("wiki.cloud")
  button!.click()
  expect(calls).toEqual([{ name: "wiki.cloud", payload: { repo: "owner/repo", page: 2, space: "public" } }])
})

test("a legacy index without a saved space keeps its displayed public space on both page buttons", () => {
  const { host, calls } = mount(card(undefined, 2, 50))
  expect(host.querySelector('[data-testid="wiki-card-space"]')?.textContent).toBe("public")
  for (const label of ["Previous page", "Next page"]) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === label)
    expect(button?.dataset.flow).toBe("wiki.cloud")
    button!.click()
  }
  expect(calls).toEqual([
    { name: "wiki.cloud", payload: { repo: "owner/repo", page: 1, space: "public" } },
    { name: "wiki.cloud", payload: { repo: "owner/repo", page: 3, space: "public" } }
  ])
})
