/*
 * Jev command selection through the real controller (issue #3313). The
 * selector is the one fake: everything else is the registry, the store, the
 * prompt builder and the tool loop the app ships.
 */
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnJournalDelivery, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import type { CommandSelectRequest, CommandSelector, SelectedCommand } from "./CommandSelection"
import { CommandSelectError } from "./CommandSelection"
import { memoryStorage, settled } from "./TestFixtures"

const createAppController = scopedControllers()

const DARK_LINE = "- /appearance.dark-mode [light|dark] — "

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
  test("switch to dark mode: Jev's pick is listed in full, recorded on the message, and the model's call switches the theme", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector, asked } = fakeSelector(() => [{ name: "appearance.dark-mode", probability: 0.99 }])
    const { agent, requests } = scriptedAgent([
      () => call("call_1", { action: "execute", name: "appearance.dark-mode", args: "dark" }),
      () => say("Dark mode is on.")
    ])
    const controller = createAppController(store, agent, { commandSelector: selector })
    const before = store.session().theme
    controller.send("switch to dark mode")
    await until(() => requests.length === 2)
    await settled()

    expect(asked).toHaveLength(1)
    expect(asked[0]!.message).toBe("switch to dark mode")
    expect(asked[0]!.commands.some(command => command.name === "appearance.dark-mode")).toBe(true)
    // Pinned commands are already in the prompt, so Jev is not asked about them.
    expect(asked[0]!.commands.some(command => command.name === "auth.prompt")).toBe(false)
    expect(userMessage(store)?.disclosed).toEqual(["appearance.dark-mode"])
    expect(requests[0]!.instructions).toContain(DARK_LINE)
    // The continuation leg reuses the selection: no second request.
    expect(requests[1]!.instructions).toContain(DARK_LINE)
    expect(before).toBe("light")
    expect(store.session().theme).toBe("dark")
  })

  test("without a selection, a command neither pinned nor disclosed stays out of the prompt", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector } = fakeSelector(() => [])
    const { agent, requests } = scriptedAgent([() => say("Hello.")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("hi")
    await until(() => requests.length === 1)
    expect(userMessage(store)?.disclosed).toEqual([])
    expect(requests[0]!.instructions).not.toContain("/appearance.dark-mode")
    expect(requests[0]!.instructions).toContain("- /auth.prompt")
  })

  test("a failed selection fails the turn visibly with no model leg, and /chat.retry selects again", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let fail = true
    const { selector, asked } = fakeSelector(() => fail ? new CommandSelectError("timeout") : [{ name: "appearance.dark-mode", probability: 0.9 }])
    const { agent, requests } = scriptedAgent([() => say("Done.")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("switch to dark mode")
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

  test("a later turn keeps earlier disclosures, and chat.clear drops them with the messages", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector } = fakeSelector(request => request.message.includes("dark") ? [{ name: "appearance.dark-mode", probability: 0.9 }] : [])
    const { agent, requests } = scriptedAgent([() => say("ok")])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("switch to dark mode")
    await until(() => requests.length === 1 && store.session().phase === "idle")
    controller.send("thanks")
    await until(() => requests.length === 2 && store.session().phase === "idle")
    expect(requests[1]!.instructions).toContain(DARK_LINE)

    await controller.commands.run("chat.clear")
    await settled()
    controller.send("thanks again")
    await until(() => requests.length >= 3)
    expect(requests.at(-1)!.instructions).not.toContain("/appearance.dark-mode")
  })
})

