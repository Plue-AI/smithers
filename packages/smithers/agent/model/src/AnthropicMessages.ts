/**
 * Anthropic Messages request lowering and streaming event parsing.
 *
 * @since 0.1.0
 */

import { Chunk, Effect, Option, Result, Schema } from "effect"
import * as DeferredTools from "./DeferredTools.ts"
import { classifyHttpStatus } from "./HttpStatusClassifier.ts"
import * as ModelCatalog from "./ModelCatalog.ts"
import { ModelError, type ModelErrorCode } from "./ModelError.ts"
import { ModelEvent, type Usage } from "./ModelEvent.ts"
import {
  JsonObject,
  type Message,
  type ModelRequest,
  type ReasoningEffort,
  type StopReason,
  type ToolDefinition
} from "./ModelRequest.ts"
import { jsonEvent, make as makeProtocol, type Protocol } from "./Protocol.ts"
import * as ToolStream from "./ToolStream.ts"

const ID = "anthropic-messages"

// =============================================================================
// Public Input
// =============================================================================

type Request = ModelRequest

// =============================================================================
// Request Body Schema
// =============================================================================

/**
 * A prompt-cache breakpoint. The default five-minute TTL fits a frame loop,
 * where every read refreshes the entry; see "Prompt caching" in `docs/api.md`.
 */
const CacheControl = Schema.Struct({ type: Schema.Literal("ephemeral") })

const cacheControl = { cache_control: { type: "ephemeral" as const } }

const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: Schema.optional(CacheControl)
})

const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.String
})

/**
 * Anthropic's opaque form of a reasoning block its safety systems redacted.
 *
 * Extended thinking requires the complete `thinking` or `redacted_thinking`
 * blocks of the last assistant turn to be replayed whenever that turn contains
 * `tool_use`. A redacted block carries no readable text, only `data`, so it is
 * carried through the neutral event vocabulary as a thinking part whose
 * `signature` is `redacted:<data>` and lowered back to this shape here.
 */
const RedactedThinkingBlock = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String
})

/** The `ThinkingPart.signature` prefix that marks a redacted Anthropic block. */
const REDACTED_THINKING_PREFIX = "redacted:"

const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: JsonObject,
  cache_control: Schema.optional(CacheControl)
})

const ToolReferenceBlock = Schema.Struct({
  type: Schema.Literal("tool_reference"),
  tool_name: Schema.String
})

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([ToolReferenceBlock, TextBlock]))]),
  cache_control: Schema.optional(CacheControl)
})

const UserBlock = Schema.Union([TextBlock, ToolResultBlock])
const AssistantBlock = Schema.Union([TextBlock, ThinkingBlock, RedactedThinkingBlock, ToolUseBlock])

const AnthropicMessage = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(UserBlock)
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(AssistantBlock)
  })
])

const AnthropicTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: JsonObject,
  defer_loading: Schema.optional(Schema.Boolean),
  cache_control: Schema.optional(CacheControl)
})

const ThinkingConfig = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("enabled"),
    budget_tokens: Schema.Finite
  }),
  Schema.Struct({ type: Schema.Literal("adaptive") })
])

const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])

const OutputConfig = Schema.Struct({ effort: Effort })

