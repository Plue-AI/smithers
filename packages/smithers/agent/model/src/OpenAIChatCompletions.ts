/**
 * OpenAI Chat Completions request lowering and SSE event handling.
 *
 * This is the older, widely-cloned OpenAI wire shape — distinct from
 * {@link OpenAIResponses}, which targets api.openai.com's newer Responses
 * API. Every self-hosted or third-party "OpenAI-compatible" endpoint that
 * does not implement Responses (Ollama, Gemini's compatibility layer, and
 * most others) speaks this one instead, so it is the protocol a generic
 * `openaiCompatible` route needs.
 *
 * @since 0.1.0
 */

import { Effect, Option, Schema } from "effect"
import { classifyHttpStatus } from "./HttpStatusClassifier.ts"
import { ModelError } from "./ModelError.ts"
import * as ModelEvent from "./ModelEvent.ts"
import {
  JsonObject,
  type Message,
  type ModelRequest,
  ReasoningEffort,
  type StopReason,
  type ToolDefinition
} from "./ModelRequest.ts"
import * as Protocol from "./Protocol.ts"
import * as ToolStream from "./ToolStream.ts"

const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    parameters: JsonObject
  })
})

type FunctionTool = typeof FunctionTool.Type

const ToolCallRef = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String })
})

const ChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optional(Schema.Array(ToolCallRef))
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.String
  })
])

type ChatMessage = typeof ChatMessage.Type

/**
 * The `response_format` field that turns on native structured output.
 *
 * Chat Completions deployments that implement it validate the answer against
 * the supplied JSON Schema themselves, so the caller receives a document it can
 * decode rather than prose it has to scan. Measured against a live Cerebras
 * seat on 2026-08-29: `response_format` alone answers `{"city":"Paris"}`, and
 * `response_format` together with `tools` is refused with
 * `"tools" is incompatible with "response_format"` (`wrong_api_format`).
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResponseFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  json_schema: Schema.Struct({
    name: Schema.String,
    strict: Schema.Boolean,
    schema: JsonObject
  })
})

/**
 * The decoded form of {@link ResponseFormat}.
 *
 * @category models
 * @since 0.1.0
 */
export type ResponseFormat = typeof ResponseFormat.Type

/**
 * The native-structured-output toggle a route is configured with.
 *
 * Presence is the toggle: a route built without one lowers requests exactly as
 * before and leaves the schema to the prompt (`@smthrs/harness`
 * `StructuredOutput.instructions`), and a route built with one asks the
 * provider to enforce the schema instead.
 *
 * Such a route refuses a request that declares tools with `invalid_request`,
 * because the provider refuses `tools` and `response_format` together. The one
 * exception is `toolChoice: "none"`: that request forbids tool use, this
 * lowering answers it by omitting `tools`, and the two fields therefore never
 * meet on the wire, so it is lowered rather than refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface StructuredOutput {
  /** The schema's name, echoed back by the provider on a refusal. */
  readonly name: string
  /** The JSON Schema document the answer must satisfy. */
  readonly schema: JsonObject
  /** Whether the provider must reject an answer that misses the schema. Defaults to `true`. */
  readonly strict?: boolean | undefined
}

/**
 * JSON schema for a Chat Completions request body.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  tools: Schema.optional(Schema.Array(FunctionTool)),
  response_format: Schema.optional(ResponseFormat),
  reasoning_effort: Schema.optional(ReasoningEffort),
  max_tokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Literal(true) }))
})

/**
 * The decoded form of the Chat Completions request body.
 *
 * @category models
 * @since 0.1.0
 */
export type Body = typeof Body.Type

const functionTool = (tool: ToolDefinition): FunctionTool => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters }
})

const systemMessage = (request: ModelRequest): ReadonlyArray<ChatMessage> => {
  const text = request.system.map((part) => part.text).join("\n")
  return text === "" ? [] : [{ role: "system", content: text }]
}

const assistantToolCalls = (
  message: Extract<Message, { readonly role: "assistant" }>
): ReadonlyArray<typeof ToolCallRef.Type> =>
  // A truncated turn's calls never ran and have no results; see
  // ToolStream.truncated.
  ToolStream.truncated(message.stopReason) ? [] : message.content.flatMap((part) =>
    part.type === "tool-call"
      ? [{ id: part.id, type: "function" as const, function: { name: part.name, arguments: part.arguments } }]
      : []
  )

const lowerMessages = (request: ModelRequest): ReadonlyArray<ChatMessage> => {
  const messages: Array<ChatMessage> = [...systemMessage(request)]
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((part) => part.text).join("") })
      continue
    }
    if (message.role === "assistant") {
      // A historically aborted or errored turn carries no wire-valid content;
      // omitting it lets the next user input resume cleanly, matching
      // OpenAIResponses's own handling of the same case.
      if (message.stopReason === "aborted" || message.stopReason === "error") continue
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
      const toolCalls = assistantToolCalls(message)
      messages.push({
        role: "assistant",
        content: text === "" && toolCalls.length > 0 ? null : text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls })
      })
      continue
    }
    for (const result of message.content) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content })
    }
  }
  return messages
}

