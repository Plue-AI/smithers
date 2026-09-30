import { afterEach, expect, test } from "bun:test"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { promptQueueScope } from "../PromptQueue"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createPromptQueueController } from "./promptQueue"
import type { TurnController } from "./turns"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = async (send: (store: AppStore) => TurnController["send"], foreignFirst = false) => {
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await original.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    admin: false, scopesPlain: null }).isPersisted.promise
  const scope = promptQueueScope(original.session())
  const prompt = { id: "queued-request", text: "queued request", scope }
  if (foreignFirst) await original.dispatch({ type: "prompt.queued", actor: "user",
    prompt: { id: "foreign", text: "other conversation's request", scope: `${scope}-other` } }).isPersisted.promise
  await original.dispatch({ type: "prompt.queued", actor: "user", prompt }).isPersisted.promise
  const entered = Promise.withResolvers<void>()
  const persistence = Promise.withResolvers<void>()
  let settlements = 0
  // An explicit public persistence-boundary fake around the actual store.
  // This models asynchronous settlement without pretending Map storage is SQLite.
  const store: AppStore = { ...original, settled: async () => {
    await original.settled?.()
    settlements++
    entered.resolve()
    await persistence.promise
  } }
  const ctx = createControllerContext(store, unavailableAgent, {})
  const queue = createPromptQueueController(ctx, send(original))
  cleanups.push(async () => { persistence.resolve(); await ctx.dispose(); await original.dispose?.() })
  return { original, ctx, queue, entered, persistence, prompt, settlements: () => settlements }
}

test("an unresolved persistence barrier blocks admission and coalesces repeated resume and session notifications", async () => {
  const calls: Array<{ text: string; id: string | undefined; owner: string | null | undefined }> = []
  const f = await fixture(() => async (text, admission) => {
    calls.push({ text, id: admission?.turnId, owner: admission?.owner })
    return false
  })
  f.queue.subscribe()
  await f.entered.promise
  f.queue.resumePromptQueue()
  f.queue.resumePromptQueue()
  await f.original.dispatch({ type: "composer.changed", actor: "user", draft: "still editing" }).isPersisted.promise
  await f.original.settled?.()
  expect(calls).toEqual([])
  expect(f.settlements()).toBe(1)
  expect(f.original.session().draft).toBe("still editing")
  f.persistence.resolve()
  await waitFor(() => f.original.session().promptQueuePaused === true)
  expect(calls).toEqual([{ text: "queued request", id: "queued-request", owner: "alice" }])
  expect(f.original.session().queuedPrompts).toEqual([f.prompt])
  expect(f.ctx.failures.recent()).toEqual([])
})

test("disposal while persistence is unresolved cannot submit or pause the durable queued request later", async () => {
  const calls: string[] = []
  const f = await fixture(() => async text => { calls.push(text); return false })
  f.queue.subscribe()
  await f.entered.promise
  await f.ctx.dispose()
  const before = await f.original.eventHistory()
  f.persistence.resolve()
  await settle()
  await f.original.settled?.()
  expect(calls).toEqual([])
  expect(await f.original.eventHistory()).toEqual(before)
  expect(f.original.session().queuedPrompts).toEqual([f.prompt])
  expect(f.original.session().promptQueuePaused).not.toBe(true)
})

test("a persistence refusal pauses before send and reports the failed boundary", async () => {
  const calls: string[] = []
  const failure = new Error("queue persistence unavailable")
  const f = await fixture(() => async text => { calls.push(text); return true })
  f.queue.subscribe()
  await f.entered.promise
  f.persistence.reject(failure)
  await waitFor(() => f.original.session().promptQueuePaused === true)
  expect(calls).toEqual([])
  expect(f.original.session().queuedPrompts).toEqual([f.prompt])
  expect(f.ctx.failures.recent().map(row => ({ seam: row.seam, message: row.message.split("\n")[0], count: row.count })))
    .toEqual([{ seam: "prompt.queue", message: "Error: queue persistence unavailable", count: 1 }])
})

test("a false send recovers on explicit resume with the same admission, skipping an earlier foreign prompt", async () => {
  const calls: Array<{ text: string; id: string | undefined }> = []
  const f = await fixture(store => async (text, admission) => {
    calls.push({ text, id: admission?.turnId })
    if (calls.length === 1) return false
    if (admission === undefined) throw new Error("expected durable queue admission")
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: admission.turnId, text }).isPersisted.promise
    return true
  }, true)
  f.persistence.resolve()
  f.queue.subscribe()
  await waitFor(() => f.original.session().promptQueuePaused === true)
  expect(calls).toEqual([{ text: "queued request", id: "queued-request" }])
  expect(f.original.session().queuedPrompts?.map(prompt => prompt.id)).toEqual(["foreign", "queued-request"])
  f.queue.resumePromptQueue()
  await waitFor(() => f.original.session().queuedPrompts?.length === 1)
  await f.original.settled?.()
  expect(calls).toEqual([
    { text: "queued request", id: "queued-request" },
    { text: "queued request", id: "queued-request" }
  ])
  expect(f.original.session().queuedPrompts?.map(prompt => prompt.id)).toEqual(["foreign"])
  expect(f.original.collections.messages.get("message-queued-request-user")?.text).toBe("queued request")
  expect(f.original.session().promptQueuePaused).toBe(false)
  expect(f.ctx.failures.recent()).toEqual([])
})

