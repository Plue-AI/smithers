import { digest } from "@smthrs/core/Digest"
import { TURN_PATH, TURN_REPLAY_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { AgentTurnBatch,AgentTurnCursor,AgentTurnJournalDelivery,AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame,StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { afterEach,expect,test } from "bun:test"
import { createWebAgent } from "../native/WebAgent"
import { ENVELOPE_STORAGE_KEY, parseStorageEnvelope } from "../chain/TransactionalStorage"
import type { AgentPort } from "../runtime/AgentPort"
import type { AppController } from "./AppController"
import { appProjectionHash } from "./AppEventStream"
import { emptyAppProjection,projectAppEvent,seedAppProjection } from "./AppProjection"
import { type AppTransition } from "./AppState"
import { createAppStore,type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { httpToolItems } from "./HttpTurn"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

const token = "a".repeat(64)
const initialCursor = (runId = "turn", legId = "leg"): AgentTurnCursor => ({ version: 1, runId, legId, batch: 0, position: 0, hash: "0".repeat(64) })
const batchOf = (cursor: AgentTurnCursor, frames: AgentTurnFrame[]): AgentTurnBatch => {
  const body = { version: 1 as const, runId: cursor.runId, legId: cursor.legId, batch: cursor.batch + 1, from: cursor.position + 1, previousHash: cursor.hash, frames }
  return { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
}
const cursorOf = (batch: AgentTurnBatch): AgentTurnCursor => ({ version: 1, runId: batch.runId, legId: batch.legId, batch: batch.batch, position: batch.from + batch.frames.length - 1, hash: batch.hash })
const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
const step = (snapshot: ReturnType<typeof boot>, transition: AppTransition) => projectAppEvent(snapshot, { transition, revision: snapshot.sessions[0]!.revision + 1, createdAt: 2, persistenceMode: "localStorage" })
const started = (text = "Hello") => step(boot(), { type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text, retry: false, journal: { version: 1, legId: "leg", token } })
const accepted = (text = "Hello") => step(started(text), { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() })

test("a complete HTTP batch projects once with its cursor, shared message semantics and stable per-frame identities", () => {
  const before = accepted()
  const batch = batchOf(initialCursor(), [
    { type: "delta", runId: "turn", kind: "text", text: "Hello " }, { type: "delta", runId: "turn", kind: "text", text: "again" },
    { type: "gate.rejected", runId: "turn", link: 1, kind: "shape" },
    { type: "steering.drained", runId: "turn", link: 1, count: 1 }
  ])
  const event: AppTransition = { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch }
  const next = step(before, event)
  expect(next.messages.find(row => row.id === "message-turn-smithers")?.text).toBe("Hello again")
  expect(next.messages.filter(row => row.act !== undefined)).toHaveLength(2)
  expect(new Set(next.messages.map(row => row.id)).size).toBe(next.messages.length)
  expect(next.httpTurnLegs[0]?.cursor).toEqual(cursorOf(batch))
  expect(step(next, event)).toBe(next)
  expect(appProjectionHash(step(before, event))).toBe(appProjectionHash(next))
  expect(before.messages.some(row => row.role === "smithers")).toBe(false)
  const changed = { ...batch, frames: [{ type: "delta" as const, runId: "turn", kind: "text" as const, text: "forged" }] }
  expect(() => step(before, { ...event, batch: changed })).toThrow("integrity")
  const gap = batchOf({ ...initialCursor(), position: 10 }, [{ type: "delta", runId: "turn", kind: "text", text: "bad" }])
  expect(() => step(before, { ...event, batch: gap })).toThrow("cursor")
})

test("withheld claims, pending calls, settled results and continuation input all survive pure event replay", () => {
  let state = accepted("Send an email to Pat")
  const batch = batchOf(initialCursor(), [
    { type: "delta", runId: "turn", kind: "text", text: "I can send an email." },
    { type: "tool_call", runId: "turn", call_id: "call", name: "commands", arguments: '{"action":"list"}' },
    { type: "done", runId: "turn", reason: "tool_call" }
  ])
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })
  expect(state.messages.find(row => row.id === "message-turn-smithers")).toBeUndefined()
  expect(state.httpTurns[0]?.claimBuffer).toBe("I can send an email.")
  expect(state.httpTurnLegs[0]).toMatchObject({ status: "tool-ready", call: { callId: "call" } })
  state = step(state, { type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" })
  state = step(state, { type: "http.tool.settled", actor: "smithers", attemptId: "attempt", legId: "leg", result: "Available commands" })
  expect(httpToolItems(state.httpTurnLegs, "attempt")).toEqual([
    { type: "function_call", call_id: "call", name: "commands", arguments: '{"action":"list"}' },
    { type: "function_call_output", call_id: "call", output: "Available commands" }
  ])
  state = step(state, { type: "http.leg.prepared", actor: "system", attemptId: "attempt", journal: { version: 1, legId: "leg2", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg2", cursor: initialCursor("turn", "leg2") })
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg2",
    batch: batchOf(initialCursor("turn", "leg2"), [{ type: "done", runId: "turn", reason: "stop" }]) })
  expect(state.messages.find(row => row.id === "message-turn-smithers")?.text).toContain("I can't send or draft email yet")
  expect(state.sessions[0]?.phase).toBe("idle")
  expect(state.httpTurns[0]).toMatchObject({ status: "complete", claimBuffer: "" })
  expect(JSON.stringify(state.transitions)).not.toContain(token)
})

test("a front-door leg's act IS the answer: one act row, kept for the model, and no empty-response failure", () => {
  /*
   * The Jev front door (apps/server frontDoor.ts) answers a routed turn with
   * a tool call it minted itself, and the act line the registry renders for
   * that call is the whole answer — including when the act was refused. Its
   * continuation leg therefore carries no text, which used to fall into the
   * empty-response failure the next test still holds.
   */
  const callId = "frontdoor-b0a1"
  let state = accepted("show me my runs")
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [
      { type: "tool_call", runId: "turn", call_id: callId, name: "commands", arguments: '{"action":"execute","name":"runs.list"}' },
      { type: "done", runId: "turn", reason: "tool_call" }
    ]) })
  state = step(state, { type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" })
  state = step(state, { type: "http.tool.settled", actor: "smithers", attemptId: "attempt", legId: "leg",
    result: "failed: smithersai/smithers isn't on Smithers Cloud yet" })
  state = step(state, { type: "http.leg.prepared", actor: "system", attemptId: "attempt", journal: { version: 1, legId: "leg2", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg2", cursor: initialCursor("turn", "leg2") })
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg2",
    batch: batchOf(initialCursor("turn", "leg2"), [{ type: "done", runId: "turn", reason: "stop" }]) })

  // One row on screen, and it says what really happened.
  expect(state.messages.find(row => row.id === "message-turn-smithers")).toBeUndefined()
  const acts = state.messages.filter(row => row.act !== undefined)
  expect(acts).toHaveLength(1)
  expect(acts[0]?.text).toBe("Smithers tried /runs.list — failed: smithersai/smithers isn't on Smithers Cloud yet")
  // And that row is this turn's answer, so later turns read it (turns.ts contextMessages).
  expect(acts[0]?.answersTurn).toBe(true)
  expect(state.httpTurns[0]).toMatchObject({ status: "complete", receivedText: true })
  expect(state.sessions[0]?.phase).toBe("idle")
})

test("a tool leg the front door did not mint still refuses an answer with no text, and its act is not the answer", () => {
  let state = accepted("list my commands")
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [
      { type: "tool_call", runId: "turn", call_id: "call_1", name: "commands", arguments: '{"action":"list"}' },
      { type: "done", runId: "turn", reason: "tool_call" }
    ]) })
  state = step(state, { type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" })
  state = step(state, { type: "http.tool.settled", actor: "smithers", attemptId: "attempt", legId: "leg", result: "Available commands" })
  state = step(state, { type: "http.leg.prepared", actor: "system", attemptId: "attempt", journal: { version: 1, legId: "leg2", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg2", cursor: initialCursor("turn", "leg2") })
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg2",
    batch: batchOf(initialCursor("turn", "leg2"), [{ type: "done", runId: "turn", reason: "stop" }]) })

  expect(state.messages.find(row => row.id === "message-turn-smithers")?.text).toContain("empty response")
  expect(state.messages.filter(row => row.act !== undefined)[0]?.answersTurn).toBeUndefined()
  expect(state.httpTurns[0]?.status).toBe("failed")
})

test("card updates within one batch read preceding card facts and use the shared validated patch contract", () => {
  const before = accepted()
  const card = { id: "file", kind: "file" as const, title: "File", status: "active" as const, ordinal: 1, createdAt: 1,
    payload: { repo: "org/repo", path: "hello.txt", content: "before", truncated: false } }
  const batch = batchOf(initialCursor(), [{ type: "card", runId: "turn", card },
    { type: "card.update", runId: "turn", id: "file", patch: { kind: "file", title: "Updated", payload: { content: "after" } } }])
  const next = step(before, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })
  expect(next.cards.find(row => row.id === "file")).toMatchObject({ title: "Updated", payload: { content: "after", path: "hello.txt" } })
  expect(before.cards).toEqual([])
  expect(next.httpTurnLegs[0]?.cursor).toEqual(cursorOf(batch))
  const cancelled = step(next, { type: "conversation.reset", actor: "user" })
  expect(cancelled.httpTurns[0]?.status).toBe("cancelled")
  expect(cancelled.httpTurnLegs[0]?.status).toBe("cancelled")
  expect(step(cancelled, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })).toBe(cancelled)
})

const stores: AppStore[] = [], controllers: AppController[] = []
afterEach(async () => { for (const controller of controllers.splice(0)) await Promise.resolve(controller.dispose()).catch(() => {}); for (const store of stores.splice(0)) await Promise.resolve(store.dispose?.()).catch(() => {}) })
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(predicate()).toBe(true) }
const open = async (storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage }); stores.push(store)

  return store
}
const journalAgent = () => {
  const starts: StartAgentTurnRequest[] = [], reads: unknown[] = [], disconnected: string[] = []
  let listener: ((delivery: AgentTurnJournalDelivery) => Promise<void>) | undefined
  let reply: AgentTurnJournalReply = { status: "error", code: "not-found" }
  const agent: AgentPort = { available: true, startTurn: async request => { starts.push(request); return { status: "started" } }, cancelTurn: async () => {}, subscribe: () => () => {},
    journal: { subscribe: next => { listener = next; return () => { listener = undefined } }, read: async access => { reads.push(access); return reply }, retire: async () => {}, disconnect: id => { disconnected.push(id) } } }
  return { agent, starts, reads, disconnected, emit: async (delivery: AgentTurnJournalDelivery) => { await listener?.(delivery) }, setReply: (next: AgentTurnJournalReply) => { reply = next } }
}
const controllerFor = (store: AppStore, agent: AgentPort) => { const controller = createAppController(store, agent); controllers.push(controller); return controller }