const responseFormat = (structuredOutput: StructuredOutput): ResponseFormat => ({
  type: "json_schema",
  json_schema: {
    name: structuredOutput.name,
    strict: structuredOutput.strict ?? true,
    schema: structuredOutput.schema
  }
})

const buildBody = (
  request: ModelRequest,
  structuredOutput: StructuredOutput | undefined
): Body => ({
  model: request.modelId,
  messages: lowerMessages(request),
  // `toolChoice: "none"` forbids tool use, and both provider APIs express that
  // by omitting `tools` rather than by a wire field, so the request is lowered
  // as if it declared none.
  ...(structuredOutput !== undefined || request.toolChoice === "none" || request.tools.length === 0
    ? {}
    : { tools: request.tools.map(functionTool) }),
  ...(structuredOutput === undefined ? {} : { response_format: responseFormat(structuredOutput) }),
  // The same knob `OpenAIResponses` sends as `reasoning.effort`. Cerebras's
  // qwen-3.8-27b reasons at `high` when the body says nothing, so a stated
  // effort that never reached the wire spent output tokens the caller had
  // already declined. An unstated effort still leaves the body alone, and
  // with it the provider's own default.
  ...(request.params.reasoningEffort === undefined ? {} : { reasoning_effort: request.params.reasoningEffort }),
  ...(request.params.maxTokens === undefined ? {} : { max_tokens: request.params.maxTokens }),
  ...(request.params.temperature === undefined ? {} : { temperature: request.params.temperature }),
  ...(request.params.topP === undefined ? {} : { top_p: request.params.topP }),
  stream: true,
  stream_options: { include_usage: true }
})

const fromRequest = (structuredOutput: StructuredOutput | undefined) =>
  Effect.fn("OpenAIChatCompletions.fromRequest")((
    request: ModelRequest
  ): Effect.Effect<Body, ModelError> =>
    // `toolChoice: "none"` is the request saying no tool may be called, and
    // this lowering already answers it by omitting `tools`, so such a request
    // never puts `tools` and `response_format` on the wire together and there
    // is nothing to refuse.
    structuredOutput !== undefined && request.tools.length > 0 && request.toolChoice !== "none"
      // Refusing here costs one local failure; sending it costs a provider
      // round trip that ends in HTTP 400 with the same meaning.
      ? Effect.fail(
        new ModelError({
          code: "invalid_request",
          message:
            "A Chat Completions route with native structured output cannot send tools: the provider rejects tools together with response_format"
        })
      )
      : Effect.succeed(buildBody(request, structuredOutput))
  )

const ChunkToolCall = Schema.Struct({
  index: Schema.optional(Schema.Number),
  id: Schema.optional(Schema.String),
  function: Schema.optional(Schema.Struct({
    name: Schema.optional(Schema.String),
    arguments: Schema.optional(Schema.String)
  }))
})

const ChunkDelta = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.Array(ChunkToolCall))
})

const ChunkUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  /** OpenRouter's charge for the call, in USD. */
  cost: Schema.optional(Schema.Number)
})

const ChatCompletionChunk = Schema.Struct({
  id: Schema.optional(Schema.String),
  choices: Schema.optional(Schema.Array(Schema.Struct({
    index: Schema.optional(Schema.Number),
    delta: Schema.optional(ChunkDelta),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String))
  }))),
  usage: Schema.optional(Schema.NullOr(ChunkUsage)),
  error: Schema.optional(JsonObject)
})

type ChatCompletionChunk = typeof ChatCompletionChunk.Type

/**
 * What the adapter must carry between chunks of one Chat Completions stream:
 * whether the (single, id-less) text part has opened, and the in-flight tool
 * calls keyed by their stream position, since a delta only ever repeats the
 * provider tool call's array `index` — the `id` and `function.name` arrive
 * once, on the first delta for that index.
 *
 * @category models
 * @since 0.1.0
 */
export interface State {
  readonly tools: ToolStream.State
  readonly callIdByIndex: Readonly<Record<number, string>>
  readonly textOpen: boolean
  readonly settled: boolean
  readonly usage?: typeof ChunkUsage.Type
  readonly responseId?: string
}

const TEXT_ID = "text-0"

const usageEvent = (usage: typeof ChunkUsage.Type | null | undefined): ModelEvent.ModelEvent | undefined =>
  usage === null || usage === undefined ? undefined : ModelEvent.ModelEvent.Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costUsd: usage.cost
  })