/**
 * Schema for the deterministic `POST /v1/messages` body.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Body = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.Finite,
  system: Schema.optional(Schema.Array(TextBlock)),
  messages: Schema.Array(AnthropicMessage),
  tools: Schema.optional(Schema.Array(AnthropicTool)),
  stream: Schema.Literal(true),
  temperature: Schema.optional(Schema.Finite),
  top_p: Schema.optional(Schema.Finite),
  top_k: Schema.optional(Schema.Finite),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  thinking: Schema.optional(ThinkingConfig),
  output_config: Schema.optional(OutputConfig)
})

/**
 * The deterministic `POST /v1/messages` body.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Body = typeof Body.Type

// =============================================================================
// Streaming Event Schema
// =============================================================================

const AnthropicUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number))
})

const ContentBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  // The whole payload of a `redacted_thinking` block.
  data: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown)
})

const Delta = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  partial_json: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String))
})

const AnthropicEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  message: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      usage: Schema.optional(AnthropicUsage)
    })
  ),
  content_block: Schema.optional(ContentBlock),
  delta: Schema.optional(Delta),
  usage: Schema.optional(AnthropicUsage),
  error: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String)
    })
  )
})

type AnthropicEvent = typeof AnthropicEvent.Type
type AnthropicUsage = typeof AnthropicUsage.Type

const ErrorBody = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      details: Schema.optional(Schema.Struct({ error_code: Schema.optional(Schema.String) }))
    })
  )
})

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObject)
)

// =============================================================================
// Parser State
// =============================================================================

type Block =
  | { readonly type: "text"; readonly index: number; readonly id: string }
  | {
    readonly type: "thinking"
    readonly index: number
    readonly id: string
    readonly signature: string | undefined
    readonly started: boolean
    readonly fragments: Chunk.Chunk<string>
  }
  | { readonly type: "tool_use"; readonly index: number; readonly id: string; readonly name: string }

interface State {
  readonly blocks: ReadonlyArray<Block>
  readonly tools: ToolStream.State
  readonly usage: Usage | undefined
  readonly usageEmitted: boolean
  readonly stopReason: StopReason | undefined
  readonly settled: boolean
  readonly responseId: string | undefined
}

const initial = (): State => ({
  blocks: [],
  tools: ToolStream.initial(),
  usage: undefined,
  usageEmitted: false,
  stopReason: undefined,
  settled: false,
  responseId: undefined
})

// =============================================================================
// Request Body Construction
// =============================================================================

type WireMessage = Body["messages"][number]
type UserWireBlock = Extract<WireMessage, { readonly role: "user" }>["content"][number]
type AssistantWireBlock = Extract<WireMessage, { readonly role: "assistant" }>["content"][number]

const lowerTool = (tool: ToolDefinition, deferred: boolean): NonNullable<Body["tools"]>[number] => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
  ...(deferred ? { defer_loading: true } : {})
})

const lowerToolArguments = (arguments_: string): Result.Result<typeof JsonObject.Type, ModelError> => {
  const decoded = decodeArguments(arguments_)
  if (Option.isSome(decoded)) return Result.succeed(decoded.value)
  return Result.fail(
    new ModelError({
      code: "invalid_request",
      message: "Anthropic Messages tool-call arguments must be a JSON object"
    })
  )
}

const lowerAssistant = (
  message: Extract<Message, { readonly role: "assistant" }>
): Result.Result<WireMessage | undefined, ModelError> =>
  Result.gen(function*() {
    // Replaying a provider-interrupted assistant turn can make the next
    // Messages request permanently invalid, so omit it as a unit.
    if (message.stopReason === "aborted" || message.stopReason === "error") return undefined

    const content: Array<AssistantWireBlock> = []
    for (const part of message.content) {
      if (part.type === "text") {
        // Anthropic rejects an empty text block, and Claude sometimes opens
        // one before a tool_use block, so it never reaches the wire.
        if (part.text !== "") content.push({ type: "text", text: part.text })
        continue
      }
      if (part.type === "thinking") {
        // Only a complete signed block may be replayed as Anthropic thinking.
        if (part.signature === undefined) continue
        if (part.signature.startsWith(REDACTED_THINKING_PREFIX)) {
          // A turn whose reasoning was redacted still has to be replayed with
          // its tool calls, or the next request fails with "Expected thinking
          // or redacted_thinking, but found tool_use" and keeps failing.
          content.push({
            type: "redacted_thinking",
            data: part.signature.slice(REDACTED_THINKING_PREFIX.length)
          })
          continue
        }
        content.push({
          type: "thinking",
          thinking: part.text,
          signature: part.signature
        })
        continue
      }
      // A truncated turn's calls never ran and have no tool_result to pair
      // with; see ToolStream.truncated.
      if (part.type === "tool-call" && !ToolStream.truncated(message.stopReason)) {
        content.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: yield* lowerToolArguments(part.arguments)
        })
      }
    }
    // Every message but a final assistant one must carry content; a turn that
    // held only unsigned thinking or empty text lowers to nothing.
    return content.length === 0 ? undefined : { role: "assistant", content }
  })

const lowerUser = (message: Extract<Message, { readonly role: "user" }>): WireMessage | undefined => {
  const content: Array<UserWireBlock> = []
  for (const part of message.content) {
    if (part.type === "text" && part.text !== "") content.push({ type: "text", text: part.text })
  }
  return content.length === 0 ? undefined : { role: "user", content }
}

const lowerToolResults = (
  message: Extract<Message, { readonly role: "tool" }>,
  deferredNames: ReadonlyMap<string, string>,
  loadedNames: Set<string>
): WireMessage => {
  // Activation metadata and untrusted tool output share the tool_result
  // boundary; output must never become sibling user text.
  const results: Array<UserWireBlock> = []
  for (const part of message.content) {
    const references: Array<typeof ToolReferenceBlock.Type> = []
    for (const name of part.addedToolNames) {
      const normalized = name.trim().toLowerCase()
      const deferred = deferredNames.get(normalized)
      if (deferred === undefined || loadedNames.has(normalized)) continue
      loadedNames.add(normalized)
      references.push({ type: "tool_reference", tool_name: deferred })
    }
    results.push({
      type: "tool_result",
      tool_use_id: part.toolCallId,
      content: references.length === 0 ? part.content : [...references, { type: "text", text: part.content }]
    })
  }
  return { role: "user", content: results }
}

const lowerMessages = (
  request: Request,
  deferredNames: ReadonlyArray<string>
): Result.Result<{ readonly messages: ReadonlyArray<WireMessage>; readonly stable: number }, ModelError> =>
  Result.gen(function*() {
    const deferred = new Map(deferredNames.map((name) => [name.trim().toLowerCase(), name] as const))
    const loaded = new Set<string>()
    const messages: Array<WireMessage> = []
    const boundary = request.cacheBoundary ?? request.messages.length
    // Lowering drops messages, so the boundary is re-counted on the wire.
    let stable = 0
    for (const [index, message] of request.messages.entries()) {
      if (index === boundary) stable = messages.length
      if (message.role === "user") {
        const lowered = lowerUser(message)
        if (lowered !== undefined) messages.push(lowered)
        continue
      }
      if (message.role === "assistant") {
        const lowered = yield* lowerAssistant(message)
        if (lowered !== undefined) messages.push(lowered)
        continue
      }
      messages.push(lowerToolResults(message, deferred, loaded))
    }
    if (boundary >= request.messages.length) stable = messages.length
    return { messages, stable }
  })

const withLastBlockMarked = <B extends { readonly type: string }>(
  content: ReadonlyArray<B>,
  rebuild: (content: ReadonlyArray<B>) => WireMessage
): WireMessage | undefined => {
  for (let at = content.length - 1; at >= 0; at--) {
    const type = content[at]!.type
    if (type === "thinking" || type === "redacted_thinking") continue
    return rebuild(content.map((block, index) => index === at ? { ...block, ...cacheControl } : block))
  }
  return undefined
}

/**
 * Marks the last block of the first `stable` wire messages that can carry a
 * breakpoint. Thinking blocks cannot, so the walk passes over them.
 */