for (const next of [undefined, "Hello", "Still composing"]) {
  test(`HTTP submission preserves and replays the next draft (${next ?? "unchanged"})`, async () => {
    const storage = memoryStorage(), store = await open(storage), remote = journalAgent()
    const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const gated: AppStore = { ...store, dispatch: transition => {
      const transaction = store.dispatch(transition)
      if (transition.type !== "command.intent.accepted") return transaction
      entered.resolve()
      return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
        ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held.promise) } : Reflect.get(target, key, receiver) })
    } }
    const controller = controllerFor(gated, remote.agent)
    controller.changeDraft("Hello")
    const pending = controller.commands.run("chat.send", "Hello")
    await entered.promise
    expect(remote.starts).toHaveLength(0)
    if (next !== undefined) {
      controller.changeDraft("")
      controller.changeDraft(next)
    }
    held.resolve()
    await pending
    await until(() => remote.starts.length === 1)
    expect(store.collections.messages.get(`message-${remote.starts[0]!.runId}-user`)?.text).toBe("Hello")
    expect(store.session().draft).toBe(next ?? "")
    await controller.dispose()
    await store.settled?.()
    expect((await store.verifyState()).valid).toBe(true)
    await store.dispose?.()
    const restored = await open(storage)
    expect(restored.session().draft).toBe(next ?? "")
    expect((await restored.verifyState()).valid).toBe(true)
  })
}

