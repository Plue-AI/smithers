import { expect, test } from "bun:test"
import { MessageSchema, ToastSchema } from "../state/AppState"
import { FLOW_NAMES } from "./FlowName"
import { publicSecretInput } from "./SecretPayload"

test("saved secret actions decode to the canonical door without retaining values", () => {
  for (const operation of ["set", "delete", "scope", "bind"] as const) {
    const input = { name: "KEY", repo: "owner/repo", value: "private", token: "private", key: "private", ...(operation === "scope" ? { scope: "all" } : {}) }
    const saved = { flow: `secrets.${operation}`, args: JSON.stringify(input), label: "Saved" }
    const expected = { flow: "secrets", label: "Saved", args: JSON.stringify(publicSecretInput({ ...input, operation })) }
    expect(MessageSchema.shape.action.parse(saved)).toEqual(expected)
    expect(ToastSchema.shape.action.parse(saved)).toEqual(expected)
    expect(FLOW_NAMES.includes(saved.flow as never)).toBe(false)
  }
  const decoded = MessageSchema.shape.action.parse({ flow: "secrets.scope", args: "KEY main-only owner/repo", label: "Scope" })!
  expect(JSON.parse(decoded.args!)).toEqual({ name: "KEY", scope: "main_only", repo: "owner/repo", operation: "scope" })
})
