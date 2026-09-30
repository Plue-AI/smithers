import { afterEach, describe, expect, test } from "bun:test"
import type { AgentTurnFrame, FetchLike, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { CommandRegistry } from "../../flows/Commands"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import type { AppTransition } from "../AppState"
import { memoryStorage, settled } from "../TestFixtures"
import { createAuthBillingController } from "./auth-billing"
import { createControllerContext } from "./context"
import { createTurnController } from "./turns"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const signedIn = (login: string) => ({ state: "signed-in" as const, login, admin: false })

const fixture = async (options: {
  readonly start?: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  readonly cancel?: (runId: string) => Promise<void>
  readonly tool?: () => Promise<string>
  readonly steer?: () => Promise<boolean>
  readonly approval?: () => Promise<boolean>
  readonly fetch?: FetchLike
} = {}) => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn("alice"), scopesPlain: null }).isPersisted.promise
  const launches: StartAgentTurnRequest[] = [], cancellations: string[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const emit = (frame: AgentTurnFrame) => { for (const listener of listeners) listener(frame) }
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { launches.push(request); return options.start?.(request) ?? { status: "started" } },
    cancelTurn: async runId => { cancellations.push(runId); await options.cancel?.(runId) },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    ...(options.steer === undefined ? {} : { steer: options.steer }),
    ...(options.approval === undefined ? {} : { resolveApproval: options.approval })
  }
  const ctx = createControllerContext(store, agent, {
    fetchImpl: options.fetch ?? (async () => Response.json({ scopes: [], state: "ok", allowedToStartWork: true,
      balance: { totalUsd: "0", lifetimeChargedUsd: "0", chargeCount: 0 } }))
  })
  // Exercise the turn boundary independently of the app's startup flows.
  ctx.commands = { all: () => [], callable: () => [], find: () => undefined, toolSpecs: () => [],
    // The turn's command catalog is filtered against this state (turns.ts
    // turnCommands), so the double answers it rather than leaving it undefined.
    state: () => ({ surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false }),
    executeForAgent: options.tool ?? (async () => "done") } as unknown as CommandRegistry
  ctx.withToast = async (_key, _title, _doneTitle, work) => work()
  const auth = createAuthBillingController(ctx, store.nextOrdinal, {
    current: async () => null, signInPath: "/api/auth/github"
  })
  const turns = createTurnController(ctx, { nextOrdinal: store.nextOrdinal,
    settleTurnBilling: () => {}, surfaceCommandFailure: () => {}, forwardApprovalDecision: async () => {},
    forwardInboxApprovalDecision: async () => {} })
  turns.subscribeToAgent()
  cleanups.push(async () => { await ctx.dispose(); await store.dispose?.() })
  return { store, storage, ctx, auth, turns, emit, launches, cancellations }
}

const oldResponses = (turnId: string): AppTransition[] => [
  { type: "message.response.delta", actor: "smithers", turnId, channel: "text", delta: "alice-private-delta" },
  { type: "message.response.failed", actor: "system", turnId, message: "alice-private-error" },
  { type: "message.response.cancelled", actor: "system", turnId, detail: "alice-private-cancel" },
  { type: "message.response.completed", actor: "smithers", turnId }
]