test("the active AppController persists capability and prompt before POST, then resumes a disconnected leg after a real reopen", async () => {
  const storage = memoryStorage(), store = await open(storage), remote = journalAgent()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const gated: AppStore = { ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    return transition.type !== "http.turn.started" ? transaction : new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held) } : Reflect.get(target, key, receiver) })
  } }
  const controller = controllerFor(gated, remote.agent)
  let admitted = false
  const admission = Promise.resolve(controller.send("Hello")).then(value => { admitted = value === true })
  await store.settled?.()
  expect(admitted).toBe(false)
  expect(remote.starts).toHaveLength(0)
  release(); await admission; await until(() => remote.starts.length === 1)
  expect(admitted).toBe(true)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  expect(store.collections.httpTurnLegs.get(cursor.legId)?.journal).toEqual(request.journal)
  await remote.emit({ type: "accepted", cursor })
  const first = batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "Part one. " }])
  await remote.emit({ type: "batch", batch: first, cursor: cursorOf(first) })
  await controller.dispose()
  const second = batchOf(cursorOf(first), [{ type: "delta", runId: request.runId, kind: "text", text: "Part two." }, { type: "done", runId: request.runId, reason: "stop" }])
  const restored = await open(storage), resumed = journalAgent()
  resumed.setReply({ status: "ok", after: cursorOf(first), next: cursorOf(second), head: cursorOf(second), terminal: true, more: false, batches: [second] })
  controllerFor(restored, resumed.agent)
  await until(() => restored.session().phase === "idle")
  expect(resumed.starts).toHaveLength(0)
  expect(resumed.reads).toHaveLength(1)
  expect(restored.collections.messages.get(`message-${request.runId}-smithers`)?.text).toBe("Part one. Part two.")
  expect((await restored.verifyState()).valid).toBe(true)
})

