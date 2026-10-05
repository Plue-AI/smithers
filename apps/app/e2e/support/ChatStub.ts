import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { CloudAgent } from "../../src/bun/CloudAgent"
import { TITLE_INSTRUCTIONS } from "../../src/mainview/state/seams/TimelineTitleSeam"

/*
 * SMITHERS_CHAT_STUB=1: a deterministic CloudAgent so the Playwright suite and
 * CI run offline. It streams one reasoning delta, then the text
 * `stub: <last user message>`, then done; `stub-tool <flow> [args]` instead
 * calls that flow through the app's `commands` tool. A timeline title request
 * (#3732) is answered `Fast title for <N> entries.`, N being the count the
 * request states.
 *
 * Test scaffolding, so it lives in the test tree: every host that wants it
 * INJECTS it as `startLocalServer({ agent: createChatStub })`. The one host
 * that cannot be injected into is the packaged Electrobun app — the packaged
 * tier spawns a built binary (e2e/packaged/PackagedApp.ts) and asserts
 * `stub: <message>` in its transcript — so src/bun/NativeApp.ts imports this
 * behind SMITHERS_CHAT_STUB, the same way it imports PackagedE2EBridge.
 */

const lastUserMessage = (request: StartAgentTurnRequest): string => {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message !== undefined && "role" in message && message.role === "user") return message.content
  }
  return ""
}

export const stubReply = (request: StartAgentTurnRequest): string => {
  if (request.instructions === TITLE_INSTRUCTIONS) return `Fast title for ${/holds (\d+) entries/.exec(lastUserMessage(request))?.[1] ?? "?"} entries.`
  return `stub: ${lastUserMessage(request)}`
}

/**
 * `stub-tool <flow> [args]`: the model's one call to the app's `commands`
 * tool, so a spec can drive a flow's agent door. The continuation turn that
 * carries the call's output answers in text, so the loop ends.
 */
const STUB_TOOL = /^stub-tool (\S+)(?: ([\s\S]+))?$/

const toolCall = (request: StartAgentTurnRequest): AgentTurnFrame | undefined => {
  if (request.messages.some((message) => "type" in message && message.type === "function_call_output")) return undefined
  const match = STUB_TOOL.exec(lastUserMessage(request).trim())
  if (match === null) return undefined
  const [, name, args] = match
  return { runId: request.runId, type: "tool_call", call_id: `stub-call-${request.runId}`, name: "commands",
    arguments: JSON.stringify({ action: "execute", name, ...(args === undefined ? {} : { args }) }) }
}

export const createChatStub = (publish: (frame: AgentTurnFrame) => void): CloudAgent => {
  const active = new Set<string>()
  return {
    start: (request) => {
      if (active.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      active.add(request.runId)
      const call = toolCall(request)
      const frames: ReadonlyArray<AgentTurnFrame> = call !== undefined
        ? [call, { runId: request.runId, type: "done", reason: "tool_call" }]
        : [
          { runId: request.runId, type: "delta", kind: "reasoning", text: "stub: thinking" },
          { runId: request.runId, type: "delta", kind: "text", text: stubReply(request) },
          { runId: request.runId, type: "done", reason: "stop" }
        ]
      let index = 0
      const step = (): void => {
        if (!active.has(request.runId)) return
        const frame = frames[index]
        index += 1
        if (frame === undefined) {
          active.delete(request.runId)
          return
        }
        publish(frame)
        setTimeout(step, 5)
      }
      setTimeout(step, 5)
      return { status: "started" }
    },
    cancel: (runId) => {
      if (!active.has(runId)) return { status: "not-found" }
      active.delete(runId)
      return { status: "cancelled" }
    }
  }
}
