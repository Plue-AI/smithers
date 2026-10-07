import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
test("saved terminal commands retain their terminal and command without registering a send alias", () => {
 const args = JSON.stringify({ id: "private-terminal", command: "pwd" })
 const saved = JSON.stringify({ id: "private-terminal", command: "pwd", operation: "command" })
 for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) expect(schema.parse({ flow: "terminal.send", args, label: "Retry" })).toEqual({ flow: "terminal", args: saved, label: "Retry" })
 expect(SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: "terminal.send", args, requirement: "signed-in", requestedAt: 1 } }).pendingCommand?.args).toBe(saved)
 expect(MessageSchema.shape.action.parse({ flow: "terminal.send", args: "invalid", label: "Retry" })?.args).toBe('{"operation":"command"}')
 expect(FLOW_NAMES.includes("terminal.send" as never)).toBe(false)
})
