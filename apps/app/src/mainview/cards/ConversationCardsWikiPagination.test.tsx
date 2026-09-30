import { ControllerContext } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
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

let account: AppController
beforeAll(async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  account = { store, wikiIndexes: { get: () => undefined, subscribe: () => () => {} } } as unknown as AppController
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.() })

const card = (space: "public" | "private" | undefined, page: number, count: number): Extract<Card, { kind: "world" }> => ({
  id: "wiki-index-owner-repo", kind: "world", title: "Wiki", status: "active", createdAt: 1, ordinal: 1,
  payload: {
    documents: Array.from({ length: count }, (_, number) => ({
      id: `wiki:owner/repo:${number + 1}`, path: `Page-${number + 1}.md`, title: `Page ${number + 1}`, confidence: 1, cloud: { repo: "owner/repo", slug: `page-${number + 1}`, revision: 1, visibility: space ?? "public", accountLogin: "will" }
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
  flushSync(() => root.render(<ControllerContext.Provider value={account}><WorldCardBody card={wikiCard} worldDocuments={[]}
    onChangeWorldDocument={() => {}} onRunCommand={(name, args) => {
      const parsed = payloadFor(name, args)
      calls.push({ name, payload: "payload" in parsed ? parsed.payload : parsed })
    }} /></ControllerContext.Provider>))
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
