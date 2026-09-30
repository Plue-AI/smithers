import { afterEach, expect, test } from "bun:test"
import { AgentTurnFrameSchema, type AgentTurnFrame, type StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, waitFor } from "../TestFixtures"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Typed transport unit double; commands and projection use the real controller,
// catalog, and Map-backed store. No provider, HTTP socket, or SQL is involved.
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const starts: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: string[] = []
  const agent: AgentPort = {
    available: true,
    startTurn: async request => { starts.push(request); return { status: "started" } },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const controller = createAppController(store, agent, {
    fetchImpl: async input => {
      requests.push(new URL(String(input), "https://app.test").pathname)
      return Response.json({ error: "unit boundary unavailable" }, { status: 404 })
    }
  })
  cleanups.push(() => controller.dispose())
  expect(await controller.send("make a note")).toBe(true)
  expect(starts).toHaveLength(1)
  const runId = starts[0]!.runId
  const emit = (frame: AgentTurnFrame) => {
    const admitted = AgentTurnFrameSchema.parse(frame)
    for (const listener of listeners) listener(admitted)
  }
  const pendingCall = (callId = "note-call") => emit({ runId, type: "tool_call", call_id: callId, name: "commands",
    arguments: JSON.stringify({ action: "execute", name: "world.new-note" }) })
  const answers = () => [...store.collections.messages.values()].filter(row => row.role === "smithers" && row.act === undefined)
  return { store, starts, requests, emit, pendingCall, runId, answers }
}

const capMessage = "Smithers Cloud stopped this turn at its tool-call limit."
for (const partial of [false, true]) {
  test(`a terminal tool limit rejects a pending command without executing or continuing (${partial})`, async () => {
    const f = await fixture()
    if (partial) f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Partial answer" })
    f.pendingCall()
    f.emit({ runId: f.runId, type: "done", reason: "tool_limit" })
    // Bounded on the regression too: an incorrect continuation is observable.
    await waitFor(() => f.starts.length > 1 || f.store.session().phase === "idle")
    expect(f.starts).toHaveLength(1)
    expect([...f.store.collections.worldDocuments.values()]).toEqual([])
    expect([...f.store.collections.messages.values()].filter(row => row.act !== undefined)).toEqual([])
    expect(f.answers().map(row => ({ text: row.text, status: row.status, detail: row.statusDetail }))).toEqual([
      { text: partial ? "Partial answer" : `I couldn't complete that turn. ${capMessage}`, status: "failed", detail: partial ? capMessage : undefined }
    ])
    await settle()
    expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
    const history = await f.store.eventHistory()
    f.pendingCall()
    f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Late overwrite" })
    f.emit({ runId: f.runId, type: "done", reason: "stop" })
    await settle()
    expect(await f.store.eventHistory()).toEqual(history)
    expect(f.starts).toHaveLength(1)
    expect([...f.store.collections.worldDocuments.values()]).toEqual([])
    expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
  })
}

for (const terminal of [
  { reason: "cancelled", status: "interrupted", detail: "That turn was stopped by the server." },
  { reason: "stop", error: "Provider ended the stream", status: "failed", detail: "Provider ended the stream" },
  { reason: "cancelled", error: "Cancellation transport failed", status: "failed", detail: "Cancellation transport failed" },
  { reason: "tool_limit", error: "Cap transport failed", status: "failed", detail: "Cap transport failed" }
] as const) {
  test(`terminal ${terminal.reason}/${"error" in terminal ? terminal.error : "no error"} outranks a pending call and ignores later frames`, async () => {
    const f = await fixture()
    f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Partial answer" })
    f.pendingCall()
    f.emit({ runId: f.runId, type: "done", reason: terminal.reason,
      ...("error" in terminal ? { error: terminal.error } : {}) })
    await waitFor(() => f.store.session().phase === "idle")
    await settle()
    expect(f.answers().map(row => ({ text: row.text, status: row.status, detail: row.statusDetail }))).toEqual([
      { text: "Partial answer", status: terminal.status, detail: terminal.detail }
    ])
    expect(f.starts).toHaveLength(1)
    expect([...f.store.collections.worldDocuments.values()]).toEqual([])
    expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
    const history = await f.store.eventHistory()
    f.pendingCall()
    f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Late overwrite" })
    f.emit({ runId: f.runId, type: "done", error: "Late failure" })
    f.emit({ runId: "foreign-run", type: "done", reason: "stop" })
    await settle()
    expect(await f.store.eventHistory()).toEqual(history)
    expect(f.starts).toHaveLength(1)
    expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
  })
}

