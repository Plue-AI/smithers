import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { runsArgs } from "./RunsPayload"

test("saved Runs reads retain their source and operation without an executable alias", () => {
  for (const [flow, operation, args] of [["approvals.list", "approval-list", "owner/repo"], ["approvals.open", "approval-open", "sourceCard=private-run run-1"], ["runs.attention", "attention", "sourceCard=private-list owner/repo"]] as const) {
    const saved = { flow, args, label: "Saved" }
    const expected = { flow: "runs", args: runsArgs(operation, args), label: "Saved" }
    expect(MessageSchema.shape.action.parse(saved)).toEqual(expected)
    expect(ToastSchema.shape.action.parse(saved)).toEqual(expected)
    expect(FLOW_NAMES.includes(flow as never)).toBe(false)
  }
  expect(JSON.parse(runsArgs("approval-open", "sourceCard=private-run run-1"))).toEqual({ runId: "run-1", sourceCard: "private-run", operation: "approval-open" })
})
