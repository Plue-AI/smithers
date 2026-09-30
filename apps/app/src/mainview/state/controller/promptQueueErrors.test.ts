import { afterEach, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { promptQueueScope } from "../PromptQueue"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createPromptQueueController } from "./promptQueue"
import type { TurnController } from "./turns"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = async (storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  const ctx = createControllerContext(store, unavailableAgent, {})
  cleanups.push(async () => { await ctx.dispose(); await store.dispose?.() })
  const persisted = async () => {
    if (store.settled === undefined) throw new Error("real store must expose persistence settlement")
    await store.settled()
  }
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    admin: false, scopesPlain: null }).isPersisted.promise
  const scope = promptQueueScope(store.session())
  const prompt = { id: "queued-one", text: "first queued request", scope }
  await store.dispatch({ type: "prompt.queued", actor: "user", prompt }).isPersisted.promise
  return { store, ctx, prompt, scope, persisted }
}

for (const failure of [new Error("queue gateway unavailable"), "queue gateway unavailable"]) {
  test(`a ${failure instanceof Error ? "typed" : "string"} send failure retains the prompt until explicit resume`, async () => {
    const f = await fixture()
    const calls: Array<{ text: string; id: string | undefined; owner: string | null | undefined }> = []
    let recovered = false
    const send: TurnController["send"] = async (text, admission) => {
      calls.push({ text, id: admission?.turnId, owner: admission?.owner })
      if (!recovered) throw failure
      if (admission === undefined) throw new Error("queued send must carry its admission")
      await f.store.dispatch({ type: "message.submitted", actor: "user", turnId: admission.turnId, text }).isPersisted.promise
      return true
    }
    const queue = createPromptQueueController(f.ctx, send)
    queue.subscribe()
    await waitFor(() => f.store.session().promptQueuePaused === true, 5_000)
    await f.persisted()
    expect(calls).toEqual([{ text: "first queued request", id: "queued-one", owner: "alice" }])
    expect(f.store.session().queuedPrompts).toEqual([f.prompt])
    expect(f.ctx.failures.recent().map(({ seam, fault, lost, message, count }) =>
      ({ seam, fault, lost, message: message.split("\n")[0], count })))
      .toEqual([{ seam: "prompt.queue", fault: "infra", lost: "app-bug",
        message: failure instanceof Error ? "Error: queue gateway unavailable" : "queue gateway unavailable", count: 1 }])
    expect([...f.store.collections.messages.values()].filter(row => row.role === "user")).toEqual([])
    await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "unrelated draft" }).isPersisted.promise
    await settle()
    expect(calls).toHaveLength(1)
    recovered = true
    queue.resumePromptQueue()
    await waitFor(() => f.store.session().queuedPrompts?.length === 0, 5_000)
    await f.persisted()
    expect(calls).toEqual([
      { text: "first queued request", id: "queued-one", owner: "alice" },
      { text: "first queued request", id: "queued-one", owner: "alice" }
    ])
    expect([...f.store.collections.messages.values()].filter(row => row.role === "user").map(row => row.text))
      .toEqual(["first queued request"])
    expect(f.store.session().promptQueuePaused).toBe(false)
  })
}

test("a refused send pauses the retained queue without manufacturing a transport failure", async () => {
  const f = await fixture()
  const calls: Array<string> = []
  const queue = createPromptQueueController(f.ctx, async text => { calls.push(text); return false })
  queue.subscribe()
  await waitFor(() => f.store.session().promptQueuePaused === true, 5_000)
  await f.persisted()
  expect(calls).toEqual(["first queued request"])
  expect(f.store.session().queuedPrompts).toEqual([f.prompt])
  expect(f.ctx.failures.recent()).toEqual([])
  queue.resumePromptQueue()
  await waitFor(() => calls.length === 2 && f.store.session().promptQueuePaused === true, 5_000)
  await f.persisted()
  expect(f.store.session().queuedPrompts).toEqual([f.prompt])
  expect(f.ctx.failures.recent()).toEqual([])
})

test("disposal prevents a late rejected send from changing the queued state", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<boolean>()
  let admitted = false
  const queue = createPromptQueueController(f.ctx, () => { admitted = true; return held.promise })
  queue.subscribe()
  await waitFor(() => admitted, 5_000)
  await f.ctx.dispose()
  held.reject(new Error("late gateway failure"))
  await waitFor(() => f.ctx.failures.recent().length === 1, 5_000)
  await f.persisted()
  expect(f.ctx.failures.recent().map(({ seam, fault, lost, message, count }) =>
    ({ seam, fault, lost, message: message.split("\n")[0], count })))
    .toEqual([{ seam: "prompt.queue", fault: "infra", lost: "app-bug", message: "Error: late gateway failure", count: 1 }])
  expect(f.store.session().queuedPrompts).toEqual([f.prompt])
  expect(f.store.session().promptQueuePaused).not.toBe(true)
  expect([...f.store.collections.messages.values()].filter(row => row.role === "user")).toEqual([])
})

