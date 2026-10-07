import { expect, test } from "bun:test"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { TITLE_INSTRUCTIONS } from "../../src/mainview/state/seams/TimelineTitleSeam"
import { stubReply } from "./ChatStub"

test("the stub echoes the last user message, tool output or not, and titles a timeline by its stated count", () => {
  const request: StartAgentTurnRequest = { runId: "stub-test", instructions: "Answer briefly.", messages: [{ role: "user", content: "How do I put HTTPS in front?" },
    { type: "function_call_output", call_id: "docs", output: "the bundled page" }] }
  expect(stubReply(request)).toBe("stub: How do I put HTTPS in front?")
  expect(stubReply({ ...request, messages: [{ role: "user", content: "Hello" }] })).toBe("stub: Hello")
  expect(stubReply({ ...request, instructions: TITLE_INSTRUCTIONS, messages: [{ role: "user", content: "The timeline holds 3 entries." }] }))
    .toBe("Fast title for 3 entries.")
})
