import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { createCommandRegistry } from "./Commands"
import { stubCommandActions } from "./StubCommandActions"

test("recorded PR targets preserve their repository without executable aliases", () => {
  for (const [flow, args, payload] of [["prs", "owner/repo", { operation: "list", repo: "owner/repo" }], ["prs.list", "owner/repo", { operation: "list", repo: "owner/repo" }], ["prs.view", "42 owner/repo", { number: 42, repo: "owner/repo" }]] as const) {
    for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
      const saved = schema.parse({ flow, args, label: "Open" })!
      expect(saved.flow).toBe("pr")
      expect(JSON.parse(saved.args!)).toEqual(payload)
    }
    const pending = SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: flow, args, requestedAt: 1, requirement: "signed-in" } }).pendingCommand!
    expect(pending.name).toBe("pr")
    expect(JSON.parse(pending.args!)).toEqual(payload)
    expect(FLOW_NAMES.includes(flow as never)).toBe(false)
  }
})

test("one PR door retains explicit repository and rejects ambiguous list/detail targets", async () => {
  const calls: unknown[] = []
  const list = Object.assign(async (repo?: string) => { calls.push(["list", repo]) }, { preload: async () => {} })
  const view = Object.assign(async (number: number, repo?: string) => { calls.push(["view", number, repo]) }, { preload: async () => {} })
  const registry = createCommandRegistry(stubCommandActions({
    noteCommandRun: () => {}, traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, signedOut: false, admin: false, hasConnectors: true }),
    listLandings: list, viewLanding: view
  }))
  expect((await registry.run("pr", JSON.stringify({ operation: "list", repo: "owner/repo" }))).status).toBe("executed")
  expect((await registry.runAsAgent("pr", "42 owner/repo")).status).toBe("executed")
  expect(calls).toEqual([["list", "owner/repo"], ["view", 42, "owner/repo"]])
  for (const payload of [{ operation: "list", number: 42 }, { number: 0, repo: "owner/repo" }, { number: 1.2 }, { number: Number.MAX_SAFE_INTEGER + 1 }, { operation: "recorded-invalid" }]) await registry.run("pr", JSON.stringify(payload))
  expect(calls).toHaveLength(2)
})