test("a failed admission clears only its own mirror while a newer ordinary HTTP turn remains usable", async () => {
  const disk = memoryStorage()
  let fail = false
  const storage = { ...disk, setItem: (key: string, value: string) => {
    if (fail && key === ENVELOPE_STORAGE_KEY && Object.keys(JSON.parse(parseStorageEnvelope(value)!.entries["smithers-mvp.app-http-turns"] ?? "{}")).length) {
      fail = false; throw Error("Admission disk failure")
    }
    disk.setItem(key, value)
  } }
  const store = await open(storage), remote = journalAgent()
  let release!: () => void, rolledBack = false
  const held = new Promise<void>(resolve => { release = resolve })
  const gated: AppStore = { ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    if (transition.type !== "http.turn.started" || transition.text !== "First") return transaction
    const promise = transaction.isPersisted.promise.catch(async error => { rolledBack = true; await held; throw error })
    return new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise } : Reflect.get(target, key, receiver) })
  } }
  const controller = controllerFor(gated, remote.agent)
  fail = true
  const first = Promise.resolve(controller.send("First"))
  await until(() => rolledBack && store.session().phase === "idle")
  expect(remote.starts).toHaveLength(0)
  expect(store.collections.httpTurns.size).toBe(0)
  expect(await controller.send("Second")).toBe(true)
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  release(); await expect(first).rejects.toThrow("Admission disk failure")
  await remote.emit({ type: "accepted", cursor })
  const done = batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "Second completed" }, { type: "done", runId: request.runId, reason: "stop" }])
  await remote.emit({ type: "batch", batch: done, cursor: cursorOf(done) })
  expect(store.session().phase).toBe("idle")
  expect(store.collections.messages.get(`message-${request.runId}-smithers`)?.text).toBe("Second completed")
  expect((await store.verifyState()).valid).toBe(true)
})

test("an accepted tool with no durable result is ambiguous after reload and never starts a model or tool again", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Do work", retry: false, journal: { version: 1, legId: "leg", token } }).isPersisted.promise
  await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() }).isPersisted.promise
  await store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch: batchOf(initialCursor(), [
    { type: "tool_call", runId: "turn", call_id: "call", name: "commands", arguments: '{"action":"execute","name":"app.reset"}' }, { type: "done", runId: "turn", reason: "tool_call" }
  ]) }).isPersisted.promise
  await store.dispatch({ type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" }).isPersisted.promise
  await store.dispose?.()
  const restored = await open(storage), remote = journalAgent()
  controllerFor(restored, remote.agent)
  await until(() => restored.session().phase === "idle")
  expect(restored.collections.httpTurns.get("attempt")?.status).toBe("ambiguous")
  expect(remote.starts).toHaveLength(0)
  expect(remote.reads).toHaveLength(0)
  expect(restored.collections.commandIntents.size).toBe(0)
  expect(restored.collections.messages.get("message-turn-smithers")?.text).toContain("its result was not saved")
})