describe("the list action's query", () => {
  test("discloses Jev's pick among undisclosed commands, records it, and the next leg lists it in full", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const { selector, asked } = fakeSelector(request => request.message === "open issue 4 and list the open pull requests"
      ? [{ name: "issues.view", probability: 0.5 }]
      : [{ name: "prs.list", probability: 0.8 }, { name: "issues.view", probability: 0.1 }])
    let toolResult = ""
    const { agent, requests } = scriptedAgent([
      () => call("call_q", { action: "list", query: "list pull requests" }),
      (request) => {
        const output = request.messages.find(item => "type" in item && item.type === "function_call_output")
        toolResult = output !== undefined && "output" in output ? output.output : ""
        return say("Listing them.")
      }
    ])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("open issue 4 and list the open pull requests")
    await until(() => requests.length === 2)
    await settled()

    expect(asked).toHaveLength(2)
    expect(asked[1]!.message).toBe("list pull requests")
    // Already-disclosed and pinned commands are not offered to the query.
    expect(asked[1]!.commands.some(command => command.name === "issues.view")).toBe(false)
    expect(asked[1]!.commands.some(command => command.name === "auth.prompt")).toBe(false)
    const listed = JSON.parse(toolResult) as { commands: Array<{ name: string; args?: string }> }
    expect(listed.commands.map(command => command.name)).toEqual(["prs.list"])
    expect(listed.commands[0]!.args).toBeDefined()
    expect(userMessage(store)?.disclosed).toEqual(["issues.view", "prs.list"])
    expect(requests[1]!.instructions).toContain("- /prs.list ")
    expect(requests[1]!.instructions).toContain("- /issues.view ")
  })

  test("a failed query is the model's coded tool failure, and the turn continues", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let calls = 0
    const { selector } = fakeSelector(() => (calls += 1) === 1 ? [] : new CommandSelectError("http"))
    let toolResult = ""
    const { agent, requests } = scriptedAgent([
      () => call("call_q", { action: "list", query: "anything" }),
      (request) => {
        const output = request.messages.find(item => "type" in item && item.type === "function_call_output")
        toolResult = output !== undefined && "output" in output ? output.output : ""
        return say("I could not look that up.")
      }
    ])
    const controller = createAppController(store, agent, { commandSelector: selector })
    controller.send("do the thing")
    await until(() => requests.length === 2)
    expect(toolResult).toMatch(/^failed: commands_select_failed \(http\):/)
  })
})

describe("the web turn path (HTTP journal)", () => {
  const journalAgent = () => {
    const starts: StartAgentTurnRequest[] = []
    const reply: AgentTurnJournalReply = { status: "error", code: "not-found" }
    let listener: ((delivery: AgentTurnJournalDelivery) => Promise<void>) | undefined
    const agent: AgentPort = {
      available: true,
      startTurn: async request => { starts.push(request); return { status: "started" } },
      cancelTurn: async () => {},
      subscribe: () => () => {},
      journal: { subscribe: next => { listener = next; return () => { listener = undefined } }, read: async () => reply, retire: async () => {}, disconnect: () => {} }
    }
    return { agent, starts, listening: () => listener !== undefined }
  }

  test("the first leg waits for selection; a failure interrupts the attempt with no POST", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let fail = false
    const { selector } = fakeSelector(() => fail ? new CommandSelectError("credit") : [{ name: "appearance.dark-mode", probability: 0.99 }])
    const remote = journalAgent()
    const controller = createAppController(store, remote.agent, { commandSelector: selector })
    controller.send("switch to dark mode")
    await until(() => remote.starts.length === 1)
    expect(remote.starts[0]!.instructions).toContain(DARK_LINE)
    expect(userMessage(store)?.disclosed).toEqual(["appearance.dark-mode"])
    await controller.commands.run("chat.stop")
    await until(() => store.session().phase === "idle")

    fail = true
    controller.send("and light mode later")
    const refusal = () => {
      const failed = [...store.collections.messages.values()].filter(message => message.role === "smithers").at(-1)
      return failed?.text ?? failed?.statusDetail ?? ""
    }
    // The send settles asynchronously: an idle phase can be read before the second send leaves it, so wait for its refusal.
    await until(() => refusal().includes("your balance is spent"))
    await until(() => store.session().phase === "idle")
    expect(remote.starts).toHaveLength(1)
  })
})
