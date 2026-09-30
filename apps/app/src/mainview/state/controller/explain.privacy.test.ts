import { afterEach, describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnJournalDelivery, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentPort } from "../../runtime/AgentPort"
import { scopedControllers } from "../ControllerTestScope"
import { createAppStore } from "../AppStore"
import { memoryStorage, settled } from "../TestFixtures"

const createAppController = scopedControllers()
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const fixture = async (options: {
  start?: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  journal?: boolean
  read?: () => Promise<AgentTurnJournalReply>
  holdAnswered?: Promise<void>
  trackQueue?: boolean
  cancel?: (runId: string) => Promise<void>
  retire?: (runId: string) => Promise<void>
} = {}) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice",
    provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
  const launches: StartAgentTurnRequest[] = []
  const cancellations: string[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const deliveries = new Set<(delivery: AgentTurnJournalDelivery) => Promise<void>>()
  const disconnects: string[] = []
  const retirements: string[] = []
  const diagnostics: unknown[] = []
  let erasuresQueued = 0
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { launches.push(request); return options.start?.(request) ?? { status: "started" } },
    cancelTurn: async runId => { cancellations.push(runId); await options.cancel?.(runId) },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    ...(options.journal ? { journal: {
      subscribe: (listener: (delivery: AgentTurnJournalDelivery) => Promise<void>) => {
        deliveries.add(listener); return () => { deliveries.delete(listener) }
      },
      read: async () => options.read?.() ?? { status: "error" as const, code: "not-found" as const },
      retire: async ({ runId }: { runId: string }) => { retirements.push(runId); await options.retire?.(runId) },
      disconnect: (runId: string) => { disconnects.push(runId) }
    } } : {})
  }
  const controllerStore = options.holdAnswered === undefined && options.trackQueue !== true ? store : {
    ...store,
    dispatch: (action: Parameters<typeof store.dispatch>[0]) => {
      const receipt = store.dispatch(action)
      if (action.type !== "card.upsert" || action.card.kind !== "explain" || action.card.payload.phase !== "answered") return receipt
      return { ...receipt, isPersisted: { promise: Promise.all([receipt.isPersisted.promise, options.holdAnswered]).then(() => {}) } }
    },
    queueTurnErasure: (...args: Parameters<typeof store.queueTurnErasure>) => {
      erasuresQueued++
      return store.queueTurnErasure(...args)
    }
  } as typeof store
  const controller = createAppController(controllerStore, agent, {
    clientErrors: { report: (kind, error) => { diagnostics.push({ kind, error: String(error) }) }, reported: () => diagnostics.length },
    fetchImpl: async input => String(input).includes("/api/auth/logout")
      ? new Response(null, { status: 204 })
      : Response.json({ status: "error", message: "no route" }, { status: 404 })
  })
  cleanups.push(async () => { await controller.dispose(); await store.dispose?.() })
  return { storage, store, controller, launches, cancellations, disconnects, retirements, diagnostics,
    emit: (frame: AgentTurnFrame) => { for (const listener of [...listeners]) listener(frame) },
    captureFrame: () => [...listeners][0],
    captureDelivery: () => [...deliveries].at(-1),
    queuedErasures: () => erasuresQueued,
    listenerCount: () => listeners.size + deliveries.size }
}

const owner = (login: string) => ({ type: "identity.session.loaded" as const, actor: "system" as const,
  state: "signed-in" as const, login, provider: "github" as const, admin: false, scopesPlain: null })

const journalOutput = (request: StartAgentTurnRequest): AgentTurnJournalDelivery[] => {
  const { runId, journal } = request
  if (journal === undefined) throw new Error("expected journal request")
  const accepted = { version: 1 as const, runId, legId: journal.legId, batch: 0, position: 0, hash: "0".repeat(64) }
  const batch = { version: 1 as const, runId, legId: journal.legId, batch: 1, from: 1,
    previousHash: accepted.hash, hash: "1".repeat(64), frames: [
      { runId, type: "delta" as const, kind: "text" as const, text: "Alice private answer" },
      { runId, type: "done" as const, reason: "stop" as const }
    ] }
  return [{ type: "accepted", cursor: accepted },
    { type: "batch", batch, cursor: { ...accepted, batch: 1, position: 2, hash: batch.hash } }]
}

