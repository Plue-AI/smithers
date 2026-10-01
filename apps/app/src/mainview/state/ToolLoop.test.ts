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
  arguments: JSON.stringify({ action: "execute", name: "world.new-note" })
}

describe("the client-side agent tool loop", () => {
  test("tool_call → registry execution → continuation POST → resumed stream", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedToolAgent([
      () => [newNoteCall, { type: "done" as const, reason: "tool_call" as const }],
      (request) => {
        // The continuation leg: assert the contract shape mid-flight.
        const items = request.messages.filter((m) => "type" in m)
        expect(items).toEqual([
          {
            type: "function_call",
            call_id: "call_1",
            name: "commands",
            arguments: newNoteCall.arguments
          },
          { type: "function_call_output", call_id: "call_1", output: "executed /world.new-note" }
        ])
        return [
          { type: "delta" as const, kind: "text" as const, text: "Done — the note exists." },
          { type: "done" as const, reason: "stop" as const }
        ]
      }
    ])
    const controller = createAppController(store, agent)

    controller.send("make me a note")
    await settled()
    await settled()

    // Two legs: the initial turn and the continuation, same runId.
    expect(requests).toHaveLength(2)
    expect(requests[1]?.runId).toBe(requests[0]?.runId)
    // Every leg carries the one tool spec.
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["commands"])
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(["commands"])

    // The command actually ran through the registry: the note is in the store.
    const notes = [...store.collections.worldDocuments.values()].filter((document) =>
      document.path.startsWith("Untitled")
    )
    expect(notes).toHaveLength(1)

    // The act is visible — nothing completes silently.
    const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined)
    expect(acts.map((message) => message.text)).toEqual(["Smithers ran /world.new-note"])
    // The journal records the agent as the actor of its own act.
    const journal = [...store.collections.transitions.values()]
    expect(journal.some((r) => r.type === "message.tool.executed" && r.actor === "smithers")).toBe(true)
    expect(journal.some((r) => r.type === "world.document.upserted" && r.actor === "smithers")).toBe(true)

    // The resumed stream rendered and the turn completed.
    const final = [...store.collections.messages.values()].find((m) => m.text === "Done — the note exists.")
    expect(final?.status).toBe("complete")
    expect(store.session().phase).toBe("idle")
  })

  /*
   * #3311: on smithers.sh "switch to dark mode" did not switch. The model
   * names the mode, so the turn ends dark whether the app started light or
   * dark (the bare toggle turned an already-dark app light).
   */
  for (const from of ["light", "dark"] as const) {
    test(`"switch to dark mode" from ${from} executes /appearance.dark-mode dark and ends dark`, async () => {
      const store = await webStore()
      store.dispatch({ type: "theme.changed", actor: "user", theme: from })
      const darkCall = {
        type: "tool_call" as const,
        call_id: "call_dark",
        name: "commands",
        arguments: JSON.stringify({ action: "execute", name: "appearance.dark-mode", args: "dark" })
      }
      const { agent, requests } = scriptedToolAgent([
        () => [darkCall, { type: "done" as const, reason: "tool_call" as const }],
        () => [
          { type: "delta" as const, kind: "text" as const, text: "Dark mode is on." },
          { type: "done" as const, reason: "stop" as const }
        ]
      ])
      const controller = createAppController(store, agent)
      controller.send("switch to dark mode")
      await settled()
      await settled()

      const output = requests[1]?.messages.find((m) => "type" in m && m.type === "function_call_output")
      expect(output !== undefined && "output" in output ? output.output : undefined).toBe("executed /appearance.dark-mode")
      expect(store.session().theme).toBe("dark")
      expect(store.session().phase).toBe("idle")
    })
  }

  test("a slash-spelled command name still runs, and the act line never doubles the slash", async () => {
    // Live on canary the model wrote {"name":"/browser"} — the catalog's own
    // spelling — and the transcript read "Smithers tried //browser —
    // unknown-command: /browser". Both halves are pinned here: the execution
    // normalizes, and the act line renders /name once.
    const store = await webStore()
    const slashCall = {
      type: "tool_call" as const,
      call_id: "call_s",
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "/world.new-note" })
    }
    const { agent, requests } = scriptedToolAgent([
      () => [slashCall, { type: "done" as const, reason: "tool_call" as const }],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Done — the note exists." },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("make me a note")
    await settled()
    await settled()

    const output = requests[1]?.messages.find((m) => "type" in m && m.type === "function_call_output")
    expect(output !== undefined && "output" in output ? output.output : undefined).toBe(
      "executed /world.new-note"
    )
    const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined)
    expect(acts.map((message) => message.text)).toEqual(["Smithers ran /world.new-note"])
  })

  test("null tool input is returned to the model and the turn can finish", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedToolAgent([
      () => [
        { type: "tool_call" as const, call_id: "null-call", name: "commands", arguments: "null" },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "I can correct that input." },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    try {
      controller.send("read the file")
      await settled(); await settled()
      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages).toContainEqual({ type: "function_call_output", call_id: "null-call", output: "failed: the commands tool arguments must be an object" })
      expect(store.session().phase).toBe("idle")
    } finally { controller.dispose() }
  })

  test("a pending confirmation is described without claiming the flow ran", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedToolAgent([
      () => [
        { type: "tool_call" as const, call_id: "clear", name: "commands", arguments: JSON.stringify({ action: "execute", name: "chat.clear" }) },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [{ type: "done" as const, reason: "stop" as const }]
    ])
    const controller = createAppController(store, agent)
    try {
      controller.send("start a fresh conversation")
      await settled(); await settled()
      expect(requests).toHaveLength(2)
      const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined)
      expect(acts.map((message) => message.text)).toEqual(["Smithers asked for confirmation of /chat.clear"])
      // The conversation is untouched until the human confirms: the ask is a message with the flow attached.
      expect([...store.collections.messages.values()].some((message) => message.action?.flow === "chat.clear")).toBe(true)
    } finally { controller.dispose() }
  })

  test("an unknown tool name returns an honest tool-result error to the model, never a crash", async () => {
    const store = await webStore()
    const { agent, requests } = scriptedToolAgent([
      () => [
        { type: "tool_call" as const, call_id: "call_x", name: "not-a-tool", arguments: "{}" },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Understood, no such tool." },
        { type: "done" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("do something odd")
    await settled()
    await settled()

    expect(requests).toHaveLength(2)
    const output = requests[1]?.messages.find((m) => "type" in m && m.type === "function_call_output")
    expect(output !== undefined && "output" in output ? output.output : undefined).toBe(
      "unknown-tool: not-a-tool"
    )
    // The turn still completes cleanly; the act line is honest about the attempt.
    expect(store.session().phase).toBe("idle")
    const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined)
    expect(acts[0]?.text).toContain("Smithers tried not-a-tool")
    expect(acts[0]?.text).toContain("unknown-tool")
  })

  test("the loop caps client-side legs and ends with an honest limit line", async () => {
    const store = await webStore()
    // Every leg asks for another tool call — a model that never stops.
    const { agent, requests } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: `call_${requests.length}`,
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "appearance.theme" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("loop forever")
    for (let i = 0; i < 20; i += 1) await settled()

    // 1 initial leg + 8 capped continuations (mirroring the server cap), then stop.
    expect(requests).toHaveLength(9)
    const failed = [...store.collections.messages.values()].find((m) => m.status === "failed")
    // No text ever streamed, so the honest limit line IS the message body.
    expect(failed?.text).toContain("tool-call limit")
    expect(store.session().phase).toBe("idle")
    const acts = [...store.collections.messages.values()].filter((message) => message.act !== undefined)
    expect(acts).toHaveLength(8)
  })

  test("a server-side kill during a pending tool call stops the turn instead of continuing it", async () => {
    const store = await webStore()
    // The kill lands between the model's tool_call frame and the upstream's
    // own done: the Worker injects done:cancelled instead. That must end the
    // turn — not run the tool and POST another leg (checklist B-3).
    const { agent, requests } = scriptedToolAgent([
      () => [newNoteCall, { type: "done" as const, reason: "cancelled" as const }]
    ])
    const controller = createAppController(store, agent)
    controller.send("make me a note")
    for (let i = 0; i < 5; i += 1) await settled()

    // One leg only: the killed turn never continued.
    expect(requests).toHaveLength(1)
    // The tool never ran, so no note and no act line.
    expect([...store.collections.worldDocuments.values()].filter((d) => d.path.startsWith("Untitled"))).toHaveLength(0)
    expect([...store.collections.messages.values()].filter((m) => m.act !== undefined)).toHaveLength(0)
    // And the kill is visible, never silence.
    const stopped = [...store.collections.messages.values()].find((m) => m.status === "interrupted")
    expect(stopped?.statusDetail ?? stopped?.text).toBe("That turn was stopped by the server.")
    expect(store.session().phase).toBe("idle")
  })

  test("a server-side tool_limit done reason surfaces the same honest failure", async () => {
    const store = await webStore()
    const { agent } = scriptedToolAgent([
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Partial answer." },
        { type: "done" as const, reason: "tool_limit" as const }
      ]
    ])
    const controller = createAppController(store, agent)
    controller.send("hello")
    await settled()
    const failed = [...store.collections.messages.values()].find((m) => m.status === "failed")
    expect(failed?.statusDetail).toContain("tool-call limit")
  })
})
