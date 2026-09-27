/**
 * OpenAI Responses request lowering and SSE event handling.
 *
 * @since 0.1.0
 */

import { Clock, Effect, Option, Schema } from "effect"
import * as CanonicalJson from "./CanonicalJson.ts"
import * as DeferredTools from "./DeferredTools.ts"
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
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  defer_loading: Schema.optional(Schema.Boolean)
})

const WebSearchTool = Schema.Struct({
  type: Schema.Literal("web_search"),
  filters: Schema.optional(Schema.Struct({ allowed_domains: Schema.Array(Schema.String) }))
})

const Tool = Schema.Union([FunctionTool, WebSearchTool])

const ReasoningInput = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(Schema.Json)),
  encrypted_content: Schema.optional(Schema.String)
})

const InputItem = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }))
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }))
  }),
  Schema.Struct({ type: Schema.Literal("item_reference"), id: Schema.String }),
  ReasoningInput,
  Schema.Struct({
    type: Schema.Literal("function_call"),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literal("tool_search_call"),
    call_id: Schema.String,
    execution: Schema.Literal("client"),
    status: Schema.Literal("completed"),
    arguments: Schema.Struct({ query: Schema.String, limit: Schema.Finite })
  }),
  Schema.Struct({
    type: Schema.Literal("tool_search_output"),
    call_id: Schema.String,
    execution: Schema.Literal("client"),
    status: Schema.Literal("completed"),
    tools: Schema.Array(FunctionTool)
  })
])

