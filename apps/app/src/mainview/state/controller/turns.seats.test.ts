import { afterEach, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { CommandRegistry } from "../../flows/Commands"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { memoryStorage, settled } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createTurnController } from "./turns"

/*
 * No model seat rides the conversation's own turns. The `front-door` seat and
 * its `decisionModel` field were deleted with the server front door (#3313);
 * the explainer and recommend seats serve other calls, so assigning them leaves
 * the turn body exactly what it was.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const JEV = { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } as const
const MINE = { id: "mine", protocol: "openai-chat", baseUrl: "https://api.cerebras.ai", modelId: "qwen-3-coder-480b", credential: "CEREBRAS_API_KEY" } as const

const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", admin: false, scopesPlain: null }).isPersisted.promise
  for (const model of [JEV, MINE]) await store.dispatch({ type: "model.saved", actor: "user", model }).isPersisted.promise
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { launches.push(request); return { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const ctx = createControllerContext(store, agent, {
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent"], authFlow: "redirect", sandbox: null },
    fetchImpl: async () => Response.json({})
  })
  ctx.commands = { all: () => [], callable: () => [], find: () => undefined, toolSpecs: () => [],
    state: () => ({ surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: false }),
    executeForAgent: async () => "done" } as unknown as CommandRegistry
  ctx.withToast = async (_key, _title, _doneTitle, work) => work()
  const turns = createTurnController(ctx, { nextOrdinal: store.nextOrdinal,
    settleTurnBilling: () => {}, surfaceCommandFailure: () => {}, forwardApprovalDecision: async () => {},
    forwardInboxApprovalDecision: async () => {} })
  turns.subscribeToAgent()
  cleanups.push(async () => { await ctx.dispose(); await store.dispose?.() })
  const ask = async (text: string): Promise<StartAgentTurnRequest> => {
    const before = launches.length
    turns.send(text)
    await settled()
    expect(launches).toHaveLength(before + 1)
    const launch = launches[before]!
    for (const listener of listeners) listener({ runId: launch.runId, type: "done", reason: "stop" })
    await settled()
    return launch
  }
  return { store, ask }
}

test("an unassigned seat sends a turn with no model binding", async () => {
  const f = await fixture()
  const launch = await f.ask("show me my runs")
  expect("decisionModel" in launch).toBe(false)
  expect("model" in launch).toBe(false)
})

test("assigned explainer and recommend seats leave the conversation turn unchanged, and a turn with tools never binds `model`", async () => {
  const f = await fixture()
  const bare = await f.ask("show me my runs")
  await f.store.dispatch({ type: "seat.assigned", actor: "user", seat: "recommend", recordId: "jev" }).isPersisted.promise
  await f.store.dispatch({ type: "seat.assigned", actor: "user", seat: "explainer", recordId: "mine" }).isPersisted.promise
  const bound = await f.ask("show me my runs")
  expect("decisionModel" in bound).toBe(false)
  expect("model" in bound).toBe(false)
  expect(Object.keys(bound).sort()).toEqual(Object.keys(bare).sort())
})