test("the production tool door waits for the whole batch receipt, deduplicates replay and scopes an explicit retry to a new attempt", async () => {
  const store = await open(), remote = journalAgent()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let holdBatch = true
  const gated: AppStore = { ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    return transition.type !== "http.turn.batch.received" || !holdBatch ? transaction : new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held) } : Reflect.get(target, key, receiver) })
  } }
  const controller = controllerFor(gated, remote.agent)
  controller.send("Make a note")
  await until(() => remote.starts.length === 1)
  const first = remote.starts[0]!, cursor = initialCursor(first.runId, first.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const call = batchOf(cursor, [{ type: "tool_call", runId: first.runId, call_id: "same-call", name: "commands", arguments: '{"action":"execute","name":"wiki.new-note"}' },
    { type: "done", runId: first.runId, reason: "tool_call" }])
  const originalNotes = store.collections.worldDocuments.size
  const receipt = remote.emit({ type: "batch", batch: call, cursor: cursorOf(call) })
  await store.settled?.()
  expect(store.collections.commandIntents.size).toBe(0)
  expect(store.collections.worldDocuments.size).toBe(originalNotes)
  expect(remote.starts).toHaveLength(1)
  holdBatch = false; release(); await receipt
  await until(() => remote.starts.length === 2)
  expect(store.collections.worldDocuments.size).toBe(originalNotes + 1)
  expect([...store.collections.commandIntents.values()].filter(row => row.name === "wiki.new-note" && row.status === "settled")).toHaveLength(1)
  await remote.emit({ type: "batch", batch: call, cursor: cursorOf(call) })
  expect(store.collections.worldDocuments.size).toBe(originalNotes + 1)
  const continuation = remote.starts[1]!, nextCursor = initialCursor(first.runId, continuation.journal!.legId)
  expect(continuation.messages.filter(item => "type" in item && item.type === "function_call_output")).toHaveLength(1)
  await remote.emit({ type: "accepted", cursor: nextCursor })
  const done = batchOf(nextCursor, [{ type: "delta", runId: first.runId, kind: "text", text: "Made a note." }, { type: "done", runId: first.runId, reason: "stop" }])
  await remote.emit({ type: "batch", batch: done, cursor: cursorOf(done) })
  await controller.commands.run("chat.retry")
  await until(() => remote.starts.length === 3)
  const retry = remote.starts[2]!, retryCursor = initialCursor(first.runId, retry.journal!.legId)
  expect(retry.runId).toBe(first.runId)
  expect(retry.journal?.legId).not.toBe(first.journal?.legId)
  await remote.emit({ type: "accepted", cursor: retryCursor })
  const again = batchOf(retryCursor, call.frames)
  await remote.emit({ type: "batch", batch: again, cursor: cursorOf(again) })
  await until(() => remote.starts.length === 4)
  expect(store.collections.worldDocuments.size).toBe(originalNotes + 2)
  expect([...store.collections.commandIntents.values()].filter(row => row.name === "wiki.new-note" && row.status === "settled")).toHaveLength(2)
})

test("reload drains more than one thousand missed frames across all bounded pages without another inference", async () => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Hello", retry: false, journal: { version: 1, legId: "leg", token } }).isPersisted.promise
  await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() }).isPersisted.promise
  await store.dispose?.()
  const batches: AgentTurnBatch[] = []
  let cursor = initialCursor()
  for (let page = 0; page < 5; page++) {
    const frames: AgentTurnFrame[] = Array.from({ length: 201 }, () => ({ type: "delta", runId: "turn", kind: "text", text: "x" }))
    if (page === 4) frames.push({ type: "done", runId: "turn", reason: "stop" })
    const batch = batchOf(cursor, frames); batches.push(batch); cursor = cursorOf(batch)
  }
  const restored = await open(storage), remote = journalAgent()
  const journal = remote.agent.journal!
  let readCount = 0
  const agent: AgentPort = { ...remote.agent, journal: { ...journal, read: async access => {
    readCount++
    const next = batches[access.after?.batch ?? 0]!
    return { status: "ok", after: access.after ?? initialCursor(), next: cursorOf(next), head: cursor,
      terminal: true, more: next.batch < batches.length, batches: [next] }
  } } }
  controllerFor(restored, agent)
  await until(() => restored.session().phase === "idle")
  expect(readCount).toBe(5)
  expect(remote.starts).toHaveLength(0)
  expect(restored.collections.messages.get("message-turn-smithers")?.text).toBe("x".repeat(1005))
  expect(restored.collections.httpTurnLegs.get("leg")?.cursor).toEqual(cursor)
  expect((await restored.verifyState()).valid).toBe(true)
})

test("a failed real batch commit cannot start a tool or continuation and reload still owns the preceding cursor", async () => {
  const disk = memoryStorage()
  let fail = false
  const storage = { ...disk, setItem: (key: string, value: string) => { if (fail) throw new Error("disk unavailable"); disk.setItem(key, value) } }
  const store = await open(storage), remote = journalAgent(), controller = controllerFor(store, remote.agent)
  controller.send("Make a note")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const notes = store.collections.worldDocuments.size
  const batch = batchOf(cursor, [{ type: "tool_call", runId: request.runId, call_id: "call", name: "commands", arguments: '{"action":"execute","name":"wiki.new-note"}' },
    { type: "done", runId: request.runId, reason: "tool_call" }])
  fail = true
  await expect(remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })).rejects.toThrow()
  expect(remote.starts).toHaveLength(1)
  expect(store.collections.worldDocuments.size).toBe(notes)
  expect(store.collections.commandIntents.size).toBe(0)
  fail = false
  await Promise.resolve(controller.dispose()).catch(() => {})
  const restored = await open(storage)
  expect(restored.collections.httpTurnLegs.get(cursor.legId)?.cursor).toEqual(cursor)
  expect(restored.collections.httpTurnLegs.get(cursor.legId)?.status).toBe("streaming")
  expect((await restored.verifyState()).valid).toBe(true)
})

