import { afterEach, expect, test } from "bun:test"
import { AgentTurnFrameSchema, type AgentTurnFrame, type StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { memoryStorage, waitFor } from "../TestFixtures"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Transport-boundary unit double. Native frames enter the actual subscription;
// event persistence and projection use the real Map-backed AppStore.
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const requests: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { requests.push(request); return { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const controller = createAppController(store, agent, { fetchImpl: async () => Response.json({}, { status: 404 }) })
  cleanups.push(() => controller.dispose())
  expect(await controller.send("Observe this turn")).toBe(true)
  expect(requests).toHaveLength(1)
  const runId = requests[0]!.runId
  const emit = (frame: AgentTurnFrame) => {
    const admitted = AgentTurnFrameSchema.parse(frame)
    for (const listener of listeners) listener(admitted)
  }
  const rows = () => [...store.collections.messages.values()].filter(row => row.role === "smithers").sort((a, b) => a.ordinal - b.ordinal)
  const authored = () => emit({ runId, type: "link.authored", link: 0, scriptDigest: "debug-script-digest",
    script: "debug-only authored source" })
  const flush = async () => { await store.settled?.() }
  const messageEvents = async () => (await store.eventHistory()).events
    .filter(event => event.type.startsWith("message."))
    .map(event => ({ type: event.type, actor: event.actor }))
  const billingSettled = () => waitFor(() => [...store.collections.transitions.values()]
    .some(event => event.type === "billing.unavailable"))
  return { store, requests, runId, emit, rows, authored, flush, messageEvents, billingSettled }
}

for (const verdict of ["run", "hit", "replay"] as const) {
  test(`a settled command receipt projects its act durably without executing another command (${verdict})`, async () => {
    const f = await fixture()
    f.authored()
    f.emit({ runId: f.runId, type: "call.started", link: 0, ordinal: 0, name: "files.read" })
    await f.flush()
    expect(f.rows()).toEqual([])
    f.emit({ runId: f.runId, type: "call.settled", link: 0, ordinal: 0, name: "files.read", verdict,
      resultDigest: "debug-result-digest" })
    await f.flush()
    expect(f.rows().map(row => ({ text: row.text, act: row.act, turnId: row.turnId, status: row.status }))).toEqual([
      { text: "Smithers ran /files.read", act: "Smithers ran /files.read", turnId: f.runId, status: "complete" }
    ])
    expect(f.store.session().phase).toBe("responding")
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(f.rows())).not.toContain("debug-")
    f.emit({ runId: f.runId, type: "done", reason: "stop" })
    await f.flush()
    expect(f.store.session().phase).toBe("idle")
    expect(await f.messageEvents()).toEqual([
      { type: "message.submitted", actor: "user" },
      { type: "message.tool.executed", actor: "smithers" },
      { type: "message.response.completed", actor: "smithers" }
    ])
  })
}

test("harness calls and link bookkeeping never become transcript acts or command execution", async () => {
  const f = await fixture()
  const before = await f.store.eventHistory()
  for (const [ordinal, name] of ["author", "say", "card.show", "card.update", "sys/check"].entries()) {
    f.emit({ runId: f.runId, type: "call.started", link: 0, ordinal, name })
    f.emit({ runId: f.runId, type: "call.settled", link: 0, ordinal, name, verdict: "run" })
  }
  for (const outcome of ["to", "park", "done"] as const) f.emit({ runId: f.runId, type: "link.ended", link: 0, outcome })
  await f.flush()
  expect(f.rows()).toEqual([])
  expect(await f.store.eventHistory()).toEqual(before)
  expect(f.store.session().phase).toBe("responding")
  expect(f.requests).toHaveLength(1)
  expect([...f.store.collections.cards.values()]).toEqual([])
})

for (const [code, text] of [
  ["approval", undefined],
  ["quota", "Smithers paused — this turn ran out of budget."],
  ["event", "Smithers paused — it is waiting on something outside this chat."],
  ["timer", "Smithers paused — it is waiting on something outside this chat."],
  ["plugin", "Smithers paused — it is waiting on something outside this chat."]
] as const) {
  test(`a ${code} park has its literal transcript effect without prematurely settling the turn`, async () => {
    const f = await fixture()
    f.authored()
    f.emit({ runId: f.runId, type: "park", code })
    await f.flush()
    expect(f.rows().map(row => ({ text: row.text, status: row.status, act: row.act }))).toEqual(
      text === undefined ? [] : [{ text, status: "complete", act: undefined }]
    )
    expect(f.store.session().phase).toBe("responding")
    expect(await f.messageEvents()).toEqual(text === undefined
      ? [{ type: "message.submitted", actor: "user" }]
      : [{ type: "message.submitted", actor: "user" }, { type: "message.appended", actor: "system" }])
    f.emit({ runId: f.runId, type: "done", reason: "stop" })
    await f.flush()
    expect(f.store.session().phase).toBe("idle")
    expect(f.rows().map(row => row.text)).toEqual(text === undefined ? [] : [text])
    expect(f.requests).toHaveLength(1)
  })
}

test("gate recovery and drained steering render literal acts in arrival order, excluding debug diagnostics", async () => {
  const f = await fixture()
  f.authored()
  f.emit({ runId: f.runId, type: "gate.rejected", link: 0, kind: "denied", message: "sensitive debug refusal" })
  f.emit({ runId: f.runId, type: "steering.drained", link: 1, count: 3 })
  f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Adjusted answer." })
  f.emit({ runId: f.runId, type: "done", reason: "stop" })
  await f.flush()
  expect(f.rows().map(row => ({ text: row.text, act: row.act, status: row.status }))).toEqual([
    { text: "Smithers adjusted its approach", act: "Smithers adjusted its approach", status: "complete" },
    { text: "Smithers picked up your note", act: "Smithers picked up your note", status: "complete" },
    { text: "Adjusted answer.", act: undefined, status: "complete" }
  ])
  expect(JSON.stringify(f.rows())).not.toContain("sensitive debug refusal")
  expect(await f.messageEvents()).toEqual([
    { type: "message.submitted", actor: "user" },
    { type: "message.tool.executed", actor: "smithers" },
    { type: "message.tool.executed", actor: "smithers" },
    { type: "message.response.delta", actor: "smithers" },
    { type: "message.response.completed", actor: "smithers" }
  ])
})

test("foreign chain frames and frames after completion cannot append acts or reopen a settled turn", async () => {
  const f = await fixture()
  const observations = (runId: string): AgentTurnFrame[] => [
    { runId, type: "call.settled", link: 0, ordinal: 0, name: "files.read", verdict: "run" },
    { runId, type: "park", code: "quota" },
    { runId, type: "gate.rejected", link: 0, kind: "fuel" },
    { runId, type: "steering.drained", link: 0, count: 1 },
    { runId, type: "link.authored", link: 0, scriptDigest: "foreign", script: "foreign source" }
  ]
  const before = await f.store.eventHistory()
  for (const frame of observations("foreign-run")) f.emit(frame)
  await f.flush()
  expect(await f.store.eventHistory()).toEqual(before)
  expect(f.store.session().phase).toBe("responding")
  f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Final answer." })
  f.emit({ runId: f.runId, type: "done", reason: "stop" })
  await f.flush()
  // Observe actual billing completion before freezing the durable history.
  await f.billingSettled()
  await f.flush()
  const completed = await f.store.eventHistory()
  for (const frame of observations(f.runId)) f.emit(frame)
  await f.flush()
  expect(await f.store.eventHistory()).toEqual(completed)
  expect(f.rows().map(row => row.text)).toEqual(["Final answer."])
  expect(f.store.session().phase).toBe("idle")
  expect(f.requests).toHaveLength(1)
})
