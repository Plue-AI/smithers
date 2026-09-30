import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"

describe("model settlement cost trace", () => {
  const settled = (cost: { readonly costUsd?: number; readonly costSource?: "reported" | "estimated" }) =>
    AgentSession.trace(
      new AgentEvent.ModelSettled({
        eventType: AgentEvent.eventType.modelSettled,
        message: new ModelRequest.AssistantMessage({
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop"
        }),
        usage: { inputTokens: 8, outputTokens: 4 },
        durationMillis: 5,
        ...cost
      })
    )

  it.each(["reported", "estimated"] as const)("journals a %s call cost beside its usage", (costSource) => {
    expect(settled({ costUsd: 0.000056, costSource })).toEqual({
      eventType: "control.agent.model-settled",
      payload: {
        text: "done",
        usage: { inputTokens: 8, outputTokens: 4 },
        costUsd: 0.000056,
        costSource,
        durationMillis: 5
      }
    })
  })

  it("journals no cost fields for an unpriced call", () => {
    const payload = settled({})?.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty("costUsd")
    expect(payload).not.toHaveProperty("costSource")
  })
})