const withMessageBreakpoint = (
  messages: ReadonlyArray<WireMessage>,
  stable: number
): ReadonlyArray<WireMessage> => {
  for (let index = stable - 1; index >= 0; index--) {
    const message = messages[index]!
    const marked: WireMessage | undefined = message.role === "user"
      ? withLastBlockMarked(message.content, (content) => ({ role: "user", content }))
      : withLastBlockMarked(message.content, (content) => ({ role: "assistant", content }))
    if (marked !== undefined) {
      return messages.map((original, originalIndex) => originalIndex === index ? marked : original)
    }
  }
  return messages
}

/**
 * Marks the end of the static prefix. Tools render before system, so a
 * breakpoint on the last system block covers both; without a system prompt it
 * goes on the last immediately loaded tool, since deferred ones sit after it.
 */
const withPrefixBreakpoint = (
  system: ReadonlyArray<typeof TextBlock.Type>,
  tools: ReadonlyArray<NonNullable<Body["tools"]>[number]>,
  immediate: number
): { readonly system: ReadonlyArray<typeof TextBlock.Type>; readonly tools: typeof tools } => {
  const marking = <A>(items: ReadonlyArray<A>, at: number): ReadonlyArray<A> =>
    items.map((item, index) => index === at ? { ...item, ...cacheControl } : item)
  if (system.length > 0) return { system: marking(system, system.length - 1), tools }
  return { system, tools: marking(tools, immediate - 1) }
}

type Effort = typeof Effort.Type

const effortOrder: ReadonlyArray<Effort> = ["low", "medium", "high", "xhigh", "max"]

/**
 * The effort levels a Claude model accepts in `output_config.effort`, and
 * whether it takes `thinking: { type: "adaptive" }`. A model absent from this
 * table has no effort control, so `reasoningEffort` is dropped for it.
 * https://platform.claude.com/docs/en/build-with-claude/effort
 */
