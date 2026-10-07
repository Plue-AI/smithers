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
