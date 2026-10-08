import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { createCommandRegistry } from "./Commands"
import { stubCommandActions } from "./StubCommandActions"

test("recorded workspace doors preserve recovery and repository identity without executable aliases", () => {
  for (const [name, args, flow, payload] of [
    ["box.open", "main owner/repo --kind vm --snapshot snap --recoveryOf original", "branch", { bookmark: "main", repo: "owner/repo", kind: "vm", snapshot: "snap", recoveryOf: "original", operation: "workspace-open" }],
    ["box.view", "original", "branch", { workspaceId: "original", operation: "workspace-view" }],
    ["box.list", "owner/repo", "branches", { repo: "owner/repo", operation: "workspace" }]
  ] as const) {
    for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
      const action = schema.parse({ flow: name, args, label: "Branch" })!
      expect(action.flow).toBe(flow)
      expect(JSON.parse(action.args!)).toEqual(payload)
    }
    const pending = SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name, args, requestedAt: 1, requirement: "signed-in" } }).pendingCommand!
    expect(pending.name).toBe(flow)
    expect(JSON.parse(pending.args!)).toEqual(payload)
    expect(FLOW_NAMES.includes(name as never)).toBe(false)
  }
})

test("invalid recorded recovery and cancellation inputs never gain an implicit target", async () => {
  const calls: unknown[] = []
  const registry = createCommandRegistry(stubCommandActions({
    noteCommandRun: () => {}, traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, signedOut: false, admin: false, hasConnectors: true }),
    openWorkspace: async (...args) => { calls.push(args) }, stopAllRuns: async (...args) => { calls.push(args) }
  }))
  for (const [flow, args] of [["box.open", "--snapshot"], ["box.open", "--unknown"], ["box.open", "[]"], ["box.open", "null"], ["box.open", "{"], ["flow.run.stop-all", "--unknown"]]) {
    const action = MessageSchema.shape.action.parse({ flow, args, label: "Retry" })!
    expect((await registry.run(action.flow, action.args)).status).toBe("failed")
  }
  expect(calls).toEqual([])
})