/**
 * JSON schema for an OpenAI Responses request body.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Body = Schema.Struct({
  model: Schema.String,
  instructions: Schema.optional(Schema.String),
  input: Schema.Array(InputItem),
  tools: Schema.optional(Schema.Array(Tool)),
  reasoning: Schema.optional(Schema.Struct({
    effort: ReasoningEffort,
    summary: Schema.optional(Schema.Literals(["auto", "concise", "detailed"]))
  })),
  max_output_tokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  stream: Schema.Literal(true),
  prompt_cache_key: Schema.optional(Schema.String)
})

/**
 * The decoded form of the Responses request body.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Body = typeof Body.Type

const { max_output_tokens: _maxOutputTokens, ...chatgptFields } = Body.fields

/**
 * JSON schema for a ChatGPT-plan Responses request body. The subscription
 * backend narrows the API-key surface (each delta confirmed against the live
 * backend, 2026-08-25). `store` must be `false`, because nothing is persisted
 * server-side. `max_output_tokens` is rejected outright, so a request that
 * sets `params.maxTokens` fails locally as `invalid_request` naming that
 * member rather than being sent unbounded. `include:
 * ["reasoning.encrypted_content"]` is how reasoning survives the
 * statelessness: the returned items carry their own encrypted state and are
 * replayed verbatim on the next request.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ChatGPTBody = Schema.Struct({
  ...chatgptFields,
  store: Schema.Literal(false),
  include: Schema.Array(Schema.Literal("reasoning.encrypted_content"))
})

/**
 * The decoded form of the ChatGPT-plan Responses request body.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ChatGPTBody = typeof ChatGPTBody.Type

type InputItem = typeof InputItem.Type
type FunctionTool = typeof FunctionTool.Type

const OpenAIEvent = Schema.Struct({
  type: Schema.String,
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  param: Schema.optional(Schema.NullOr(Schema.String)),
  item_id: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  item: Schema.optional(JsonObject),
  response: Schema.optional(JsonObject),
  error: Schema.optional(JsonObject)
})

type OpenAIEvent = typeof OpenAIEvent.Type

const decodeReasoningInput = Schema.decodeUnknownOption(Schema.fromJsonString(ReasoningInput))
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject))

/**
 * What the adapter must carry between events of one Responses stream: the
 * partially assembled tool calls, the ids already opened, and the response
 * identity a continuation replays.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface State {
  readonly tools: ToolStream.State
  readonly toolNames: Readonly<Record<string, string>>
  readonly textIds: ReadonlySet<string>
  readonly thinkingIds: ReadonlySet<string>
  readonly completedToolIds: ReadonlySet<string>
  readonly itemIds: ReadonlyArray<string>
  readonly responseId: string | undefined
  readonly settled: boolean
}

const functionTool = (tool: ToolDefinition, deferred = false): FunctionTool => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
  ...(deferred ? { defer_loading: true } : {})
})

const systemInstructions = (request: ModelRequest): string | undefined => {
  const text = request.system.map((part) => part.text).join("\n")
  return text === "" ? undefined : text
}

const assistantInput = (message: Extract<Message, { readonly role: "assistant" }>): ReadonlyArray<InputItem> => {
  // Incomplete historical output cannot be replayed as a completed Responses
  // item. Omitting it lets the next user input resume cleanly.
  if (message.stopReason === "aborted" || message.stopReason === "error") return []
  const result: Array<InputItem> = []
  const referenced = new Set<string>()
  const reasoningIds = new Set(
    message.content.flatMap((part) => {
      if (part.type !== "thinking" || part.signature === undefined) return []
      const parsed = decodeReasoningInput(part.signature)
      if (Option.isSome(parsed) && parsed.value.id !== undefined) return [parsed.value.id]
      return [part.signature]
    })
  )
  for (const id of message.itemIds ?? []) {
    if (reasoningIds.has(id) || referenced.has(id)) continue
    result.push({ type: "item_reference", id })
    referenced.add(id)
  }
  // Items replay in the order the model produced them, as the Responses
  // reasoning guide asks: a reasoning item precedes the message it reasoned
  // toward. The text parts still join into one message, placed where the
  // first of them stood.
  const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
  let textPlaced = text === ""
  for (const part of message.content) {
    if (part.type === "text" && !textPlaced) {
      result.push({
        role: "assistant",
        content: [{ type: "output_text", text }]
      })
      textPlaced = true
    }
    if (part.type === "thinking" && part.signature !== undefined) {
      const parsed = decodeReasoningInput(part.signature)
      if (Option.isSome(parsed)) {
        result.push(parsed.value)
        if (parsed.value.id !== undefined) referenced.add(parsed.value.id)
      } else if (!referenced.has(part.signature)) {
        result.push({ type: "item_reference", id: part.signature })
        referenced.add(part.signature)
      }
    }
    // A truncated turn's calls never ran, so replaying one would send a
    // function_call with no function_call_output. See ToolStream.truncated.
    if (part.type === "tool-call" && !ToolStream.truncated(message.stopReason)) {
      result.push({ type: "function_call", call_id: part.id, name: part.name, arguments: part.arguments })
    }
  }
  return result
}

const selectedTools = (
  names: ReadonlyArray<string>,
  tools: ReadonlyArray<ToolDefinition>
): ReadonlyArray<ToolDefinition> => {
  const byName = new Map(tools.map((tool) => [tool.name.trim().toLowerCase(), tool] as const))
  const result: Array<ToolDefinition> = []
  for (const name of names) {
    const tool = byName.get(name.trim().toLowerCase())
    if (tool !== undefined && !result.some((entry) => entry.name === tool.name)) result.push(tool)
  }
  return result
}

const searchItems = (
  toolCallId: string,
  names: ReadonlyArray<string>,
  tools: ReadonlyArray<ToolDefinition>,
  loadedNames: Set<string>
): ReadonlyArray<InputItem> => {
  const activated = selectedTools(names, tools).filter((tool) => {
    const normalized = tool.name.trim().toLowerCase()
    if (loadedNames.has(normalized)) return false
    loadedNames.add(normalized)
    return true
  })
  if (activated.length === 0) return []
  // Measured against pi's reference implementation: this exact synthetic pair
  // reads as a completed client search at the load point.
  const searchCallId = `pi_tool_load_${
    CanonicalJson.shortHash(`${toolCallId}:${activated.map((tool) => tool.name).join(",")}`)
  }`
  return [
    {
      type: "tool_search_call",
      call_id: searchCallId,
      execution: "client",
      status: "completed",
      arguments: { query: activated.map((tool) => tool.name).join(" "), limit: activated.length }
    },
    {
      type: "tool_search_output",
      call_id: searchCallId,
      execution: "client",
      status: "completed",
      tools: activated.map((tool) => functionTool(tool, true))
    }
  ]
}

const lowerInput = (
  request: ModelRequest,
  deferredTools: ReadonlyArray<ToolDefinition>
): ReadonlyArray<InputItem> => {
  const input: Array<InputItem> = []
  const loadedNames = new Set<string>()
  for (const message of request.messages) {
    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content.filter((part) => part.type === "text").map((part) => ({
          type: "input_text",
          text: part.text
        }))
      })
      continue
    }
    if (message.role === "assistant") {
      input.push(...assistantInput(message))
      continue
    }
    for (const result of message.content) {
      input.push({ type: "function_call_output", call_id: result.toolCallId, output: result.content })
      input.push(...searchItems(result.toolCallId, result.addedToolNames, deferredTools, loadedNames))
    }
  }
  return input
}

const buildBody = (
  request: ModelRequest,
  options: { readonly native: boolean },
  protocolId: DeferredTools.ProtocolId = "openai-responses"
): Body => {
  const native = options.native && DeferredTools.supportsDeferred(protocolId, request.modelId)
  // `toolChoice: "none"` forbids tool use, and the Responses API expresses that
  // by omitting `tools` rather than by a wire field, so the request is lowered
  // as if it declared none: no tool declarations and no deferred-tool search
  // items in the input.
  const tools = request.toolChoice === "none"
    ? { immediate: [], deferred: [], activatedNames: [] }
    : DeferredTools.resolve(request, native)
  const instructions = systemInstructions(request)
  // Provider-run tools are not declared tools: `toolChoice: "none"` keeps
  // them, and the search runs inside this call with no call reaching us.
  const declared: ReadonlyArray<typeof Tool.Type> = [
    ...tools.immediate.map((tool) => functionTool(tool)),
    ...[...new Map((request.serverTools ?? []).map((tool) => [CanonicalJson.stringify(tool), tool])).values()].map(
      (tool) => ({
        type: tool.type,
        ...(tool.allowedDomains === undefined ? {} : { filters: { allowed_domains: tool.allowedDomains } })
      })
    )
  ]
  return {
    model: request.modelId,
    ...(instructions === undefined ? {} : { instructions }),
    input: lowerInput(request, tools.deferred),
    ...(declared.length === 0 ? {} : { tools: declared }),
    ...(request.params.reasoningEffort === undefined ? {} : { reasoning: { effort: request.params.reasoningEffort } }),
    ...(request.params.maxTokens === undefined ? {} : { max_output_tokens: request.params.maxTokens }),
    ...(request.params.temperature === undefined ? {} : { temperature: request.params.temperature }),
    ...(request.params.topP === undefined ? {} : { top_p: request.params.topP }),
    stream: true,
    ...(request.cacheKey === undefined ? {} : { prompt_cache_key: request.cacheKey })
  }
}

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")((
  request: ModelRequest,
  options: { readonly native: boolean }
): Effect.Effect<Body, ModelError> => Effect.succeed(buildBody(request, options)))

const chatgptBody = (request: ModelRequest, options: { readonly native: boolean }): ChatGPTBody => {
  // `chatgptFromRequest` has already refused a request carrying `maxTokens`,
  // so the lowered body carries no `max_output_tokens` to strip here.
  const base = buildBody(request, options, "openai-responses-chatgpt")
  return {
    ...base,
    // `item_reference` names a stored response, and this backend stores none:
    // a reference would 400 where the encrypted reasoning item replays whole.
    input: base.input.filter((item) => !("type" in item && item.type === "item_reference")),
    // Summaries stream while the model thinks, so a long think is a live
    // stream rather than minutes of silence; the model call's idle timeout
    // reads that liveness. Only here: the API-key surface refuses summaries
    // to an unverified organization.
    ...(base.reasoning === undefined ? {} : { reasoning: { ...base.reasoning, summary: "auto" as const } }),
    store: false,
    include: ["reasoning.encrypted_content"]
  }
}

const chatgptFromRequest = Effect.fn("OpenAIResponses.chatgptFromRequest")((
  request: ModelRequest,
  options: { readonly native: boolean }
): Effect.Effect<ChatGPTBody, ModelError> =>
  // The subscription backend rejects `max_output_tokens` and offers no other
  // output cap, so a budget it cannot honor is refused here, before signing
  // and transport, rather than dropped: a caller who bounded the request must
  // not receive an unbounded one. The path names the member, never its value.
  request.params.maxTokens === undefined
    ? Effect.succeed(chatgptBody(request, options))
    : Effect.fail(
      new ModelError({
        code: "invalid_request",
        message:
          "The ChatGPT-subscription backend rejects max_output_tokens, so this route cannot honor params.maxTokens: omit the budget or use an API-key route",
        path: "params.maxTokens"
      })
    )
)

const eventType = (value: OpenAIEvent): string => value.type

const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined

const providerError = (
  value: OpenAIEvent,
  now: number
): {
  readonly code: string | undefined
  readonly message: string
  readonly resetAtEpochMillis?: number
  readonly resetSource?: string
  readonly retryAfterMillis?: number
} => {
  const error = record(value.error) ?? record(record(value.response)?.error)
  const resetAt = error?.resets_at
  const resetIn = error?.resets_in_seconds
  const absolute = typeof resetAt === "number" && Number.isFinite(resetAt)
    ? resetAt < 1_000_000_000_000 ? resetAt * 1_000 : resetAt
    : undefined
  const relative = typeof resetIn === "number" && Number.isFinite(resetIn) && resetIn >= 0
    ? now + resetIn * 1_000
    : undefined
  const resetAtEpochMillis = absolute ?? relative
  return {
    code: value.code ?? string(error?.code) ?? string(error?.type),
    message: value.message ?? string(error?.message) ?? "OpenAI Responses stream failed",
    ...(resetAtEpochMillis === undefined ? {} : {
      resetAtEpochMillis,
      resetSource: absolute === undefined ? "stream.error.resets_in_seconds" : "stream.error.resets_at",
      retryAfterMillis: Math.max(0, resetAtEpochMillis - now)
    })
  }
}

const settle = (
  state: State,
  stopReason: StopReason
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } =>
  state.settled
    ? { state, events: [] }
    : {
      state: { ...state, settled: true },
      events: [
        ModelEvent.ModelEvent.Settle({
          type: "settle",
          stopReason,
          responseId: state.responseId,
          ...(state.itemIds.length === 0 ? {} : { itemIds: state.itemIds })
        })
      ]
    }

const usage = (value: unknown): ModelEvent.Usage | undefined => {
  const item = record(value)
  if (item === undefined) return undefined
  const details = record(item.input_tokens_details)
  const outputDetails = record(item.output_tokens_details)
  return {
    inputTokens: typeof item.input_tokens === "number" ? item.input_tokens : undefined,
    outputTokens: typeof item.output_tokens === "number" ? item.output_tokens : undefined,
    cachedInputTokens: typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined,
    reasoningTokens: typeof outputDetails?.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : undefined,
    totalTokens: typeof item.total_tokens === "number" ? item.total_tokens : undefined
  }
}

const completeTool = (
  state: State,
  callId: string,
  finalArguments: string | undefined
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  if (state.completedToolIds.has(callId)) return { state, events: [] }
  const open = state.tools.open.find((call) => call.callId === callId)
  if (open === undefined) return { state, events: [] }
  const tools = open.fragments.length === 0 && finalArguments !== undefined
    ? ToolStream.delta(state.tools, callId, finalArguments)
    : state.tools
  const end = ToolStream.end(tools, callId)
  if (end instanceof ModelError) return end
  return {
    state: {
      ...state,
      tools: end.state,
      completedToolIds: new Set([...state.completedToolIds, callId])
    },
    events: [
      ModelEvent.ModelEvent.ToolCallEnd({
        type: "tool-call-end",
        id: callId,
        arguments: end.completed.arguments
      })
    ]
  }
}

const rememberItem = (state: State, itemId: string): State =>
  state.itemIds.includes(itemId) ? state : { ...state, itemIds: [...state.itemIds, itemId] }

/**
 * How a stream's reasoning items are carried into the next request.
 *
 * `stored` is api.openai.com: the provider persists the response, so replay
 * sends `item_reference` ids and the settle event records which ids to
 * reference. `encrypted` is the ChatGPT-plan backend, which persists nothing
 * (`store` must be false): the reasoning item itself, `encrypted_content`
 * included, is captured as a thinking part's signature and replayed verbatim,
 * and no item id is ever recorded for referencing.
 */
