/**
 * The normalized events one model call emits, and the fold that turns them
 * back into a single durable assistant message.
 *
 * Every protocol lowers its own wire vocabulary into these events, so a
 * consumer reads one stream shape whichever provider answered.
 *
 * @since 0.1.0
 */

import { Effect, Schema } from "effect"
import { AssistantMessage, StopReason, ToolCallPart } from "./ModelRequest.ts"

/**
 * Token counts a provider reports for one request. Every field is
 * optional: providers disagree on which counters they expose, and a missing
 * count is not a zero count.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Usage = Object.assign(
  Schema.Struct({
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    reasoningTokens: Schema.optional(Schema.Number),
    cachedInputTokens: Schema.optional(Schema.Number),
    cacheWriteTokens: Schema.optional(Schema.Number),
    totalTokens: Schema.optional(Schema.Number),
    /** The USD charge the provider itself reported for the call, when it reports one. */
    costUsd: Schema.optional(Schema.Number)
  }).annotate({ identifier: "flows/model/Usage" }),
  {
    make: (input: Usage): Usage => input
  }
)

/**
 * The decoded token counts of {@link Usage}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Usage = typeof Usage.Type

/**
 * Opens a text part. Its `id` correlates the later deltas and end event
 * that belong to the same part.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TextStart = Schema.Struct({ type: Schema.Literal("text-start"), id: Schema.String })
/**
 * The decoded form of {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextStart = typeof TextStart.Type
/**
 * One incremental chunk of a text part's content.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TextDelta = Schema.Struct({ type: Schema.Literal("text-delta"), id: Schema.String, text: Schema.String })
/**
 * The decoded form of {@link TextDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextDelta = typeof TextDelta.Type
/**
 * Closes the text part opened by the matching {@link TextStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const TextEnd = Schema.Struct({ type: Schema.Literal("text-end"), id: Schema.String })
/**
 * The decoded form of {@link TextEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TextEnd = typeof TextEnd.Type
/**
 * Opens a reasoning part. `signature` carries the provider's attestation
 * for the block, which a later request must echo back verbatim.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ThinkingStart = Schema.Struct({
  type: Schema.Literal("thinking-start"),
  id: Schema.String,
  signature: Schema.optional(Schema.String)
})
/**
 * The decoded form of {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingStart = typeof ThinkingStart.Type
/**
 * One incremental chunk of a reasoning part's content.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking-delta"),
  id: Schema.String,
  text: Schema.String
})
/**
 * The decoded form of {@link ThinkingDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingDelta = typeof ThinkingDelta.Type
/**
 * Closes the reasoning part opened by the matching {@link ThinkingStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ThinkingEnd = Schema.Struct({ type: Schema.Literal("thinking-end"), id: Schema.String })
/**
 * The decoded form of {@link ThinkingEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ThinkingEnd = typeof ThinkingEnd.Type
/**
 * Opens a tool call and names the tool. The arguments arrive as deltas.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolCallStart = Schema.Struct({
  type: Schema.Literal("tool-call-start"),
  id: Schema.String,
  name: Schema.String
})
/**
 * The decoded form of {@link ToolCallStart}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallStart = typeof ToolCallStart.Type
/**
 * One incremental chunk of a tool call's JSON argument text.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolCallDelta = Schema.Struct({
  type: Schema.Literal("tool-call-delta"),
  id: Schema.String,
  arguments: Schema.String
})
/**
 * The decoded form of {@link ToolCallDelta}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallDelta = typeof ToolCallDelta.Type
/**
 * Closes a tool call. `arguments` repeats the complete argument text when
 * the provider sends it, which lets a consumer skip reassembling deltas.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolCallEnd = Schema.Struct({
  type: Schema.Literal("tool-call-end"),
  id: Schema.String,
  arguments: Schema.optional(Schema.String)
})
/**
 * The decoded form of {@link ToolCallEnd}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolCallEnd = typeof ToolCallEnd.Type
/**
 * The result of an executed tool call, as reported by a harness. Tool output
 * is not part of the settled assistant message; it renders alongside the call
 * and feeds the next request's tool message.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  output: Schema.String,
  isError: Schema.optional(Schema.Boolean)
})
/**
 * The decoded form of {@link ToolResult}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ToolResult = typeof ToolResult.Type
/**
 * Reports token counts mid-stream. The same counters as {@link Usage},
 * carried as a stream event.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const UsageEvent = Schema.Struct({
  type: Schema.Literal("usage"),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  costUsd: Schema.optional(Schema.Number)
})
/**
 * The decoded form of {@link UsageEvent}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type UsageEvent = typeof UsageEvent.Type
/**
 * A bounded model-boundary retry, recorded so run reports can count transport recovery.
 *
 * @category models
 * @since 0.1.0
 */
