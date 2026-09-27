import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness } from "@smthrs/rpc/LocalApp"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"

import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { smithersInstructions } from "./Instructions"
import { memoryStorage } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The named roles end to end. Launching one as a local CLI retired with the
 * local backend (docs/LOCAL-BACKEND-RETIREMENT.md), so what is left is the
 * side turn: `agent.explain` answers as a card on the explainer role, and the
 * orchestrator's instructions name only what this host can reach. No real
 * model is touched: the agent is a recorder.
 */


const bootstrap: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "1.0.0",
  buildSha: "abcdef1234567890",
  capabilities: ["agent"],
  authFlow: "none",
  sandbox: { platform: "darwin", mode: "enforced" }
}

const harness = (overrides: Partial<Harness> & Pick<Harness, "id" | "status">): Harness => ({
  displayName: overrides.id,
  binary: overrides.status === "unavailable" ? null : `/usr/local/bin/${overrides.id}`,
  version: "1.0.0",
  account: null,
  launch: { argv: [overrides.id] },
  ...overrides
})

const HARNESSES: ReadonlyArray<Harness> = [
  harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" } }),
  harness({ id: "codex", displayName: "Codex", status: "signed-in", account: { email: "will@example.com" } }),
  harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "api-key", account: { label: "KIMI_API_KEY" } }),
  harness({ id: "opencode-cerebras", displayName: "OpenCode · Cerebras", status: "binary-only" })
]

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
  store.dispatch({ type: "harnesses.loaded", actor: "system", harnesses: [...HARNESSES] })
  return { store, controller, recorder }
}

describe("agent roles — the explainer", () => {
  test("agent.explain runs one side turn on the explainer role and streams into an embedded card", async () => {
    const { store, controller, recorder } = await boot()
    controller.runCommand("agent.explain", "why is packages/smithers/flows/jj/wasm not a regular file")
    await settle()
    const launch = recorder.launches.at(-1)
    expect(launch).toBeDefined()
    expect(launch).toMatchObject({ purpose: "explain", role: "explainer" })
    expect(launch?.tools).toBeUndefined()
    expect(launch?.messages).toEqual([{ role: "user", content: "why is packages/smithers/flows/jj/wasm not a regular file" }])
    expect(launch?.instructions).toContain("Explainer")
    // The conversation's own phase never moves for a side turn.
    expect(store.session().phase).toBe("idle")
    const cardId = `explain-${launch?.runId ?? ""}`
    expect(store.collections.cards.get(cardId)).toMatchObject({ kind: "explain", payload: { phase: "asking", answer: "" } })
    recorder.emit({ runId: launch?.runId ?? "", type: "delta", kind: "text", text: "It is a directory " })
    recorder.emit({ runId: launch?.runId ?? "", type: "delta", kind: "text", text: "of build output." })
    recorder.emit({ runId: launch?.runId ?? "", type: "done", reason: "stop" })
    await settle()
    const card = store.collections.cards.get(cardId)
    expect(card).toMatchObject({ status: "acted", payload: { phase: "answered", answer: "It is a directory of build output." } })
    // Honest attribution: what was asked for, never a claim about who answered.
    expect(card?.kind === "explain" ? card.payload.answeredBy : "").toContain("asked for the Explainer role (Kimi K3)")
  })

  test("a refused or empty explanation lands as a failed card, and a blank ask is refused before any turn", async () => {
    const { store, controller, recorder } = await boot()
    controller.runCommand("agent.explain", "this")
    await settle()
    const launch = recorder.launches.at(-1)
    recorder.emit({ runId: launch?.runId ?? "", type: "done", error: "upstream refused" })
    await settle()
    expect(store.collections.cards.get(`explain-${launch?.runId ?? ""}`)).toMatchObject({
      status: "error",
      payload: { phase: "failed", error: "upstream refused" }
    })
    const before = recorder.launches.length
    controller.runCommand("agent.explain", "   ")
    await settle()
    expect(recorder.launches.length).toBe(before)
  })
})

describe("agent roles — the orchestrator's instructions", () => {
  test("the conversation is the orchestrator: it is told each role, its model, and which ones this host cannot launch", () => {
    const prompt = smithersInstructions([], {
      host: "native",
      github: { connected: false, login: null, repositories: null },
      localRepositories: [],
      localRepositoriesAvailable: true
    }, [
      { id: "orchestrator", label: "Orchestrator", purpose: "Delegates.", model: "Fable 5", available: true, reason: "" },
      { id: "explainer", label: "Explainer", purpose: "Explains things very well.", model: "Kimi K3", available: true, reason: "" },
      {
        id: "fast-ui",
        label: "Fast UI",
        purpose: "Fast, cheap UI iterations.",
        model: "Cerebras Qwen 3.8 27B",
        available: false,
        reason: "OpenCode · Cerebras has no credential for Cerebras Qwen 3.8 27B"
      }
    ])
    expect(prompt).toContain("You are the ORCHESTRATOR role")
    expect(prompt).toContain("agent.delegate <role> <task>")
    expect(prompt).toContain("- explainer (Kimi K3): Explains things very well.")
    expect(prompt).toContain("- fast-ui (Cerebras Qwen 3.8 27B): Fast, cheap UI iterations. — NOT available: OpenCode · Cerebras has no credential")
    // The orchestrator is not listed as something to delegate to.
    expect(prompt).not.toContain("- orchestrator (")
  })

  test("without local harnesses the instructions carry no role section at all", () => {
    const prompt = smithersInstructions([], {
      host: "native",
      github: { connected: false, login: null, repositories: null },
      localRepositories: [],
      localRepositoriesAvailable: false
    })
    expect(prompt).not.toContain("ORCHESTRATOR")
  })
})