type Continuation = "stored" | "encrypted"

// The reasoning item, replayable exactly as `assistantInput` will parse it back
// out of the signature. Emitted as its own thinking part rather than onto the
// summary's part because a part's signature is fixed at its start event, and
// the encrypted content only arrives when the item completes.
const encryptedReasoning = (
  state: State,
  itemId: string,
  item: Readonly<Record<string, unknown>>
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } => {
  const encrypted = string(item.encrypted_content)
  if (encrypted === undefined) return { state, events: [] }
  const id = `${itemId}:encrypted`
  const signature = CanonicalJson.stringify({
    type: "reasoning",
    id: itemId,
    ...(Array.isArray(item.summary) ? { summary: item.summary } : {}),
    encrypted_content: encrypted
  })
  return {
    state,
    events: [
      ModelEvent.ModelEvent.ThinkingStart({ type: "thinking-start", id, signature }),
      ModelEvent.ModelEvent.ThinkingEnd({ type: "thinking-end", id })
    ]
  }
}

/**
 * A `response.completed` that arrives while a function call is still open
 * used to settle `tool-calls` on the strength of the call having started, and
 * the halt hook then emitted whatever arguments had arrived into a message
 * that was never aborted. The final Response object is authoritative for
 * every output item, so each open call closes from it through the same strict
 * validator a done event uses; a call the final output does not finish is a
 * provider fault, not a successful tool turn.
 */