test("account replacement during a held batch receipt prevents old tools, cards and text entering the new account", async () => {
  const store = await open(), remote = journalAgent()
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const gated: AppStore = { ...store, dispatch: transition => {
    const transaction = store.dispatch(transition)
    return transition.type !== "http.turn.batch.received" ? transaction : new Proxy(transaction, { get: (target, key, receiver) => key === "isPersisted"
      ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => held) } : Reflect.get(target, key, receiver) })
  } }
  const controller = controllerFor(gated, remote.agent)
  controller.send("Alice private prompt")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const batch = batchOf(cursor, [{ type: "tool_call", runId: request.runId, call_id: "call", name: "commands", arguments: '{"action":"execute","name":"wiki.new-note"}' },
    { type: "done", runId: request.runId, reason: "tool_call" }])
  const receipt = remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })
  await store.settled?.()
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", admin: false, scopesPlain: null }).isPersisted.promise
  release(); await receipt
  const before = await store.eventHistory()
  await remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })
  expect(await store.eventHistory()).toEqual(before)
  expect(store.collections.httpTurns.size).toBe(0)
  expect(store.collections.httpTurnLegs.size).toBe(0)
  expect(store.collections.commandIntents.size).toBe(0)
  expect(remote.starts).toHaveLength(1)
  expect(JSON.stringify([...store.collections.messages.values()])).not.toContain("Alice")
  expect((await store.verifyState()).valid).toBe(true)
})

test("the production agent seat, AppController and actual WebAgent share the durable journal delivery path", async () => {
  const store = await open(), requests: string[] = []
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    requests.push(String(url))
    const request = JSON.parse(String(init?.body)) as StartAgentTurnRequest
    expect(store.collections.httpTurnLegs.get(request.journal!.legId)?.journal).toEqual(request.journal)
    const cursor = initialCursor(request.runId, request.journal!.legId)
    const batch = batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "A committed answer." }, { type: "done", runId: request.runId, reason: "stop" }])
    return new Response([JSON.stringify({ type: "accepted", cursor }), JSON.stringify({ type: "batch", batch, cursor: cursorOf(batch) })].join("\n"), {
      headers: { "x-smithers-turn-journal": "1", "content-type": "application/x-ndjson" }
    })
  } })
  const controller = controllerFor(store, agent)
  controller.send("Hello")
  await until(() => requests.length === 1 && store.session().phase === "idle")
  expect(requests).toEqual([TURN_PATH])
  expect([...store.collections.messages.values()].some(row => row.text === "A committed answer.")).toBe(true)
  expect([...store.collections.httpTurns.values()][0]?.status).toBe("complete")
  expect((await store.verifyState()).valid).toBe(true)
})

test.each(["lost POST response", "reload"])("a %s recovery leaves the pending HTTP continuation active through its not-found poll", async recovery => {
  const storage = memoryStorage(), store = await open(storage)
  if (recovery === "reload") {
    await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "List commands", retry: false,
      journal: { version: 1, legId: "leg", token } }).isPersisted.promise
    await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() }).isPersisted.promise
    await store.dispose?.()
  }
  const current = recovery === "reload" ? await open(storage) : store
  const posts: StartAgentTurnRequest[] = [], reads: string[] = []
  let resolveContinuation!: (response: Response) => void
  const continuation = new Promise<Response>(resolve => { resolveContinuation = resolve })
  const agent = createWebAgent({ fetchImpl: async (url, init) => {
    if (url === TURN_PATH) {
      const request = JSON.parse(String(init?.body)) as StartAgentTurnRequest
      posts.push(request)
      if (posts.length === 1 && recovery === "lost POST response") throw new Error("Response lost after acceptance")
      return continuation
    }
    expect(url).toBe(TURN_REPLAY_PATH)
    const access = JSON.parse(String(init?.body)) as { journal: { legId: string } }
    reads.push(access.journal.legId)
    const firstLeg = recovery === "reload" ? "leg" : posts[0]!.journal!.legId
    if (access.journal.legId !== firstLeg) return Response.json({ status: "error", code: "not-found" }, { status: 404 })
    const runId = current.collections.httpTurns.values().next().value!.turnId
    const cursor = initialCursor(runId, firstLeg)
    const batch = batchOf(cursor, [
      { type: "tool_call", runId, call_id: "call", name: "commands", arguments: '{"action":"list"}' },
      { type: "done", runId, reason: "tool_call" }
    ])
    return Response.json({ status: "ok", after: cursor, next: cursorOf(batch), head: cursorOf(batch), terminal: true, more: false, batches: [batch] })
  } })
  const controller = controllerFor(current, agent)
  if (recovery === "lost POST response") controller.send("List commands")
  const waitForPoll = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(predicate()).toBe(true)
  }
  await waitForPoll(() => posts.length === (recovery === "reload" ? 1 : 2))
  const next = posts.at(-1)!, nextLeg = next.journal!.legId
  await waitForPoll(() => reads.includes(nextLeg))
  expect(current.collections.httpTurns.values().next().value?.status).toBe("active")
  expect(current.collections.httpTurnLegs.get(nextLeg)?.status).toBe("prepared")
  const cursor = initialCursor(next.runId, nextLeg)
  const done = batchOf(cursor, [{ type: "delta", runId: next.runId, kind: "text", text: "Here are the commands." },
    { type: "done", runId: next.runId, reason: "stop" }])
  resolveContinuation(new Response([JSON.stringify({ type: "accepted", cursor }), JSON.stringify({ type: "batch", batch: done, cursor: cursorOf(done) })].join("\n"),
    { headers: { "x-smithers-turn-journal": "1", "content-type": "application/x-ndjson" } }))
  await waitForPoll(() => current.session().phase === "idle")
  expect(current.collections.httpTurns.values().next().value?.status).toBe("complete")
  expect(current.collections.messages.get(`message-${next.runId}-smithers`)?.text).toBe("Here are the commands.")
  expect((await current.verifyState()).valid).toBe(true)
  await controller.dispose()
})