const effortSupport: ReadonlyArray<
  readonly [RegExp, { readonly levels: ReadonlyArray<Effort>; readonly adaptive: boolean }]
> = [
  [
    /^claude-(?:(?:opus|sonnet)-5(?:-[0-9]{1,2})?|(?:fable|mythos)-5(?:-[0-9]+)*|opus-4-[78])$/i,
    { levels: effortOrder, adaptive: true }
  ],
  [/^claude-(?:opus|sonnet)-4-6$/i, { levels: ["low", "medium", "high", "max"], adaptive: true }],
  [/^claude-opus-4-5$/i, { levels: ["low", "medium", "high"], adaptive: false }]
]

/**
 * Lower the neutral effort onto a model's supported levels. `none` and
 * `minimal` have no Anthropic equivalent and map to `low` without asking for
 * thinking; a level the model lacks clamps to the nearest one below it.
 */
const lowerEffort = (
  modelId: string,
  requested: ReasoningEffort | undefined
): Pick<Body, "thinking" | "output_config"> => {
  if (requested === undefined) return {}
  const support = effortSupport.find(([pattern]) => pattern.test(modelId))?.[1]
  if (support === undefined) return {}
  const thinks = requested !== "none" && requested !== "minimal"
  const wanted = thinks ? effortOrder.indexOf(requested) : 0
  // Every supported model accepts `low`, so the walk starts there.
  const effort = effortOrder.slice(1, wanted + 1).reduce<Effort>(
    (best, level) => support.levels.includes(level) ? level : best,
    "low"
  )
  return {
    ...(thinks && support.adaptive ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: { effort }
  }
}

/** The budget Anthropic requires: stated, else the model ceiling, else 4096. */
const DEFAULT_MAX_TOKENS = 4096

const lowerBudget = (
  request: Request
): Result.Result<Pick<Body, "max_tokens" | "thinking">, ModelError> => {
  const params = request.params
  const budget = params.thinkingBudget
  const defaulted = ModelCatalog.maxOutputTokensFor(request.modelId) ?? DEFAULT_MAX_TOKENS
  if (budget === undefined) return Result.succeed({ max_tokens: params.maxTokens ?? defaulted })
  const thinking = { type: "enabled" as const, budget_tokens: budget }
  if (params.maxTokens === undefined) {
    // budget_tokens must sit below max_tokens; leave room for the answer.
    return Result.succeed({
      max_tokens: budget < defaulted ? defaulted : budget + DEFAULT_MAX_TOKENS,
      thinking
    })
  }
  if (budget >= params.maxTokens) {
    return Result.fail(
      new ModelError({
        code: "invalid_request",
        message: "Anthropic Messages requires params.thinkingBudget to be below params.maxTokens",
        path: "params.thinkingBudget"
      })
    )
  }
  return Result.succeed({ max_tokens: params.maxTokens, thinking })
}

const buildBody = (
  request: Request,
  options: { readonly native: boolean }
): Result.Result<Body, ModelError> =>
  Result.gen(function*() {
    const native = options.native && DeferredTools.supportsDeferred(ID, request.modelId)
    // `toolChoice: "none"` forbids tool use, and Anthropic expresses that by
    // omitting `tools` rather than by a wire field, so the request is lowered
    // as if it declared none: no tool declarations and no deferred-tool search
    // plumbing in the transcript.
    const resolution = request.toolChoice === "none"
      ? { immediate: [], deferred: [], activatedNames: [] }
      : DeferredTools.resolve(request, native)
    // Two of Anthropic's four breakpoints: the static prefix, and the last
    // message the next request repeats. See "Prompt caching" in docs/api.md.
    const { system, tools } = withPrefixBreakpoint(
      request.system.map((part) => ({ type: "text" as const, text: part.text })),
      [
        ...resolution.immediate.map((tool) => lowerTool(tool, false)),
        ...resolution.deferred.map((tool) => lowerTool(tool, true))
      ],
      resolution.immediate.length
    )
    const params = request.params
    const lowered = yield* lowerMessages(request, resolution.deferred.map((tool) => tool.name))
    const messages = withMessageBreakpoint(lowered.messages, lowered.stable)
    if (messages[0]?.role === "assistant") {
      return yield* Result.fail(
        new ModelError({
          code: "invalid_request",
          message: "Anthropic Messages requests must begin with a user message",
          path: "messages[0].role"
        })
      )
    }

    const budget = yield* lowerBudget(request)
    const effort = lowerEffort(request.modelId, params.reasoningEffort)
    // An explicit thinking budget wins over the adaptive thinking effort asks for.
    const thinking = budget.thinking ?? effort.thinking

    // Field order is explicit even though Route performs canonical encoding.
    // A model call is a sealed step, so this keeps construction itself
    // reviewable as one byte-deterministic declaration.
    return {
      model: request.modelId,
      max_tokens: budget.max_tokens,
      ...(system.length === 0 ? {} : { system }),
      messages,
      ...(tools.length === 0 ? {} : { tools }),
      stream: true,
      ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
      ...(params.topP === undefined ? {} : { top_p: params.topP }),
      ...(params.topK === undefined ? {} : { top_k: params.topK }),
      ...(params.stopSequences === undefined || params.stopSequences.length === 0
        ? {}
        : { stop_sequences: params.stopSequences }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(effort.output_config === undefined ? {} : { output_config: effort.output_config })
    }
  })

const fromRequest = Effect.fn("AnthropicMessages.fromRequest")((
  request: Request,
  options: { readonly native: boolean }
): Effect.Effect<Body, ModelError> => Effect.fromResult(buildBody(request, options)))

// =============================================================================
// Stream Parsing
// =============================================================================

type StepResult = { readonly state: State; readonly events: ReadonlyArray<ModelEvent> }

const withoutBlock = (state: State, index: number): ReadonlyArray<Block> =>
  state.blocks.filter((block) => block.index !== index)

const blockAt = (state: State, index: number): Block | undefined => state.blocks.find((block) => block.index === index)

const startBlock = (state: State, block: Block): State => ({
  ...state,
  blocks: [...withoutBlock(state, block.index), block]
})

const mapStopReason = (reason: string | null | undefined): StopReason => {
  if (reason === "end_turn" || reason === "stop_sequence" || reason === "pause_turn") return "stop"
  if (reason === "max_tokens") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "refusal") return "content-filter"
  return "unknown"
}

const totalTokens = (inputTokens: number | undefined, outputTokens: number | undefined): number | undefined =>
  inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0)

