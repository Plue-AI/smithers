/**
 * The serializable, credential-free declaration of one model call.
 *
 * Field declaration order is load-bearing: it is the stable serialization order
 * a sealed model step keys on.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * A plain JSON object. Unlike `Schema.Record`, decoding starts from
 * `Schema.Json`, so class instances such as `Date` and `Map` cannot be
 * accepted as empty records.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const JsonObject = Schema.Json.pipe(
  Schema.refine(
    (value): value is Schema.JsonObject => typeof value === "object" && value !== null && !Array.isArray(value),
    { expected: "a JSON object" }
  )
)

/**
 * The decoded form of {@link JsonObject}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type JsonObject = typeof JsonObject.Type

/**
 * Why a model stream stopped. `aborted` is this layer's own value for an
 * interrupted stream, which no provider reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const StopReason = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "aborted",
  "unknown"
])

/**
 * The decoded form of {@link StopReason}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type StopReason = typeof StopReason.Type

/**
 * One text segment of the system prompt. The prompt is a list rather than a
 * string so a cache breakpoint can fall between segments.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const SystemPart = Object.assign(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }).annotate({
    identifier: "flows/model/SystemPart"
  }),
  { make: (input: { readonly text: string }): SystemPart => ({ type: "text", text: input.text }) }
)

/**
 * The decoded form of {@link SystemPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SystemPart = typeof SystemPart.Type

/**
 * Plain text inside a message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TextPart = Object.assign(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }).annotate({ identifier: "flows/model/TextPart" }),
  { make: (input: { readonly text: string }): TextPart => ({ type: "text", text: input.text }) }
)

/**
 * The decoded form of {@link TextPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextPart = typeof TextPart.Type

/**
 * A reasoning block. `signature` is the provider's attestation and must be
 * echoed back unchanged for the block to be accepted on a later request.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ThinkingPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("thinking"),
    text: Schema.String,
    signature: Schema.optional(Schema.String)
  }).annotate({ identifier: "flows/model/ThinkingPart" }),
  {
    make: (input: { readonly text: string; readonly signature?: string | undefined }): ThinkingPart => ({
      type: "thinking",
      text: input.text,
      signature: input.signature
    })
  }
)

/**
 * The decoded form of {@link ThinkingPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingPart = typeof ThinkingPart.Type

/**
 * A tool the model asked to run. `arguments` stays JSON text rather than a
 * decoded object so it survives a round trip byte for byte.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolCallPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.String
  }).annotate({ identifier: "flows/model/ToolCallPart" }),
  {
    make: (input: { readonly id: string; readonly name: string; readonly arguments: string }): ToolCallPart => ({
      type: "tool-call",
      ...input
    })
  }
)

/**
 * The decoded form of {@link ToolCallPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallPart = typeof ToolCallPart.Type

/**
 * What a tool returned, addressed back to its call by `toolCallId`.
 * `addedToolNames` names the tools the result made available.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolResultPart = Object.assign(
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    toolCallId: Schema.String,
    content: Schema.String,
    addedToolNames: Schema.Array(Schema.String)
  }).annotate({ identifier: "flows/model/ToolResultPart" }),
  {
    make: (input: {
      readonly toolCallId: string
      readonly content: string
      readonly addedToolNames?: ReadonlyArray<string> | undefined
    }): ToolResultPart => ({
      type: "tool-result",
      toolCallId: input.toolCallId,
      content: input.content,
      addedToolNames: input.addedToolNames ?? []
    })
  }
)

/**
 * The decoded form of {@link ToolResultPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolResultPart = typeof ToolResultPart.Type

/**
 * Any part a message can carry, tagged by `type`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ContentPart = Schema.Union([TextPart, ThinkingPart, ToolCallPart, ToolResultPart]).pipe(
  Schema.toTaggedUnion("type")
)

/**
 * The decoded form of {@link ContentPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ContentPart = typeof ContentPart.Type

/**
 * The parts an assistant message can carry: everything in
 * {@link ContentPart} except a tool result, which belongs to a tool message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const AssistantContentPart = Schema.Union([TextPart, ThinkingPart, ToolCallPart]).pipe(
  Schema.toTaggedUnion("type")
)

/**
 * The decoded form of {@link AssistantContentPart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type AssistantContentPart = typeof AssistantContentPart.Type

/**
 * A turn from the user. Text only: attachments and tool output enter the
 * transcript through their own message roles.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class UserMessage extends Schema.Class<UserMessage>("flows/model/UserMessage")({
  role: Schema.Literal("user"),
  content: Schema.Array(TextPart)
}) {}

/**
 * One settled model turn, including why it stopped and the provider item
 * ids a continuation has to replay.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class AssistantMessage extends Schema.Class<AssistantMessage>("flows/model/AssistantMessage")({
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContentPart),
  stopReason: StopReason,
  responseId: Schema.optional(Schema.String),
  /**
   * Stored OpenAI reasoning item ids that must be replayed as item references
   * rather than as the reasoning text they stand for.
   */
  itemIds: Schema.optional(Schema.Array(Schema.String))
}) {}

