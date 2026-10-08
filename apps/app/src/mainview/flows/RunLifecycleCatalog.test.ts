import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { createCommandRegistry } from "./Commands"
import { stubCommandActions } from "./StubCommandActions"

test("recorded lifecycle controls retain run, reason and source without executable aliases", () => {
  for (const [name, args, payload] of [
    ["flow.run.stop", "run-1 keep the original reason", { cardId: "run-1", reason: "keep the original reason", operation: "stop" }],
    ["flow.run.retry", "request-1", { cardId: "request-1", operation: "retry" }],
    ["flow.run.stop-all", "sourceCard=list-1 owner/repo", { repo: "owner/repo", sourceCard: "list-1", operation: "stop-all" }]
  ] as const) {
    for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
      const action = schema.parse({ flow: name, args, label: "Run" })!
      expect(action.flow).toBe("flow.run")
      expect(JSON.parse(action.args!)).toEqual(payload)
    }
    const pending = SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name, args, requestedAt: 1, requirement: "signed-in" } }).pendingCommand!
    expect(pending.name).toBe("flow.run")
    expect(JSON.parse(pending.args!)).toEqual(payload)
    expect(FLOW_NAMES.includes(name as never)).toBe(false)
  }
})

test("one lifecycle door retains person execution, agent confirmation and target separation", async () => {
  const seen: unknown[] = [], confirmations: unknown[] = []
  const registry = createCommandRegistry(stubCommandActions({
    noteCommandRun: () => {}, traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, signedOut: false, admin: false, hasConnectors: true }),
    stopWatchingRun: (...args) => { seen.push(["stop", ...args]) },
    retryRunWatch: (...args) => { seen.push(["retry", ...args]) },
    stopAllRuns: async (...args) => { seen.push(["stop-all", ...args]) },
    requestFlowConfirmation: (...args) => { confirmations.push(args) }
  }))
  for (const payload of [
    { operation: "stop", cardId: "run-1", reason: "the original reason" },
    { operation: "retry", cardId: "request-1" },
    { operation: "stop-all", repo: "owner/repo", sourceCard: "list-1" }
  ]) {
    const outcome = await registry.runAsAgent("flow.run", JSON.stringify(payload))
    expect(outcome.status).toBe("executed")
    expect("value" in outcome ? outcome.value : "").toContain("asked the user to confirm")
    expect(seen).toEqual([])
  }
  expect(confirmations.map(row => (row as string[])[0])).toEqual(["flow.run", "flow.run", "flow.run"])
  expect(confirmations.map(row => JSON.parse((row as string[])[1]!))).toEqual([
    { operation: "stop", cardId: "run-1", reason: "the original reason" },
    { operation: "retry", cardId: "request-1" },
    { operation: "stop-all", repo: "owner/repo", sourceCard: "list-1" }
  ])
  for (const payload of [
    { operation: "stop", cardId: "run-1", reason: "the original reason" },
    { operation: "retry", cardId: "request-1" },
    { operation: "stop-all", repo: "owner/repo", sourceCard: "list-1" }
  ]) await registry.run("flow.run", JSON.stringify(payload))
  expect(seen).toEqual([["stop", "run-1", "the original reason"], ["retry", "request-1"], ["stop-all", "owner/repo", "list-1"]])
  for (const payload of [ { operation: "stop", cardId: "run-1", name: "todo" }, { operation: "retry", repo: "other/repo" }, { operation: "stop-all", cardId: "run-1" }, { operation: "invented", cardId: "run-1" } ]) await registry.run("flow.run", JSON.stringify(payload))
  expect(seen).toHaveLength(3)
})