const mapUsage = (usage: AnthropicUsage | undefined): Usage | undefined => {
  if (usage === undefined) return undefined
  const cachedInputTokens = usage.cache_read_input_tokens ?? undefined
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? undefined
  const hasInput = usage.input_tokens !== undefined || cachedInputTokens !== undefined || cacheWriteTokens !== undefined
  const inputTokens = hasInput
    ? (usage.input_tokens ?? 0) + (cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0)
    : undefined
  const outputTokens = usage.output_tokens
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(totalTokens(inputTokens, outputTokens) === undefined
      ? {}
      : { totalTokens: totalTokens(inputTokens, outputTokens) })
  }
}

const mergeUsage = (left: Usage | undefined, right: Usage | undefined): Usage | undefined => {
  if (left === undefined) return right
  if (right === undefined) return left
  const inputTokens = right.inputTokens ?? left.inputTokens
  const outputTokens = right.outputTokens ?? left.outputTokens
  // Anthropic reports no reasoning-token count on this wire, so there is
  // nothing to merge; `mapUsage` is the only producer of both operands.
  const cachedInputTokens = right.cachedInputTokens ?? left.cachedInputTokens
  const cacheWriteTokens = right.cacheWriteTokens ?? left.cacheWriteTokens
  const total = totalTokens(inputTokens, outputTokens)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(total === undefined ? {} : { totalTokens: total })
  }
}

const onMessageStart = (state: State, event: AnthropicEvent): StepResult => ({
  state: {
    ...state,
    usage: mergeUsage(state.usage, mapUsage(event.message?.usage)),
    responseId: event.message?.id ?? state.responseId
  },
  events: []
})

