import { describe, expect, test } from "bun:test"
import { traceFromJournal } from "./RunTrace"
import { stepFacts } from "./RunTraceSteps"
import { tokenWords, totalTokens, traceSteps } from "./TraceSteps"
import { traceStatus } from "./RunTraceStatus"

const event = (sequence: number, kind: string, payload: Record<string, unknown> = {}, at = 1_000 + sequence * 1_000) => ({
  sequence, kind: `control.${kind}`, occurredAt: at, payload: { ...payload, at }
})
const model = (records: ReadonlyArray<ReturnType<typeof event>>, status = "running") =>
  traceFromJournal({ runId: "run-1", flowId: "coding/request", status }, records)

describe("traceSteps", () => {
  test("reads a stored Astra model turn", () => {
    const steps = traceSteps(model([
      event(1, "agent.turn-opened", { seat: "openai:gpt-6-astra" }),
      event(2, "agent.model-settled", { text: "Historical answer" })
    ]))
    expect(steps[0]?.description).toBe("Model turn · openai:gpt-6-astra")
  })

  test("a run reads as steps: time · type · description · duration · tokens, in journal order", () => {
    const steps = traceSteps(model([
      event(1, "agent.turn-opened", { seat: "openai:gpt-6.1-sol" }),
      event(2, "agent.model-settled", { text: "Reading the file", usage: { inputTokens: 1200, outputTokens: 300 } }),
      event(3, "agent.cell-produced", { source: "await ctx.call('read', { path: 'src/a.ts' })" }),
      event(4, "agent.cell-call-started", { callId: "c1", flowName: "read", input: { path: "src/a.ts" } }),
      event(5, "agent.cell-call-settled", { callId: "c1", flowName: "read", outcome: "success", value: "one line" }),
      event(6, "agent.cell-call-started", { callId: "c2", flowName: "bash", input: { command: "bun test src" } }),
      event(7, "agent.cell-call-settled", { callId: "c2", flowName: "bash", outcome: "failure", error: "1 failed" })
    ]))
    // Frames and cells are containers; the model turn and the two calls are the steps.
    expect(steps.map((step) => [step.type, step.description, step.status])).toEqual([
      ["model", "Model turn · openai:gpt-6.1-sol", "completed"],
      ["read", "Read a.ts", "completed"],
      ["test", "Failed to run bun test src", "failed"]
    ])
    expect(steps[0]!.tokens).toBe(1_500)
    expect(steps[1]!.durationMs).toBe(1_000)
    expect(steps.every((step, index) => index === 0 || step.at >= steps[index - 1]!.at)).toBe(true)
    expect(totalTokens(steps)).toBe(1_500)
    expect(stepFacts(steps, 6_000)).toEqual(["3 steps", "6.0s", "1.5k tok"])
  })

  test("an open call reads to the run's latest record and a run without usage shows no tokens", () => {
    const steps = traceSteps(model([
      event(1, "agent.turn-opened"),
      event(2, "agent.cell-call-started", { callId: "c1", flowName: "write", input: { path: "src/b.ts", content: "x" } }),
      event(3, "agent.cell-printed", { text: "still going" })
    ]))
    expect(steps).toHaveLength(1)
    expect(steps[0]!.type).toBe("write")
    expect(steps[0]!.description).toBe("Writing b.ts")
    expect(steps[0]!.durationMs).toBe(1_000)
    expect(steps[0]!.tokens).toBeUndefined()
    expect(totalTokens(steps)).toBeUndefined()
    expect(stepFacts(steps, 0)).toEqual(["1 step"])
  })

  test("an unknown flow keeps its own name and never earns an activity word", () => {
    const steps = traceSteps(model([
      event(1, "agent.turn-opened"),
      event(2, "agent.cell-call-started", { callId: "c1", flowName: "slack.post", input: { channel: "#team" } }),
      event(3, "agent.cell-call-settled", { callId: "c1", flowName: "slack.post", outcome: "success" })
    ]))
    expect(steps.map((step) => [step.type, step.description])).toEqual([["call", "slack.post"]])
  })

  test("token words", () => {
    expect(tokenWords(812)).toBe("812")
    expect(tokenWords(2_140)).toBe("2.1k")
    expect(tokenWords(1_300_000)).toBe("1.3M")
  })
})

describe("a park", () => {
  test("an ordinary park is Blocked until the run resumes, and an approval outranks it", () => {
    const records = [
      event(1, "agent.turn-opened"),
      event(2, "agent.cell-call-started", { callId: "c1", flowName: "read", input: { path: "README.md" } }),
      event(3, "run.parked", { reason: "timer" })
    ]
    expect(traceStatus(model(records))).toMatchObject({ activity: "Reading README.md", condition: "blocked", action: "resume" })
    expect(traceStatus(model([...records, event(4, "run.resumed")]))).not.toHaveProperty("condition")
    expect(traceStatus(model([...records, event(4, "approval.requested", { requestId: "g1" })]))).toMatchObject({ condition: "approval" })
  })
})
