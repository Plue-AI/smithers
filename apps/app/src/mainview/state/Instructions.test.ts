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
import { IDENTITY_LINE, NO_DOWNLOAD_LINE, instructionStageOf, smithersInstructions, WEB_HOST_LINE } from "./Instructions"
import type { InstructionHonesty } from "./Instructions"
import { memoryStorage, settle } from "./TestFixtures"

const createAppController = scopedControllers()

const honesty = (host: InstructionHonesty["host"], nativeDownloadable?: boolean): InstructionHonesty => ({
  host,
  ...(nativeDownloadable === undefined ? {} : { nativeDownloadable }),
  github: { connected: false, login: null, repositories: null },
  localRepositories: [],
  localRepositoriesAvailable: host === "native"
})

describe("the host line", () => {
  test("the web app states what needs the native app, that code intelligence is among them, that the GitHub sign-in is the Cloud sign-in, and what to execute when asked", () => {
    const prompt = smithersInstructions([], honesty("web", true))
    expect(prompt).toContain(WEB_HOST_LINE)
    expect(WEB_HOST_LINE).toBe(
      "This is the Smithers web app. Local repositories, local terminals, build targets, local agents, code intelligence (hover, definitions, diagnostics) need the native app; when asked for one, say so and execute app.download.prompt. On the web the GitHub sign-in is the Smithers Cloud sign-in — there is no separate Cloud sign-in to offer."
    )
    expect(prompt.split(WEB_HOST_LINE)).toHaveLength(2)
    // A published native build: no caveat.
    expect(prompt).not.toContain(NO_DOWNLOAD_LINE)
  })

  test("while no native release carries an asset the web line says the app is not downloadable, from the live fact", () => {
    for (const prompt of [smithersInstructions([], honesty("web")), smithersInstructions([], honesty("web", false))]) {
      expect(prompt).toContain(`${WEB_HOST_LINE} ${NO_DOWNLOAD_LINE}`)
      expect(prompt.split(NO_DOWNLOAD_LINE)).toHaveLength(2)
    }
    expect(smithersInstructions([], honesty("native"))).not.toContain(NO_DOWNLOAD_LINE)
  })

  test("the native app carries no such line", () => {
    expect(smithersInstructions([], honesty("native"))).not.toContain("Smithers web app")
  })
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
      capabilities: localCapabilities({ agent: true, identity: true, cloud: true, nativeShell: true }),
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
    allowlisted: true,
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
    test(`${host}: the instructions pin the one-word name, name smithers.who, and the catalog lists it`, async () => {
      const { instructions, names } = await firstTurnInstructions(host, "who are you?")
      expect(instructions).toContain(IDENTITY_LINE)
      expect(IDENTITY_LINE).toContain("answer with the single word Smithers")
      expect(IDENTITY_LINE).toContain("execute smithers.who")
      expect(names).toContain("smithers.who")
      expect(instructions).toContain(instructionStageOf(instructions) === 3 ? "smithers (" : "/smithers.who")
      expect(instructions).toContain("Your name is exactly \"Smithers\"")
      expect(instructions).toContain("Do not suggest features absent from your catalog.")
      expect(names).toContain("wiki")
    })
  }
})

describe("the turn passes the host from the bootstrap", () => {
  test("a cloud bootstrap's turn carries the web line and the flow it names", async () => {
    const { instructions, names } = await firstTurnInstructions("cloud")
    expect(instructions).toContain(WEB_HOST_LINE)
    // The line names a flow this host's catalog actually has.
    expect(names).toContain("app.download.prompt")
    expect(instructions).toContain(instructionStageOf(instructions) === 3 ? "app (" : "/app.download.prompt")
    // And the live download fact: no native release carries an asset today (AppLinks.ts).
    expect(instructions).toContain(NO_DOWNLOAD_LINE)
  })

  test("a local bootstrap's turn carries neither", async () => {
    const { instructions } = await firstTurnInstructions("local")
    expect(instructions).not.toContain("Smithers web app")
    expect(instructions).not.toContain("/app.download.prompt")
  })
})

describe("the prompt's surface examples", () => {
  test("name no default-off feature, in either flag state", () => {
    const prompt = smithersInstructions([], honesty("web"))
    expect(prompt).toContain("When a surface is involved (connect, browser)")
    expect(prompt).not.toContain("(world, connect, browser)")
  })
})