const closeOpenCalls = (
  state: State,
  response: Readonly<Record<string, unknown>> | undefined
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  if (state.tools.open.length === 0) return { state, events: [] }
  const output = Array.isArray(response?.output) ? response.output.map(record) : []
  let current = state
  const events: Array<ModelEvent.ModelEvent> = []
  for (const open of state.tools.open) {
    const item = output.find((entry) =>
      entry?.type === "function_call" &&
      (string(entry.call_id) === open.callId || current.toolNames[string(entry.id) ?? ""] === open.callId)
    )
    if (item === undefined && open.fragments.length === 0) continue
    const result = completeTool(current, open.callId, string(item?.arguments))
    if (result instanceof ModelError) return result
    current = result.state
    events.push(...result.events)
  }
  const unfinished = current.tools.open.length
  if (unfinished > 0) {
    return new ModelError({
      code: "invalid_provider_output",
      message: `OpenAI Responses completed with ${unfinished} unfinished function call${unfinished === 1 ? "" : "s"}`
    })
  }
  return { state: current, events }
}

const stepEvent = (
  state: State,
  value: OpenAIEvent,
  continuation: Continuation,
  now: number
): { readonly state: State; readonly events: ReadonlyArray<ModelEvent.ModelEvent> } | ModelError => {
  if (state.settled) return { state, events: [] }
  const type = eventType(value)
  const item = record(value.item)
  const explicitItemId = string(value.item_id) ?? string(item?.id)
  const current = state
  const itemId = explicitItemId ?? "output-0"
  const delta = string(value.delta)
  if (type === "response.created") {
    const responseId = string(record(value.response)?.id)
    return {
      state: responseId === undefined ? current : { ...current, responseId },
      events: []
    }
  }
  if (type === "response.output_text.delta" && delta !== undefined) {
    const fresh = !current.textIds.has(itemId)
    return {
      state: { ...current, textIds: new Set([...current.textIds, itemId]) },
      events: [
        ...(fresh ? [ModelEvent.ModelEvent.TextStart({ type: "text-start", id: itemId })] : []),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: itemId, text: delta })
      ]
    }
  }
  if (type === "response.output_text.done") {
    return {
      state: current,
      events: current.textIds.has(itemId) ? [ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: itemId })] : []
    }
  }
  if (
    (type === "response.reasoning_summary.delta" || type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta") && delta !== undefined
  ) {
    const reasoning = continuation === "stored" ? rememberItem(current, itemId) : current
    const fresh = !reasoning.thinkingIds.has(itemId)
    return {
      state: { ...reasoning, thinkingIds: new Set([...reasoning.thinkingIds, itemId]) },
      events: [
        ...(fresh
          ? [
            ModelEvent.ModelEvent.ThinkingStart({
              type: "thinking-start",
              id: itemId,
              // Under stored continuation the item id doubles as the replay
              // signature; under encrypted continuation the signature is the
              // full reasoning item, which arrives with the item's done event.
              ...(continuation === "stored" ? { signature: itemId } : {})
            })
          ]
          : []),
        ModelEvent.ModelEvent.ThinkingDelta({ type: "thinking-delta", id: itemId, text: delta })
      ]
    }
  }
  if (
    type === "response.reasoning_summary.done" || type === "response.reasoning_summary_text.done" ||
    type === "response.reasoning_text.done"
  ) {
    const reasoning = continuation === "stored" ? rememberItem(current, itemId) : current
    return {
      state: reasoning,
      events: reasoning.thinkingIds.has(itemId)
        ? [ModelEvent.ModelEvent.ThinkingEnd({ type: "thinking-end", id: itemId })]
        : []
    }
  }
  if (type === "response.output_item.added") {
    if (item?.type === "reasoning") {
      return { state: continuation === "stored" ? rememberItem(current, itemId) : current, events: [] }
    }
    if (item?.type !== "function_call") return { state: current, events: [] }
    const callId = string(item.call_id) ?? string(item.id)
    const name = string(item.name)
    if (callId === undefined || name === undefined) {
      return new ModelError({
        code: "invalid_provider_output",
        message: "OpenAI Responses emitted a function call without an id or name"
      })
    }
    const initialArguments = string(item.arguments)
    const tools = initialArguments === undefined || initialArguments === ""
      ? ToolStream.start(current.tools, { callId, name })
      : ToolStream.delta(ToolStream.start(current.tools, { callId, name }), callId, initialArguments)
    return {
      state: {
        ...current,
        tools,
        toolNames: { ...current.toolNames, [itemId]: callId }
      },
      events: [
        ModelEvent.ModelEvent.ToolCallStart({ type: "tool-call-start", id: callId, name }),
        ...(initialArguments === undefined || initialArguments === ""
          ? []
          : [
            ModelEvent.ModelEvent.ToolCallDelta({
              type: "tool-call-delta",
              id: callId,
              arguments: initialArguments
            })
          ])
      ]
    }
  }
  if (type === "response.function_call_arguments.delta" && delta !== undefined) {
    const callId = current.toolNames[itemId]
    if (callId === undefined) {
      return new ModelError({
        code: "invalid_provider_output",
        message: "OpenAI Responses emitted arguments for an unknown function call"
      })
    }
    return {
      state: { ...current, tools: ToolStream.delta(current.tools, callId, delta) },
      events: [ModelEvent.ModelEvent.ToolCallDelta({ type: "tool-call-delta", id: callId, arguments: delta })]
    }
  }
  if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
    if (type === "response.output_item.done" && item?.type === "reasoning") {
      return continuation === "stored"
        ? { state: rememberItem(current, itemId), events: [] }
        : encryptedReasoning(current, itemId, item)
    }
    if (type === "response.output_item.done" && item?.type !== "function_call") {
      return { state: current, events: [] }
    }
    const callId = current.toolNames[itemId] ?? string(item?.call_id)
    if (callId === undefined) return { state: current, events: [] }
    return completeTool(current, callId, string(value.arguments) ?? string(item?.arguments))
  }
  if (type === "response.completed" || type === "response.incomplete") {
    // Both terminal events carry the full Response object, so a token-limited
    // or filtered turn bills its tokens and names its id exactly like a
    // completed one.
    const response = record(value.response)
    const events: Array<ModelEvent.ModelEvent> = []
    const eventUsage = usage(response?.usage)
    if (eventUsage !== undefined) events.push(ModelEvent.ModelEvent.Usage(eventUsage))
    const identified = {
      ...current,
      responseId: string(response?.id) ?? current.responseId
    }
    if (type === "response.incomplete") {
      // The event says WHY it is incomplete. `content_filter` is a refusal, not a
      // token budget, and `StopReason` already distinguishes the two.
      const reason = record(response?.["incomplete_details"])?.["reason"]
      // A call the cut interrupted closes with what arrived, before the settle.
      const flushed = ToolStream.flushAborted(identified.tools)
      const closed = flushed.completed.map((call) =>
        ModelEvent.ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments })
      )
      const terminal = settle(
        { ...identified, tools: flushed.state },
        reason === "content_filter" ? "content-filter" : "length"
      )
      return { state: terminal.state, events: [...events, ...closed, ...terminal.events] }
    }
    const closed = closeOpenCalls(identified, response)
    if (closed instanceof ModelError) return closed
    const terminal = settle(closed.state, Object.keys(closed.state.toolNames).length === 0 ? "stop" : "tool-calls")
    return { state: terminal.state, events: [...events, ...closed.events, ...terminal.events] }
  }
  if (type === "response.failed" || type === "error") {
    const error = providerError(value, now)
    return new ModelError({
      code: classifyHttpStatus(undefined, error.code, error.message),
      message: error.message,
      providerCode: error.code,
      resetAtEpochMillis: error.resetAtEpochMillis,
      resetSource: error.resetSource,
      retryAfterMillis: error.retryAfterMillis
    })
  }
  return { state: current, events: [] }
}

