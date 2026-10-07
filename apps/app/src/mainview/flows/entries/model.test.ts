import { afterEach, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, settled } from "../../state/TestFixtures"
import { installFixture } from "../../state/seams/InstallFixtures.test-support"
import { MessageSchema, ToastSchema } from "../../state/AppState"
import { modelInvocable } from "../registry"

const bootstrap: AppBootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "abcdef1234567890", capabilities: ["agent", "install"], authFlow: "none", sandbox: { platform: "darwin", mode: "enforced" } }
const port: AgentPort = { available: false, startTurn: async () => ({ status: "error", message: "unavailable" }), cancelTurn: async () => {}, subscribe: () => () => {} }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const binding = { protocol: "openai-responses", modelId: "model-a", credential: "OPENAI_API_KEY" }
const payload = (owner = true, model = "model-a") => ({ native: false, canAssign: owner, roleBindings: { fast: binding, coding: binding, jev: { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" } }, agents: [
 { id: "reviewer", label: "Reviewer agent", purpose: "", model: { provider: "openai-responses", id: model, label: model }, binding: { ...binding, modelId: model }, source: "owner", instructions: "flows/todo/flow.ts", builtin: true, available: false, reason: "", account: "" }
] })
const harness = async (owner = true, read?: Promise<Response>, save?: Promise<Response>, probe?: Promise<Response>) => {
 const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
 const requests: Array<{ path: string; method: string; body?: string }> = []
 let selected = "model-a"
 const controller = createAppController(store, port, { bootstrap, fetchImpl: async (input, init) => {
  const path = new URL(String(input), "http://localhost:4000").pathname
  const method = init?.method ?? "GET"
  requests.push({ path, method, body: init?.body?.toString() })
  if (path === "/api/install") return Response.json(installFixture())
  if (path === "/api/agents" && method === "GET") return read ?? Response.json(payload(owner, selected))
  if (path === "/api/agents/reviewer/model" && method === "PUT") {
   if (!owner) return Response.json({ code: "permission", class: "permission", message: "Owner access required" }, { status: 403 })
   selected = JSON.parse(init!.body as string).model.modelId
   return save ?? Response.json(payload(owner, selected))
  }
  if (path === "/api/model/test") return probe ?? Response.json({ ok: true, latencyMs: 2, sample: "ok", output: { kind: "text", text: "ok" } })
  return Response.json({ code: "absent" }, { status: 404 })
 } })
 cleanups.push(() => controller.dispose())
 const card = () => store.collections.cards.get("agents")
 const row = () => { const current = card(); return current?.kind === "agents" && "agents" in current.payload ? current.payload : undefined }
 return { store, controller, requests, card, row }
}

test("/agents returns before its read; the install card never displays seeded profiles", async () => {
 let resolve!: (response: Response) => void
 const read = new Promise<Response>(done => { resolve = done })
 const h = await harness(true, read)
 try {
  expect((await h.controller.commands.run("agents")).status).toBe("executed")
  expect(h.row()?.agents).toEqual([])
  resolve(Response.json(payload())); await settled()
  expect(h.row()?.agents.map(row => row.id)).toEqual(["reviewer"])
  expect(h.row()?.agents[0]?.model.id).toBe("model-a")
 } finally { resolve(Response.json(payload())) }
})

test("the slash and button assignment share a durable background request and real seam", async () => {
 let resolve!: (response: Response) => void
 const save = new Promise<Response>(done => { resolve = done })
 const h = await harness(true, undefined, save)
 try {
  await h.controller.commands.run("agents"); await settled()
  const launches = await Promise.all([h.controller.commands.run("model.assign", "reviewer model-b"), h.controller.commands.submit({ name: "model.assign", payload: { role: "reviewer", model: "model-b" }, actor: "user" })])
  expect(launches.map(outcome => outcome.status)).toEqual(["executed", "executed"])
  await settled()
  expect(h.row()?.assignment?.state).toBe("requested")
  expect(h.row()?.agents[0]?.model.id).toBe("model-a")
  await h.controller.commands.submit({ name: "model.assign", payload: { role: "reviewer", model: "model-b" }, actor: "user" }); await settled()
  expect(h.requests.filter(row => row.method === "PUT")).toHaveLength(1)
  expect(JSON.parse(h.requests.find(row => row.method === "PUT")!.body!)).toEqual({ model: { protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" } })
  resolve(Response.json(payload(true, "model-b"))); await settled()
  expect(h.row()?.agents[0]?.model.id).toBe("model-b")
  expect(h.row()?.assignment).toBeUndefined()
 } finally { resolve(Response.json(payload(true, "model-b"))) }
})

test("member and model invocations cannot change bindings or local records", async () => {
 const h = await harness(false)
 await h.controller.commands.run("agents"); await settled()
 await h.controller.commands.run("model.assign", "reviewer model-b"); await settled()
 expect(h.requests.filter(row => row.method === "PUT")).toEqual([])
 expect(h.row()?.assignment?.state).toBe("failed")
 expect(h.row()?.error).toBe("Owner access required")
 for (const name of ["model.new", "model.edit", "model.save", "model.remove", "model.test", "model.assign", "settings.model.set"]) {
  const entry = h.controller.commands.find(name)!
  expect(entry.metadata.hidden).toBe(true)
  expect(modelInvocable(entry)).toBe(false)
 }
 expect(h.controller.commands.find("model.compose")).toBeUndefined()
 expect(h.controller.commands.find("model.ask")).toBeUndefined()
 expect(h.controller.slashItems("model")).toEqual([])
})

test("saved assignment records are persisted, editable, and assign their complete binding", async () => {
 const h = await harness()
 await h.controller.commands.run("agents"); await settled()
 const model = { name: "review-b", protocol: "openai-responses", modelId: "model-b", credential: "OPENAI_API_KEY" }
 expect((await h.controller.commands.submit({ name: "model.save", payload: model, actor: "user" })).status).toBe("executed")
 expect(h.store.collections.models.get("review-b")?.modelId).toBe("model-b")
 await h.controller.commands.run("model.show", "review-b"); await settled()
 expect(h.row()?.selectedModel).toBe("review-b")
 await h.controller.commands.run("model.assign", "reviewer review-b"); await settled()
 expect(h.row()?.agents[0]?.model.id).toBe("model-b")
 expect((await h.controller.commands.run("model.edit", "review-b")).status).toBe("executed")
 expect([...h.store.collections.cards.values()].some(card => card.kind === "flow-form")).toBe(true)
 await h.controller.commands.run("model.remove", "review-b")
 expect(h.store.collections.models.has("review-b")).toBe(false)
})

 test("/agent reviewer selects the same served Agent card", async () => {
 const h = await harness()
 expect((await h.controller.commands.run("agent", "reviewer")).status).toBe("executed")
 await settled()
 expect(h.row()?.selectedAgent).toBe("reviewer")
 expect(h.row()?.agents[0]?.model.id).toBe("model-a")
 await h.controller.commands.run("agents"); await settled()
 expect(h.row()?.selectedAgent).toBeUndefined()
 })

 test("model Test returns while the provider is unresolved and coalesces repeated input", async () => {
 let resolve!: (response: Response) => void
 const probe = new Promise<Response>(done => { resolve = done })
 const h = await harness(true, undefined, undefined, probe)
 try {
  await h.controller.commands.submit({ name: "model.save", payload: { name: "probe", ...binding }, actor: "user" })
  expect((await h.controller.commands.run("model.test", "probe")).status).toBe("executed")
  await settled()
  expect(h.row()?.testing).toEqual(["probe"])
  expect(h.store.collections.models.get("probe")?.lastTest).toBeUndefined()
  await h.controller.commands.run("model.test", "probe"); await settled()
  expect(h.requests.filter(request => request.path === "/api/model/test")).toHaveLength(1)
  resolve(Response.json({ ok: true, latencyMs: 2, sample: "ok" })); await settled()
  expect(h.row()?.testing).toEqual([])
  expect(h.store.collections.models.get("probe")?.lastTest?.result.ok).toBe(true)
 } finally { resolve(Response.json({ ok: true, latencyMs: 2, sample: "ok" })) }
 })
 test("a failed model Test stays visible and can be retried", async () => {
 const h = await harness(true, undefined, undefined, Promise.resolve(Response.json({ code: "host_failed" }, { status: 503 })))
 await h.controller.commands.submit({ name: "model.save", payload: { name: "probe", ...binding }, actor: "user" })
 await h.controller.commands.run("model.test", "probe"); await settled()
 expect(h.row()?.testing).toEqual([])
 expect(h.row()?.error).toBeDefined()
 expect(h.store.collections.models.get("probe")?.lastTest).toBeUndefined()
 await h.controller.commands.run("model.test", "probe"); await settled()
 expect(h.requests.filter(request => request.path === "/api/model/test")).toHaveLength(2)
 })


test("retired model doors decode saved actions and expose only canonical commands", async () => {
 const h = await harness()
 for (const [old, current, args] of [["model", "agents", ""], ["agent.open", "agent", "reviewer"], ["agent.model", "model.assign", '{"role":"reviewer","model":"model-b"}']]) {
  expect(h.controller.commands.find(old!)).toBeUndefined()
  expect(await h.controller.runCommandForResult(old!, args)).toMatchObject({ status: "unknown-command" })
  const saved = MessageSchema.shape.action.parse({ flow: old, args, label: "Open" })!
  expect(saved.flow).toBe(current!)
  expect(ToastSchema.shape.action.parse({ flow: old, args, label: "Open" })).toEqual(saved)
  expect(await h.controller.commands.run(saved.flow, saved.args)).toMatchObject({ status: "executed" })
  await settled()
 }
 expect(h.requests.filter(row => row.method === "PUT")).toHaveLength(1)
 expect(h.row()?.agents[0]?.model.id).toBe("model-b")
})
