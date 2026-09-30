import { afterEach, expect, test } from "bun:test"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { promptQueueScope } from "../PromptQueue"
import { memoryStorage, settle, unavailableAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createPromptQueueController } from "./promptQueue"
import type { TurnController } from "./turns"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = async (send: TurnController["send"]) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent, {
    fetchImpl: async () => { throw new Error("unexpected HTTP request in queue unit") }
  })
  const ctx = createControllerContext(store, unavailableAgent, {})
  // Use the actual catalog; the separately injected turn boundary records
  // queue admission without dispatching a model or a provider request.
  ctx.commands = controller.commands
  cleanups.push(async () => { await ctx.dispose(); await controller.dispose() })
  await store.dispatch({ type: "prompt.queue.paused", actor: "user", paused: true }).isPersisted.promise
  const settled = async () => { await store.settled?.(); await settle() }
  return { store, queue: createPromptQueueController(ctx, send), settled }
}

for (const capturedCurrent of [true, false]) {
  test(`enqueue preserves a captured draft only when its owner is stale (${capturedCurrent})`, async () => {
    const calls: string[] = []
    const f = await fixture(async text => { calls.push(text); return false })
    await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "queued request" }).isPersisted.promise
    f.queue.enqueuePrompt("queued request", () => capturedCurrent)
    await f.settled()
    const prompts = f.store.session().queuedPrompts ?? []
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ text: "queued request", scope: promptQueueScope(f.store.session()) })
    expect(prompts[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(f.store.session().draft).toBe(capturedCurrent ? "" : "queued request")
    expect(calls).toEqual([])
  })
}

test("enqueue's default draft capture clears its own matching draft and preserves unrelated edits", async () => {
  const f = await fixture(async () => false)
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "first" }).isPersisted.promise
  f.queue.enqueuePrompt("first")
  await f.settled()
  expect(f.store.session().draft).toBe("")
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "unrelated edit" }).isPersisted.promise
  f.queue.enqueuePrompt("second")
  await f.settled()
  expect(f.store.session().draft).toBe("unrelated edit")
  expect(f.store.session().queuedPrompts?.map(prompt => prompt.text)).toEqual(["first", "second"])
})

test("an unknown slash command takes its immediate refusal door instead of becoming queued model prose", async () => {
  const calls: Array<{ text: string; admission: Parameters<TurnController["send"]>[1]; captured: Parameters<TurnController["send"]>[2] }> = []
  const f = await fixture(async (text, admission, captured) => { calls.push({ text, admission, captured }); return false })
  const captured = () => false
  f.queue.enqueuePrompt("/not-a-registered-command", captured)
  expect(calls).toEqual([{ text: "/not-a-registered-command", admission: undefined, captured }])
  await f.settled()
  expect(f.store.session().queuedPrompts ?? []).toEqual([])
})

test("editing a current queued prompt restores its text but cannot remove a foreign conversation's prompt", async () => {
  const f = await fixture(async () => false)
  const scope = promptQueueScope(f.store.session())
  const current = { id: "current", text: "queued request", scope }
  const foreign = { id: "foreign", text: "private other conversation", scope: `${scope}-elsewhere` }
  for (const prompt of [current, foreign]) await f.store.dispatch({ type: "prompt.queued", actor: "user", prompt }).isPersisted.promise
  await f.store.dispatch({ type: "composer.changed", actor: "user", draft: "existing draft" }).isPersisted.promise
  f.queue.removeQueuedPrompt("foreign", true)
  f.queue.removeQueuedPrompt("missing", true)
  await f.settled()
  expect(f.store.session().queuedPrompts).toEqual([current, foreign])
  expect(f.store.session().draft).toBe("existing draft")
  f.queue.removeQueuedPrompt("current", true)
  await f.settled()
  expect(f.store.session().queuedPrompts).toEqual([foreign])
  expect(f.store.session().draft).toBe("queued request\n\nexisting draft")
  expect(f.store.session().paletteOpen).toBe(true)
})