/**
 * The results of the tool calls the previous assistant message asked for.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ToolMessage extends Schema.Class<ToolMessage>("flows/model/ToolMessage")({
  role: Schema.Literal("tool"),
  content: Schema.Array(ToolResultPart)
}) {}

/**
 * Any transcript message, tagged by `role`, with the per-role constructors
 * attached.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Message = Object.assign(
  Schema.Union([UserMessage, AssistantMessage, ToolMessage]).pipe(Schema.toTaggedUnion("role")),
  {
    make: (message: Message): Message => message,
    user: (content: string | TextPart | ReadonlyArray<TextPart>): UserMessage =>
      new UserMessage({ role: "user", content: userContentParts(content) }),
    assistant: (
      content: string | AssistantContentPart | ReadonlyArray<AssistantContentPart>,
      options: {
        readonly stopReason?: StopReason | undefined
        readonly responseId?: string | undefined
        readonly itemIds?: ReadonlyArray<string> | undefined
      } = {}
    ): AssistantMessage =>
      new AssistantMessage({
        role: "assistant",
        content: contentParts(content),
        stopReason: options.stopReason ?? "unknown",
        responseId: options.responseId,
        itemIds: options.itemIds
      }),
    tool: (content: ToolResultPart | ReadonlyArray<ToolResultPart>): ToolMessage =>
      new ToolMessage({ role: "tool", content: "type" in content ? [content] : content })
  }
)

/**
 * The decoded form of {@link Message}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Message = typeof Message.Type

const userContentParts = (content: string | TextPart | ReadonlyArray<TextPart>): ReadonlyArray<TextPart> =>
  typeof content === "string" ? [TextPart.make({ text: content })] : "type" in content ? [content] : content

const contentParts = (
  content: string | AssistantContentPart | ReadonlyArray<AssistantContentPart>
): ReadonlyArray<AssistantContentPart> =>
  typeof content === "string" ? [TextPart.make({ text: content })] : "type" in content ? [content] : content

/**
 * A provider-neutral tool declaration. `parameters` is a JSON Schema object.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ToolDefinition extends Schema.Class<ToolDefinition>("flows/model/ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
  /**
   * A lazy tool is wire metadata only: it may never add prompt text,
   * snippets, or guidelines, because changing the prompt prefix would change
   * the sealed-step key of every request that declares it.
   */
  deferred: Schema.optional(Schema.Boolean),
  loader: Schema.optional(Schema.Boolean)
}) {
  /** @category constructors @since 0.1.0 */
  static override make(input: ToolDefinition | ConstructorParameters<typeof ToolDefinition>[0]): ToolDefinition {
    return input instanceof ToolDefinition ? input : new ToolDefinition(input)
  }
}

