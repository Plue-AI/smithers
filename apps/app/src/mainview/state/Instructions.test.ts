/*
 * The host line of the generated instructions (docs/web-mode/PLAN.md §1).
 *
 * On the web the model is told, once, which asks belong to the native app and
 * what to execute when it gets one; on the native host the line is absent. The
 * line names `app.download.prompt`, a flow the cloud host registers — so the
 * instruction is catalog-grounded, not prompt-fragile.
 */
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentPort } from "../runtime/AgentPort"
import { executeAgentToolCall } from "../flows/agentTools"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { WEB_HOST_LINE, smithersInstructions } from "./Instructions"
import type { InstructionHonesty } from "./Instructions"
import { memoryStorage, settle } from "./TestFixtures"

const createAppController = scopedControllers()

const honesty = (): InstructionHonesty => ({
  github: { connected: false, login: null, repositories: null },
  localRepositories: [], localRepositoriesAvailable: false
})

test("the browser host line is present once and names no retired download door", () => {
  const prompt = smithersInstructions([], honesty())
  expect(prompt.split(WEB_HOST_LINE)).toHaveLength(2)
  expect(prompt).not.toContain("app.download")
})

/** An agent double that records the turn request and answers one text frame. */
const recordingAgent = (): { agent: AgentPort; requests: Array<StartAgentTurnRequest> } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const requests: Array<StartAgentTurnRequest> = []
  return {
    requests,
    agent: {
      available: true,
      startTurn: async (request) => {
        requests.push(request)
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ type: "delta", kind: "text", text: "hi", runId: request.runId } as AgentTurnFrame)
            listener({ type: "done", reason: "stop", runId: request.runId } as AgentTurnFrame)
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
  }
}

const bootstrapFor = (host: AppBootstrap["host"]): AppBootstrap =>
  host === "cloud"
    ? {
      apiVersion: 1,
      host,
      version: "test",
      buildSha: "cloud",
      capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: false }),
      authFlow: "redirect",
      sandbox: null
    }
    : {
      apiVersion: 1,
      host,
      version: "test",
      buildSha: "local",
      // The desktop shell's row: the mode line reads it, never the host name.
      capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
      authFlow: "native-handoff",
      sandbox: { platform: "darwin", mode: "enforced" }
    }

const firstTurnInstructions = async (host: AppBootstrap["host"], prompt = "hello"): Promise<{ instructions: string; names: string[] }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const { agent, requests } = recordingAgent()
  const controller = createAppController(store, agent, { bootstrap: bootstrapFor(host) })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    admin: false,
    scopesPlain: null
  })
  await settle(2)
  controller.send(prompt)
  await settle()
  expect(requests.length).toBeGreaterThan(0)
  const catalog = JSON.parse(await executeAgentToolCall(controller.commands, { name: "commands", arguments: JSON.stringify({ action: "list" }) }))
  return { instructions: requests[0]?.instructions ?? "", names: catalog.commands.map((command: { name: string }) => command.name) }
}

/*
 * The name proof (Concierge L1). A live model answered "Smith Smithers"; the
 * fix is not another adjective in the prompt but a registered flow the model
 * executes, so the sentence it reads and the line the app renders share one
 * constant. The test asks the question a user asks and reads what the model
 * is told on that turn: the one-word name and the flow that answers it, on
 * both hosts.
 */
describe("a turn asking who you are is answered with the name", () => {
  for (const host of ["cloud", "local"] as const) {
    test(`${host}: the instructions pin the one-word name without the retired identity command`, async () => {
      const { instructions, names } = await firstTurnInstructions(host, "who are you?")
      expect(instructions).toContain('Your name is exactly "Smithers"')
      expect(instructions).not.toContain("execute smithers.who")
      expect(names).not.toContain("smithers.who")
      // The retained identity rule needs no dedicated command.
      expect(instructions).not.toMatch(/^- \/smithers\.who\b.* — /m)
      expect(instructions).toContain("Your name is exactly \"Smithers\"")
      expect(instructions).toContain("Do not suggest features absent from your catalog.")
      expect(names).toContain("wiki")
    })
  }
})

describe("the turn passes the current browser host contract", () => {
  for (const host of ["cloud", "local"] as const) test(`${host} has the browser line and no download door`, async () => {
    const { instructions, names } = await firstTurnInstructions(host)
    expect(instructions).toContain(WEB_HOST_LINE)
    expect(names).not.toContain("app.download.prompt")
  })
})

describe("the command section lists pinned and disclosed commands in full, and only those", () => {
  const catalog = [
    { name: "theme", summary: "Switch to the dark theme" },
    { name: "auth.prompt", summary: "Render the sign-in button" },
    { name: "runs.list", summary: "List runs", args: "[--limit <n>]" },
    { name: "issues.list", summary: "List issues" }
  ]
  const header = 'Commands for this conversation (4 exist; the list action with a "query" finds the rest, with their arguments):'

  test("with nothing pinned or disclosed, the header counts the catalog and no command line follows", () => {
    const prompt = smithersInstructions(catalog, honesty())
    expect(prompt).toContain(`${header}\n\n`)
    for (const { name } of catalog) expect(prompt).not.toContain(`- /${name}`)
  })

  test("a disclosed command is listed with its arguments and summary; an undisclosed one stays out", () => {
    const prompt = smithersInstructions(catalog, honesty(), { pinned: ["auth.prompt"], disclosed: ["theme", "runs.list"] })
    const section = prompt.slice(prompt.indexOf(header) + header.length).split("\n\n")[0]!.trim().split("\n")
    // Catalog order, not request order; one line per command.
    expect(section).toEqual([
      "- /theme — Switch to the dark theme",
      "- /auth.prompt — Render the sign-in button",
      "- /runs.list [--limit <n>] — List runs"
    ])
    expect(prompt).not.toContain("- /issues.list")
  })

  test("a disclosed name the catalog no longer has is dropped, and a name both pinned and disclosed is listed once", () => {
    const prompt = smithersInstructions(catalog, honesty(), { pinned: ["runs.list"], disclosed: ["runs.list", "gone.command"] })
    expect(prompt.split("- /runs.list")).toHaveLength(2)
    expect(prompt).not.toContain("gone.command")
  })
})

describe("the prompt's surface examples", () => {
  test("name no default-off feature, in either flag state", () => {
    const prompt = smithersInstructions([], honesty())
    expect(prompt).toContain("When a surface is involved (wiki, browser)")
    expect(prompt).not.toContain("(world, connect, browser)")
  })
})
