import { ControlFacts } from "@smthrs/control"
import { JournalEvent } from "@smthrs/journal"
import { describe, expect, it } from "vitest"
import { latestPendingApproval } from "../src/internal/PendingApproval.ts"

const envelope = { capabilities: [], flows: [], budget: {} }

let seq = 0

/** One control journal entry, as `scanRun` hands it back. */
const entry = (eventType: string, payload: unknown): JournalEvent.Entry => {
  seq += 1
  return new JournalEvent.Entry({
    runId: JournalEvent.RunId.make("run-1"),
    seq: JournalEvent.Seq.make(seq),
    eventId: `event-${seq}`,
    sourceId: JournalEvent.SourceId.make("control"),
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    emittedAtMs: 0,
    eventType,
    payload,
    meta: {}
  })
}

const node = (requestId: string) => ({ _tag: "Node" as const, runId: "run-1", requestId, digest: "d", envelope })

const requested = (requestId: string, question: string) =>
  entry("control.approval.requested", {
    factVersion: ControlFacts.version,
    runId: "run-1",
    requestId,
    question,
    payload: { target: node(requestId), scope: "run", idempotencyKey: `approve:${requestId}` }
  })

const decided = (eventType: "control.approval.approved" | "control.approval.denied", requestId: string) =>
  entry(eventType, ControlFacts.approvalDecisionFact(`token:${requestId}`, node(requestId)))

describe("the approval a run still waits on", () => {
  it("is the latest request no decision answered, with its question", () => {
    expect(latestPendingApproval([
      requested("ask/run-1/a", "first?"),
      decided("control.approval.approved", "ask/run-1/a"),
      requested("budget/run-1/b", "Raise the tokens budget?"),
      requested("ask/run-1/c", "park here?")
    ])).toEqual({ requestId: "ask/run-1/c", question: "park here?" })
  })

  it("is nothing once every request is approved or denied", () => {
    expect(latestPendingApproval([
      requested("ask/run-1/a", "first?"),
      requested("budget/run-1/b", "Raise?"),
      decided("control.approval.denied", "budget/run-1/b"),
      decided("control.approval.approved", "ask/run-1/a")
    ])).toBeUndefined()
  })

  it("moves a request asked again after its decision to the end", () => {
    expect(latestPendingApproval([
      requested("ask/run-1/a", "first?"),
      requested("ask/run-1/b", "second?"),
      decided("control.approval.denied", "ask/run-1/a"),
      requested("ask/run-1/a", "first?")
    ])).toEqual({ requestId: "ask/run-1/a", question: "first?" })
  })

  it("ignores plan decisions, unreadable facts, and other events", () => {
    const plan = { _tag: "Plan" as const, planId: "plan-1", digest: "d", envelope }
    expect(latestPendingApproval([
      requested("ask/run-1/a", "park here?"),
      entry("control.approval.approved", ControlFacts.approvalDecisionFact("token:plan", plan)),
      entry("control.approval.approved", { factVersion: 999 }),
      entry("control.approval.requested", { requestId: "ask/run-1/z" }),
      entry("control.run.resumed", {})
    ])).toEqual({ requestId: "ask/run-1/a", question: "park here?" })
  })
})
