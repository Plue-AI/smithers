import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { terminalSkillProof } from "./terminal-skill-proof"

const transcript = (command: string, content: unknown, isError: boolean) => [
  { message: { content: [{ type: "tool_use", name: "Bash", id: "call", input: { command } }] } },
  { message: { content: [{ type: "tool_result", tool_use_id: "call", content, is_error: isError }] } },
  { type: "result", subtype: "success", is_error: false }
]
const run = (messages: unknown[], expected = ["todo new"], confirmation: string | undefined = "todo new", refusal?: { code: string; message: string }) =>
  spawnSync("/usr/bin/python3", ["-c", terminalSkillProof(expected, refusal ? undefined : confirmation, refusal)], {
    input: messages.map(message => JSON.stringify(message)).join("\n"), encoding: "utf8"
  })
const pending = { confirmation: "private-card-1", state: "pending", message: "Waiting for ben to confirm" }

describe("installed Claude skill execution receipts", () => {
  test.each([false, true])("pending CLI exit 3 is accepted with tool is_error=%s", isError => {
    const result = run(transcript("smthrs todo new --text Fix --json", `Exit code 3\n${JSON.stringify(pending)}`, isError))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("J6CONFIRMATION=private-card-1\nJ6SKILL=executed\n")
  })
  test("merge receipt supports structured text blocks", () => {
    const result = run(transcript("smthrs merge T1 --json", [{ type: "text", text: JSON.stringify(pending) }], true), ["merge"], "merge")
    expect(result.status).toBe(0)
  })
  test.each([
    { state: "pending" }, { confirmation: "", state: "pending" },
    { confirmation: "   ", state: "pending" }, { confirmation: 42, state: "pending" },
    { confirmation: "private-card-1", state: "requested" }, { class: "infra", code: "todo_unavailable" }
  ])("refuses invalid or failed confirmation: %j", receipt => {
    expect(run(transcript("smthrs todo new --json", JSON.stringify(receipt), true)).status).not.toBe(0)
  })
  test("pending receipt from another tool does not excuse its failure", () => {
    expect(run(transcript("smthrs wiki show --json", JSON.stringify(pending), true)).status).not.toBe(0)
  })
  test("an issued command without a result is not completion", () => {
    const messages = transcript("smthrs todo new --json", JSON.stringify(pending), false)
    messages.splice(1, 1)
    expect(run(messages).status).not.toBe(0)
  })
  test("the missing-consumer refusal must be literal", () => {
    const refusal = { code: "confirm_in_app", message: "Confirm in the app" }
    const messages = transcript("smthrs todo new --json", JSON.stringify({ class: "permission", ...refusal }), true)
    expect(run(messages, ["todo new"], undefined, refusal).status).toBe(0)
    expect(run(messages, ["todo new"], undefined, { ...refusal, code: "permission" }).status).not.toBe(0)
  })
  test("a later failed tool or final Claude failure invalidates the transcript", () => {
    const messages: unknown[] = transcript("smthrs todo new --json", JSON.stringify(pending), true)
    messages.splice(2, 0, { message: { content: [{ type: "tool_result", tool_use_id: "other", content: "failed", is_error: true }] } })
    expect(run(messages).status).not.toBe(0)
    messages.splice(2, 1)
    messages[2] = { type: "result", subtype: "error_during_execution", is_error: true }
    expect(run(messages).status).not.toBe(0)
  })
})
