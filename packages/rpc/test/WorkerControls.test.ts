import { describe, expect, test } from "vitest"
import { type Action, allowed, live, type Status } from "../src/WorkerControls.ts"

const actions: ReadonlyArray<Action> = [
  "stop",
  "retry",
  "model",
  "wait",
  "steer",
  "thinking",
  "resume",
  "inspect",
  "approval"
]

describe("worker controls", () => {
  test.each(
    [
      ["requested", true, ["stop", "inspect"]],
      ["queued", true, ["stop", "inspect"]],
      ["running", true, ["stop", "steer", "thinking", "inspect"]],
      ["waiting", true, ["stop", "resume", "inspect", "approval"]],
      ["parked", true, ["stop", "thinking", "resume", "inspect"]],
      ["done", false, ["inspect"]],
      ["failed", false, ["retry", "model", "inspect"]],
      ["cancelled", false, ["retry", "inspect"]]
    ] as const
  )("exposes only eligible actions in %s", (status, unfinished, expected) => {
    expect(live(status)).toBe(unfinished)
    expect(actions.filter((action) => allowed(action, { status }))).toEqual(expected)
  })

  test.each(
    [
      ["requested", false],
      ["queued", false],
      ["running", true],
      ["waiting", false],
      ["parked", true],
      ["done", false],
      ["failed", true],
      ["cancelled", false]
    ] as const
  )("allows a live model switch only while running or parked (%s)", (status, expected) => {
    expect(allowed("model", { status, liveModelSwitch: true })).toBe(expected)
    expect(allowed("model", { status, liveModelSwitch: false })).toBe(status === "failed")
  })

  test.each(
    [
      ["failed", ["wait"], true],
      ["failed", ["retry"], false],
      ["failed", [], false],
      ["cancelled", ["wait"], false],
      ["running", ["wait"], false]
    ] as const
  )("requires a failed worker and explicit wait recovery (%s, %s)", (status, failureActions, expected) => {
    expect(allowed("wait", { status, failure: { actions: failureActions } })).toBe(expected)
  })

  test("failure recovery choices do not leak into a completed worker", () => {
    const status: Status = "done"
    expect(actions.filter((action) =>
      allowed(action, {
        status,
        failure: { actions: ["wait"] },
        liveModelSwitch: true
      })
    )).toEqual(["inspect"])
  })
})
