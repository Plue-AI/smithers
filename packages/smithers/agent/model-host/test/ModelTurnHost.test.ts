import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { providerRequest, runModelTurn, StreamingCredentialCutter } from "../src/ModelTurnHost.ts"

const turn: StartAgentTurnRequest = {
  runId: "run-1",
  instructions: "help",
  messages: [
    { role: "user", content: "inspect" },
    { type: "function_call", call_id: "old", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "old", output: "ok" }
  ],
  tools: [{ type: "function", name: "write", description: "write a file", parameters: { type: "object" } }]
}

describe("ModelTurnHost", () => {
  test("projects the established wire into the canonical model request", () => {
    const request = providerRequest(turn, { modelId: "model-a", maxTokens: 99 })
    expect(request.modelId).toBe("model-a")
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(request.tools[0]?.name).toBe("write")
    expect(request.params.maxTokens).toBe(99)
  })

  test("streams deterministic text and tool invocation before a real terminal", async () => {
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "text", text: "hello " },
      { type: "text-delta", id: "text", text: "world" },
      { type: "tool-call-start", id: "call-1", name: "write" },
      { type: "tool-call-delta", id: "call-1", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call-1", arguments: "{\"path\":\"a\"}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const model = Model.make({ stream: () => Stream.fromIterable(events) })
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(model, turn, { modelId: "model-a" }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "hello " },
      { runId: "run-1", type: "delta", kind: "text", text: "world" },
      { runId: "run-1", type: "tool_call", call_id: "call-1", name: "write", arguments: "{\"path\":\"a\"}" },
      { runId: "run-1", type: "done", reason: "tool_call" }
    ])
  })

  test("cuts a credential split across provider chunks and tool arguments", async () => {
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "text", text: "key=sk-se" },
      { type: "text-delta", id: "text", text: "cret safe" },
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-end", id: "call", arguments: "{\"key\":\"sk-secret\"}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(Model.make({ stream: () => Stream.fromIterable(events) }), turn, {
        modelId: "m",
        credential: "sk-secret"
      }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    expect(JSON.stringify(frames)).not.toContain("sk-secret")
    expect(frames.some((frame) => frame.type === "delta" && frame.text.includes("safe"))).toBe(true)
  })

  test("fiber interruption emits no invented completion", async () => {
    const frames: Array<AgentTurnFrame> = []
    const model = Model.make({ stream: () => Stream.never })
    const fiber = Effect.runFork(
      runModelTurn(model, turn, { modelId: "m" }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(frames).toEqual([])
  })

  test("credential cutter holds only a possible secret prefix", () => {
    const cutter = new StreamingCredentialCutter("abcdef")
    expect(cutter.push("safe abc")).toBe("safe ")
    expect(cutter.push("xyz")).toBe("abcxyz")
    expect(cutter.finish()).toBe("")
  })
})

const collect = async (events: ReadonlyArray<ModelEvent.ModelEvent>, credential?: string) => {
  const frames: AgentTurnFrame[] = []
  await Effect.runPromise(runModelTurn(
    Model.make({ stream: () => Stream.fromIterable(events) }),
    turn,
    { modelId: "fixture", ...(credential === undefined ? {} : { credential }) },
    (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      })
  ))
  return frames
}

test("groups consecutive calls and results without merging ordinary assistant messages", () => {
  const call = { type: "function_call", call_id: "first", name: "read", arguments: "{}" } as const
  const result = { type: "function_call_output", call_id: "first", output: "ok" } as const
  const request = providerRequest({
    ...turn,
    messages: [call, { ...call, call_id: "second" }, result, { ...result, call_id: "second" }, {
      role: "assistant",
      content: "done"
    }, call]
  }, { modelId: "fixture" })
  expect(request.messages.map((message) => [message.role, message.content.length])).toEqual([
    ["assistant", 2],
    ["tool", 2],
    ["assistant", 1],
    ["assistant", 1]
  ])
  expect(
    providerRequest({ runId: turn.runId, instructions: turn.instructions, messages: [result] }, { modelId: "fixture" })
      .tools
  ).toEqual([])
})

test.each(["aborted", "error", "content-filter", "unknown", "stop", "length"] as const)(
  "preserves the terminal meaning of %s",
  async (stopReason) => {
    const frames = await collect([{ type: "settle", stopReason }])
    expect(frames).toEqual([{
      runId: turn.runId,
      type: "done",
      reason: stopReason === "aborted" ? "cancelled" : "stop",
      ...(["error", "content-filter", "unknown", "length"].includes(stopReason)
        ? { error: `model stopped: ${stopReason}` }
        : {})
    }])
  }
)

test("reports the call's merged usage on every done frame, tool calls included", async () => {
  expect(
    await collect([
      { type: "usage", inputTokens: 1_000, cachedInputTokens: 900 },
      { type: "usage", outputTokens: 40, reasoningTokens: 7 },
      { type: "settle", stopReason: "tool-calls" }
    ])
  ).toEqual([{
    runId: turn.runId,
    type: "done",
    reason: "tool_call",
    usage: { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 40 }
  }])
  expect(
    await collect([
      { type: "usage", inputTokens: 5, outputTokens: 1 },
      { type: "retry", attempt: 1, code: "overloaded", delayMillis: 0 },
      { type: "usage", outputTokens: 2 },
      { type: "settle", stopReason: "stop" }
    ])
  ).toEqual([{ runId: turn.runId, type: "done", reason: "stop", usage: { outputTokens: 2 } }])
})

test("omits usage when the provider reports none or only invalid counts", async () => {
  expect(
    await collect([{ type: "usage", inputTokens: -1, outputTokens: Number.NaN }, {
      type: "settle",
      stopReason: "stop"
    }])
  ).toEqual([{ runId: turn.runId, type: "done", reason: "stop" }])
})

test("flushes held text and reasoning at settlement and uses accumulated tool arguments", async () => {
  expect(
    await collect([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "abc" },
      { type: "thinking-delta", id: "thought", text: "abc" },
      { type: "tool-call-start", id: "call", name: "abcdefinspect" },
      { type: "tool-call-delta", id: "call", arguments: "{\"value\":\"abcdef\"}" },
      { type: "tool-call-end", id: "call" },
      { type: "settle", stopReason: "tool-calls" }
    ], "abcdef")
  ).toEqual([
    { runId: turn.runId, type: "tool_call", call_id: "call", name: "inspect", arguments: "{\"value\":\"\"}" },
    { runId: turn.runId, type: "delta", kind: "reasoning", text: "abc" },
    { runId: turn.runId, type: "delta", kind: "text", text: "abc" },
    { runId: turn.runId, type: "done", reason: "tool_call" }
  ])
  const cutter = new StreamingCredentialCutter("")
  expect(cutter.push("unchanged")).toBe("unchanged")
})

test.each(
  [
    [[{ type: "tool-call-delta", id: "missing", arguments: "{}" }], "tool delta preceded its start"],
    [[{ type: "tool-call-end", id: "missing" }], "tool end preceded its start"],
    [[{ type: "settle", stopReason: "stop" }, { type: "settle", stopReason: "stop" }], "model settled twice"],
    [[], "model stream ended without settlement"]
  ] satisfies Array<[ModelEvent.ModelEvent[], string]>
)("rejects malformed event sequences %j", async (events, message) => {
  await expect(collect(events)).rejects.toThrow(message)
})