// Nothing follows the terminal Response event on the wire, so the route stops
// pulling there instead of waiting for a body a proxy may never close.
const terminalEvent = (event: OpenAIEvent): boolean =>
  event.type === "response.completed" || event.type === "response.incomplete"

const stepWith = (continuation: Continuation) =>
  Effect.fn("OpenAIResponses.step")((
    state: State,
    event: OpenAIEvent
  ): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent.ModelEvent>], ModelError> =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const result = stepEvent(state, event, continuation, now)
      if (result instanceof ModelError) return yield* Effect.fail(result)
      return [result.state, result.events] as const
    })
  )

const step = stepWith("stored")

const finalize = (state: State): ReadonlyArray<ModelEvent.ModelEvent> =>
  ToolStream.flushAborted(state.tools).completed.map((call) =>
    ModelEvent.ModelEvent.ToolCallEnd({
      type: "tool-call-end",
      id: call.callId,
      arguments: call.arguments
    })
  )

const classifyError = (status: number, body: string): ModelError => {
  const decoded = decodeErrorBody(body)
  const parsed = Option.isSome(decoded) ? decoded.value : undefined
  const error = record(parsed?.error)
  const code = string(error?.code) ?? string(error?.type) ?? string(parsed?.code)
  // The ChatGPT-plan backend answers 4xx with a flat `{"detail": "…"}`
  // envelope rather than api.openai.com's `{"error": {…}}`; both spell a
  // classifiable message.
  const message = string(error?.message) ?? string(parsed?.message) ?? string(parsed?.detail) ??
    `OpenAI Responses request failed with HTTP ${status}`
  return new ModelError({
    code: classifyHttpStatus(status, code, message),
    message,
    httpStatus: status,
    providerCode: code
  })
}