describe("turn ownership at account boundaries", () => {
  test("stale deltas and terminal facts never enter the replacement event stream", async () => {
    const { store } = await fixture()
    await store.dispatch({ type: "message.submitted", actor: "user", turnId: "alice-turn", text: "alice-private-prompt" }).isPersisted.promise
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    for (const phase of ["signed-out", "bob-turn"] as const) {
      if (phase === "bob-turn") {
        await store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn("bob"), scopesPlain: null }).isPersisted.promise
        await store.dispatch({ type: "message.submitted", actor: "user", turnId: "bob-turn", text: "Bob prompt" }).isPersisted.promise
      }
      const before = await store.eventHistory()
      for (const response of oldResponses("alice-turn")) await store.dispatch(response).isPersisted.promise
      expect(await store.eventHistory()).toEqual(before)
      expect(store.collections.messages.get("message-alice-turn-smithers")).toBeUndefined()
      expect((await store.verifyState()).valid).toBe(true)
    }
    expect(store.session()).toMatchObject({ turnId: "bob-turn", phase: "responding" })
    await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId: "bob-turn" }).isPersisted.promise
    const completed = await store.eventHistory()
    for (const response of oldResponses("bob-turn")) await store.dispatch(response).isPersisted.promise
    expect(await store.eventHistory()).toEqual(completed)
  })

  test("signout cancels without rendering old frames, including while Bob is responding", async () => {
    const f = await fixture()
    f.turns.send("Alice private prompt")
    await settled()
    const alice = f.launches[0]!.runId
    await f.auth.signOut()
    expect(f.ctx.activeTurn).toBeUndefined()
    expect(f.cancellations).toContain(alice)
    const signedOut = await f.store.eventHistory()
    f.emit({ runId: alice, type: "done", error: "alice-private-error" })
    expect(await f.store.eventHistory()).toEqual(signedOut)
    await f.auth.adoptSession(signedIn("bob"))
    f.turns.send("Bob prompt")
    await settled()
    const bob = f.launches[1]!.runId
    const before = await f.store.eventHistory()
    f.emit({ runId: alice, type: "delta", kind: "text", text: "alice-private-delta" })
    f.emit({ runId: alice, type: "tool_call", call_id: "old-tool", name: "commands", arguments: "alice-private-tool" })
    f.emit({ runId: alice, type: "done", reason: "stop" })
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.store.session()).toMatchObject({ turnId: bob, phase: "responding" })
    f.emit({ runId: bob, type: "delta", kind: "text", text: "Bob answer" })
    f.emit({ runId: bob, type: "done", reason: "stop" })
    await f.store.settled?.()
    expect(f.store.collections.messages.get(`message-${bob}-smithers`)?.text).toBe("Bob answer")
    expect(f.store.session().phase).toBe("idle")
  })

  test.each(["started", "error"] as const)("a late %s acknowledgement cannot revive an old account turn", async status => {
    const start = Promise.withResolvers<StartAgentTurnResult>()
    const f = await fixture({ start: () => start.promise })
    f.turns.send("Alice private prompt")
    const alice = f.launches[0]!.runId
    await f.auth.adoptSession(signedIn("bob"))
    await settled()
    const before = await f.store.eventHistory()
    start.resolve(status === "started" ? { status } : { status, message: "alice-private-start-error" })
    await settled()
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.ctx.activeTurn).toBeUndefined()
    expect(f.cancellations.filter(id => id === alice)).toHaveLength(status === "started" ? 2 : 1)
  })

  test("a retry waiting for cancellation cannot launch after an account change", async () => {
    const cancelled = Promise.withResolvers<void>()
    const f = await fixture({ cancel: () => cancelled.promise })
    f.turns.send("Alice prompt")
    await settled()
    const alice = f.launches[0]!.runId
    f.turns.stop()
    f.turns.retryLastTurn()
    expect(f.launches).toHaveLength(1)
    await f.auth.adoptSession(signedIn("bob"))
    await settled()
    const before = await f.store.eventHistory()
    cancelled.resolve()
    await settled()
    expect(f.launches).toHaveLength(1)
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.ctx.activeTurn).toBeUndefined()
    expect(f.cancellations).toContain(alice)
  })

  test("availability outages and same-owner recovery preserve an active turn", async () => {
    const f = await fixture()
    f.turns.send("Alice prompt")
    await settled()
    const alice = f.launches[0]!.runId
    await f.auth.adoptSession({ state: "unavailable", login: null, admin: false })
    expect(f.cancellations).toHaveLength(0)
    f.emit({ runId: alice, type: "delta", kind: "text", text: "Still " })
    await f.auth.adoptSession(signedIn("alice"))
    expect(f.cancellations).toHaveLength(0)
    f.emit({ runId: alice, type: "delta", kind: "text", text: "Alice" })
    f.emit({ runId: alice, type: "done", reason: "stop" })
    await f.store.settled?.()
    expect(f.store.collections.messages.get(`message-${alice}-smithers`)?.text).toBe("Still Alice")
    expect(f.store.session().phase).toBe("idle")
  })

  test("late tool results cannot write private results or start a continuation", async () => {
    const tool = Promise.withResolvers<string>()
    const f = await fixture({ tool: () => tool.promise })
    f.turns.send("Alice prompt")
    await settled()
    const alice = f.launches[0]!.runId
    f.emit({ runId: alice, type: "tool_call", call_id: "call", name: "commands", arguments: "{}" })
    f.emit({ runId: alice, type: "done" })
    await f.auth.adoptSession(signedIn("bob"))
    await settled()
    const before = await f.store.eventHistory()
    tool.resolve("alice-private-tool-result")
    await settled()
    expect(f.launches).toHaveLength(1)
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.store.collections.toolCalls.size).toBe(0)
  })

  test("a late steering acknowledgement cannot append a private prompt", async () => {
    const steering = Promise.withResolvers<boolean>()
    const f = await fixture({ steer: () => steering.promise })
    f.turns.send("Alice prompt")
    await settled()
    f.turns.send("alice-private-steering")
    await f.auth.signOut()
    const before = await f.store.eventHistory()
    steering.resolve(true)
    await settled()
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.store.collections.messages.size).toBe(0)
  })

  test("a definitive signed-out answer fences the turn before the consent-copy request finishes", async () => {
    const scopes = Promise.withResolvers<Response>()
    const f = await fixture({ fetch: async input => String(input).endsWith("/auth/scopes")
      ? scopes.promise : Response.json({ status: "signed-out" }) })
    f.turns.send("Alice prompt")
    await settled()
    const alice = f.launches[0]!.runId
    const loaded = f.auth.loadSession()
    await settled()
    expect(f.ctx.activeTurn).toBeUndefined()
    expect(f.cancellations).toContain(alice)
    const before = await f.store.eventHistory()
    f.emit({ runId: alice, type: "done", error: "alice-private-error" })
    expect(await f.store.eventHistory()).toEqual(before)
    scopes.resolve(Response.json({ scopes: [] }))
    await loaded
    expect(f.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a late approval acknowledgement cannot resume a retired account's lineage", async () => {
    const approval = Promise.withResolvers<boolean>()
    const f = await fixture({ approval: () => approval.promise })
    f.turns.send("Alice prompt")
    await settled()
    const alice = f.launches[0]!.runId
    f.emit({ runId: alice, type: "link.authored", link: 1, scriptDigest: "digest", script: "script" })
    f.emit({ runId: alice, type: "done" })
    await f.store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "approval", kind: "approval", title: "Approval needed", status: "active", createdAt: 1, ordinal: 10,
      payload: { capability: "read repository", runId: alice, chain: true }
    } }).isPersisted.promise
    f.turns.decideApproval("approval", "approved")
    await f.auth.adoptSession(signedIn("bob"))
    await settled()
    const before = await f.store.eventHistory()
    approval.resolve(true)
    await settled()
    expect(f.launches).toHaveLength(1)
    expect(await f.store.eventHistory()).toEqual(before)
    expect(f.ctx.activeTurn).toBeUndefined()
  })
})