test("ordinary tool completion continues once with the exact result and bills only after the resumed answer", async () => {
  const f = await fixture()
  f.pendingCall()
  f.emit({ runId: f.runId, type: "done", reason: "tool_call" })
  await waitFor(() => f.starts.length === 2)
  expect(f.starts[1]!.runId).toBe(f.runId)
  expect(f.starts[1]!.messages.filter(message => "type" in message)).toEqual([
    { type: "function_call", call_id: "note-call", name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "world.new-note" }) },
    { type: "function_call_output", call_id: "note-call", output: "executed /world.new-note" }
  ])
  expect([...f.store.collections.worldDocuments.values()]).toHaveLength(1)
  expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(0)
  f.emit({ runId: f.runId, type: "delta", kind: "text", text: "Your note is ready." })
  f.emit({ runId: f.runId, type: "done", reason: "stop" })
  await waitFor(() => f.store.session().phase === "idle")
  await settle()
  expect(f.answers().map(row => ({ text: row.text, status: row.status }))).toEqual([
    { text: "Your note is ready.", status: "complete" }
  ])
  expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
})

test("reasoning, empty text, and foreign prose do not substitute for an answer", async () => {
  const f = await fixture()
  f.emit({ runId: f.runId, type: "delta", kind: "reasoning", text: "Private reasoning" })
  f.emit({ runId: f.runId, type: "delta", kind: "text", text: "" })
  f.emit({ runId: "foreign-run", type: "delta", kind: "text", text: "Someone else's answer" })
  f.emit({ runId: f.runId, type: "done", reason: "stop" })
  await waitFor(() => f.store.session().phase === "idle")
  expect(f.answers().map(row => ({ text: row.text, reasoning: row.reasoning, status: row.status, detail: row.statusDetail }))).toEqual([
    { text: "", reasoning: "Private reasoning", status: "failed", detail: "Smithers Cloud returned an empty response." }
  ])
})

test("an authored chain counts as work even without a prose response", async () => {
  const f = await fixture()
  f.emit({ runId: f.runId, type: "link.authored", link: 0, scriptDigest: "authored-script", script: "card.show({})" })
  f.emit({ runId: f.runId, type: "done", reason: "stop" })
  await waitFor(() => f.store.session().phase === "idle")
  await settle()
  expect(f.answers()).toEqual([])
  expect([...f.store.collections.transitions.values()].filter(row => row.type === "message.response.failed")).toEqual([])
  expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
})


test("a server tool cap keeps its diagnostic at the client continuation ceiling", async () => {
  const f = await fixture()
  for (let leg = 0; leg < 8; leg += 1) {
    f.pendingCall(`note-leg-${leg}`)
    f.emit({ runId: f.runId, type: "done", reason: "tool_call" })
    await waitFor(() => f.starts.length === leg + 2)
  }
  expect([...f.store.collections.worldDocuments.values()]).toHaveLength(8)
  expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(0)
  f.pendingCall("blocked-note-call")
  f.emit({ runId: f.runId, type: "done", reason: "tool_limit" })
  await waitFor(() => f.store.session().phase === "idle")
  await settle()
  expect(f.starts).toHaveLength(9)
  expect([...f.store.collections.worldDocuments.values()]).toHaveLength(8)
  expect(f.answers().map(row => ({ text: row.text, status: row.status }))).toEqual([
    { text: `I couldn't complete that turn. ${capMessage}`, status: "failed" }
  ])
  expect(f.requests.filter(path => path === "/api/billing/balance")).toHaveLength(1)
})