export const Retry = Schema.Struct({
  type: Schema.Literal("retry"),
  attempt: Schema.Int,
  code: Schema.String,
  /**
   * Milliseconds the boundary waited before this attempt, as the retry
   * schedule decided it on the injected clock.
   *
   * Recording the count alone was not enough to tell a working backoff from a
   * broken one. Every retry of one sealed step is buffered and journaled
   * together when the step settles, so two retries carry the same journal
   * timestamp whether they were seconds apart or instantaneous — a wave report
   * reading those timestamps cannot see the schedule at all. The delay is
   * therefore stated by the event that took it. Zero is what a record written
   * before this field carried, and what an unscheduled retry means.
   */
  delayMillis: Schema.Number.pipe(
    Schema.withConstructorDefault(Effect.succeed(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(0))
  )
})
/**
 * The decoded form of {@link Retry}.
 *
 * @category models
 * @since 0.1.0
 */
export type Retry = typeof Retry.Type
/**
 * Ends the stream and states why. A stream without one was interrupted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Settle = Schema.Struct({
  type: Schema.Literal("settle"),
  stopReason: StopReason,
  responseId: Schema.optional(Schema.String),
  /** The vendor session that answered, for a seat that is a wrapped CLI: `claude --resume <sessionId>`. */
  sessionId: Schema.optional(Schema.String),
  /**
   * Stored provider reasoning items required for replay-safe continuation: a
   * provider that keeps reasoning server side answers the next request with
   * these ids rather than the text they stand for.
   */
  itemIds: Schema.optional(Schema.Array(Schema.String))
})
/**
 * The decoded form of {@link Settle}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Settle = typeof Settle.Type

/**
 * Every event a model stream can emit, tagged by `type`, with a constructor
 * per member and {@link settledMessage} attached.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ModelEvent = Object.assign(
  Schema.Union([
    TextStart,
    TextDelta,
    TextEnd,
    ThinkingStart,
    ThinkingDelta,
    ThinkingEnd,
    ToolCallStart,
    ToolCallDelta,
    ToolCallEnd,
    ToolResult,
    UsageEvent,
    Retry,
    Settle
  ]).pipe(Schema.toTaggedUnion("type")),
  {
    TextStart: TextStart.make,
    TextDelta: TextDelta.make,
    TextEnd: TextEnd.make,
    ThinkingStart: ThinkingStart.make,
    ThinkingDelta: ThinkingDelta.make,
    ThinkingEnd: ThinkingEnd.make,
    ToolCallStart: ToolCallStart.make,
    ToolCallDelta: ToolCallDelta.make,
    ToolCallEnd: ToolCallEnd.make,
    ToolResult: ToolResult.make,
    Usage: (input: Usage): UsageEvent => ({ type: "usage", ...input }),
    Retry: Retry.make,
    Settle: Settle.make,
    settledMessage
  }
)

/**
 * The decoded form of {@link ModelEvent}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ModelEvent = typeof ModelEvent.Type

/**
 * Folds a stream into the one durable assistant message. No settlement means
 * interruption, which is represented as an aborted message rather than an
 * exception so the transcript remains resumable.
 *
 * Two policies meet here on one condition, and the split is deliberate.
 * `ToolStream.end` refuses argument text that is not a JSON object with
 * `invalid_provider_output`, because a live stream that cannot say what the
 * model asked for must fail rather than execute a guess. This projection
 * preserves malformed text verbatim, because it folds a stream that has
 * already happened and the durable transcript must remain truthful. Built-in
 * protocols validate live completions before they emit `tool-call-end`; only
 * an aborted turn can retain partial text, and every built-in lowering omits
 * that turn from the next request. A consumer must still validate arguments
 * before executing a tool.
 *
 * @category destructors
 * @since 0.1.0
 * @slop
 */
export function settledMessage(
  events: Iterable<ModelEvent>
): { readonly message: AssistantMessage; readonly usage: Usage } {
  const parts: Array<AssistantMessage["content"][number]> = []
  const indexes = new Map<string, number>()
  let usage: Usage = {}
  let stopReason: StopReason = "aborted"
  let didSettle = false
  let responseId: string | undefined
  let itemIds: ReadonlyArray<string> | undefined

  const part = (id: string, initial: AssistantMessage["content"][number]): number => {
    const existing = indexes.get(id)
    if (existing !== undefined) return existing
    const index = parts.length
    parts.push(initial)
    indexes.set(id, index)
    return index
  }

  for (const event of events) {
    switch (event.type) {
      case "text-start":
        part(event.id, { type: "text", text: "" })
        break
      case "text-delta": {
        const index = part(event.id, { type: "text", text: "" })
        const current = parts[index]
        if (current?.type === "text") parts[index] = { type: "text", text: current.text + event.text }
        break
      }
      case "thinking-start":
        part(event.id, { type: "thinking", text: "", signature: event.signature })
        break
      case "thinking-delta": {
        const index = part(event.id, { type: "thinking", text: "" })
        const current = parts[index]
        if (current?.type === "thinking") parts[index] = { ...current, text: current.text + event.text }
        break
      }
      case "tool-call-start":
        part(event.id, ToolCallPart.make({ id: event.id, name: event.name, arguments: "" }))
        break
      case "tool-call-delta": {
        const index = part(event.id, ToolCallPart.make({ id: event.id, name: "unknown", arguments: "" }))
        const current = parts[index]
        if (current?.type === "tool-call") parts[index] = { ...current, arguments: current.arguments + event.arguments }
        break
      }
      case "tool-call-end": {
        const index = indexes.get(event.id)
        const current = index === undefined ? undefined : parts[index]
        if (index !== undefined && current?.type === "tool-call") {
          const arguments_ = event.arguments ?? current.arguments
          parts[index] = {
            ...current,
            arguments: arguments_
          }
        }
        break
      }
      case "usage": {
        const next = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          cachedInputTokens: event.cachedInputTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          totalTokens: event.totalTokens,
          costUsd: event.costUsd
        }
        usage = {
          ...usage,
          ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
        }
        break
      }
      case "retry":
        parts.length = 0
        indexes.clear()
        usage = {}
        stopReason = "aborted"
        didSettle = false
        responseId = undefined
        itemIds = undefined
        break
      case "settle":
        if (!didSettle) {
          stopReason = event.stopReason
          responseId = event.responseId
          itemIds = event.itemIds
          didSettle = true
        }
        break
    }
  }
  return {
    message: new AssistantMessage({
      role: "assistant",
      content: parts,
      stopReason,
      responseId,
      itemIds
    }),
    usage
  }
}
