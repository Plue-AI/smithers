import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { ConfiguredModel } from "@smthrs/rpc/ConfiguredModel"
import type { AgentPort } from "../runtime/AgentPort"
import { emptyAppProjection, projectAppEvent, seedAppProjection, type AppProjectionSnapshot } from "./AppProjection"
import type { AppTransition } from "./AppState"
import { DEFAULT_BRANCH_ID } from "./AppState"
import { createAppStore } from "./AppStore"
import { APP_TRANSITION_SCHEMAS } from "./AppTransitionValidation"
import { scopedControllers } from "./ControllerTestScope"
import { projectHttpFrame, type HttpTurn, type HttpTurnLeg } from "./HttpTurn"
import { memoryStorage, settled } from "./TestFixtures"

const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 100, theme: "dark" })
const apply = (state: AppProjectionSnapshot, transition: AppTransition, createdAt = 200): AppProjectionSnapshot =>
  projectAppEvent(state, { transition, createdAt, revision: state.sessions[0]!.revision + 1, persistenceMode: "memory" })
const record = (state: AppProjectionSnapshot, usage: Extract<AppTransition, { type: "chat.usage.recorded" }>["usage"]) =>
  apply(state, { type: "chat.usage.recorded", actor: "smithers", turnId: "t1", usage })

describe("the chat meter fold", () => {
  test("sums every call, keeps the latest call's input as the context, and names the chat seat's model", () => {
    const gpt4o: ConfiguredModel = { id: "mine", protocol: "openai-chat", baseUrl: "https://api.openai.com", modelId: "gpt-4o",
      credential: "OPENAI_API_KEY" }
    let state = apply(apply(boot(), { type: "model.saved", actor: "user", model: gpt4o }),
      { type: "seat.assigned", actor: "user", seat: "chat", recordId: "mine" })
    state = record(state, { inputTokens: 9_000, outputTokens: 100, cachedInputTokens: 8_000 })
    state = record(state, { outputTokens: 5 })
    state = record(state, {})
    state = record(state, { inputTokens: 10_000, outputTokens: 50, cachedInputTokens: 9_500 })
    expect(state.sessions[0]!.chatUsage).toEqual({
      branchId: DEFAULT_BRANCH_ID, input: 19_000, output: 155, cached: 17_500, context: 10_000, modelId: "gpt-4o"
    })
  })

  test("a call with no cached count leaves cached absent, and no seat leaves the model unknown", () => {
    expect(record(boot(), { inputTokens: 3, outputTokens: 1 }).sessions[0]!.chatUsage)
      .toEqual({ branchId: DEFAULT_BRANCH_ID, input: 3, output: 1, context: 3 })
  })

  test("a reset conversation drops its meter and a new conversation starts from zero", () => {
    const used = record(boot(), { inputTokens: 100, outputTokens: 10 })
    expect(apply(used, { type: "conversation.reset", actor: "user" }).sessions[0]!.chatUsage).toBeUndefined()
    const next = apply(used, { type: "conversation.cleared", actor: "user", branchId: "branch-next", notes: [] })
    expect(next.sessions[0]!.chatUsage?.branchId).toBe(DEFAULT_BRANCH_ID)
    expect(record(next, { inputTokens: 7, outputTokens: 2 }).sessions[0]!.chatUsage)
      .toEqual({ branchId: "branch-next", input: 7, output: 2, context: 7 })
  })

  test("the transition contract refuses a count that is not a non-negative integer", () => {
    const schema = APP_TRANSITION_SCHEMAS["chat.usage.recorded"]
    const valid = { type: "chat.usage.recorded", actor: "smithers", turnId: "t", usage: { inputTokens: 1 } }
    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse({ ...valid, usage: { inputTokens: -1 } }).success).toBe(false)
    expect(schema.safeParse({ ...valid, usage: { outputTokens: 0.5 } }).success).toBe(false)
    expect(schema.safeParse({ ...valid, actor: "user" }).success).toBe(false)
  })
})

describe("done frames feed the meter", () => {
  test("the HTTP projection records a done frame's usage, tool-call legs included", () => {
    const turn = { id: "a1", turnId: "t1", legId: "l1", status: "active", receivedText: false, claimBuffer: "", createdAt: 0, revision: 0 } as HttpTurn
    const leg = { id: "l1", attemptId: "a1", turnId: "t1", ordinal: 0, status: "streaming", createdAt: 0,
      call: { callId: "c1", name: "files.read", args: "{}" } } as unknown as HttpTurnLeg
    const view = { answer: "", card: () => undefined, protectedCard: () => false, executedLegs: 0 }
    const usage = { inputTokens: 40, outputTokens: 4, cachedInputTokens: 30 }
    const projected = projectHttpFrame(turn, leg, { runId: "t1", type: "done", reason: "tool_call", usage }, view)
    expect(projected.leg.status).toBe("tool-ready")
    expect(projected.transitions).toEqual([{ type: "chat.usage.recorded", actor: "smithers", turnId: "t1", usage }])
    expect(projectHttpFrame(turn, { ...leg, call: undefined }, { runId: "t1", type: "done", reason: "stop" }, view).transitions
      .some((transition) => transition.type === "chat.usage.recorded")).toBe(false)
  })

  test("the native turn loop folds the usage of each leg into the session", async () => {
    const createAppController = scopedControllers()
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    const legs: ReadonlyArray<ReadonlyArray<AgentTurnFrame>> = [
      [
        { runId: "", type: "tool_call", call_id: "c1", name: "commands", arguments: JSON.stringify({ action: "execute", name: "world.new-note" }) },
        { runId: "", type: "done", reason: "tool_call", usage: { inputTokens: 1_000, outputTokens: 20, cachedInputTokens: 0 } }
      ],
      [
        { runId: "", type: "delta", kind: "text", text: "Done." },
        { runId: "", type: "done", reason: "stop", usage: { inputTokens: 1_200, outputTokens: 10, cachedInputTokens: 1_000 } }
      ]
    ]
    let started = 0
    const agent: AgentPort = {
      available: true,
      startTurn: async (request: StartAgentTurnRequest) => {
        const frames = legs[started++] ?? []
        queueMicrotask(() => { for (const frame of frames) for (const listener of listeners) listener({ ...frame, runId: request.runId }) })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
    }
    const controller = createAppController(store, agent)
    controller.send("make me a note")
    await settled()
    await settled()
    expect(started).toBe(2)
    expect(store.session().chatUsage).toEqual({ branchId: DEFAULT_BRANCH_ID, input: 2_200, output: 30, cached: 1_000, context: 1_200 })
  })
})
