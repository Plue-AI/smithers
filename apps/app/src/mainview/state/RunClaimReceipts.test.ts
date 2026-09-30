import { expect, test } from "bun:test"
import { runLaunchCommandOf, toolResultLaunchedRun } from "./RunClaims"

const argumentsOf = (name: string, action: unknown = "execute"): string => JSON.stringify({ name, action, args: "owner/repo" })

test("every supported launch door recognizes executable canonical and catalog names", () => {
  for (const name of ["flow.create", "flow.run", "feature.prototype", "change.request"]) {
    expect(runLaunchCommandOf(name, "not JSON")).toBe(name)
    expect(runLaunchCommandOf("commands", argumentsOf(name))).toBe(name)
    expect(runLaunchCommandOf("commands", argumentsOf(`  //${name}  `))).toBe(name)
  }
})

test("malformed or non-executable tool arguments cannot arm a launch claim", () => {
  for (const args of ["{", "null", "[]", "4", "false", '"flow.run"', "{}", '{"action":"execute","name":12}', '{"name":"flow.run"}']) {
    expect(runLaunchCommandOf("commands", args)).toBeUndefined()
  }
  for (const action of ["list", "form", "confirm", null, true, 12]) {
    expect(runLaunchCommandOf("commands", argumentsOf("flow.run", action))).toBeUndefined()
  }
  expect(runLaunchCommandOf("other-tool", argumentsOf("flow.run"))).toBeUndefined()
})

test("only complete machine launch markers prove a saved request or started run", () => {
  for (const result of ["run-requested request=saved", "run-started run=live", "flow-requested request=saved", "flow-started run=live"]) {
    expect(toolResultLaunchedRun(result)).toBe(true)
  }
  for (const result of ["", "run-request", "run-start", "prerun-started", "run-startedness", "flow requested", "started a workflow", "rendered a form for workflow"]) {
    expect(toolResultLaunchedRun(result)).toBe(false)
  }
})

test("refusal envelopes cannot turn mentioned launch markers into success receipts", () => {
  for (const result of ["failed: run-started", "failed: flow-requested", "unknown-command: run-requested", "unknown-tool: flow-started"]) {
    expect(toolResultLaunchedRun(result)).toBe(false)
  }
})
