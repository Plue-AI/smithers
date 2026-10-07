import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema } from "../state/AppState"
import { githubArgs } from "./GitHubPayload"
import { FLOW_NAMES } from "./FlowName"

test("saved GitHub actions retain their operation without an executable alias", () => {
  for (const [flow, operation, args] of [["github.retry", "retry", undefined], ["github.app.open", "app-open", "owner/repo"], ["github.app.choose", "app-choose", "42"], ["github.reconcile", "reconcile", "owner/repo"], ["github.app", "app-status", "owner/repo"]] as const) {
    const saved = { flow, args, label: "Saved" }
    const expected = { flow: "github", args: githubArgs(operation, args), label: "Saved" }
    expect(MessageSchema.shape.action.parse(saved)).toEqual(expected)
    expect(ToastSchema.shape.action.parse(saved)).toEqual(expected)
    expect(FLOW_NAMES.includes(flow as never)).toBe(false)
  }
})