test("a corrupt received batch preserves the applied prefix and settles honestly without replaying its contents", async () => {
  const store = await open(), remote = journalAgent(), controller = controllerFor(store, remote.agent)
  controller.send("Hello")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const batch = { ...batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "forged output" }]), hash: "f".repeat(64) }
  await remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })
  expect(store.session().phase).toBe("idle")
  expect(store.collections.httpTurnLegs.get(cursor.legId)?.cursor).toEqual(cursor)
  expect(store.collections.httpTurnLegs.get(cursor.legId)?.status).toBe("ambiguous")
  expect(JSON.stringify([...store.collections.messages.values()])).not.toContain("forged output")
  expect(store.collections.messages.get(`message-${request.runId}-smithers`)?.text).toContain("failed an integrity check")
  expect(remote.starts).toHaveLength(1)
  expect((await store.verifyState()).valid).toBe(true)
})

test("HTTP Stop cancellation settles before an explicit retry can POST the same transcript identity", async () => {
  const store = await open(), remote = journalAgent()
  let release!: () => void, cancellations = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const controller = controllerFor(store, { ...remote.agent, cancelTurn: async () => { cancellations++; await held } })
  controller.send("Hello")
  await until(() => remote.starts.length === 1)
  await controller.commands.run("chat.stop")
  await until(() => cancellations === 1)
  await controller.commands.run("chat.retry")
  await store.settled?.()
  expect(remote.starts).toHaveLength(1)
  expect(store.collections.httpTurns.size).toBe(2)
  release()
  await until(() => remote.starts.length === 2)
  expect(remote.starts[1]?.runId).toBe(remote.starts[0]?.runId)
  expect(remote.starts[1]?.journal?.legId).not.toBe(remote.starts[0]?.journal?.legId)
})

test.each([
  { name: "retired", status: 410, body: { status: "error", code: "request_invalid", message: "Retired" } },
  { name: "cursor refusal", status: 409, body: { status: "error", code: "request_invalid", message: "Wrong cursor" } },
  { name: "corrupt prefix", status: 500, body: { status: "error", code: "corrupt" } },
  { name: "invalid request", status: 400, body: { status: "error", code: "request_invalid" } },
  { name: "malformed response", status: 200, body: { unexpected: true } },
  { name: "wrong replay boundary", status: 200, body: { status: "ok", after: initialCursor("other"), next: initialCursor("other"), head: initialCursor("other"), terminal: false, more: false, batches: [] } }
])("recovery settles $name as ambiguous without another inference or changing the saved prefix", async ({ status, body }) => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Hello", retry: false, journal: { version: 1, legId: "leg", token } }).isPersisted.promise
  await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() }).isPersisted.promise
  const restored = await open(storage), urls: string[] = []
  controllerFor(restored, createWebAgent({ fetchImpl: async url => { urls.push(String(url)); return Response.json(body, { status }) } }))
  await until(() => restored.session().phase === "idle")
  expect(urls).toHaveLength(1)
  expect(urls).not.toContain(TURN_PATH)
  expect(restored.collections.httpTurns.get("attempt")?.status).toBe("ambiguous")
  expect(restored.collections.httpTurnLegs.get("leg")?.cursor).toEqual(initialCursor())
  expect((await restored.verifyState()).valid).toBe(true)
})

