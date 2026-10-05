import { expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { commandsToolSpec } from "@smthrs/rpc/AgentCommands"
import { createLocalCommandChat } from "../e2e/graph/LocalCommandChat"

const reply = async (messages: StartAgentTurnRequest["messages"]) => {
  const frames: AgentTurnFrame[] = []
  let complete!: () => void
  const done = new Promise<void>(resolve => { complete = resolve })
  const chat = createLocalCommandChat(frame => { frames.push(frame); if (frame.type === "done") complete() })
  chat.start({ runId: "turn", instructions: "", tools: [commandsToolSpec], messages })
  await done
  return frames
}

test("local chat delegates typed flow commands to the app's real commands tool", async () => {
  const frames = await reply([{ role: "user", content: "/flow.create add validation test/repo" }])
  expect(frames.find(frame => frame.type === "tool_call")).toMatchObject({
    name: "commands", arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "add validation test/repo" })
  })
  expect(JSON.stringify(frames)).not.toContain("stub:")
})

test("unconfigured natural language is refused honestly, without a fictional run", async () => {
  const frames = await reply([{ role: "user", content: "Add a validation step" }])
  expect(frames.some(frame => frame.type === "tool_call")).toBe(false)
  expect(frames.find(frame => frame.type === "delta")).toMatchObject({ kind: "text", text: "Local chat accepts /flow.* commands." })
})

test("tool continuation repeats the real registry result and does not relaunch", async () => {
  const frames = await reply([{ role: "user", content: "/flow.create add validation" }, { type: "function_call_output", call_id: "call-1", output: "flow-requested repo=test/repo" }])
  expect(frames.some(frame => frame.type === "tool_call")).toBe(false)
  expect(frames.find(frame => frame.type === "delta")).toMatchObject({ text: "flow-requested repo=test/repo" })
})
