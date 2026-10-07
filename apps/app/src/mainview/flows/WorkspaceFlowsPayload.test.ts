import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { workspaceFlowsArgs } from "./WorkspaceFlowsPayload"
test("saved workspace catalogs and deferred sign-in retain their original source", () => {
 const args = "sourceCard=private-run owner/repo"
 const canonical = workspaceFlowsArgs(args)
 expect(JSON.parse(canonical)).toEqual({ operation: "workspace", repo: "owner/repo", sourceCard: "private-run" })
 for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) expect(schema.parse({ flow: "flow.list", args, label: "Saved" })).toEqual({ flow: "flows", args: canonical, label: "Saved" })
 expect(SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: "flow.list", args, requirement: "signed-in", requestedAt: 1 } }).pendingCommand).toEqual({ name: "flows", args: canonical, requirement: "signed-in", requestedAt: 1 })
 expect(MessageSchema.shape.action.parse({ flow: "flows", args: "", label: "Flows" })).toEqual({ flow: "flows", args: "", label: "Flows" })
 expect(FLOW_NAMES.includes("flow.list" as never)).toBe(false)
})
