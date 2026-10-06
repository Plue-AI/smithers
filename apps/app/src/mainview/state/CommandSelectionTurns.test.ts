/*
 * Jev command selection through the real controller (issue #3313). The
 * selector is the one fake: everything else is the registry, the store, the
 * prompt builder and the tool loop the app ships.
 */
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import type { CommandSelectRequest, CommandSelector, SelectedCommand } from "./CommandSelection"
import { CommandSelectError } from "./CommandSelection"
import { memoryStorage, settled } from "./TestFixtures"

const createAppController = scopedControllers()

const DARK_LINE = "- /theme [light|dark] — "

/** One frame without its run id, per member of the union. */
type FrameBody = AgentTurnFrame extends infer F ? F extends AgentTurnFrame ? Omit<F, "runId"> : never : never

type Step = (request: StartAgentTurnRequest) => ReadonlyArray<FrameBody>

const scriptedAgent = (steps: ReadonlyArray<Step>): { agent: AgentPort; requests: StartAgentTurnRequest[] } => {
  const requests: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      const step = steps[requests.length] ?? steps[steps.length - 1]
      requests.push(request)
      queueMicrotask(() => {
        for (const frame of step?.(request) ?? []) for (const listener of listeners) listener({ ...frame, runId: request.runId } as AgentTurnFrame)
      })
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
  }
  return { agent, requests }
}

/** A selector that answers from a table and records what it was asked. */
const fakeSelector = (answer: (request: CommandSelectRequest) => ReadonlyArray<SelectedCommand> | Error) => {
  const asked: CommandSelectRequest[] = []
  const selector: CommandSelector = async (request) => {
    asked.push(request)
    const result = answer(request)
    if (result instanceof Error) throw result
    return result
  }
  return { selector, asked }
}

const say = (text: string): ReadonlyArray<FrameBody> =>
  [{ type: "delta" as const, kind: "text" as const, text }, { type: "done" as const, reason: "stop" as const }]
const call = (id: string, args: Record<string, unknown>): ReadonlyArray<FrameBody> =>
  [{ type: "tool_call" as const, call_id: id, name: "commands", arguments: JSON.stringify(args) }, { type: "done" as const, reason: "tool_call" as const }]

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

const userMessage = (store: Awaited<ReturnType<typeof createAppStore>>) =>
  [...store.collections.messages.values()].filter(message => message.role === "user").sort((a, b) => a.ordinal - b.ordinal).at(-1)

describe("command selection before the first leg", () => {
  test("legacy selection cannot execute a tool in the browser", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector, asked } = fakeSelector(() => [{ name: "theme", probability: 0.99 }])
    const { agent, requests } = scriptedAgent([
      () => call("call_1", { action: "execute", name: "theme", args: "dark" }),
      () => say("Dark mode is on.")
    ])
    const controller = createAppController(store, agent, { commandSelector: selector })
    const before = store.session().theme
    controller.send("make it darker")
    await until(() => requests.length === 1)
    await settled()

    expect(asked).toHaveLength(1)
    expect(asked[0]!.message).toBe("make it darker")
    expect(asked[0]!.commands.some(command => command.name === "theme")).toBe(true)
    // Pinned commands are already in the prompt, so Jev is not asked about them.
    expect(asked[0]!.commands.some(command => command.name === "auth.prompt")).toBe(false)
    expect(userMessage(store)?.disclosed).toEqual(["theme"])
    expect(requests[0]!.instructions).toContain(DARK_LINE)
    // The continuation leg reuses the selection: no second request.
    expect(before).toBe("light")
    expect(store.session().theme).toBe(before)
    expect(store.collections.toolCalls.size).toBe(0)
  })

  test("without a selection, a command neither pinned nor disclosed stays out of the prompt", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector } = fakeSelector(() => [])
    const { agent, requests } = scriptedAgent([() => say("Hello.")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("hi")
    await until(() => requests.length === 1)
    expect(userMessage(store)?.disclosed).toEqual([])
    expect(requests[0]!.instructions).not.toContain("/theme")
    expect(requests[0]!.instructions).toContain("- /auth.prompt")
  })

  test("a failed selection fails the turn visibly with no model leg, and /chat.retry selects again", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let fail = true
    const { selector, asked } = fakeSelector(() => fail ? new CommandSelectError("timeout") : [{ name: "theme", probability: 0.9 }])
    const { agent, requests } = scriptedAgent([() => say("Done.")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("make it darker")
    await until(() => store.session().phase === "idle")
    expect(requests).toHaveLength(0)
    const failed = [...store.collections.messages.values()].find(message => message.role === "smithers" && message.status === "failed")
    expect(failed?.text).toContain("could not choose commands for this message: the decision model did not answer in time")
    expect(userMessage(store)?.disclosed).toBeUndefined()

    fail = false
    await controller.commands.run("chat.retry")
    await until(() => requests.length === 1)
    expect(asked).toHaveLength(2)
    expect(requests[0]!.instructions).toContain(DARK_LINE)
  })

  test("later turns keep earlier disclosures in the shared permanent conversation", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector } = fakeSelector(request => request.message.includes("dark") ? [{ name: "theme", probability: 0.9 }] : [])
    const { agent, requests } = scriptedAgent([() => say("ok")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("make it darker")
    await until(() => requests.length === 1 && store.session().phase === "idle")
    controller.send("thanks")
    await until(() => requests.length === 2 && store.session().phase === "idle")

    expect(controller.commands.find("chat.clear")).toBeUndefined()
    controller.send("thanks again")
    await until(() => requests.length >= 3)
    expect(requests.at(-1)!.instructions).toContain("/theme")
  })
})
