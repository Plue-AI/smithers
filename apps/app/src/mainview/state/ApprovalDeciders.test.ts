import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { adminDecided, canDecide, shownInTranscript } from "./ApprovalDeciders"

const run = (workflow: string) => ({ id: "r", kind: "run-trace", title: "", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "acme/widgets", runId: "run-1", workflow, phase: "waiting-approval", steps: [], result: null, lastSeq: 0 } }) as Card
const approval = (name?: string) => ({ id: "a", kind: "approval", title: "Review", status: "active", createdAt: 0, ordinal: 0,
  payload: { capability: "Review", ...(name === undefined ? {} : { question: { kind: "select", prompt: "Register?", name } }) } }) as unknown as Card

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
})
