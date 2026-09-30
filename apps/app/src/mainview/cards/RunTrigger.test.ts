import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { runTriggersOf, runTriggerWords } from "./RunTrigger"

/*
 * The Steps view's trigger rows (#2115) come only from what was recorded: the
 * launch's pinned pushed ref, the schedule a dispatch named, and the
 * journal's approval decisions with their principal, and the message a
 * dispatched turn's admission recorded on its `control.run.accepted` record.
 * Nothing is read off a bare input, and a run with no record leads with no
 * row.
 */

const card = (payload: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>): Card => ({
  id: "flow-request-r1", kind: "run-trace", title: "coding/request", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "coding/request", phase: "running", steps: [], result: null, lastSeq: 1, ...payload }
})
const launch = (extra: Record<string, unknown>) => ({ version: 1, id: "r1", owner: "will", repo: "smithersai/smithers", workflow: "coding/request", input: {}, ...extra })

describe("recorded run triggers", () => {
  test("a change request leads with the pushed ref preparation pinned; an unpinned or absent source is no row", () => {
    expect(runTriggersOf(card({ input: { _workflowLaunch: launch({ source: { name: "spike", explicit: true, commitId: "abc" } }) } })))
      .toEqual([{ kind: "push", ref: "spike" }])
    expect(runTriggersOf(card({ input: { _workflowLaunch: launch({ source: { name: "spike", explicit: true } }) } }))).toEqual([])
    expect(runTriggersOf(card({ input: { request: "Add a test" } }))).toEqual([])
    expect(runTriggersOf(card({}))).toEqual([])
    expect(runTriggersOf(undefined)).toEqual([])
  })

  test("a schedule dispatch leads with its slug and the cron preparation pinned", () => {
    expect(runTriggersOf(card({ input: { operation: "fire", schedule: "0 2 * * *", _workflowLaunch: launch({ triggerDispatch: { slug: "nightly" } }) } })))
      .toEqual([{ kind: "schedule", slug: "nightly", cron: "0 2 * * *" }])
    expect(runTriggersOf(card({ input: { _workflowLaunch: launch({ triggerDispatch: { slug: "nightly" } }) } }))).toEqual([{ kind: "schedule", slug: "nightly" }])
  })

  test("every approval decision in the journal is a row with the principal the control plane stamped, in order", () => {
    const events = [
      { sequence: 1, kind: "control.run.accepted", occurredAt: 1000, payload: {} },
      { sequence: 2, kind: "control.approval.requested", occurredAt: 2000, payload: { requestId: "req-1", question: "write src/x.ts?" } },
      { sequence: 3, kind: "control.approval.approved", occurredAt: 3000, payload: { tokenId: "req-1", principal: { id: "will", kind: "user", stampedAt: 2900 }, at: 2950 } },
      { sequence: 4, kind: "control.approval.denied", occurredAt: 4000, payload: { tokenId: "req-2", principal: "ada" } },
      { sequence: 5, kind: "control.approval.approved", occurredAt: 5000, payload: { tokenId: "req-3" } }
    ]
    expect(runTriggersOf(card({ events }))).toEqual([
      { kind: "approval", decision: "approved", principal: "will", at: 2950 },
      { kind: "approval", decision: "denied", principal: "ada", at: 4000 },
      { kind: "approval", decision: "approved", at: 5000 }
    ])
  })

  test("the launch rows come first, then the decisions", () => {
    const rows = runTriggersOf(card({
      input: { schedule: "0 2 * * *", _workflowLaunch: launch({ triggerDispatch: { slug: "nightly" } }) },
      events: [{ sequence: 3, kind: "control.approval.approved", occurredAt: 3000, payload: { tokenId: "req-1", principal: { id: "will", kind: "user", stampedAt: 1 } } }]
    }))
    expect(rows.map((row) => row.kind)).toEqual(["schedule", "approval"])
  })

  test("a dispatched turn leads with the message its admission recorded: who, which conversation, the exact text", () => {
    const trigger = { kind: "message", author: "alice", conversationId: "session-1", messageId: "314", text: "  Why does /hello greet null?\n", origin: "chat" }
    const accepted = { sequence: 1, kind: "control.run.accepted", occurredAt: 1000, payload: { runId: "run-1", status: "accepted", trigger } }
    const dispatched = (payload: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>) => card({ workflow: "coding/dispatch", ...payload })
    const message = { kind: "message" as const, author: "alice", conversationId: "session-1", messageId: "314", text: "  Why does /hello greet null?\n" }
    expect(runTriggersOf(dispatched({ events: [accepted] }))).toEqual([message])
    // Replaying the journal never adds a second message row: the record is admitted once.
    const decision = { sequence: 3, kind: "control.approval.approved", occurredAt: 3000, payload: { principal: "will" } }
    const replayed = dispatched({ events: [accepted, decision, decision] })
    expect(runTriggersOf(replayed).filter((row) => row.kind === "message")).toEqual([message])
    expect(runTriggersOf(replayed).map((row) => row.kind)).toEqual(["message", "approval", "approval"])
  })

  test("no recorded message is no row: never read off the prompt, another flow, or a partial record", () => {
    const trigger = { kind: "message", author: "alice", conversationId: "session-1", messageId: "314", text: "hi", origin: "chat" }
    const accepted = (payload: Record<string, unknown>) => ({ sequence: 1, kind: "control.run.accepted", occurredAt: 1000, payload })
    const dispatched = (events: Array<Record<string, unknown>>) => card({ workflow: "coding/dispatch", events })
    // A bare admitted input on the card is not provenance: only the journal carries it.
    expect(runTriggersOf(card({ workflow: "coding/dispatch", input: { turnId: "run-7", prompt: "Fix the build", history: [], role: "coding/dispatch", trigger } }))).toEqual([])
    expect(runTriggersOf(card({ workflow: "coding/dispatch" }))).toEqual([])
    expect(runTriggersOf(card({ events: [accepted({ runId: "run-1", status: "accepted", trigger })] }))).toEqual([])
    expect(runTriggersOf(dispatched([accepted({ runId: "run-1", status: "accepted" })]))).toEqual([])
    expect(runTriggersOf(dispatched([accepted({ runId: "run-1", status: "accepted", trigger: undefined })]))).toEqual([])
    for (const broken of [
      { ...trigger, kind: "push" }, { ...trigger, origin: "email" }, { ...trigger, author: " " }, { ...trigger, conversationId: undefined },
      { ...trigger, messageId: 314 }, { ...trigger, text: "" }, "alice said hi", null, [trigger]
    ]) expect(runTriggersOf(dispatched([accepted({ trigger: broken })]))).toEqual([])
  })

  test("the words name the source and nothing else", () => {
    expect(runTriggerWords({ kind: "message", author: "alice", conversationId: "s", messageId: "1", text: "Fix it" }, "coding/dispatch")).toBe("Fix it")
    expect(runTriggerWords({ kind: "push", ref: "spike" }, "coding/request")).toBe("from spike · coding/request")
    expect(runTriggerWords({ kind: "schedule", slug: "nightly", cron: "0 2 * * *" }, "coding/check")).toBe("schedule nightly · 0 2 * * *")
    expect(runTriggerWords({ kind: "schedule", slug: "nightly" }, "coding/check")).toBe("schedule nightly")
    expect(runTriggerWords({ kind: "approval", decision: "approved", principal: "will" }, "x")).toBe("approved by")
    expect(runTriggerWords({ kind: "approval", decision: "denied" }, "x")).toBe("denied")
  })
})
