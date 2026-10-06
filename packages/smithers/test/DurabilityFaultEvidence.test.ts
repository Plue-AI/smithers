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
  const leaf = (suffix: string, marker?: string) => [
    event("run", `${name}/${suffix}`),
    ...(marker === undefined ? [] : [event("output", `${name}/${suffix}`, marker)]),
    event("pass", `${name}/${suffix}`)
  ].join("\n")
  it("requires a marker for every kill-point subtest", () => {
    const log = `${leaf("before", "CRASH-POINT pre-launch\n")}\n${leaf("after")}\n${passed}`
    expect(() => requireReachedGoFault(log, name)).toThrow(`${name}/after`)
  })
  it("does not borrow a parent's marker for an unmarked leaf", () => {
    const log = `${event("output", name, "CRASH-POINT post-launch\n")}\n${leaf("after")}\n${passed}`
    expect(() => requireReachedGoFault(log, name)).toThrow(`${name}/after`)
  })
  it("accepts nested matrices only when every leaf reached its boundary", () => {
    const log = [leaf("people/before", "CRASH-POINT pre-launch\r\n"),
      leaf("people/after", "CRASH-POINT post-launch subject todo-1\n"),
      event("pass", `${name}/people`), passed].join("\n")
    expect(() => requireReachedGoFault(log, name)).not.toThrow()
  })
  it("refuses a leaf that started but never finished", () => {
    const log = `${leaf("before", "CRASH-POINT pre-launch\n")}\n${event("run", `${name}/after`)}\n${passed}`
    expect(() => requireReachedGoFault(log, name)).toThrow("subtest did not pass")
  })
  it("joins split output only within the same leaf", () => {
    const child = `${name}/before`
    const log = [event("output", child, "CRASH-"), event("output", child, "POINT pre-launch\n"),
      event("pass", child), passed].join("\n")
    expect(() => requireReachedGoFault(log, name)).not.toThrow()
  })
  it.each(["CRASH-POINT \npost-launch\n", "CRASH-POINT post-launch!\n", " CRASH-POINT post-launch\n"]) (
    "refuses malformed point lines: %s", (marker) => {
      expect(() => requireReachedGoFault(`${leaf("before", marker)}\n${passed}`, name)).toThrow()
    }
  )
})
