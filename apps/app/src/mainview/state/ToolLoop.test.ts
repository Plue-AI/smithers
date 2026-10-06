import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, settled } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/**
 * A scripted chat transport double: each startTurn runs the next script step
 * against the request it received, emitting frames on the next microtask —
 * the shape of the chat worker's tool-loop contract (tool_call → done, then a
 * continuation POST with the tool result).
 */
const scriptedToolAgent = (
  steps: ReadonlyArray<(request: StartAgentTurnRequest) => ReadonlyArray<Omit<AgentTurnFrame, "runId">>>
): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const requests: Array<StartAgentTurnRequest> = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      const step = steps[requests.length] ?? steps[steps.length - 1]
      requests.push(request)
      queueMicrotask(() => {
        for (const frame of step?.(request) ?? []) {
          for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
        }
      })
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { agent, requests }
}

const newNoteCall = {
  type: "tool_call" as const,
  call_id: "call_1",
  name: "commands",
  arguments: JSON.stringify({ action: "execute", name: "wiki.new-note" })
}

describe("legacy browser tool calls", () => {
  test("refuses a tool without executing or posting a continuation", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedToolAgent([() => [newNoteCall, { type: "done", reason: "tool_call" }]])
    const controller = createAppController(store, agent)
    await controller.send("Create a note")
    await settled()
    expect(requests).toHaveLength(1)
    expect(store.collections.toolCalls.size).toBe(0)
    expect(store.session().phase).toBe("idle")
    expect([...store.collections.messages.values()].some(message => message.text.includes("host-owned conversation"))).toBe(true)
  })
})
