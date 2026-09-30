import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { adminDecided, canDecide, shownInTranscript } from "./ApprovalDeciders"

const run = (workflow: string): Card => ({ id: "r", kind: "run-trace", title: "", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "acme/widgets", runId: "run-1", workflow, phase: "waiting-approval", steps: [], result: null, lastSeq: 0 } })
const approval = (name?: string): Card => ({ id: "a", kind: "approval", title: "Review", status: "active", createdAt: 0, ordinal: 0,
  payload: { capability: "Review", detail: "Review repository registration", runId: "run-1", requestId: "review",
    approval: { target: { _tag: "Node", runId: "run-1", requestId: "review" }, scope: "run", idempotencyKey: "review" },
    ...(name === undefined ? {} : { question: { kind: "select", prompt: "Register?", name, options: ["Approve", "Reject"] } }) } })
const imported = (registration?: boolean): Card => ({ id: "import", kind: "repo-import", title: "Import", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "acme/widgets", jobId: "import-1", phase: "running", detail: null, ...(registration === undefined ? {} : { registration }) } })

test("a registration's review is the admin's; every other wait is the run owner's", () => {
  expect(adminDecided("register-repository")).toBe(true)
  expect(adminDecided("register-repository/review")).toBe(true)
  expect(adminDecided("register-repository-x")).toBe(false)
  expect(adminDecided("coding/request")).toBe(false)
  expect(canDecide("register-repository/review", false)).toBe(false)
  expect(canDecide("register-repository/review", true)).toBe(true)
  expect(canDecide(undefined, false)).toBe(true)
})

test("the transcript shows no registration run or import, and no approval its viewer cannot decide", () => {
  expect(shownInTranscript(run("register-repository"), true)).toBe(false)
  expect(shownInTranscript(run("coding/request"), false)).toBe(true)
  expect(shownInTranscript(approval("register-repository/review"), false)).toBe(false)
  expect(shownInTranscript(approval("register-repository/review"), true)).toBe(true)
  expect(shownInTranscript(approval(), false)).toBe(true)
  for (const admin of [false, true]) {
    expect(shownInTranscript(imported(true), admin)).toBe(false)
    expect(shownInTranscript(imported(false), admin)).toBe(true)
    expect(shownInTranscript(imported(), admin)).toBe(true)
  }
  expect(shownInTranscript({ id: "notice", kind: "status", title: "Notice", status: "acted", createdAt: 0, ordinal: 0, payload: { note: "Ready" } }, false)).toBe(true)
})
