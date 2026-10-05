import { expect, test } from "vitest"
import * as FC from "fast-check"
import { traceFromJournal, type JournalRecord } from "../src/RunTrace.js"
const run = { runId: "run", flowId: "todo", status: "completed" }
const opened: JournalRecord = { sequence: 1, kind: "control.approval.requested", occurredAt: 1000,
  payload: { requestId: "q", question: "Which language?" } }
const decision = (at: number, kind = "approved", id = "q"): JournalRecord => ({ sequence: 2,
  kind: `control.approval.${kind}`, occurredAt: at, payload: { tokenId: id,
    principal: { id: "alice", kind: "person" } } })
test("settled wait retains its opening, member and time; duplicate decisions cannot rewrite it", () => {
  const model = traceFromJournal(run, [opened, decision(13000), { ...decision(14000, "denied"), sequence: 3 }])
  const wait = model.rows.find(row => row.kind === "approval")!
  expect(wait.startedAt).toBe(1000)
  expect(wait.endedAt).toBe(13000)
  expect(wait.status).toBe("approved")
  expect(wait.detail.fields).toMatchObject({ principal: { id: "alice", kind: "person" }, settled_at: 13000 })
})
test("an unknown decision leaves the wait open and cancellation invents no member", () => {
  const wait = traceFromJournal(run, [opened, decision(13000, "approved", "other"),
    { sequence: 3, kind: "control.run.cancelled", occurredAt: 14000 }]).rows.find(row => row.kind === "approval")!
  expect(wait.status).toBe("waiting")
  expect(wait.endedAt).toBeUndefined()
  expect(wait.detail.fields?.principal).toBeUndefined()
})
test("wait duration preserves every generated delay", () => {
  FC.assert(FC.property(FC.integer({ min: 0, max: 86400000 }), delay => {
    const wait = traceFromJournal(run, [opened, decision(1000 + delay)]).rows.find(row => row.kind === "approval")!
    expect(wait.endedAt! - wait.startedAt).toBe(delay)
  }))
})