/**
 * How much reasoning to spend on a request, in the provider-neutral
 * vocabulary the adapters map onto their own. `max` is the top of the
 * OpenAI Responses scale (the Codex CLI's `model_reasoning_effort = "max"`);
 * the OpenAI lowerings pass it through unchanged.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
])

/**
 * The decoded form of {@link ReasoningEffort}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReasoningEffort = typeof ReasoningEffort.Type

/**
 * The sampling and budget knobs of one request. Every field is optional; an
 * omitted field leaves the provider default in place, except that the Anthropic
 * Messages lowering sends the model's output ceiling from
 * `ModelCatalog.maxOutputTokensFor`, or `max_tokens: 4096` for a model the
 * catalog has not met, for an omitted `maxTokens`, because that API requires a
 * budget.
 *
 * Dropping a knob is a separate rule from defaulting one. A protocol with no
 * wire field for a stated knob leaves it out of the body, so `topK`,
 * `stopSequences`, and `thinkingBudget` are absent from both OpenAI bodies.
 * Anthropic lowers `reasoningEffort` to `output_config.effort`, clamped to the
 * levels the model accepts, and drops it for a model with no effort control.
 * The stated knobs that fail instead of being dropped are `maxTokens` on the
 * ChatGPT-subscription route, which `Route.prepare` rejects as
 * `invalid_request`, and an Anthropic `thinkingBudget` not below a stated
 * `maxTokens`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class GenerationParams extends Schema.Class<GenerationParams>("flows/model/GenerationParams")({
  maxTokens: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  topK: Schema.optional(Schema.Finite),
  stopSequences: Schema.optional(Schema.Array(Schema.String)),
  thinkingBudget: Schema.optional(Schema.Finite),
  reasoningEffort: Schema.optional(ReasoningEffort)
}) {
  /** @category constructors @since 0.1.0 */
  static override make(
    input: GenerationParams | ConstructorParameters<typeof GenerationParams>[0] = {}
  ): GenerationParams {
    return input instanceof GenerationParams ? input : new GenerationParams(input)
  }
}

/**
 * How the provider may use the declared tools.
 *
 * Only `none` is modelled, because it is the one value the harness declares: a
 * cell-first frame and a legacy landing frame both forbid tool use. It is a
 * declared property of the request — part of the sealed step's key material and
 * readable by any adapter — rather than a wire field. The built-in protocol
 * encoders express the same thing by omitting `tools` altogether, which is what
 * both provider APIs require; neither accepts a tool choice without tools.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolChoice = Schema.Literal("none")

/**
 * How the provider may use the declared tools.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolChoice = typeof ToolChoice.Type

/**
 * A tool the provider runs itself, inside the model call. `web_search` lets
 * the model search the public web and cite what it found, restricted to
 * `allowedDomains` (each with its subdomains) when set. Unlike a
 * {@link ToolDefinition} no call reaches the caller: the provider runs the
 * search and the model answers with it. A protocol whose provider serves no
 * such tool omits it; OpenAI Responses (API key and ChatGPT plan) serves it.
 *
 * @category models
 * @since 1.0.0
 */
export const ServerTool = Schema.Struct({
  type: Schema.Literal("web_search"),
  allowedDomains: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})

/**
 * A provider-run tool.
 *
 * @category models
 * @since 1.0.0
 */
export type ServerTool = typeof ServerTool.Type

/**
 * The declaration order below is load-bearing: it is the stable step-key
 * serialization order for a sealed model step.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class ModelRequest extends Schema.Class<ModelRequest>("flows/model/ModelRequest")({
  modelId: Schema.String,
  system: Schema.Array(SystemPart),
  messages: Schema.Array(Message),
  tools: Schema.Array(ToolDefinition),
  params: GenerationParams,
  toolChoice: Schema.optional(ToolChoice),
  /**
   * The conversation this request continues, for providers that route by it.
   *
   * A prefix cache is per machine, so a provider that spreads one
   * conversation's requests across machines re-reads the whole prefix at full
   * price on most of them. OpenAI Responses sends this as `prompt_cache_key`,
   * and the ChatGPT-plan backend also as the `session-id` header its cache
   * affinity is derived from. It must be stable for every request that
   * shares a prefix, and it never reaches the model. Protocols without such a
   * field ignore it.
   */
  cacheKey: Schema.optional(Schema.String),
  /**
   * How many leading messages the next request in this conversation repeats
   * unchanged; unset means all of them.
   *
   * Anthropic Messages caches only at explicit breakpoints and reads a prior
   * entry only where a previous request wrote one, so it puts its moving
   * message breakpoint on the last of these messages. A caller that appends a
   * volatile block after its transcript sets this to the transcript length so
   * the breakpoint never lands on bytes the next request will not repeat.
   * Protocols that cache automatically ignore it, and it never reaches the
   * model.
   */
  cacheBoundary: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Provider-run tools the model may use in this call. They are not declared
   * tools, so `toolChoice: "none"` does not remove them: a cell-first frame
   * still forbids function calls while its model may search. Unset or empty
   * leaves the request as it was.
   */
  serverTools: Schema.optional(Schema.Array(ServerTool))
}) {
  /** @category constructors @since 0.1.0 */
  static override make(input: ModelRequest | ConstructorParameters<typeof ModelRequest>[0]): ModelRequest {
    return input instanceof ModelRequest ? input : new ModelRequest(input)
  }
}