describe("explainer account privacy", () => {
  test("ordinary delayed output cannot restore Alice's private card after sign-out, including after reopening", async () => {
    const f = await fixture()
    f.controller.runCommand("agent.explain", "Private incident code ALICE-SECRET-REPORT")
    await settled()
    const runId = f.launches[0]!.runId
    const cardId = `explain-${runId}`
    const late = f.captureFrame()
    expect(f.store.collections.cards.get(cardId)).toMatchObject({ kind: "explain", payload: { phase: "asking" } })

    expect(await f.controller.signOut()).toBeUndefined()
    expect(f.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
    expect(f.store.collections.cards.get(cardId)).toBeUndefined()
    late?.({ runId, type: "delta", kind: "text", text: "Private explanation for Alice" })
    late?.({ runId, type: "done", reason: "stop" })
    await settled()
    expect(f.cancellations).toContain(runId)
    expect(f.store.collections.cards.get(cardId)).toBeUndefined()
    expect(JSON.stringify(await f.store.eventHistory())).not.toContain("ALICE-SECRET-REPORT")

    const reopened = await createAppStore({ kind: "localStorage", storage: f.storage })
    try { expect(reopened.collections.cards.get(cardId)).toBeUndefined() }
    finally { await reopened.dispose?.() }
  })

  test("account replacement drops old frames while the new owner can explain", async () => {
    const f = await fixture()
    f.controller.runCommand("agent.explain", "Alice private question")
    await settled()
    const alice = f.launches[0]!.runId
    await f.store.dispatch(owner("bob")).isPersisted.promise
    f.emit({ runId: alice, type: "delta", kind: "text", text: "Alice private answer" })
    f.emit({ runId: alice, type: "done", reason: "stop" })
    await settled()
    expect(f.cancellations).toContain(alice)
    expect(f.store.collections.cards.get(`explain-${alice}`)).toBeUndefined()
    expect(JSON.stringify(await f.store.eventHistory())).not.toContain("Alice private question")
    f.controller.runCommand("agent.explain", "Bob question")
    await settled()
    const bob = f.launches[1]!.runId
    f.emit({ runId: bob, type: "delta", kind: "text", text: "Bob answer" })
    f.emit({ runId: bob, type: "done", reason: "stop" })
    await settled()
    expect(f.store.collections.cards.get(`explain-${bob}`)).toMatchObject({
      status: "acted", payload: { question: "Bob question", answer: "Bob answer" }
    })
  })

  test("same-owner reprobe preserves valid output", async () => {
    const f = await fixture()
    f.controller.runCommand("agent.explain", "Alice still owns this")
    await settled()
    const runId = f.launches[0]!.runId
    await f.store.dispatch(owner("alice")).isPersisted.promise
    expect(f.cancellations).not.toContain(runId)
    f.emit({ runId, type: "delta", kind: "text", text: "Valid answer" })
    f.emit({ runId, type: "done", reason: "stop" })
    await settled()
    expect(f.store.collections.cards.get(`explain-${runId}`)).toMatchObject({
      status: "acted", payload: { answer: "Valid answer" }
    })
  })

  for (const journal of [false, true]) for (const outcome of ["started", "error", "rejected"] as const) {
    test(`${journal ? "journal" : "ordinary"} pending launch ${outcome} after sign-out cannot restore private state`, async () => {
      const start = Promise.withResolvers<StartAgentTurnResult>()
      const f = await fixture({ journal, start: () => start.promise })
      const secret = `Alice pending ${journal ? "journal" : "ordinary"} ${outcome}`
      f.controller.runCommand("agent.explain", secret)
      await settled()
      const runId = f.launches[0]!.runId
      await f.controller.signOut()
      expect(f.cancellations.filter(cancelled => cancelled === runId)).toHaveLength(1)
      if (outcome === "rejected") start.reject(new Error("late private rejection"))
      else start.resolve(outcome === "started" ? { status: "started" } : { status: "error", message: "late private refusal" })
      await settled()
      expect(f.cancellations.filter(cancelled => cancelled === runId)).toHaveLength(2)
      expect(f.store.collections.cards.get(`explain-${runId}`)).toBeUndefined()
      expect(JSON.stringify(await f.store.eventHistory())).not.toContain(secret)
      if (journal) expect(f.retirements).toContain(runId)
      const reopened = await createAppStore({ kind: "localStorage", storage: f.storage })
      try { expect(JSON.stringify(await reopened.eventHistory())).not.toContain(secret) }
      finally { await reopened.dispose?.() }
    })
  }

  test("late journal output cannot restore cards or enqueue stale cleanup metadata", async () => {
    const f = await fixture({ journal: true, trackQueue: true })
    f.controller.runCommand("agent.explain", "Alice journal secret")
    await settled()
    const request = f.launches[0]!
    const late = f.captureDelivery()
    expect(late).toBeDefined()
    const listenersBeforeSignOut = f.listenerCount()
    await f.controller.signOut()
    const pendingErasure = f.store.privacyRetirementStatus().remotePending
    for (const delivery of journalOutput(request)) await late!(delivery)
    await settled()
    expect(f.cancellations).toContain(request.runId)
    expect(f.disconnects).toContain(request.runId)
    expect(f.retirements).toContain(request.runId)
    expect(f.queuedErasures()).toBe(0)
    expect(f.listenerCount()).toBe(listenersBeforeSignOut - 1)
    expect(f.store.collections.cards.get(`explain-${request.runId}`)).toBeUndefined()
    expect(JSON.stringify(await f.store.eventHistory())).not.toContain("Alice journal secret")
    expect(f.store.privacyRetirementStatus().remotePending).toBe(pendingErasure)
  })

  test("failed cancel and remote retirement after sign-out leave no private diagnostic or local proof", async () => {
    const privateError = "Alice private cancellation failure"
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on("unhandledRejection", onUnhandled)
    try {
      const f = await fixture({ journal: true, trackQueue: true,
        cancel: async () => { throw new Error(privateError) },
        retire: async () => { throw new Error("Alice private retirement failure") } })
      f.controller.runCommand("agent.explain", "Alice private failed cleanup")
      await settled()
      const runId = f.launches[0]!.runId
      expect(await f.controller.signOut()).toBeUndefined()
      await settled()
      expect(f.cancellations).toContain(runId)
      expect(f.retirements).toContain(runId)
      expect(f.store.collections.cards.get(`explain-${runId}`)).toBeUndefined()
      expect(f.queuedErasures()).toBe(0)
      expect(unhandled).toEqual([])
      expect(JSON.stringify(f.diagnostics)).not.toContain("Alice private")
      expect(JSON.stringify(await f.store.eventHistory())).not.toContain("Alice private")
    } finally { process.off("unhandledRejection", onUnhandled) }
  })

  test("a delayed journal read cannot replay output after sign-out", async () => {
    const read = Promise.withResolvers<AgentTurnJournalReply>()
    const readStarted = Promise.withResolvers<void>()
    const f = await fixture({ journal: true, read: () => { readStarted.resolve(); return read.promise } })
    f.controller.runCommand("agent.explain", "Alice delayed read")
    await settled()
    const request = f.launches[0]!
    const [accepted, delivery] = journalOutput(request)
    await f.captureDelivery()!(accepted!)
    await readStarted.promise
    await f.controller.signOut()
    if (accepted?.type !== "accepted" || delivery?.type !== "batch") throw new Error("expected journal batch")
    read.resolve({ status: "ok", after: accepted.cursor, next: delivery.cursor,
      head: delivery.cursor, terminal: true, more: false, batches: [delivery.batch] })
    await settled()
    expect(f.store.collections.cards.get(`explain-${request.runId}`)).toBeUndefined()
    expect(JSON.stringify(await f.store.eventHistory())).not.toContain("Alice delayed read")
  })

  test("a terminal card receipt overtaken by sign-out cannot enqueue stale erasure metadata", async () => {
    const saved = Promise.withResolvers<void>()
    const f = await fixture({ journal: true, holdAnswered: saved.promise })
    f.controller.runCommand("agent.explain", "Alice terminal secret")
    await settled()
    const request = f.launches[0]!
    const deliver = f.captureDelivery()!
    const [accepted, batch] = journalOutput(request)
    await deliver(accepted!)
    const completion = deliver(batch!)
    for (let attempt = 0; attempt < 50 && f.store.collections.cards.get(`explain-${request.runId}`)?.status !== "acted"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(f.store.collections.cards.get(`explain-${request.runId}`)).toMatchObject({ status: "acted" })
    expect(f.queuedErasures()).toBe(0)
    await f.controller.signOut()
    const pendingAfterSignOut = f.store.privacyRetirementStatus().remotePending
    const queuedAfterSignOut = f.queuedErasures()
    saved.resolve()
    await completion
    await settled()
    expect(f.store.collections.cards.get(`explain-${request.runId}`)).toBeUndefined()
    expect(f.store.privacyRetirementStatus().remotePending).toBe(pendingAfterSignOut)
    expect(f.queuedErasures()).toBe(queuedAfterSignOut)
    expect(f.retirements).toContain(request.runId)
  })

  test("disposal releases an active turn and suppresses subsequent output", async () => {
    const f = await fixture()
    f.controller.runCommand("agent.explain", "Alice disposing")
    await settled()
    const runId = f.launches[0]!.runId
    await f.controller.dispose()
    const before = await f.store.eventHistory()
    f.emit({ runId, type: "delta", kind: "text", text: "Late answer" })
    f.emit({ runId, type: "done", reason: "stop" })
    await settled()
    expect(f.cancellations).toContain(runId)
    expect(f.listenerCount()).toBe(0)
    expect(await f.store.eventHistory()).toEqual(before)
  })
})
