import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { ModelError } from "../src/ModelError.ts"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"

const streamRequest = Request.ModelRequest.make({
  modelId: "qwen2.5:3b",
  system: [],
  messages: [],
  tools: [],
  params: Request.GenerationParams.make()
})

const fixture = (name: string): ReadonlyArray<string> =>
  readFileSync(new URL(`./fixtures/openai-chat/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n\n")
    .flatMap((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      return data === undefined || data === "" || data === "[DONE]" ? [] : [data]
    })

const step = (
  state: ReturnType<typeof OpenAIChatCompletions.protocol.stream.initial>,
  data: string
) => {
  const event = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(data)
  return Effect.runSync(OpenAIChatCompletions.protocol.stream.step(state, event))
}

const replayData = (data: ReadonlyArray<string>): ReadonlyArray<Events.ModelEvent> => {
  let state = OpenAIChatCompletions.protocol.stream.initial(streamRequest)
  const events: Array<Events.ModelEvent> = []
  for (const datum of data) {
    const [next, emitted] = step(state, datum)
    state = next
    events.push(...emitted)
  }
  events.push(...(OpenAIChatCompletions.protocol.stream.onHalt?.(state) ?? []))
  return events
}

const body = (request: Request.ModelRequest): OpenAIChatCompletions.Body =>
  Effect.runSync(OpenAIChatCompletions.protocol.body.from(request, { native: false }))

const inlineError = (payload: string): ModelError =>
  Effect.runSync(Effect.flip(
    OpenAIChatCompletions.protocol.stream.step(
      OpenAIChatCompletions.protocol.stream.initial(streamRequest),
      Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(payload)
    )
  ))

describe("OpenAIChatCompletions.protocol.body", () => {
  it("lowers system, user, assistant tool-call, and tool-result messages", () => {
    const request = Request.ModelRequest.make({
      modelId: "gemini-2.5-flash-lite",
      system: [Request.SystemPart.make({ text: "Be terse." })],
      messages: [
        Request.Message.user("What is the capital of France?"),
        Request.Message.assistant(
          Request.ToolCallPart.make({ id: "call_1", name: "search", arguments: "{\"q\":\"France\"}" }),
          {
            stopReason: "tool-calls"
          }
        ),
        Request.Message.tool(Request.ToolResultPart.make({ toolCallId: "call_1", content: "Paris" }))
      ],
      tools: [Request.ToolDefinition.make({ name: "search", description: "web search", parameters: {} })],
      params: Request.GenerationParams.make()
    })
    const decoded = body(request)
    expect(decoded.model).toBe("gemini-2.5-flash-lite")
    expect(decoded.stream).toBe(true)
    expect(decoded.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "What is the capital of France?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"q\":\"France\"}" } }]
      },
      { role: "tool", tool_call_id: "call_1", content: "Paris" }
    ])
    expect(decoded.tools).toEqual([
      { type: "function", function: { name: "search", description: "web search", parameters: {} } }
    ])
  })

  it("lowers assistant text without fabricating tool calls", () => {
    const decoded = body(Request.ModelRequest.make({
      modelId: "qwen2.5:3b",
      system: [],
      messages: [Request.Message.assistant("Paris", { stopReason: "stop" })],
      tools: [],
      params: Request.GenerationParams.make()
    }))

    expect(decoded.messages).toEqual([{ role: "assistant", content: "Paris" }])
  })

  it("omits declared tools when the request forbids tool use", () => {
    // `toolChoice: "none"` is a declared property of the request, and both
    // provider APIs express it by omitting `tools`. Before this, a request that
    // said "no tools" still put them on the wire.
    const withTools = (toolChoice?: "none"): Request.ModelRequest =>
      Request.ModelRequest.make({
        modelId: "qwen2.5:3b",
        system: [],
        messages: [Request.Message.user("hi")],
        tools: [Request.ToolDefinition.make({ name: "search", description: "web search", parameters: {} })],
        params: Request.GenerationParams.make(),
        ...(toolChoice === undefined ? {} : { toolChoice })
      })

    expect(body(withTools("none")).tools).toBeUndefined()
    expect(body(withTools()).tools).toEqual([
      { type: "function", function: { name: "search", description: "web search", parameters: {} } }
    ])
  })

  it("carries the sampling parameters the wire shape accepts", () => {
    const decoded = body(Request.ModelRequest.make({
      modelId: "qwen2.5:3b",
      system: [],
      messages: [Request.Message.user("hi")],
      tools: [],
      params: Request.GenerationParams.make({ maxTokens: 128, temperature: 0.25, topP: 0.9 })
    }))

    expect(decoded).toMatchObject({ max_tokens: 128, temperature: 0.25, top_p: 0.9 })
  })

  it("carries the stated reasoning effort, and states nothing when the request states nothing", () => {
    // Cerebras's qwen-3.8-27b reasons at `high` when the body says nothing, so
    // a stated effort that never reached the wire spent output tokens the
    // caller had already refused. `reasoning_effort` is the Chat Completions
    // field for it, the same knob `OpenAIResponses` sends as `reasoning.effort`.
    const withEffort = (reasoningEffort?: Request.ReasoningEffort): OpenAIChatCompletions.Body =>
      body(Request.ModelRequest.make({
        modelId: "qwen-3.8-27b",
        system: [],
        messages: [Request.Message.user("hi")],
        tools: [],
        params: Request.GenerationParams.make(reasoningEffort === undefined ? {} : { reasoningEffort })
      }))

    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(withEffort(effort).reasoning_effort).toBe(effort)
    }
    expect(withEffort().reasoning_effort).toBeUndefined()
    expect(Object.hasOwn(withEffort(), "reasoning_effort")).toBe(false)
  })

  it("omits an aborted or errored historical assistant turn", () => {
    const request = Request.ModelRequest.make({
      modelId: "gemini-2.5-flash-lite",
      system: [],
      messages: [Request.Message.assistant("partial", { stopReason: "aborted" })],
      tools: [],
      params: Request.GenerationParams.make()
    })
    expect(body(request).messages).toEqual([])
  })
})

describe("OpenAIChatCompletions.protocol.stream", () => {
  it("replays a recorded Gemini text completion and settles once", () => {
    expect(replayData(fixture("text.sse"))).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "ok" },
      { type: "text-end", id: "text-0" },
      { type: "usage", inputTokens: 6, outputTokens: 1, totalTokens: 77 },
      { type: "settle", stopReason: "stop", responseId: "YLGPaoe0GcCm1MkPxerGiQg" }
    ])
  })

  it("replays a recorded Gemini tool call whose stop finish reason follows the streamed call", () => {
    expect(replayData(fixture("tool-call.sse"))).toEqual([
      { type: "tool-call-start", id: "call_457349", name: "get_weather" },
      { type: "tool-call-delta", id: "call_457349", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-end", id: "call_457349", arguments: "{\"city\":\"Paris\"}" },
      { type: "usage", inputTokens: 54, outputTokens: 16, totalTokens: 128 },
      { type: "settle", stopReason: "tool-calls", responseId: "YbGPao_THuGw1MkPgpuuqAg" }
    ])
  })

  it("separates recorded parallel Gemini tool calls that omit indexes", () => {
    expect(replayData(fixture("parallel-tool-calls.sse"))).toEqual([
      { type: "tool-call-start", id: "call_365409", name: "get_weather" },
      { type: "tool-call-delta", id: "call_365409", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-start", id: "call_365410", name: "get_weather" },
      { type: "tool-call-delta", id: "call_365410", arguments: "{\"city\":\"Tokyo\"}" },
      { type: "tool-call-end", id: "call_365409", arguments: "{\"city\":\"Paris\"}" },
      { type: "tool-call-end", id: "call_365410", arguments: "{\"city\":\"Tokyo\"}" },
      { type: "usage", inputTokens: 64, outputTokens: 32, totalTokens: 154 },
      { type: "settle", stopReason: "tool-calls", responseId: "YrGPavuGIbah9MoP5_XUmAg" }
    ])
  })

  it("replays a plain-text completion captured from a real Ollama server", () => {
    const events = replayData([
      "{\"id\":\"chatcmpl-709\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Paris\"},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-709\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"stop\"}]}",
      "{\"id\":\"chatcmpl-709\",\"choices\":[],\"usage\":{\"prompt_tokens\":29,\"completion_tokens\":2,\"total_tokens\":31}}"
    ])
    expect(events).toEqual([
      Events.ModelEvent.TextStart({ type: "text-start", id: "text-0" }),
      Events.ModelEvent.TextDelta({ type: "text-delta", id: "text-0", text: "Paris" }),
      Events.ModelEvent.TextEnd({ type: "text-end", id: "text-0" }),
      Events.ModelEvent.Settle({ type: "settle", stopReason: "stop", responseId: "chatcmpl-709" }),
      Events.ModelEvent.Usage({ inputTokens: 29, outputTokens: 2, totalTokens: 31 })
    ])
  })

  it("replays a tool-call completion captured from a real Ollama server", () => {
    const events = replayData([
      "{\"id\":\"chatcmpl-204\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_sx8k7q8i\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"answer\",\"arguments\":\"{\\\"answer\\\":\\\"Paris\\\"}\"}}]},\"finish_reason\":null}]}",
      "{\"id\":\"chatcmpl-204\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"tool_calls\"}]}",
      "{\"id\":\"chatcmpl-204\",\"choices\":[],\"usage\":{\"prompt_tokens\":155,\"completion_tokens\":29,\"total_tokens\":184}}"
    ])
    expect(events).toEqual([
      Events.ModelEvent.ToolCallStart({ type: "tool-call-start", id: "call_sx8k7q8i", name: "answer" }),
      Events.ModelEvent.ToolCallDelta({
        type: "tool-call-delta",
        id: "call_sx8k7q8i",
        arguments: "{\"answer\":\"Paris\"}"
      }),
      Events.ModelEvent.ToolCallEnd({
        type: "tool-call-end",
        id: "call_sx8k7q8i",
        arguments: "{\"answer\":\"Paris\"}"
      }),
      Events.ModelEvent.Settle({ type: "settle", stopReason: "tool-calls", responseId: "chatcmpl-204" }),
      Events.ModelEvent.Usage({ inputTokens: 155, outputTokens: 29, totalTokens: 184 })
    ])
  })

  it("accumulates a tool call streamed across multiple argument-only deltas", () => {
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_1\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"answer\",\"arguments\":\"{\\\"a\"}}]},\"finish_reason\":null}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"nswer\\\":\\\"Paris\\\"}\"}}]},\"finish_reason\":null}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
    ])
    const end = events.find((event): event is Events.ToolCallEnd => event.type === "tool-call-end")
    expect(end?.arguments).toBe("{\"answer\":\"Paris\"}")
  })

  it("classifies an inline stream error by the provider's own vocabulary", () => {
    // Chat-compatible gateways answer HTTP 200 and report the real failure in
    // the stream. Reporting all of them as `provider_internal` made a rate
    // limit, an exhausted balance and a rejected key retryable.
    expect(inlineError("{\"error\":{\"code\":\"invalid_api_key\",\"message\":\"bad key\"}}")).toMatchObject({
      code: "authentication",
      providerCode: "invalid_api_key"
    })
    expect(inlineError("{\"error\":{\"code\":429,\"message\":\"Rate limit exceeded\"}}")).toMatchObject({
      code: "rate_limited",
      providerCode: "429"
    })
    expect(inlineError("{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"no balance\"}}")).toMatchObject({
      code: "quota_exceeded"
    })
    expect(inlineError("{\"error\":{\"message\":\"maximum context length is 8192 tokens\"}}")).toMatchObject({
      code: "context_overflow"
    })
    expect(inlineError("{\"error\":{\"message\":\"blocked by content_filter\"}}")).toMatchObject({
      code: "content_policy"
    })
    expect(inlineError("{\"error\":{\"code\":\"server_error\",\"message\":\"upstream died\"}}")).toMatchObject({
      code: "provider_internal"
    })
    expect(inlineError("{\"error\":{\"code\":\"overloaded\",\"message\":\"try later\"}}")).toMatchObject({
      code: "provider_internal"
    })
    expect(inlineError("{\"error\":{\"message\":\"invalid_request: bad tool schema\"}}")).toMatchObject({
      code: "invalid_request"
    })
    expect(inlineError("{\"error\":{\"message\":\"something nobody classified\"}}")).toMatchObject({
      code: "unknown",
      providerCode: undefined
    })
    expect(inlineError("{\"error\":{}}")).toMatchObject({
      code: "unknown",
      message: "Chat Completions stream reported an error",
      providerCode: undefined
    })
  })

  it("classifies numeric inline code 429 as rate limited", () => {
    expect(inlineError("{\"error\":{\"code\":429,\"message\":\"try later\"}}")).toMatchObject({
      code: "rate_limited",
      providerCode: "429"
    })
  })

  it("classifies numeric inline code 401 as authentication", () => {
    expect(inlineError("{\"error\":{\"code\":401,\"message\":\"denied\"}}")).toMatchObject({
      code: "authentication",
      providerCode: "401"
    })
  })

  it("classifies numeric inline code 500 as provider internal", () => {
    expect(inlineError("{\"error\":{\"code\":500,\"message\":\"upstream failed\"}}")).toMatchObject({
      code: "provider_internal",
      providerCode: "500"
    })
  })

  it("does not treat a numeric inline code outside the HTTP range as a status", () => {
    expect(inlineError("{\"error\":{\"code\":42,\"message\":\"mystery\"}}")).toMatchObject({
      code: "unknown",
      providerCode: "42"
    })
  })

  it("short-circuits settlement when the state becomes settled during a step", () => {
    let reads = 0
    const state = Object.defineProperty(
      { ...OpenAIChatCompletions.protocol.stream.initial(streamRequest) },
      "settled",
      { get: () => reads++ > 0 }
    )

    const [settled, events] = step(
      state,
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}"
    )
    expect(settled.settled).toBe(true)
    expect(events).toEqual([])
  })

  it("recovers a tool call's index from its id when the delta omits the index", () => {
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"lookup\"}}]}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_a\",\"function\":{\"arguments\":\"{}\"}}]}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
    ])

    expect(events).toEqual([
      { type: "tool-call-start", id: "call_a", name: "lookup" },
      { type: "tool-call-delta", id: "call_a", arguments: "{}" },
      { type: "tool-call-end", id: "call_a", arguments: "{}" },
      { type: "settle", stopReason: "tool-calls" }
    ])
  })

  it("opens a nameless tool call as a typed provider fault", () => {
    const error = Effect.runSync(Effect.flip(
      OpenAIChatCompletions.protocol.stream.step(
        OpenAIChatCompletions.protocol.stream.initial(streamRequest),
        Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
          "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\"}]}}]}"
        )
      )
    ))

    expect(error).toMatchObject({
      code: "invalid_provider_output",
      message: "Chat Completions opened a tool call without a name"
    })
  })

  it("fails a finish_reason that arrives while a tool call's arguments are still partial", () => {
    const error = Effect.runSync(Effect.flip(
      OpenAIChatCompletions.protocol.stream.step(
        step(
          OpenAIChatCompletions.protocol.stream.initial(streamRequest),
          "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]}}]}"
        )[0],
        Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
          "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
        )
      )
    ))

    expect(error).toMatchObject({ code: "invalid_provider_output" })
  })

  it("reads the trailing usage-only chunk that follows the finish_reason chunk", () => {
    // Both Ollama and api.openai.com send one final choice-less chunk carrying
    // only `usage` after settlement, and nothing exercised that path.
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
      "{\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}"
    ])

    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  })

  it("carries OpenRouter's reported USD charge as the usage cost", () => {
    const events = replayData([
      "{\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4,\"cost\":0.00042}}"
    ])
    expect(events).toEqual([{ type: "usage", inputTokens: 3, outputTokens: 1, totalTokens: 4, costUsd: 0.00042 }])
    expect(Events.settledMessage(events).usage.costUsd).toBe(0.00042)
  })

  it("reads a choice-less usage chunk before settlement", () => {
    expect(replayData([
      "{\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}"
    ])).toEqual([
      { type: "usage", inputTokens: 3, outputTokens: 1, totalTokens: 4 }
    ])
  })

  it("flushes a tool call left open when the stream is cut short", () => {
    expect(replayData(fixture("abort-mid-stream.sse"))).toEqual([
      { type: "tool-call-start", id: "call_abort", name: "lookup" },
      { type: "tool-call-delta", id: "call_abort", arguments: "{\"query\":\"par" },
      { type: "tool-call-end", id: "call_abort", arguments: "{\"query\":\"par" }
    ])
  })

  it("ignores empty deltas, empty chunks, and chunks that arrive after settlement", () => {
    const events = replayData([
      // A choice-less chunk with no usage at all.
      "{\"id\":\"chatcmpl_1\"}",
      "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"one\"}}]}",
      // A second text delta on the already-open part.
      "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\" two\"}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"lookup\"}}]}}]}",
      // A tool-call delta carrying no argument fragment.
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\"}}]}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}",
      // Everything after settlement is ignored unless it carries usage.
      "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"after\"}}]}"
    ])

    expect(events).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "one" },
      { type: "text-delta", id: "text-0", text: " two" },
      { type: "tool-call-start", id: "call_a", name: "lookup" },
      { type: "tool-call-end", id: "call_a", arguments: "{}" },
      { type: "text-end", id: "text-0" },
      // A choice-less chunk is read for its usage alone, so the id it carried
      // never reached the state.
      { type: "settle", stopReason: "tool-calls" }
    ])
  })

  it("opens a tool call the provider identified only by position", () => {
    // A delta with neither an index nor an id starts the next call, and its id
    // is synthesized from that position because there is nothing else to key on.
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}"
    ])

    expect(events).toEqual([
      { type: "tool-call-start", id: "tool-0", name: "lookup" },
      { type: "tool-call-delta", id: "tool-0", arguments: "{}" },
      { type: "tool-call-end", id: "tool-0", arguments: "{}" },
      { type: "settle", stopReason: "tool-calls" }
    ])
  })

  it("settles exactly once when two chunks both carry a finish_reason", () => {
    const events = replayData([
      "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
      "{\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}"
    ])

    expect(events.filter((event) => event.type === "settle")).toHaveLength(1)
  })

  it("settles once on a defect malformed chunk carrying an inline error", () => {
    const result = Effect.runSync(
      Effect.flip(
        OpenAIChatCompletions.protocol.stream.step(
          OpenAIChatCompletions.protocol.stream.initial(streamRequest),
          Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
            "{\"error\":{\"message\":\"model overloaded\",\"code\":\"overloaded\"}}"
          )
        )
      )
    )
    expect(result.code).toBe("provider_internal")
    expect(result.message).toBe("model overloaded")
  })

  it("maps every finish_reason to its provider-neutral stop reason", () => {
    const reasonFor = (finishReason: string): string => {
      const events = replayData([`{"choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}"}]}`])
      const settle = events.find((event): event is Events.Settle => event.type === "settle")
      return settle?.stopReason ?? "missing"
    }
    expect(reasonFor("stop")).toBe("stop")
    expect(reasonFor("length")).toBe("length")
    expect(reasonFor("tool_calls")).toBe("tool-calls")
    expect(reasonFor("content_filter")).toBe("content-filter")
    expect(reasonFor("something_unrecognized")).toBe("unknown")
  })
})

describe("OpenAIChatCompletions.protocol.stream terminal reason", () => {
  const call =
    "{\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_1\",\"index\":0,\"type\":\"function\",\"function\":{\"name\":\"answer\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}"
  const finish = (reason: string) => `{"choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}]}`
  const reasonOf = (data: ReadonlyArray<string>) =>
    replayData(data).find((event): event is Events.Settle => event.type === "settle")?.stopReason

  // Gemini finishes a successful tool turn with `stop`, so a completed call
  // normalizes that to `tool-calls`; a truncation or a refusal that happens to
  // follow a completed call is still a truncation or a refusal.
  it.each([
    ["stop", "tool-calls", "stop"],
    ["tool_calls", "tool-calls", "tool-calls"],
    ["length", "length", "length"],
    ["content_filter", "content-filter", "content-filter"],
    ["mystery", "unknown", "unknown"]
  ])("settles finish_reason %s as %s with a tool call and %s without", (finishReason, withCall, withoutCall) => {
    expect(reasonOf([call, finish(finishReason)])).toBe(withCall)
    expect(reasonOf([finish(finishReason)])).toBe(withoutCall)
  })

  it("keeps a completed tool call in a length-stopped message", () => {
    const message = Events.ModelEvent.settledMessage(replayData([call, finish("length")])).message
    expect(message.stopReason).toBe("length")
    expect(message.content).toEqual([{ type: "tool-call", id: "call_1", name: "answer", arguments: "{}" }])
  })

  it("declares the trailing choice-less usage chunk as the terminal event", () => {
    // `[DONE]` never reaches a protocol (SSE framing discards it), and the
    // finish_reason chunk precedes the usage chunk this route always requests,
    // so the choice-less usage chunk is the last frame the protocol can see.
    const decode = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)
    const terminal = OpenAIChatCompletions.protocol.stream.terminal
    expect(terminal).toBeDefined()
    expect(
      terminal?.(decode("{\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}"))
    ).toBe(true)
    expect(terminal?.(decode("{\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}"))).toBe(
      true
    )
    expect(terminal?.(decode(finish("stop")))).toBe(false)
    expect(terminal?.(decode("{\"choices\":[],\"usage\":null}"))).toBe(false)
    expect(
      terminal?.(
        decode(
          "{\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}"
        )
      )
    ).toBe(false)
  })
})