const onContentBlockStart = (state: State, event: AnthropicEvent): StepResult | ModelError => {
  const index = event.index
  const content = event.content_block
  if (index === undefined || content === undefined) return { state, events: [] }

  if (content.type === "text") {
    const id = `text-${index}`
    return {
      state: startBlock(state, { type: "text", index, id }),
      events: [
        ModelEvent.TextStart({ type: "text-start", id }),
        ...(content.text === undefined || content.text === ""
          ? []
          : [ModelEvent.TextDelta({ type: "text-delta", id, text: content.text })])
      ]
    }
  }

  if (content.type === "thinking") {
    const id = `thinking-${index}`
    const started = content.signature !== undefined
    return {
      state: startBlock(state, {
        type: "thinking",
        index,
        id,
        signature: content.signature,
        started,
        fragments: started || content.thinking === undefined || content.thinking === ""
          ? Chunk.empty()
          : Chunk.of(content.thinking)
      }),
      events: started
        ? [
          ModelEvent.ThinkingStart({
            type: "thinking-start",
            id,
            signature: content.signature
          }),
          ...(content.thinking === undefined || content.thinking === ""
            ? []
            : [ModelEvent.ThinkingDelta({ type: "thinking-delta", id, text: content.thinking })])
        ]
        : []
    }
  }

  if (content.type === "redacted_thinking") {
    const id = `thinking-${index}`
    const signature = `${REDACTED_THINKING_PREFIX}${content.data ?? ""}`
    return {
      state: startBlock(state, { type: "thinking", index, id, signature, started: true, fragments: Chunk.empty() }),
      events: [ModelEvent.ThinkingStart({ type: "thinking-start", id, signature })]
    }
  }

  if (content.type === "tool_use") {
    const id = content.id
    const name = content.name
    if (id === undefined || name === undefined) {
      // Fabricating `String(index)` and `""` here handed the harness a call
      // named "" that it reports as an unknown tool. The two OpenAI protocols
      // fail typed on the same condition, and so does this one now.
      return new ModelError({
        code: "invalid_provider_output",
        message: "Anthropic Messages emitted a tool_use block without an id or name"
      })
    }
    return {
      state: {
        ...startBlock(state, { type: "tool_use", index, id, name }),
        tools: ToolStream.start(state.tools, { callId: id, name })
      },
      events: [ModelEvent.ToolCallStart({ type: "tool-call-start", id, name })]
    }
  }

  return { state, events: [] }
}

const onContentBlockDelta = (state: State, event: AnthropicEvent): StepResult => {
  const index = event.index
  const delta = event.delta
  if (index === undefined || delta === undefined) return { state, events: [] }
  const block = blockAt(state, index)

  if (delta.type === "text_delta" && delta.text !== undefined && block?.type === "text") {
    return {
      state,
      events: [ModelEvent.TextDelta({ type: "text-delta", id: block.id, text: delta.text })]
    }
  }

  if (delta.type === "thinking_delta" && delta.thinking !== undefined && block?.type === "thinking") {
    if (!block.started) {
      return {
        state: startBlock(state, { ...block, fragments: Chunk.append(block.fragments, delta.thinking) }),
        events: []
      }
    }
    return {
      state,
      events: [ModelEvent.ThinkingDelta({ type: "thinking-delta", id: block.id, text: delta.thinking })]
    }
  }

  if (delta.type === "signature_delta" && delta.signature !== undefined && block?.type === "thinking") {
    if (block.started) {
      return {
        state: startBlock(state, { ...block, signature: delta.signature }),
        events: []
      }
    }
    return {
      state: startBlock(state, {
        ...block,
        signature: delta.signature,
        started: true,
        fragments: Chunk.empty()
      }),
      events: [
        ModelEvent.ThinkingStart({
          type: "thinking-start",
          id: block.id,
          signature: delta.signature
        }),
        ...Chunk.toReadonlyArray(block.fragments).map((text) =>
          ModelEvent.ThinkingDelta({
            type: "thinking-delta",
            id: block.id,
            text
          })
        )
      ]
    }
  }

  if (delta.type === "input_json_delta" && delta.partial_json !== undefined && block?.type === "tool_use") {
    return {
      state: { ...state, tools: ToolStream.delta(state.tools, block.id, delta.partial_json) },
      events: [
        ModelEvent.ToolCallDelta({
          type: "tool-call-delta",
          id: block.id,
          arguments: delta.partial_json
        })
      ]
    }
  }

  return { state, events: [] }
}

