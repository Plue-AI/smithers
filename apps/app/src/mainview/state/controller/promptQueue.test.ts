import { afterEach, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { CommandRegistry } from "../../flows/Commands"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { promptQueueScope } from "../PromptQueue"
import { memoryStorage, settle, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createPromptQueueController } from "./promptQueue"
import { createTurnController } from "./turns"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const fixture = async (options: {
  steer?: () => Promise<boolean>
  storage?: ReturnType<typeof memoryStorage>
  start?: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
} = {}) => {
  const storage = options.storage ?? memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  const launches: StartAgentTurnRequest[] = [], steers: string[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { launches.push(request); return options.start?.(request) ?? { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    steer: async (_id, text) => { steers.push(text); return options.steer?.() ?? true }
  }
  const ctx = createControllerContext(store, agent, {})
  ctx.commands = { all: () => [], callable: () => [], find: () => undefined, toolSpecs: () => [],
    state: () => ({ surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false }) } as unknown as CommandRegistry
  ctx.withToast = async (_key, _title, _doneTitle, work) => work()
  const turns = createTurnController(ctx, { nextOrdinal: store.nextOrdinal,
    settleTurnBilling: () => {}, surfaceCommandFailure: () => {}, forwardApprovalDecision: async () => {},
    forwardInboxApprovalDecision: async () => {} })
  const queue = createPromptQueueController(ctx, turns.send)
  turns.subscribeToAgent()
  queue.subscribe()
  const close = async () => { await ctx.dispose(); await store.dispose?.() }
  cleanups.push(close)
  const finish = (error?: string) => {
    const runId = ctx.activeTurn!.id
    if (!error) for (const listener of listeners) listener({ type: "delta", runId, kind: "text", text: "Done" })
    for (const listener of listeners) listener({ type: "done", runId, ...(error ? { error } : { reason: "stop" }) })
  }
  return { storage, store, ctx, turns, queue, launches, steers, finish, close }
}

test("queue returns during an unresolved launch, steers stay usable, and follow-ups drain FIFO only after completion", async () => {
  const start = Promise.withResolvers<StartAgentTurnResult>()
  const f = await fixture({ start: () => start.promise })
  await f.turns.send("first")
  expect(f.queue.enqueuePrompt("second")).toBeUndefined()
  f.queue.enqueuePrompt("third")
  await f.store.settled?.()
  expect(f.launches).toHaveLength(1)
  expect(f.store.session().queuedPrompts?.map(p => p.text)).toEqual(["second", "third"])
  f.turns.send("steer now")
  await waitFor(() => f.steers.length === 1)
  start.resolve({ status: "started" })
  await settle()
  expect(f.launches).toHaveLength(1)
  const queuedIds = f.store.session().queuedPrompts!.map(p => p.id)
  f.finish()
  await waitFor(() => f.launches.length === 2)
  expect(f.launches[1]!.runId).toBe(queuedIds[0]!)
  expect(f.store.session().queuedPrompts?.map(p => p.text)).toEqual(["third"])
  expect(f.store.collections.messages.get(`message-${queuedIds[0]}-user`)?.text).toBe("second")
  f.finish()
  await waitFor(() => f.launches.length === 3)
  expect(f.launches[2]!.runId).toBe(queuedIds[1]!)
  expect(f.store.session().queuedPrompts).toEqual([])
})

test.each(["failure", "stop"])("%s pauses remaining prompts until explicitly resumed", async kind => {
  const f = await fixture()
  await f.turns.send("first")
  f.queue.enqueuePrompt("second")
  await f.store.settled?.()
  if (kind === "failure") f.finish("offline")
  else f.turns.stop()
  await settle()
  expect(f.store.session()).toMatchObject({ phase: "idle", promptQueuePaused: true })
  expect(f.launches).toHaveLength(1)
  f.queue.resumePromptQueue()
  await waitFor(() => f.launches.length === 2)
  expect(f.store.session().queuedPrompts).toEqual([])
})

test("queue survives reload, deduplicates IDs, and edits/removals preserve the current draft", async () => {
  const f = await fixture()
  await f.turns.send("first")
  f.queue.enqueuePrompt("second")
  f.queue.enqueuePrompt("third")
  await f.store.settled?.()
  const first = f.store.session().queuedPrompts![0]!
  await f.store.dispatch({ type: "prompt.queued", actor: "user", prompt: first }).isPersisted.promise
  await f.close()
  const restored = await fixture({ storage: f.storage })
  await settle()
  expect(restored.launches).toHaveLength(0)
  expect(restored.store.session()).toMatchObject({ promptQueuePaused: true })
  expect(restored.store.session().queuedPrompts?.map(p => p.text)).toEqual(["second", "third"])
  await restored.store.dispatch({ type: "composer.changed", actor: "user", draft: "draft" }).isPersisted.promise
  restored.queue.removeQueuedPrompt(first.id, true)
  expect(restored.store.session().draft).toBe("second\n\ndraft")
  restored.queue.removeQueuedPrompt(restored.store.session().queuedPrompts![0]!.id)
  expect(restored.store.session().queuedPrompts).toEqual([])
  expect(restored.store.session().draft).toBe("second\n\ndraft")
})

test("prompts captured for another scope never run or get edited here, and sign-out forgets them", async () => {
  const f = await fixture()
  const here = promptQueueScope(f.store.session())
  await f.store.dispatch({ type: "prompt.queued", actor: "user", prompt: { id: "elsewhere", text: "private", scope: here + "other" } }).isPersisted.promise
  f.queue.removeQueuedPrompt("elsewhere", true)
  await settle()
  expect(f.launches).toHaveLength(0)
  expect(f.store.session().queuedPrompts).toHaveLength(1)
  expect(f.store.session().draft).toBe("")
  await f.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
  expect(f.store.session().queuedPrompts ?? []).toEqual([])
})

test("a queued turn cannot clear an unrelated draft", async () => {
  const f = await fixture()
  await f.turns.send("first")
  f.queue.enqueuePrompt("second")
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "still composing" }).isPersisted.promise
  f.finish()
  await waitFor(() => f.launches.length === 2)
  expect(f.store.session().draft).toBe("still composing")
})

for (const next of [undefined, "steer now", "the next draft"]) {
  test(`a delayed successful steer consumes only its original input (${next ?? "unchanged"})`, async () => {
    const held = Promise.withResolvers<boolean>()
    const f = await fixture({ steer: () => held.promise })
    await f.turns.send("first")
    f.store.dispatch({ type: "composer.changed", actor: "user", draft: "steer now" })
    f.turns.send("steer now")
    await waitFor(() => f.steers.length === 1)
    if (next !== undefined) {
      f.store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      f.store.dispatch({ type: "composer.changed", actor: "user", draft: next })
    }
    held.resolve(true)
    await waitFor(() => [...f.store.collections.messages.values()].some(row => row.role === "user" && row.text === "steer now"))
    expect(f.steers).toEqual(["steer now"])
    expect(f.store.session().draft).toBe(next ?? "")
    await f.store.settled?.()
    expect((await f.store.verifyState()).valid).toBe(true)
  })
}

for (const rejection of ["refused", "failed"] as const) {
  test(`a ${rejection} steer keeps its input retryable`, async () => {
    const held = Promise.withResolvers<boolean>()
    const f = await fixture({ steer: () => held.promise })
    await f.turns.send("first")
    f.store.dispatch({ type: "composer.changed", actor: "user", draft: "steer now" })
    f.turns.send("steer now")
    await waitFor(() => f.steers.length === 1)
    if (rejection === "refused") held.resolve(false)
    else held.reject(new Error("offline"))
    await settle()
    expect(f.store.session().draft).toBe("steer now")
    expect([...f.store.collections.messages.values()].filter(row => row.role === "user" && row.text === "steer now")).toHaveLength(0)
  })
}
