import { describe, expect, it } from "vitest"
import { waitingAnnotation } from "../src/internal/WaitingAnnotation.ts"

describe("waiting annotation", () => {
  it("keeps the earliest durable timer wake on an unrequested poll", () => {
    expect(waitingAnnotation("parked", [{ dueAtMs: 90 }, { dueAtMs: 40 }]))
      .toEqual({ reason: "timer", wakeAt: 40 })
  })

  it("keeps a declared reason and its token on an unrequested poll", () => {
    expect(waitingAnnotation("parked", [], { reason: "budget", token: "budget/run-1/abc" }))
      .toEqual({ reason: "budget", token: "budget/run-1/abc" })
    expect(waitingAnnotation("waiting-approval", [], { reason: "approval", token: "ask/run-1/abc" }))
      .toEqual({ reason: "approval", token: "ask/run-1/abc" })
    expect(waitingAnnotation("parked", [{ dueAtMs: 40 }], { reason: "quota", token: null }))
      .toEqual({ reason: "quota", wakeAt: 40 })
    // A released row declared nothing; the derivation stands.
    expect(waitingAnnotation("parked", [], { reason: "released", token: null })).toEqual({ reason: "event" })
  })

  it("keeps a declared token's question as the JSON text the first park wrote", () => {
    const question = { question: "park here?" }
    expect(waitingAnnotation("waiting-approval", [], { reason: "approval", token: "ask/run-1/abc", request: question }))
      .toEqual({ reason: "approval", token: "ask/run-1/abc", request: JSON.stringify(question) })
    // A question travels with its token: a reason the status overrides drops both.
    expect(
      waitingAnnotation("waiting-approval", [], { reason: "budget", token: "budget/run-1/abc", request: question })
    )
      .toEqual({ reason: "approval" })
  })

  it("keeps approval and event parks distinct from timers", () => {
    expect(waitingAnnotation("waiting-approval", [])).toEqual({ reason: "approval" })
    expect(waitingAnnotation("parked", [])).toEqual({ reason: "event" })
  })
})