test.each(["network", "503", "storage_failed"])("recovery keeps an accepted turn unresolved during transient %s failure", async failure => {
  const storage = memoryStorage(), store = await open(storage)
  await store.dispatch({ type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Hello", retry: false, journal: { version: 1, legId: "leg", token } }).isPersisted.promise
  await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() }).isPersisted.promise
  const restored = await open(storage), urls: string[] = []
  const controller = controllerFor(restored, createWebAgent({ fetchImpl: async url => {
    urls.push(String(url))
    if (failure === "network") throw new Error("Offline")
    return Response.json(failure === "503" ? { message: "Unavailable" } : { status: "error", code: "storage_failed" }, { status: 503 })
  } }))
  await until(() => urls.length === 1)
  await controller.dispose()
  expect(restored.collections.httpTurns.get("attempt")?.status).toBe("active")
  expect(restored.session().phase).toBe("responding")
  expect(urls).not.toContain(TURN_PATH)
})

test("a one-shot failed batch commit settles the live turn as ambiguous and Chat accepts the next send without a reload", async () => {
  const disk = memoryStorage()
  let fail = false
  const storage = { ...disk, setItem: (key: string, value: string) => { if (fail) { fail = false; throw new Error("disk unavailable") } disk.setItem(key, value) } }
  const store = await open(storage), remote = journalAgent(), controller = controllerFor(store, remote.agent)
  controller.send("Hello")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const batch = batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "Unsaved" }])
  fail = true
  await expect(remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })).rejects.toThrow("disk unavailable")
  await until(() => store.session().phase === "idle")
  expect([...store.collections.httpTurns.values()][0]?.status).toBe("ambiguous")
  expect(store.collections.messages.get(`message-${request.runId}-smithers`)?.text).toContain("could not be saved")
  expect(remote.disconnected).toContain(request.runId)
  expect(await controller.send("Again")).toBe(true)
  await until(() => remote.starts.length === 2)
  const next = remote.starts[1]!, nextCursor = initialCursor(next.runId, next.journal!.legId)
  await remote.emit({ type: "accepted", cursor: nextCursor })
  const done = batchOf(nextCursor, [{ type: "delta", runId: next.runId, kind: "text", text: "Saved answer" }, { type: "done", runId: next.runId, reason: "stop" }])
  await remote.emit({ type: "batch", batch: done, cursor: cursorOf(done) })
  expect(store.session().phase).toBe("idle")
  expect(store.collections.messages.get(`message-${next.runId}-smithers`)?.text).toBe("Saved answer")
  expect((await store.verifyState()).valid).toBe(true)
})

test("Stop still settles a turn whose batch and ambiguity writes both failed, once storage recovers", async () => {
  const disk = memoryStorage()
  let fail = false
  const storage = { ...disk, setItem: (key: string, value: string) => { if (fail) throw new Error("disk unavailable"); disk.setItem(key, value) } }
  const store = await open(storage), remote = journalAgent(), controller = controllerFor(store, remote.agent)
  controller.send("Hello")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await remote.emit({ type: "accepted", cursor })
  const batch = batchOf(cursor, [{ type: "delta", runId: request.runId, kind: "text", text: "Unsaved" }])
  fail = true
  await expect(remote.emit({ type: "batch", batch, cursor: cursorOf(batch) })).rejects.toThrow("disk unavailable")
  await store.settled?.()
  expect(store.session().phase).toBe("responding")
  fail = false
  await controller.commands.run("chat.stop")
  await until(() => store.session().phase === "idle")
  expect([...store.collections.httpTurns.values()][0]?.status).toBe("cancelled")
  expect(await controller.send("Again")).toBe(true)
  await until(() => remote.starts.length === 2)
  expect((await store.verifyState()).valid).toBe(true)
})

test("a malformed acceptance cursor settles the live turn as ambiguous instead of wedging Chat", async () => {
  const store = await open(), remote = journalAgent(), controller = controllerFor(store, remote.agent)
  controller.send("Hello")
  await until(() => remote.starts.length === 1)
  const request = remote.starts[0]!, cursor = initialCursor(request.runId, request.journal!.legId)
  await expect(remote.emit({ type: "accepted", cursor: { ...cursor, batch: 3 } })).rejects.toThrow("acceptance cursor")
  await until(() => store.session().phase === "idle")
  expect([...store.collections.httpTurns.values()][0]?.status).toBe("ambiguous")
  expect(await controller.send("Again")).toBe(true)
  await until(() => remote.starts.length === 2)
})