test("pending admission deduplicates repeated resume and state changes without blocking draft edits", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<boolean>()
  const calls: Array<string> = []
  const queue = createPromptQueueController(f.ctx, text => { calls.push(text); return held.promise })
  queue.subscribe()
  await waitFor(() => calls.length === 1, 5_000)
  const next = { id: "queued-two", text: "second queued request", scope: f.scope }
  await f.store.dispatch({ type: "prompt.queued", actor: "user", prompt: next }).isPersisted.promise
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "still editing" }).isPersisted.promise
  queue.resumePromptQueue()
  queue.resumePromptQueue()
  await f.persisted()
  await settle()
  expect(calls).toEqual(["first queued request"])
  expect(f.store.session().draft).toBe("still editing")
  expect(f.store.session().queuedPrompts).toEqual([f.prompt, next])
  held.resolve(false)
  await waitFor(() => f.store.session().promptQueuePaused === true, 5_000)
  await f.persisted()
  expect(calls).toEqual(["first queued request"])
  expect(f.store.session().queuedPrompts).toEqual([f.prompt, next])
  expect(f.store.session().draft).toBe("still editing")
})

test("a prompt removed during pending admission is not paused again by its late refusal", async () => {
  const f = await fixture()
  const held = Promise.withResolvers<boolean>()
  let admitted = false
  const queue = createPromptQueueController(f.ctx, () => { admitted = true; return held.promise })
  queue.subscribe()
  await waitFor(() => admitted, 5_000)
  queue.removeQueuedPrompt(f.prompt.id)
  await f.persisted()
  held.resolve(false)
  await settle()
  await f.persisted()
  expect(f.store.session().queuedPrompts).toEqual([])
  expect(f.store.session().promptQueuePaused).not.toBe(true)
  expect(f.ctx.failures.recent()).toEqual([])
  expect([...f.store.collections.messages.values()].filter(row => row.role === "user")).toEqual([])
})

test("restoring prompts prepends FIFO text while leaving another scope and the existing draft intact", async () => {
  const f = await fixture()
  await f.store.dispatch({ type: "prompt.queue.paused", actor: "user", paused: true }).isPersisted.promise
  const next = { id: "queued-two", text: "second queued request", scope: f.scope }
  const elsewhere = { id: "queued-elsewhere", text: "private other conversation", scope: `${f.scope}-elsewhere` }
  for (const prompt of [next, elsewhere]) await f.store.dispatch({ type: "prompt.queued", actor: "user", prompt }).isPersisted.promise
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "existing draft" }).isPersisted.promise
  const calls: Array<string> = []
  const queue = createPromptQueueController(f.ctx, async text => { calls.push(text); return false })
  queue.subscribe()
  queue.restoreQueuedPrompts()
  await f.persisted()
  expect(f.store.session().draft).toBe("first queued request\n\nsecond queued request\n\nexisting draft")
  expect(f.store.session().queuedPrompts).toEqual([elsewhere])
  expect(f.store.session().promptQueuePaused).toBe(true)
  expect(calls).toEqual([])
})

for (const reason of ["QuotaExceededError", "SecurityError"] as const) {
  test(`a ${reason} while persisting Resume keeps queued work paused and retryable`, async () => {
    const backing = memoryStorage()
    let blocked = false
    let failedWrites = 0
    const storage: ReturnType<typeof memoryStorage> = {
      ...backing,
      setItem: (key, value) => {
        if (blocked) {
          failedWrites++
          throw new DOMException("test storage refused the write", reason)
        }
        backing.setItem(key, value)
      }
    }
    const f = await fixture(storage)
    await f.store.dispatch({ type: "prompt.queue.paused", actor: "user", paused: true }).isPersisted.promise
    const calls: Array<string> = []
    const queue = createPromptQueueController(f.ctx, async text => { calls.push(text); return false })
    queue.subscribe()
    try {
      blocked = true
      queue.resumePromptQueue()
      await waitFor(() => f.ctx.failures.recent().some(failure => failure.seam === "prompt.queue"), 5_000)
      expect(failedWrites).toBeGreaterThan(0)
      expect(f.store.session().promptQueuePaused).toBe(true)
      expect(f.store.session().queuedPrompts).toEqual([f.prompt])
      expect(calls).toEqual([])
      blocked = false
      queue.resumePromptQueue()
      await waitFor(() => calls.length === 1 && f.store.session().promptQueuePaused === true, 5_000)
      await f.persisted()
      expect(calls).toEqual(["first queued request"])
      expect(f.store.session().queuedPrompts).toEqual([f.prompt])
    } finally {
      blocked = false
    }
  })
}