const onContentBlockStop = (
  state: State,
  event: AnthropicEvent
): Result.Result<StepResult, ModelError> => {
  const index = event.index
  if (index === undefined) return Result.succeed({ state, events: [] })
  const block = blockAt(state, index)
  if (block === undefined) return Result.succeed({ state, events: [] })
  const blocks = withoutBlock(state, index)

  if (block.type === "text") {
    return Result.succeed({
      state: { ...state, blocks },
      events: [ModelEvent.TextEnd({ type: "text-end", id: block.id })]
    })
  }

  if (block.type === "thinking") {
    return Result.succeed({
      state: { ...state, blocks },
      events: [
        ...(block.started
          ? []
          : [
            ModelEvent.ThinkingStart({
              type: "thinking-start",
              id: block.id,
              signature: block.signature
            }),
            ...Chunk.toReadonlyArray(block.fragments).map((text) =>
              ModelEvent.ThinkingDelta({
                type: "thinking-delta",
                id: block.id,
                text
              })
            )
          ]),
        ModelEvent.ThinkingEnd({ type: "thinking-end", id: block.id })
      ]
    })
  }

  const ended = ToolStream.end(state.tools, block.id)
  // Arguments that are not a JSON object may be a call the output budget cut
  // off, which only the stop reason still to come can say. The call stays
  // open and `onMessageStop` decides.
  if (ended instanceof ModelError) return Result.succeed({ state: { ...state, blocks }, events: [] })
  return Result.succeed({
    state: { ...state, blocks, tools: ended.state },
    events: [
      ModelEvent.ToolCallEnd({
        type: "tool-call-end",
        id: block.id,
        arguments: ended.completed.arguments
      })
    ]
  })
}

const onMessageDelta = (state: State, event: AnthropicEvent): StepResult => {
  const usage = mergeUsage(state.usage, mapUsage(event.usage))
  const hasUsage = event.usage !== undefined && usage !== undefined
  return {
    state: {
      ...state,
      usage,
      usageEmitted: state.usageEmitted || hasUsage,
      stopReason: event.delta?.stop_reason === undefined
        ? state.stopReason
        : mapStopReason(event.delta.stop_reason)
    },
    events: hasUsage ? [ModelEvent.Usage(usage)] : []
  }
}

/**
 * Closes the calls still open at `message_stop`. A truncated turn closes them
 * with what arrived (see `ToolStream.truncated`); any other turn must have
 * sent a complete JSON object for each, or the stream fails.
 */
const closeOpenCalls = (state: State): Result.Result<StepResult, ModelError> => {
  if (ToolStream.truncated(state.stopReason)) {
    const flushed = ToolStream.flushAborted(state.tools)
    return Result.succeed({
      state: { ...state, tools: flushed.state },
      events: flushed.completed.map((call) =>
        ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: call.arguments })
      )
    })
  }
  let tools = state.tools
  const events: Array<ModelEvent> = []
  for (const call of state.tools.open) {
    const ended = ToolStream.end(tools, call.callId)
    if (ended instanceof ModelError) return Result.fail(ended)
    tools = ended.state
    events.push(
      ModelEvent.ToolCallEnd({ type: "tool-call-end", id: call.callId, arguments: ended.completed.arguments })
    )
  }
  return Result.succeed({ state: { ...state, tools }, events })
}

const onMessageStop = (state: State): Result.Result<StepResult, ModelError> =>
  Result.gen(function*() {
    if (state.settled) return { state, events: [] }
    const closed = yield* closeOpenCalls(state)
    return {
      state: { ...closed.state, settled: true },
      events: [
        ...closed.events,
        ...(state.usage === undefined || state.usageEmitted
          ? []
          : [ModelEvent.Usage(state.usage)]),
        ModelEvent.Settle({
          type: "settle",
          stopReason: state.stopReason ?? "unknown",
          responseId: state.responseId
        })
      ]
    }
  })

const providerReason = (
  status: number | undefined,
  providerType: string | undefined,
  message: string
): ModelErrorCode => {
  const reason = classifyHttpStatus(status, providerType, message)
  if (reason === "quota_exceeded" || reason === "authentication") return reason
  const normalized = `${providerType ?? ""} ${message}`.toLowerCase()
  // Anthropic overloads are transient rate limits, including HTTP 529.
  if (status === 529 || normalized.includes("overloaded")) return "rate_limited"
  if (reason === "unknown" && normalized.includes("api_error")) return "provider_internal"
  return reason
}

const streamError = (event: AnthropicEvent): ModelError => {
  const providerType = event.error?.type
  const providerMessage = event.error?.message ?? "Anthropic Messages stream error"
  return new ModelError({
    code: providerReason(undefined, providerType, providerMessage),
    message: providerType === undefined ? providerMessage : `${providerType}: ${providerMessage}`,
    providerCode: providerType
  })
}

