import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema, SessionSchema, initialSession } from "../state/AppState"
import { ActionSchema, registeredAction } from "@smthrs/rpc/CardAction"
import { FLOW_NAMES } from "./FlowName"
test("recorded proposal subjects retain their identity under the Wiki door", () => {
 for (const args of ["check:lint@review", '{"id":"check:lint@review"}']) {
  const saved = '{"operation":"proposal","id":"check:lint@review"}'
  for (const schema of [MessageSchema.shape.action, ToastSchema.shape.action]) expect(schema.parse({ flow: "proposal", args, label: "Lesson" })).toEqual({ flow: "wiki", args: saved, label: "Lesson" })
  expect(SessionSchema.parse({ ...initialSession("light"), pendingCommand: { name: "proposal", args, requirement: "signed-in", requestedAt: 1 } }).pendingCommand?.args).toBe(saved)
 }
 expect(registeredAction(ActionSchema.parse({ tag: "proposal", label: "Lesson", args: { id: "private-note" } }))).toMatchObject({ tag: "wiki", args: { operation: "proposal", id: "private-note" } })
 expect(FLOW_NAMES.includes("proposal" as never)).toBe(false)
})
