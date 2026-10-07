import { expect, test } from "bun:test"
import { assignInstallAgentModel, createModelsController } from "./models"
import type { ControllerContext } from "./context"

const context = (owner: boolean, actor: "user" | "smithers" = "user") => {
 const calls: string[] = []
 let epoch = 1
 const ctx = { commandActor: actor, baseUrl: "http://install.test", get accountEpoch() { return epoch },
  http: async (path: string) => { calls.push(path); return Response.json({ canAssign: owner, agents: [{ id: "reviewer", binding: { protocol: "openai-responses", modelId: "model-a", credential: "OPENAI_API_KEY" } }] }) },
  store: { collections: { models: new Map(), cards: new Map() } }, onDispose: () => undefined, errorMessageOf: async () => "Refused"
 } as unknown as ControllerContext
 return { ctx, calls, changeAccount: () => { epoch++ } }
}

test("a direct agent call cannot reach the transport or modify a named record", async () => {
 const h = context(true, "smithers")
 await expect(assignInstallAgentModel(h.ctx, "reviewer", "model-b")).rejects.toThrow("Owner access required")
 const controller = createModelsController(h.ctx, { renderFlowForm: () => undefined, listAgents: async () => {} })
 expect(await controller.saveModel({ name: "mine", protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" })).toBe("Owner access required")
 expect(h.calls).toEqual([])
})

test("an owner response from an earlier account generation never issues the setting write", async () => {
 const h = context(true)
 const transport = h.ctx.http
 h.ctx.http = async (...args) => { const result = await transport(...args); h.changeAccount(); return result }
 await expect(assignInstallAgentModel(h.ctx, "reviewer", "model-b")).rejects.toThrow("Owner access required")
 expect(h.calls).toEqual(["http://install.test/api/agents"])
})

test("a member read cannot issue the assignment write", async () => {
 const h = context(false)
 await expect(assignInstallAgentModel(h.ctx, "reviewer", "model-b")).rejects.toThrow("Owner access required")
 expect(h.calls).toEqual(["http://install.test/api/agents"])
})

// Unit transport controls deliberately hold both admission and execution so
// returning a launch acknowledgment cannot accidentally be treated as done.
const probeHarness = (recovered?: { requestId: string; model: import("@smthrs/rpc/ConfiguredModel").ConfiguredModel }) => {
 const model = { id: "probe", protocol: "openai-chat" as const, modelId: "probe-model", credential: "PROBE_KEY" }
 const cards = new Map<string, any>([["agents", { id: "agents", kind: "agents", payload: { native: false, agents: [], ...(recovered ? { testing: ["probe"], testRequests: { probe: recovered } } : {}) } }]])
 const listeners = new Set<() => void>()
 Object.assign(cards, { subscribeChanges: (listener: () => void) => { listeners.add(listener); return { unsubscribe: () => listeners.delete(listener) } } })
 const models = new Map([["probe", model]])
 const posts: any[] = [], events: any[] = []
 let received!: () => void
 const posted = new Promise<void>(resolve => { received = resolve })
 let resolveLaunch!: (value: Response) => void
 const launch = new Promise<Response>(resolve => { resolveLaunch = resolve })
 let toastWork: Promise<unknown> | undefined
 let disposed = false
 const ctx = { commandActor: "user", baseUrl: "http://install.test", accountEpoch: 1, get disposed() { return disposed },
  store: { collections: { cards, models }, settled: async () => {}, dispatch: (event: any) => {
   events.push(event)
   if (event.type === "card.upsert") { cards.set(event.card.id, event.card); for (const listener of listeners) listener() }
   return { isPersisted: { promise: Promise.resolve() } }
  } },
  http: async (path: string, init?: RequestInit) => {
   if (path.endsWith("/api/agents")) return Response.json({ canAssign: true })
   if (path.endsWith("/api/model/test")) { posts.push(JSON.parse(String(init?.body))); received(); return launch }
   return Response.json({ state: "completed", result: { ok: true, latencyMs: 2, sample: "ok" } })
  },
  withToast: (_key: string, _start: string, _end: string, work: () => Promise<unknown>) => { toastWork = work(); return toastWork },
  onDispose: () => undefined, errorMessageOf: async () => "Refused"
 } as unknown as ControllerContext
 const controller = createModelsController(ctx, { renderFlowForm: () => undefined, listAgents: async () => {} })
 return { ctx, controller, cards, models, posts, events, posted, resolveLaunch, hydrated: () => { for (const listener of listeners) listener() }, finish: () => toastWork!, dispose: () => { disposed = true } }
}

test("a plain-HTTP probe persists its identity and returns while admission is unresolved; duplicate input joins", async () => {
 const randomUUID = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
 Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
 try {
 const h = probeHarness()
 await h.controller.testModel("probe")
 await h.controller.testModel("probe")
 await h.posted
 expect(h.posts).toHaveLength(1)
 const request = h.cards.get("agents").payload.testRequests.probe
 expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
 expect(h.posts[0]).toEqual({ requestId: request.requestId, model: request.model })
 expect(request.model.modelId).toBe("probe-model")
 expect(h.cards.get("agents").payload.testing).toEqual(["probe"])
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(0)
 h.resolveLaunch(Response.json({ state: "accepted" }, { status: 202 }))
 await h.finish()
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(1)
 expect(h.cards.get("agents").payload.testing).toEqual([])
 expect(h.cards.get("agents").payload.testRequests).toEqual({})
 } finally {
  if (randomUUID) Object.defineProperty(crypto, "randomUUID", randomUUID)
  else delete (crypto as Partial<Crypto>).randomUUID
 }
})

test("reload reconnects with the original probe and ignores a newly edited record", async () => {
 const request = { requestId: "persisted-probe-request", model: { id: "probe", protocol: "openai-chat" as const, modelId: "old-model", credential: "PROBE_KEY" } }
 const h = probeHarness(request)
 await h.controller.testModel("probe")
 await h.posted
 expect(h.posts).toEqual([{ requestId: "persisted-probe-request", model: request.model }])
 h.resolveLaunch(Response.json({}, { status: 202 }))
 await h.finish()
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(0)
})

test("disposal retains the pending receipt for reload and refuses stale results", async () => {
 const h = probeHarness()
 await h.controller.testModel("probe")
 await h.posted
 h.dispose()
 h.resolveLaunch(Response.json({}, { status: 202 }))
 await h.finish()
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(0)
 expect(h.cards.get("agents").payload.testRequests.probe.requestId).toBe(h.posts[0].requestId)
})

test("a lost admission response remains retryable with the same persisted probe identity", async () => {
 const h = probeHarness()
 const http = h.ctx.http
 let reject = true
 h.ctx.http = async (...args) => {
  if (String(args[0]).endsWith("/api/model/test") && reject) throw new Error("Connection lost")
  return http(...args)
 }
 await h.controller.testModel("probe")
 await h.finish()
 const request = h.cards.get("agents").payload.testRequests.probe
 expect(h.cards.get("agents").payload.error).toBe("Connection lost")
 expect(h.cards.get("agents").payload.testing).toEqual([])
 reject = false
 await h.controller.testModel("probe")
 await h.posted
 expect(h.posts[0].requestId).toBe(request.requestId)
 h.resolveLaunch(Response.json({}, { status: 202 }))
 await h.finish()
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(1)
})

test("a pending probe hydrated after controller construction reconnects automatically", async () => {
 const h = probeHarness()
 await Promise.resolve()
 const card = h.cards.get("agents")
 card.payload = { ...card.payload, testing: ["probe"], testRequests: { probe: { requestId: "late-hydrated-probe", model: h.models.get("probe") } } }
 h.hydrated()
 await h.posted
 expect(h.posts[0].requestId).toBe("late-hydrated-probe")
 h.resolveLaunch(Response.json({}, { status: 202 }))
 await h.finish()
 expect(h.events.filter(event => event.type === "model.tested")).toHaveLength(1)
})
