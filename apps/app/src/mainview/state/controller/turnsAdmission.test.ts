import { afterEach, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../../runtime/AgentPort"
import { ENVELOPE_STORAGE_KEY } from "../../chain/TransactionalStorage"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"
import { memoryStorage, settle } from "../TestFixtures"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = async (receipt?: ReturnType<typeof Promise.withResolvers<void>>) => {
  const storage = memoryStorage()
  const original = await createAppStore({ kind: "localStorage", storage })
  await original.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  const receiptEntered = Promise.withResolvers<void>()
  const store: AppStore = receipt === undefined ? original : { ...original, dispatch: transition => {
    const transaction = original.dispatch(transition)
    if (transition.type !== "message.submitted") return transaction
    // The Map transaction can already be committed: this delays/rejects its
    // public completion receipt, proving admission ordering, not SQL atomicity.
    return new Proxy(transaction, { get: (target, key, receiver) => {
      if (key !== "isPersisted") return Reflect.get(target, key, receiver)
      return { ...target.isPersisted, promise: target.isPersisted.promise.then(async () => {
        receiptEntered.resolve()
        await receipt.promise
      }) }
    } })
  } }
  const starts: StartAgentTurnRequest[] = []
  const steers: Array<{ id: string; text: string }> = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { starts.push(request); return { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    steer: async (id, text) => { steers.push({ id, text }); return false }
  }
  const controller = createAppController(store, agent, {
    fetchImpl: async () => { throw new Error("unexpected HTTP request in turn unit") }
  })
  cleanups.push(async () => { receipt?.resolve(); await controller.dispose() })
  return { original, storage, controller, starts, steers, listeners, receiptEntered }
}

test("empty input and foreign-owner queue admission leave both host and event history untouched", async () => {
  const f = await fixture()
  const before = await f.original.eventHistory()
  expect(f.controller.send(" \n\t ")).toBeUndefined()
  expect(f.controller.send("private queued prompt", { turnId: "foreign", owner: "bob" })).toBeUndefined()
  await settle()
  expect(f.starts).toEqual([])
  expect(f.steers).toEqual([])
  expect(await f.original.eventHistory()).toEqual(before)
})

test("queued admission during an active turn cannot become steering input", async () => {
  const f = await fixture()
  expect(await f.controller.send("first request")).toBe(true)
  expect(f.starts).toHaveLength(1)
  const first = f.starts[0]!.runId
  const before = await f.original.eventHistory()
  expect(f.controller.send("queued request", { turnId: "queued", owner: "alice" })).toBeUndefined()
  await settle()
  expect(f.starts).toHaveLength(1)
  expect(f.steers).toEqual([])
  expect(await f.original.eventHistory()).toEqual(before)
  f.controller.send("ordinary steering request")
  await settle()
  expect(f.steers).toEqual([{ id: first, text: "ordinary steering request" }])
  expect(f.starts).toHaveLength(1)
  expect([...f.original.collections.messages.values()].filter(row => row.role === "user").map(row => row.text))
    .toEqual(["first request"])
})

for (const disposed of [false, true]) {
  test(`queued admission waits for its receipt and cannot launch after disposal (${disposed})`, async () => {
    const receipt = Promise.withResolvers<void>()
    const f = await fixture(receipt)
    try {
      const pending = Promise.resolve(f.controller.send("durable queued request", { turnId: "queued", owner: "alice" }))
      await f.receiptEntered.promise
      expect(f.starts).toEqual([])
      if (disposed) await f.controller.dispose()
      receipt.resolve()
      expect(await pending).toBe(true)
      await settle()
      expect(f.starts.map(request => {
        const last = request.messages.at(-1)
        return { id: request.runId, text: last && "content" in last ? last.content : undefined }
      }))
        .toEqual(disposed ? [] : [{ id: "queued", text: "durable queued request" }])
      if (disposed) expect(f.listeners.size).toBe(0)
    } finally { receipt.resolve() }
  })
}

test("a failed queued receipt propagates its error without dispatching a host request", async () => {
  const receipt = Promise.withResolvers<void>()
  const f = await fixture(receipt)
  const failure = new Error("queued admission persistence rejected")
  const pending = Promise.resolve(f.controller.send("unsaved queued request", { turnId: "queued", owner: "alice" }))
  const observed = pending.catch(error => error)
  await f.receiptEntered.promise
  expect(f.starts).toEqual([])
  receipt.reject(failure)
  expect(await observed).toBe(failure)
  await settle()
  expect(f.starts).toEqual([])
})

test("a disposed controller cannot accept new input or acquire another host subscription", async () => {
  const f = await fixture()
  expect(f.listeners.size).toBe(1)
  await f.controller.dispose()
  const before = f.storage.getItem(ENVELOPE_STORAGE_KEY)
  expect(f.controller.send("too late", { turnId: "late", owner: "alice" })).toBeUndefined()
  await settle()
  expect(f.storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(before)
  expect(f.starts).toEqual([])
  expect(f.steers).toEqual([])
  expect(f.listeners.size).toBe(0)
})
