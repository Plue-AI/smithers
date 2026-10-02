import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"

import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

/* Ordinary explanation remains chat; no dedicated model side turn is launched. */

const bootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const recordingAgent = () => {
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: AgentPort = {
    available: true,
    startTurn: async (request) => {
      launches.push(request)
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return { agent, launches, emit }
}

const settle = async (ticks = 4) => {
  for (let tick = 0; tick < ticks; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const recorder = recordingAgent()
  const controller = createAppController(store, recorder.agent, {
    bootstrap,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: "absent", message: "no seam" } }), { status: 404 })
  })
  return { store, controller, recorder }
}

describe("ordinary explanations use chat", () => {
  test("the retired side-turn command cannot launch a model", async () => {
    const { store, controller, recorder } = await boot()
    expect(controller.commands.find("agent.explain")).toBeUndefined()
    expect((await controller.commands.run("agent.explain", "why?")).status).not.toBe("executed")
    await settle()
    expect(recorder.launches).toEqual([])
    await controller.commands.run("agent.list")
    const card = store.collections.cards.get("agents")
    expect(card?.kind === "agents" && "agents" in card.payload ? card.payload.agents.map(role => role.id) : []).not.toContain("explainer")
    expect(controller.commands.find("chat.send")).toBeDefined()
  })
})