const stopReasonOf = (reason: string): StopReason =>
  reason === "stop"
    ? "stop"
    : reason === "length"
    ? "length"
    : reason === "tool_calls"
    ? "tool-calls"
    : reason === "content_filter"
    ? "content-filter"
    : "unknown"

const settle = (
  state: State,
  stopReason: StopReason,
  usage: ModelEvent.ModelEvent | undefined
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } =>
  state.settled
    ? { state, events: [] }
    : {
      state: { ...state, settled: true },
      events: [
        ...(state.textOpen ? [ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: TEXT_ID })] : []),
        ...(usage === undefined ? [] : [usage]),
        ModelEvent.ModelEvent.Settle({
          type: "settle",
          stopReason,
          ...(state.responseId === undefined ? {} : { responseId: state.responseId })
        })
      ]
    }

const toolIndex = (state: State, call: typeof ChunkToolCall.Type): number => {
  if (call.index !== undefined) return call.index
  if (call.id !== undefined) {
    for (const [index, callId] of Object.entries(state.callIdByIndex)) {
      if (callId === call.id) return Number(index)
    }
  }
  return Object.keys(state.callIdByIndex).reduce((next, index) => Math.max(next, Number(index) + 1), 0)
}

const stepToolCall = (
  state: State,
  call: typeof ChunkToolCall.Type
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  const index = toolIndex(state, call)
  const existingId = state.callIdByIndex[index]
  if (existingId === undefined) {
    const id = call.id ?? `tool-${index}`
    const name = call.function?.name
    if (name === undefined) {
      return new ModelError({
        code: "invalid_provider_output",
        message: "Chat Completions opened a tool call without a name"
      })
    }
    const initialArguments = call.function?.arguments
    const tools = initialArguments === undefined || initialArguments === ""
      ? ToolStream.start(state.tools, { callId: id, name })
      : ToolStream.delta(ToolStream.start(state.tools, { callId: id, name }), id, initialArguments)
    return {
      state: { ...state, tools, callIdByIndex: { ...state.callIdByIndex, [index]: id } },
      events: [
        ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id, name }),
        ...(initialArguments === undefined || initialArguments === ""
          ? []
          : [ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id, arguments: initialArguments })])
      ]
    }
  }
  const fragment = call.function?.arguments
  if (fragment === undefined || fragment === "") return { state, events: [] }
  return {
    state: { ...state, tools: ToolStream.delta(state.tools, existingId, fragment) },
    events: [ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: existingId, arguments: fragment })]
  }
}

const stepEvent = (
  state: State,
  event: ChatCompletionChunk
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  if (event.error !== undefined) {
    // Chat-compatible gateways answer HTTP 200 and report the real failure
    // inside the stream: OpenRouter sends `{"error":{"code":429,...}}` this
    // way. Classifying every one of them as `provider_internal` made a rate
    // limit, an exhausted balance and a rejected key all retryable, so the
    // ladder burned instead of the seat parking or the call failing typed.
    const error = event.error as { readonly message?: unknown; readonly code?: unknown }
    const providerCode = typeof error.code === "string"
      ? error.code
      : typeof error.code === "number"
      ? String(error.code)
      : undefined
    const message = typeof error.message === "string" ? error.message : "Chat Completions stream reported an error"
    return new ModelError({
      code: providerReason(undefined, providerCode, message),
      message,
      providerCode
    })
  }
  const usage = usageEvent(event.usage)
  // Both Ollama and api.openai.com send one final, choice-less chunk carrying
  // only `usage` after the chunk with `finish_reason`, so it must be read
  // even once `state.settled` is already true; nothing else may run past
  // settlement.
  if (state.settled) return { state, events: usage === undefined ? [] : [usage] }
  const choice = event.choices?.[0]
  if (choice === undefined) return { state, events: usage === undefined ? [] : [usage] }
  const delta = choice.delta
  const events: Array<ModelEvent.ModelEvent> = []
  let current: State = {
    ...state,
    ...(event.usage === undefined || event.usage === null ? {} : { usage: event.usage }),
    ...(event.id === undefined ? {} : { responseId: event.id })
  }
  if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
    if (!current.textOpen) {
      current = { ...current, textOpen: true }
      events.push(ModelEvent.ModelEvent.TextStart({ type: "text-start", id: TEXT_ID }))
    }
    events.push(ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: TEXT_ID, text: delta.content }))
  }
  for (const call of delta?.tool_calls ?? []) {
    const result = stepToolCall(current, call)
    if (result instanceof ModelError) return result
    current = result.state
    events.push(...result.events)
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    // Every open tool call closes when the provider signals it stopped:
    // Chat Completions never sends a per-call "done" event the way Responses
    // does, only the aggregate `finish_reason`. A truncated turn closes its
    // calls with what arrived (see ToolStream.truncated); any other validates.
    const stopReason = stopReasonOf(choice.finish_reason)
    if (ToolStream.truncated(stopReason)) {
      const flushed = ToolStream.flushAborted(current.tools)
      current = { ...current, tools: flushed.state }
      for (const call of flushed.completed) {
        events.push(
          ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments })
        )
      }
    }
    for (const callId of Object.values(current.callIdByIndex)) {
      if (!current.tools.open.some((call) => call.callId === callId)) continue
      const ended = ToolStream.end(current.tools, callId)
      if (ended instanceof ModelError) return ended
      current = { ...current, tools: ended.state }
      events.push(
        ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: callId, arguments: ended.completed.arguments })
      )
    }
    // Gemini finishes a successful tool turn with `stop`, so a completed call
    // normalizes that to `tool-calls`. A truncation or a refusal that follows a
    // completed call is still a truncation or a refusal.
    const terminal = settle(
      current,
      stopReason === "stop" && Object.keys(current.callIdByIndex).length > 0 ? "tool-calls" : stopReason,
      usageEvent(event.usage ?? current.usage)
    )
    return { state: terminal.state, events: [...events, ...terminal.events] }
  }
  return { state: current, events }
}