test("a turn completed before its admission returns drains the remaining FIFO request without another session event", async () => {
  const calls: Array<{ id: string; text: string }> = []
  const f = await fixture(store => async (text, admission) => {
    if (admission === undefined) throw new Error("expected queue admission")
    calls.push({ id: admission.turnId, text })
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: admission.turnId, text }).isPersisted.promise
    await store.dispatch({ type: "message.response.delta", actor: "smithers", turnId: admission.turnId,
      channel: "text", delta: `answer to ${text}` }).isPersisted.promise
    await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: admission.turnId }).isPersisted.promise
    // Completion can arrive before the host's start acknowledgement. The
    // caller still receives successful admission after the turn has settled.
    return true
  })
  await f.original.dispatch({ type: "prompt.queued", actor: "user", prompt: {
    id: "next-request", text: "next request", scope: f.prompt.scope
  } }).isPersisted.promise
  f.persistence.resolve()
  f.queue.subscribe()
  await waitFor(() => calls.length === 2 && f.original.session().phase === "idle")
  await f.original.settled?.()
  expect(calls).toEqual([
    { id: "queued-request", text: "queued request" },
    { id: "next-request", text: "next request" }
  ])
  expect(f.original.session().queuedPrompts).toEqual([])
  expect(f.original.collections.messages.get("message-queued-request-smithers")?.text).toBe("answer to queued request")
  expect(f.original.collections.messages.get("message-next-request-smithers")?.text).toBe("answer to next request")
  expect(f.ctx.failures.recent()).toEqual([])
})

test("an enqueue write refusal reports the boundary and never submits the rejected prompt", async () => {
  const backing = memoryStorage()
  let rejectNextWrite = false
  let rejectedWrites = 0
  const store = await createAppStore({ kind: "localStorage", storage: { ...backing, setItem(key, value) {
    if (rejectNextWrite) {
      rejectNextWrite = false
      rejectedWrites++
      throw new DOMException("queue write exceeded its quota", "QuotaExceededError")
    }
    backing.setItem(key, value)
  } } })
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async () => { throw new Error("unexpected HTTP request in queue unit") }
  })
  const ctx = createControllerContext(store, unavailableAgent, {})
  ctx.commands = controller.commands
  cleanups.push(async () => { rejectNextWrite = false; await ctx.dispose(); await controller.dispose() })
  await store.dispatch({ type: "composer.changed", actor: "user", draft: "queued request" }).isPersisted.promise
  const calls: string[] = []
  const queue = createPromptQueueController(ctx, async text => { calls.push(text); return false })
  rejectNextWrite = true
  queue.enqueuePrompt("queued request")
  await waitFor(() => ctx.failures.recent().some(row => row.seam === "prompt.queue"))
  await store.settled?.()
  expect(rejectedWrites).toBe(1)
  expect(calls).toEqual([])
  expect(ctx.failures.recent().filter(row => row.seam === "prompt.queue")
    .map(row => ({ message: row.message.split("\n")[0], count: row.count })))
    .toEqual([{ message: "QuotaExceededError: queue write exceeded its quota", count: 1 }])
  expect([...store.collections.messages.values()].filter(row => row.role === "user")).toEqual([])
  expect(store.session().queuedPrompts ?? []).toEqual([])
  expect(store.session().draft).toBe("queued request")
})

test("a send error retains its diagnostic even when persisting the protective pause also fails", async () => {
  const backing = memoryStorage()
  let rejectPauseWrite = false
  let rejectedWrites = 0
  const store = await createAppStore({ kind: "localStorage", storage: { ...backing, setItem(key, value) {
    if (rejectPauseWrite) {
      rejectPauseWrite = false
      rejectedWrites++
      throw new DOMException("pause write exceeded its quota", "QuotaExceededError")
    }
    backing.setItem(key, value)
  } } })
  const prompt = { id: "retained", text: "retained request", scope: promptQueueScope(store.session()) }
  await store.dispatch({ type: "prompt.queued", actor: "user", prompt }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, {})
  cleanups.push(async () => { rejectPauseWrite = false; await ctx.dispose(); await store.dispose?.() })
  const calls: string[] = []
  const queue = createPromptQueueController(ctx, text => {
    calls.push(text)
    rejectPauseWrite = true
    throw new Error("send transport failed")
  })
  queue.subscribe()
  await waitFor(() => rejectedWrites === 1)
  await store.settled?.()
  await settle()
  expect(calls).toEqual(["retained request"])
  expect(store.session().queuedPrompts).toEqual([prompt])
  expect([...store.collections.messages.values()].filter(row => row.role === "user")).toEqual([])
  expect(ctx.failures.recent().map(row => ({ seam: row.seam, message: row.message.split("\n")[0], count: row.count })))
    .toEqual([{ seam: "prompt.queue", message: "Error: send transport failed", count: 1 }])
})
