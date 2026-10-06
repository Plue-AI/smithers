import { describe, expect, it } from "vitest"
import { requireReachedGoFault } from "./faults/harness/durability.ts"
const name = "TestRouteFault"
const event = (Action: string, Test?: string, Output?: string) => JSON.stringify({ Action, Test, Output })
const passed = event("pass", name)
describe("Go fault evidence cannot pass vacuously", () => {
  it("accepts a reached boundary and a passing named case", () => {
    expect(() => requireReachedGoFault(`${event("output", name, "CRASH-POINT post-launch subject todo-1\n")}\n${passed}`, name)).not.toThrow()
  })
  it.each([
    ["no selected tests", event("pass")],
    ["different case", event("pass", "TestOther")],
    ["skipped parent", event("skip", name)],
    ["skipped child", `${passed}\n${event("skip", `${name}/post-launch`)}`],
    ["failed child", `${passed}\n${event("fail", `${name}/post-launch`)}`],
    ["missing marker", passed],
    ["quoted marker", `${event("output", name, "expected CRASH-POINT post-launch")}\n${passed}`],
    ["another case's marker", `${event("output", "TestOther", "CRASH-POINT post-launch\n")}\n${passed}`],
    ["malformed stream", "not JSON"]
  ])("rejects %s", (_, log) => {
    expect(() => requireReachedGoFault(log, name)).toThrow()
  })
})
