import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ContextLine } from "./ContextLine"
import { contextActions } from "./flows/contextActions"
import { contextOpenAction } from "./flows/contextOpenAction"
import { createAppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { memoryStorage } from "./state/TestFixtures"
import type { AgentPort } from "./runtime/AgentPort"
import { RunContainer } from "./cards/RunContainer"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const pinned = "0123456789abcdef0123456789abcdef01234567"
const items = [{ kind: "file" as const, label: "retry.ts", ref: "src/webhooks/retry.ts", revision: pinned, reason: "Retry implementation" }]
const agent: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }

test("Context opens a pinned file through cardActions, the registered flow and the real install seam", async () => {
  const requests: string[] = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, agent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null },
    fetchImpl: async url => {
      const path = String(url); requests.push(path)
      if (path === `/api/branches/main/files/src/webhooks/retry.ts?at=${pinned}`) return Response.json({
        branch: "main", path: "src/webhooks/retry.ts", language: "typescript", digest: "literal-retry",
        content: { kind: "text", text: "export const retry = 3" }, mode: "read_only", diagnostics: [], authors: [], editors: []
      })
      return new Response("{}", { status: 404 })
    }
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "acme/app", org: "acme", ownerKind: "user", name: "app", head: { bookmark: "main", changeId: "c", commitId: pinned } }] }).isPersisted.promise
    let completed: Promise<unknown> = Promise.resolve()
    const actions = contextActions(items, (tag, input) => { completed = controller.runCommandForResult(tag, JSON.stringify(input)) }, contextOpenAction)
    let expanded = false
    const render = () => flushSync(() => root.render(<ContextLine count={1} items={items} expanded={expanded} onView={patch => { expanded = patch.expanded; render() }} {...actions} />))
    render()
    expect(host.querySelectorAll("button")).toHaveLength(1)
    host.querySelector<HTMLButtonElement>(".context-toggle")!.click()
    const source = host.querySelector<HTMLButtonElement>(".context-chip")!
    expect(source.tagName).toBe("BUTTON")
    source.focus(); expect(document.activeElement).toBe(source)
    expect(source.dataset.flow).toBe("file")
    source.click(); await completed
    expect(requests).toContain(`/api/branches/main/files/src/webhooks/retry.ts?at=${pinned}`)
    const card = [...store.collections.cards.values()].find(card => card.kind === "file")
    expect(card?.payload).toMatchObject({ path: "src/webhooks/retry.ts", ref: pinned, content: "export const retry = 3" })
    expect(requests.some(path => path.includes("wake") || path.includes("/machines"))).toBe(false)
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})

test("a missing pinned-page provider leaves disclosure readable without an active card action", () => {
  const page = [{ kind: "page" as const, label: "Retries", ref: "retries", revision: "4", reason: "Policy" }]
  const actions = contextActions(page, () => { throw new Error("unavailable provider ran") }, contextOpenAction)
  const host = document.createElement("div"), root = createRoot(host)
  flushSync(() => root.render(<ContextLine count={1} items={page} expanded={true} onView={() => {}} {...actions} />))
  expect(host.querySelectorAll("button")).toHaveLength(1)
  expect(host.querySelector(".context-chip")?.tagName).toBe("SPAN")
  expect(host.textContent).toContain("Retries")
  flushSync(() => root.unmount())
})

test("historical seeded file contexts keep their branch door", () => {
  expect(contextOpenAction({ kind: "file", label: "checkout.test.ts", ref: "checkout.test.ts", revision: "b-race" })?.command_input)
    .toEqual({ path: "checkout.test.ts", branch: "b-race" })
})

test("the Inspect flow opens a durable host preflight on an install without the seeded run provider", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, agent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["install", "identity"], authFlow: "redirect", sandbox: null },
    fetchImpl: async () => new Response("{}", { status: 404 })
  })
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Retry?", retry: false,
      journal: { version: 1, legId: "leg", token: "a".repeat(64) } }).isPersisted.promise
    const cursor = { version: 1 as const, runId: "turn", legId: "leg", batch: 0, position: 0, hash: "0".repeat(64) }
    await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor }).isPersisted.promise
    const body = { version: 1 as const, runId: "turn", legId: "leg", batch: 1, from: 1, previousHash: cursor.hash, frames: [
      { runId: "turn", type: "context.preflight" as const, phase: "completed" as const, result: { context: items,
        candidates: [{ kind: "file" as const, label: "retry.ts", ref: "src/webhooks/retry.ts", revision: pinned }], model: "owner-fast", durationMs: 12 } },
      { runId: "turn", type: "delta" as const, kind: "text" as const, text: "Retries three times" },
      { runId: "turn", type: "done" as const, reason: "stop" as const }
    ] }
    await store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
      batch: { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) } }).isPersisted.promise
    expect(controller.design.world().traces).toHaveLength(0)
    const model = controller.contextRun("turn")!
    let completed: Promise<unknown> = Promise.resolve()
    flushSync(() => root.render(<RunContainer model={model} dispatch={(tag, input) => {
      completed = controller.runCommandForResult(tag, JSON.stringify(input))
    }} view={{ maximized: false }} onView={() => {}} />))
    host.querySelector<HTMLButtonElement>('[data-flow="run.inspect"]')!.click()
    await completed
    expect(store.collections.cards.get("run:turn")).toMatchObject({ kind: "run", payload: { id: "turn" } })
    expect(store.session().maximizedCardId).toBe("run:turn")
    flushSync(() => root.render(<RunContainer model={controller.contextRun("turn")} dispatch={() => {}}
      view={{ maximized: true }} onView={() => {}} />))
    expect(host.querySelector(".mvp-run-step-head")?.textContent).toBe("Preflight")
    expect(host.textContent).toContain("src/webhooks/retry.ts")
    expect(host.textContent).toContain("Retry implementation")
    expect(host.textContent).toContain("owner-fast")
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
    expect(controller.contextRun("turn")).toBeUndefined()
  } finally { flushSync(() => root.unmount()); host.remove(); await controller.dispose() }
})