const step = Effect.fn("OpenAIChatCompletions.step")((
  state: State,
  event: ChatCompletionChunk
): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent.ModelEvent>], ModelError> =>
  Effect.suspend(() => {
    const result = stepEvent(state, event)
    return result instanceof ModelError ? Effect.fail(result) : Effect.succeed([result.state, result.events] as const)
  })
)

// `[DONE]` never reaches a protocol (SSE framing discards it), and the
// finish_reason chunk precedes the choice-less usage chunk that
// `stream_options.include_usage` makes api.openai.com and Ollama send last, so
// that chunk is the final frame the route can stop pulling at. A provider that
// folds usage into the finish_reason chunk still ends at HTTP EOF.
const terminalEvent = (event: ChatCompletionChunk): boolean =>
  (event.choices === undefined || event.choices.length === 0) && event.usage !== undefined && event.usage !== null

const finalize = (state: State): ReadonlyArray<ModelEvent.ModelEvent> =>
  ToolStream.flushAborted(state.tools).completed.map((call) =>
    ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments })
  )

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const providerReason = (
  status: number | undefined,
  code: string | undefined,
  message: string
): ModelError["code"] => {
  // A chat-compatible gateway reporting a failure inside an HTTP 200 stream has
  // no status to hand us and puts the one it would have sent in `code`
  // instead: OpenRouter sends `{"error":{"code":429}}`. A purely numeric
  // provider code in the HTTP range therefore stands in for the status the
  // transport never carried, so `429` classifies as a rate limit rather than
  // falling through every phrase test to `unknown`.
  const numeric = code === undefined ? Number.NaN : Number(code)
  const httpLike = Number.isInteger(numeric) && numeric >= 400 && numeric <= 599 ? numeric : undefined
  const effective = status ?? httpLike
  return classifyHttpStatus(effective, code, message)
}

const classifyError = (status: number, body: string): ModelError => {
  const decoded = decodeErrorBody(body)
  const parsed = Option.isSome(decoded) ? decoded.value : undefined
  const error = record(record(parsed)?.error) ?? record(parsed)
  const code = string(error?.code) ?? string(error?.type)
  const message = string(error?.message) ?? `Chat Completions request failed with HTTP ${status}`
  return new ModelError({
    code: providerReason(status, code, message),
    message,
    httpStatus: status,
    providerCode: code
  })
}

/**
 * Builds the OpenAI Chat Completions protocol, optionally with native
 * structured output turned on.
 *
 * The option is presence-based: without it the lowering is byte-for-byte what
 * it has always been, so existing sealed step keys are unchanged.
 *
 * @category constructors
 * @since 0.1.0
 */
export const protocolWith = (
  options: { readonly structuredOutput?: StructuredOutput | undefined } = {}
): Protocol.Protocol<Body, string, ChatCompletionChunk, State> =>
  Protocol.make({
    id: "openai-chat-completions",
    supportsDeferred: () => false,
    body: {
      schema: Body,
      from: fromRequest(options.structuredOutput)
    },
    stream: {
      event: Protocol.jsonEvent(ChatCompletionChunk),
      initial: () => ({ tools: ToolStream.initial(), callIdByIndex: {}, textOpen: false, settled: false }),
      step,
      onHalt: finalize,
      terminal: terminalEvent
    },
    classifyError
  })

/**
 * The OpenAI Chat Completions protocol with native structured output off — the
 * wire shape Ollama, Gemini's OpenAI-compatible endpoint, and most other
 * self-hosted or third-party "OpenAI-compatible" servers actually implement.
 *
 * @category models
 * @since 0.1.0
 */
export const protocol: Protocol.Protocol<Body, string, ChatCompletionChunk, State> = protocolWith()
