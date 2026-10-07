import { expect, test } from "bun:test"
import { admittedReplyFrames, sharedPromptRequest, sharedStopRequest } from "./shared-traffic"

test("only shared prompt and stop requests are observed", () => {
  for (const method of ["POST", "GET", "DELETE"]) {
    expect(sharedPromptRequest(method, "http://install/api/conversations/main/prompt")).toBe(method === "POST")
    expect(sharedStopRequest(method, "http://install/api/conversations/branch%2Fone/turns/id/stop")).toBe(method === "POST")
    expect(sharedPromptRequest(method, "http://install/api/agent/turn")).toBe(false)
    expect(sharedStopRequest(method, "http://install/api/agent/turn/cancel")).toBe(false)
  }
})

test("durable evidence selects the admitted author and requires a real terminal frame", () => {
  const delta = { runId: "run", type: "delta", kind: "text", text: "literal Markdown" } as const
  const done = { runId: "run", type: "done", reason: "stop" } as const
  const entry = (id: string, frames: unknown[]) => ({ id, runId: "run", frames })
  expect(admittedReplyFrames({ entries: [entry("other", [done])] }, "admitted")).toEqual([])
  expect(admittedReplyFrames({ entries: [entry("admitted", [delta]), entry("other", [done])] }, "admitted")).toEqual([delta])
  expect(admittedReplyFrames({ entries: [entry("admitted", [delta, done])] }, "admitted")).toEqual([delta, done])
  expect(() => admittedReplyFrames({ entries: [entry("admitted", [done, delta])] }, "admitted")).toThrow("terminal")
  expect(() => admittedReplyFrames({ entries: [entry("admitted", [{ ...delta, runId: "foreign" }])] }, "admitted")).toThrow("admitted run")
  expect(() => admittedReplyFrames({ entries: [entry("admitted", [{ type: "invented" }])] }, "admitted")).toThrow()
})