/**
 * The OpenAI Responses protocol.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const protocol: Protocol.Protocol<
  Body,
  string,
  OpenAIEvent,
  State
> = Protocol.make({
  id: "openai-responses",
  supportsDeferred: (modelId) => DeferredTools.supportsDeferred("openai-responses", modelId),
  body: {
    schema: Body,
    from: fromRequest
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIEvent),
    initial: () => ({
      tools: ToolStream.initial(),
      toolNames: {},
      textIds: new Set(),
      thinkingIds: new Set(),
      completedToolIds: new Set(),
      itemIds: [],
      responseId: undefined,
      settled: false
    }),
    step,
    onHalt: finalize,
    terminal: terminalEvent
  },
  classifyError
})

/**
 * The OpenAI Responses protocol as ChatGPT-plan backends serve it: the same
 * SSE event stream and usage counters, with the request narrowed to the
 * subscription surface ({@link ChatGPTBody}) and reasoning continuation
 * carried in `encrypted_content` instead of stored item references. Deferred
 * tools are native only for the ids probed live on this backend (the GPT-6
 * family, 2026-09-24); every other model receives the portable lowering.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const chatgptProtocol: Protocol.Protocol<
  ChatGPTBody,
  string,
  OpenAIEvent,
  State
> = Protocol.make({
  id: "openai-responses-chatgpt",
  supportsDeferred: (modelId) => DeferredTools.supportsDeferred("openai-responses-chatgpt", modelId),
  body: {
    schema: ChatGPTBody,
    from: chatgptFromRequest
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIEvent),
    initial: () => ({
      tools: ToolStream.initial(),
      toolNames: {},
      textIds: new Set(),
      thinkingIds: new Set(),
      completedToolIds: new Set(),
      itemIds: [],
      responseId: undefined,
      settled: false
    }),
    step: stepWith("encrypted"),
    onHalt: finalize,
    terminal: terminalEvent
  },
  classifyError,
  // The backend derives prompt-cache affinity from this header, not from
  // `prompt_cache_key` alone: live on gpt-6-sol (2026-09-24) the body field
  // without it cached one frame in three, as codex-rs `responses_session_id`
  // warns. Codex sends its conversation id in both.
  headers: (request): Readonly<Record<string, string>> =>
    request.cacheKey === undefined ? {} : { "session-id": request.cacheKey },
  // The backend answers the first request of a conversation with a routing
  // token, and Codex echoes it on every later request of the turn. In a
  // direct three-frame probe on gpt-6-sol (2026-09-24) frame 3 read 0 of
  // 11,646 input tokens from cache without the echo (twice) and 9,088 with it.
  affinityHeader: "x-codex-turn-state"
})
