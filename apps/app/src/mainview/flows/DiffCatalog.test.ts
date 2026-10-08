import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { createCommandRegistry } from "./Commands"
import { stubCommandActions } from "./StubCommandActions"

test("saved diff controls retain change, revision and frame targets without executable aliases", () => {
  const cases = [
    ["change.view", "ch-1 3", { changeId: "ch-1", rev: 3, operation: "change" }],
    ["change.diff", "ch-1 parent 3 src/my notes.md", { changeId: "ch-1", from: "parent", to: "3", path: "src/my notes.md", operation: "change-diff" }],
    ["change.pins", "ch-1 2 current", { changeId: "ch-1", from: "2", to: "current", operation: "pins" }],
    ["change.checks", "ch-1 3", { changeId: "ch-1", seq: 3, operation: "checks" }],
    ["files.open-diff", 'frame-1 src/my notes.md', { cardId: "frame-1", path: "src/my notes.md", operation: "file" }]
  ] as const
  for (const [name, args, payload] of cases) {
    for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) {
      const action = schema.parse({ flow: name, args, label: "Open" })!
      expect(action.flow).toBe("diff")
      expect(JSON.parse(action.args!)).toEqual(payload)
    }
    const pending = SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name, args, requestedAt: 1, requirement: "signed-in" } }).pendingCommand!
    expect(pending.name).toBe("diff")
    expect(JSON.parse(pending.args!)).toEqual(payload)
    expect(FLOW_NAMES.includes(name as never)).toBe(false)
  }
})

test("the canonical diff dispatches each control to its existing reader without borrowing a target", async () => {
  const seen: unknown[] = []
  const registry = createCommandRegistry(stubCommandActions({
    noteCommandRun: () => {}, traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, signedOut: false, admin: false, hasConnectors: true }),
    viewChange: async (...args) => { seen.push(["change", ...args]) },
    diffChange: async (...args) => { seen.push(["change-diff", ...args]) },
    setChangePins: async (...args) => { seen.push(["pins", ...args]) },
    checksOfChangeAt: async (...args) => { seen.push(["checks", ...args]) },
    openDiffFile: async (...args) => { seen.push(["file", ...args]); return { value: "frame-1" } }
  }))
  for (const payload of [
    { operation: "change", changeId: "ch-1", rev: 3 },
    { operation: "change-diff", changeId: "ch-1", from: "parent", to: "3", path: "src/my notes.md" },
    { operation: "pins", changeId: "ch-1", from: "2", to: "current" },
    { operation: "checks", changeId: "ch-1", seq: 3 },
    { operation: "file", cardId: "frame-1", path: "src/my notes.md" }
  ]) await registry.run("diff", JSON.stringify(payload))
  expect(seen).toEqual([
    ["change", "ch-1", 3], ["change-diff", "ch-1", "parent", "3", "src/my notes.md"],
    ["pins", "ch-1", "2", "current"], ["checks", "ch-1", 3], ["file", "frame-1", "src/my notes.md"]
  ])
  const before = seen.length
  await registry.run("diff", '{"operation":"file","path":"src/my notes.md"}')
  await registry.run("diff", '{"operation":"pins","from":"2","to":"current"}')
  await registry.run("diff", '{"operation":"checks","changeId":"ch-1","seq":-1}')
  await registry.run("diff", '{"operation":"change","changeId":"ch-1","rev":1.5}')
  expect(seen).toHaveLength(before)
})
