import { afterEach, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController, type AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { Card } from "../AppState"
import { memoryStorage, waitFor } from "../TestFixtures"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const file = (id: string, ordinal: number, title = id): Card => ({
  id, kind: "file", title, ordinal, createdAt: 1, status: "active",
  payload: { repo: "acme/repo", path: `${id}.md`, content: "private file contents", truncated: false }
})

// Controlled transport unit: real catalog, controller, and persisted Map store.
const fixture = async (services: Pick<AppServices, "features"> = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { requests.push(request); return { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const controller = createAppController(store, agent, {
    ...services, fetchImpl: async () => Response.json({}, { status: 404 })
  })
  cleanups.push(() => controller.dispose())
  const upsert = async (card: Card) => {
    await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
  }
  const send = async () => {
    expect(await controller.send("What is on screen?")).toBe(true)
    expect(requests).toHaveLength(1)
    return requests[0]!
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return { store, requests, upsert, send, emit }
}

test("the recent-card window sorts by ordinal after excluding foreign conversation cards", async () => {
  const f = await fixture()
  // Insertion order disagrees with presentation order. A recent foreign card
  // must not displace a main-conversation card from the twelve-card window.
  for (let index = 12; index >= 0; index -= 1) await f.upsert(file(`f${index}`, index + 1))
  await f.upsert({ ...file("foreign", 99), tabId: "restored-private-conversation" })
  const request = await f.send()
  expect(request.context?.recentCards?.map(card => card.id)).toEqual([
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"
  ])
  expect(JSON.stringify(request.context)).not.toContain("foreign")
  expect([...f.store.collections.cards.values()]).toHaveLength(14)
})

for (const length of [249, 250, 251]) {
  test(`runtime card titles have a 250-character boundary without changing persisted titles (${length})`, async () => {
    const f = await fixture()
    const title = "x".repeat(length)
    await f.upsert(file("title", 1, title))
    const request = await f.send()
    expect(request.context?.recentCards).toEqual([
      { id: "title", kind: "file", title: "x".repeat(Math.min(length, 250)), status: "active", maximized: false }
    ])
    expect(f.store.collections.cards.get("title")?.title).toBe(title)
    expect(JSON.stringify(request)).not.toContain("private file contents")
  })
}

test("title line breaks are flattened in runtime context while maximization belongs to only the selected card", async () => {
  const f = await fixture()
  await f.upsert(file("first", 1, "First\r\nline\nLast"))
  await f.upsert(file("second", 2))
  await f.store.dispatch({ type: "card.maximized", actor: "user", id: "second" }).isPersisted.promise
  const request = await f.send()
  expect(request.context?.recentCards).toEqual([
    { id: "first", kind: "file", title: "First  line Last", status: "active", maximized: false },
    { id: "second", kind: "file", title: "second", status: "active", maximized: true }
  ])
  expect(f.store.collections.cards.get("first")?.title).toBe("First\r\nline\nLast")
})

for (const enabled of [false, true]) {
  test(`restored plugin cards obey the release capability before entering runtime context (${enabled})`, async () => {
    const f = await fixture({ features: { pluginLibrary: enabled } })
    await f.upsert({ id: "library", kind: "plugin-library", title: "Library", status: "active", ordinal: 1,
      createdAt: 1, payload: { tutorial: false } })
    await f.upsert(file("visible", 2))
    const request = await f.send()
    expect(request.context?.recentCards?.map(card => card.id)).toEqual(enabled ? ["library", "visible"] : ["visible"])
    expect(f.store.collections.cards.has("library")).toBe(true)
  })
}

test("older workspace cards retain honest unknown-kind and terminal defaults without exposing their payload", async () => {
  const f = await fixture()
  await f.upsert({ id: "legacy-box", kind: "workspace", title: "Box", status: "active", ordinal: 1, createdAt: 1,
    payload: { workspaceId: "box-1", repo: "acme/repo", name: "Box", targetBookmark: "main", status: "running",
      provisioningStage: null, suspendedAt: null, bookmarkHead: null, sessions: [] } })
  const request = await f.send()
  expect(request.context?.recentCards).toEqual([
    { id: "legacy-box", kind: "workspace", title: "Box", status: "active", maximized: false,
      workspace: { id: "box-1", repo: "acme/repo", kind: "unknown", status: "running", facet: "terminal" } }
  ])
  expect(JSON.stringify(request.context)).not.toContain("targetBookmark")
})

test("a continuation uses current card state without mutating the previous request snapshot", async () => {
  const f = await fixture()
  await f.upsert(file("first", 1, "Before"))
  const request = await f.send()
  const original = structuredClone(request.context?.recentCards)
  await f.upsert(file("first", 1, "After"))
  await f.upsert(file("second", 2))
  await f.store.dispatch({ type: "card.maximized", actor: "user", id: "second" }).isPersisted.promise
  f.emit({ runId: request.runId, type: "tool_call", call_id: "read-catalog", name: "commands",
    arguments: JSON.stringify({ action: "list" }) })
  f.emit({ runId: request.runId, type: "done", reason: "tool_call" })
  await waitFor(() => f.requests.length === 2)
  expect(f.requests[1]?.context?.recentCards).toEqual([
    { id: "first", kind: "file", title: "After", status: "active", maximized: false },
    { id: "second", kind: "file", title: "second", status: "active", maximized: true }
  ])
  expect(request.context?.recentCards).toEqual(original)
  expect(original).toEqual([{ id: "first", kind: "file", title: "Before", status: "active", maximized: false }])
})