const stepEvent = (state: State, event: AnthropicEvent): Result.Result<StepResult, ModelError> => {
  if (event.type === "message_start") return Result.succeed(onMessageStart(state, event))
  if (event.type === "content_block_start") {
    const started = onContentBlockStart(state, event)
    return started instanceof ModelError ? Result.fail(started) : Result.succeed(started)
  }
  if (event.type === "content_block_delta") return Result.succeed(onContentBlockDelta(state, event))
  if (event.type === "content_block_stop") return onContentBlockStop(state, event)
  if (event.type === "message_delta") return Result.succeed(onMessageDelta(state, event))
  if (event.type === "message_stop") return onMessageStop(state)
  if (event.type === "error") return Result.fail(streamError(event))
  return Result.succeed({ state, events: [] })
}

const step = Effect.fn("AnthropicMessages.step")((
  state: State,
  event: AnthropicEvent
): Effect.Effect<readonly [State, ReadonlyArray<ModelEvent>], ModelError> =>
  Effect.map(Effect.fromResult(stepEvent(state, event)), (result) => [result.state, result.events] as const)
)

const finalize = (state: State): ReadonlyArray<ModelEvent> => {
  const flushed = ToolStream.flushAborted(state.tools)
  const tools = new Map(flushed.completed.map((call) => [call.callId, call] as const))
  const events: Array<ModelEvent> = []
  for (const block of state.blocks) {
    if (block.type === "text") {
      events.push(ModelEvent.TextEnd({ type: "text-end", id: block.id }))
      continue
    }
    if (block.type === "thinking") {
      if (!block.started) {
        events.push(
          ModelEvent.ThinkingStart({
            type: "thinking-start",
            id: block.id,
            signature: block.signature
          }),
          ...Chunk.toReadonlyArray(block.fragments).map((text) =>
            ModelEvent.ThinkingDelta({
              type: "thinking-delta",
              id: block.id,
              text
            })
          )
        )
      }
      events.push(ModelEvent.ThinkingEnd({ type: "thinking-end", id: block.id }))
      continue
    }
    const tool = tools.get(block.id)
    if (tool !== undefined) {
      events.push(
        ModelEvent.ToolCallEnd({
          type: "tool-call-end",
          id: block.id,
          arguments: tool.arguments
        })
      )
    }
  }
  return events
}

/**
 * Anthropic's organization spend cap: HTTP 429 `rate_limit_error` whose
 * `details.error_code` is `enforced_spend_limit_reached`, with no
 * `retry-after`; access resumes at the time the message names, otherwise at
 * 00:00 UTC on the first of next month
 * (https://platform.claude.com/docs/en/api/rate-limits).
 */
const SPEND_CAP = "enforced_spend_limit_reached"

const spendCapResetAt = (message: string, now: number): number => {
  const named = /regain access on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}) UTC/i.exec(message)
  if (named !== null) {
    const at = Date.UTC(Number(named[1]), Number(named[2]) - 1, Number(named[3]), Number(named[4]), Number(named[5]))
    if (Number.isFinite(at) && at > now) return at
  }
  const today = new Date(now)
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)
}

const classifyError = (status: number, body: string): ModelError => {
  const decoded = decodeErrorBody(body)
  const error = Option.isSome(decoded) ? decoded.value.error : undefined
  const message = error?.message ?? `Anthropic Messages request failed with HTTP ${status}`
  if (error?.details?.error_code === SPEND_CAP) {
    // An exhausted quota with a known reset parks the run; a rate limit
    // would retry against a cap that no retry can clear.
    return new ModelError({
      code: "quota_exceeded",
      message,
      providerCode: SPEND_CAP,
      httpStatus: status,
      resetAtEpochMillis: spendCapResetAt(message, Date.now())
    })
  }
  return new ModelError({
    code: providerReason(status, error?.type, message),
    message,
    providerCode: error?.type,
    httpStatus: status
  })
}

// =============================================================================
// Protocol Value
// =============================================================================

/**
 * Anthropic's Messages API body lowering and SSE state machine.
 *
 * @category protocols
 * @since 0.1.0
 * @slop
 */
export const protocol: Protocol<Body, string, AnthropicEvent, State> = makeProtocol({
  id: ID,
  supportsDeferred: (modelId) => DeferredTools.supportsDeferred(ID, modelId),
  body: {
    schema: Body,
    from: fromRequest
  },
  stream: {
    event: jsonEvent(AnthropicEvent),
    initial,
    step,
    onHalt: finalize,
    // `message_stop` is the last frame on the wire, so the route stops pulling
    // there instead of waiting for a body a proxy may never close.
    terminal: (event) => event.type === "message_stop"
  },
  classifyError
})