describe("OpenAIChatCompletions.protocol.classifyError", () => {
  it("classifies a real Gemini 429 rate-limit body, even array-wrapped", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(
      429,
      "[{\"error\":{\"code\":429,\"message\":\"You exceeded your current quota\",\"status\":\"RESOURCE_EXHAUSTED\"}}]"
    )
    expect(error.httpStatus).toBe(429)
    expect(error.code).toBe("rate_limited")
  })

  it("classifies an authentication failure by status code", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(401, "{\"error\":{\"message\":\"invalid api key\"}}")
    expect(error.code).toBe("authentication")
  })

  it("classifies quota exhaustion by message content", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(
      400,
      "{\"error\":{\"message\":\"You have no credits remaining\"}}"
    )
    expect(error.code).toBe("quota_exceeded")
    expect(
      OpenAIChatCompletions.protocol.classifyError(
        400,
        "{\"error\":{\"message\":\"Your credit balance is too low\"}}"
      ).code
    ).toBe("quota_exceeded")
  })

  it("falls back to a generic message when the body is not JSON", () => {
    const error = OpenAIChatCompletions.protocol.classifyError(500, "internal server error, not json")
    expect(error.code).toBe("provider_internal")
    expect(error.message).toBe("Chat Completions request failed with HTTP 500")
  })
})
