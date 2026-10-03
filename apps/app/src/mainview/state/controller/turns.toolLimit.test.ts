import { expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { scopedControllers } from "../ControllerTestScope"
import { memoryStorage, settle, waitFor } from "../TestFixtures"

const createAppController = scopedControllers()
type WithoutRunId<T> = T extends unknown ? Omit<T, "runId"> : never
type Frame = WithoutRunId<AgentTurnFrame>
const capMessage = "Smithers Cloud stopped this turn at its tool-call limit."
const command = {
  type: "tool_call" as const,
  call_id: "note-1",
  name: "commands",
  arguments: JSON.stringify({ action: "execute", name: "wiki.new-note" })
}
const createdNotes = (store: Awaited<ReturnType<typeof createAppStore>>) =>
  [...store.collections.worldDocuments.values()].filter(note => note.path.startsWith("Untitled"))

const fixture = async (frames: ReadonlyArray<Frame>) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const emit = (frame: AgentTurnFrame) => { for (const listener of listeners) listener(frame) }
  const agent: AgentPort = {
    available: true,
    startTurn: async request => {
      launches.push(request)
      if (launches.length === 1) queueMicrotask(() => {
        for (const frame of frames) emit({ ...frame, runId: request.runId } as AgentTurnFrame)
      })
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  const controller = createAppController(store, agent)
  controller.send("make me a note")
  await waitFor(() => launches.length === 1)
  await settle()
  const answer = store.collections.messages.get(`message-${launches[0]!.runId}-smithers`)
  return { store, launches, answer, emit }
}

for (const partial of [false, true]) test(`a terminal tool limit refuses a pending command ${partial ? "after partial text" : "before text"}`, async () => {
  const frames: Frame[] = [
    ...(partial ? [{ type: "delta" as const, kind: "text" as const, text: "Partial answer" }] : []),
    command,
    { type: "done", reason: "tool_limit", usage: { inputTokens: 17, outputTokens: 3 } }
  ]
  const f = await fixture(frames)
  expect(f.launches).toHaveLength(1)
  expect(f.store.session().phase).toBe("idle")
  expect(createdNotes(f.store)).toHaveLength(0)
  expect([...f.store.collections.toolCalls.values()]).toHaveLength(0)
  expect(f.answer?.status).toBe("failed")
  expect(f.answer?.statusDetail ?? f.answer?.text).toContain(capMessage)
  if (partial) expect(f.answer?.text).toBe("Partial answer")
  const history = await f.store.eventHistory()
  expect(history.events.filter(row => row.type === "chat.usage.recorded")).toHaveLength(1)
  f.emit({ runId: f.launches[0]!.runId, type: "delta", kind: "text", text: "late" })
  f.emit({ runId: f.launches[0]!.runId, type: "done", reason: "tool_call" })
  expect(await f.store.eventHistory()).toEqual(history)
})

test("an explicit error wins over a tool-limit reason", async () => {
  const f = await fixture([command, { type: "done", reason: "tool_limit", error: "upstream failed" }])
  expect(f.launches).toHaveLength(1)
  expect(createdNotes(f.store)).toHaveLength(0)
  expect(f.answer?.status).toBe("failed")
  expect(f.answer?.text).toContain("upstream failed")
  expect(f.answer?.text).not.toContain(capMessage)
})

test("a cancelled pending command remains interrupted", async () => {
  const f = await fixture([command, { type: "done", reason: "cancelled" }])
  expect(f.launches).toHaveLength(1)
  expect(createdNotes(f.store)).toHaveLength(0)
  expect(f.answer?.status).toBe("interrupted")
  expect(f.answer?.text).toContain("stopped by the server")
})

test("an ordinary tool-call terminal frame executes and continues", async () => {
  const f = await fixture([command, { type: "done", reason: "tool_call" }])
  await waitFor(() => f.launches.length === 2)
  expect(createdNotes(f.store)).toHaveLength(1)
  expect([...f.store.collections.toolCalls.values()]).toHaveLength(1)
  expect(f.launches[1]?.messages).toContainEqual({ type: "function_call_output", call_id: command.call_id, output: "executed /wiki.new-note" })
  f.emit({ runId: f.launches[0]!.runId, type: "done", reason: "stop" })
  await waitFor(() => f.store.session().phase === "idle")
})
