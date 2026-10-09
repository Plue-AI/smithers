import { describe, expect, test } from "bun:test"
import { digest } from "@smthrs/core/Digest"
import { agentTurnJournalDigestInput, type AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { ConfiguredModel } from "@smthrs/rpc/ConfiguredModel"
import { emptyAppProjection, projectAppEvent, seedAppProjection, type AppProjectionSnapshot } from "./AppProjection"
import type { AppTransition } from "./AppState"
import { DEFAULT_BRANCH_ID } from "./AppState"
import { APP_TRANSITION_SCHEMAS } from "./AppTransitionValidation"
import { projectHttpFrame, type HttpTurn, type HttpTurnLeg } from "./HttpTurn"

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

  /*
   * The browser turn loop that once drove legs is gone (90ef5aaccb); a turn's
   * legs reach the session as recorded HTTP turn events, and each leg's done
   * frame folds into the one meter.
   */
  test("a tool-loop turn's recorded legs fold the usage of each leg into the session", () => {
    const token = "a".repeat(64)
    const cursor = (legId: string): AgentTurnCursor => ({ version: 1, runId: "t1", legId, batch: 0, position: 0, hash: "0".repeat(64) })
    const batch = (legId: string, frames: AgentTurnFrame[]): Extract<AppTransition, { type: "http.turn.batch.received" }> => {
      const body = { version: 1 as const, runId: "t1", legId, batch: 1, from: 1, previousHash: "0".repeat(64), frames }
      return { type: "http.turn.batch.received", actor: "system", attemptId: "a1", legId, batch: { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) } }
    }
    let state = apply(boot(), { type: "http.turn.started", actor: "user", attemptId: "a1", turnId: "t1", text: "make me a note", retry: false, journal: { version: 1, legId: "l1", token } })
    state = apply(state, { type: "http.leg.accepted", actor: "system", attemptId: "a1", legId: "l1", cursor: cursor("l1") })
    state = apply(state, batch("l1", [
      { runId: "t1", type: "tool_call", call_id: "c1", name: "commands", arguments: JSON.stringify({ action: "execute", name: "wiki.new-note" }) },
      { runId: "t1", type: "done", reason: "tool_call", usage: { inputTokens: 1_000, outputTokens: 20, cachedInputTokens: 0 } }
    ]))
    state = apply(state, { type: "http.tool.started", actor: "smithers", attemptId: "a1", legId: "l1" })
    state = apply(state, { type: "http.tool.settled", actor: "smithers", attemptId: "a1", legId: "l1", result: "ok: created note" })
    state = apply(state, { type: "http.leg.prepared", actor: "system", attemptId: "a1", journal: { version: 1, legId: "l2", token } })
    state = apply(state, { type: "http.leg.accepted", actor: "system", attemptId: "a1", legId: "l2", cursor: cursor("l2") })
    state = apply(state, batch("l2", [
      { runId: "t1", type: "delta", kind: "text", text: "Done." },
      { runId: "t1", type: "done", reason: "stop", usage: { inputTokens: 1_200, outputTokens: 10, cachedInputTokens: 1_000 } }
    ]))
    expect(state.httpTurns[0]?.status).toBe("complete")
    expect(state.sessions[0]!.chatUsage).toEqual({ branchId: DEFAULT_BRANCH_ID, input: 2_200, output: 30, cached: 1_000, context: 1_200 })
  })
})
