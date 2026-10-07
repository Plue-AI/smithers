import { expect, test } from "bun:test"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { stubReply } from "./ChatStub"

test("HTTPS model fixture cites the actual docs tool output", () => {
  const request: StartAgentTurnRequest = { runId: "docs-test", instructions: "Read docs", messages: [{ role: "user", content: "How do I put HTTPS in front?" },
    { type: "function_call_output", call_id: "docs", output: "the bundled page" }] }
  expect(stubReply(request)).toBe("docs.read quickstart: the bundled page")
  expect(stubReply({ ...request, messages: [{ role: "user", content: "Hello" }] })).toBe("stub: Hello")
  expect(stubReply({ ...request, messages: [request.messages[0]!] })).toBe("stub: How do I put HTTPS in front?")
})
