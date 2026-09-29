/**
 * Provider-neutral chat leg execution for every trusted Smithers host.
 *
 * @since 1.0.0-rc.0
 */

import type * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import {
  Message,
  ModelRequest,
  SystemPart,
  ToolCallPart,
  ToolDefinition,
  ToolResultPart
} from "@smthrs/model/ModelRequest"
import type { JsonObject, Message as ModelMessage, ModelRequest as Request } from "@smthrs/model/ModelRequest"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { cutModelCredential } from "@smthrs/rpc/ConfiguredModel"
import type { AgentChatMessage, AgentTurnFrame, AgentTurnUsage, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect, Stream } from "effect"

/**
 * Provider route and output controls for one model turn.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ModelTurnOptions {
  readonly modelId: string
  readonly maxTokens?: number
  readonly credential?: string
}
/**
 * Commits one renderer-compatible frame.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FrameWriter<E> = (frame: AgentTurnFrame) => Effect.Effect<void, E>

const appendWireMessage = (messages: Array<ModelMessage>, item: AgentChatMessage): void => {
  if ("role" in item) {
    messages.push(item.role === "user" ? Message.user(item.content) : Message.assistant(item.content))
    return
  }
  if (item.type === "function_call") {
    const call = ToolCallPart.make({ id: item.call_id, name: item.name, arguments: item.arguments })
    const prior = messages.at(-1)
    if (prior?.role === "assistant" && prior.stopReason === "tool-calls") {
      messages[messages.length - 1] = Message.assistant([...prior.content, call], { stopReason: "tool-calls" })
    } else messages.push(Message.assistant(call, { stopReason: "tool-calls" }))
    return
  }
  const result = ToolResultPart.make({ toolCallId: item.call_id, content: item.output })
  const prior = messages.at(-1)
  if (prior?.role === "tool") messages[messages.length - 1] = Message.tool([...prior.content, result])
  else messages.push(Message.tool(result))
}

/**
 * Projects the renderer request into the canonical provider model request.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const providerRequest = (turn: StartAgentTurnRequest, options: ModelTurnOptions): Request => {
  const messages: Array<ModelMessage> = []
  for (const item of turn.messages) appendWireMessage(messages, item)
  return ModelRequest.make({
    modelId: options.modelId,
    system: [SystemPart.make({ text: composeAgentInstructions(turn.instructions, turn.context) })],
    messages,
    tools: (turn.tools ?? []).map((tool) =>
      ToolDefinition.make({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as JsonObject
      })
    ),
    params: { ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) }
  })
}

/**
 * Removes a configured credential even when provider chunks split it.
 *
 * @category utilities
 * @since 1.0.0-rc.0
 */
export class StreamingCredentialCutter {
  private pending = ""
  private readonly secret: string | undefined
  constructor(secret: string | undefined) {
    this.secret = secret
  }
  push(value: string): string {
    if (this.secret === undefined || this.secret === "") return value
    this.pending = cutModelCredential(this.pending + value, this.secret)
    let held = 0
    for (let size = Math.min(this.pending.length, this.secret.length - 1); size > 0; size -= 1) {
      if (this.pending.endsWith(this.secret.slice(0, size))) {
        held = size
        break
      }
    }
    const emitted = this.pending.slice(0, this.pending.length - held)
    this.pending = this.pending.slice(this.pending.length - held)
    return emitted
  }
  finish(): string {
    const emitted = this.secret === undefined ? this.pending : cutModelCredential(this.pending, this.secret)
    this.pending = ""
    return emitted
  }
}

interface PendingToolCall {
  name: string
  arguments: string
}
const usageCount = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isFinite(value) || value < 0 ? undefined : Math.round(value)

/**
 * Folds one `usage` event into the call's running counts. A provider may
 * report input and output in separate events, so a later event overrides only
 * the counters it carries.
 */
const mergeUsage = (current: AgentTurnUsage | undefined, event: ModelEvent.UsageEvent): AgentTurnUsage | undefined => {
  const next: AgentTurnUsage = { ...current }
  const inputTokens = usageCount(event.inputTokens)
  const outputTokens = usageCount(event.outputTokens)
  const cachedInputTokens = usageCount(event.cachedInputTokens)
  if (inputTokens !== undefined) next.inputTokens = inputTokens
  if (outputTokens !== undefined) next.outputTokens = outputTokens
  if (cachedInputTokens !== undefined) next.cachedInputTokens = cachedInputTokens
  return Object.keys(next).length === 0 ? undefined : next
}

const doneFrame = (runId: string, event: ModelEvent.Settle, usage: AgentTurnUsage | undefined): AgentTurnFrame => {
  const counted = usage === undefined ? {} : { usage }
  if (event.stopReason === "tool-calls") return { runId, type: "done", reason: "tool_call", ...counted }
  if (event.stopReason === "aborted") return { runId, type: "done", reason: "cancelled", ...counted }
  // A reply cut off at the output token limit is not a finished reply. The
  // error keeps the truncation visible to the reader instead of passing it
  // off as a normal stop.
  if (["error", "content-filter", "unknown", "length"].includes(event.stopReason)) {
    return { runId, type: "done", reason: "stop", error: `model stopped: ${event.stopReason}`, ...counted }
  }
  return { runId, type: "done", reason: "stop", ...counted }
}

/**
 * Runs one provider stream and emits the established renderer frame contract.
 *
 * @category runners
 * @since 1.0.0-rc.0
 */
export const runModelTurn = <E>(
  model: Model.Model,
  turn: StartAgentTurnRequest,
  options: ModelTurnOptions,
  write: FrameWriter<E>
): Effect.Effect<void, Model.ModelFailure | ModelError | E> => {
  const text = new StreamingCredentialCutter(options.credential)
  const reasoning = new StreamingCredentialCutter(options.credential)
  const tools = new Map<string, PendingToolCall>()
  let settled = false
  let usage: AgentTurnUsage | undefined
  const emit = (frame: AgentTurnFrame): Effect.Effect<void, E> => write(frame)
  const emitDelta = (kind: "text" | "reasoning", value: string): Effect.Effect<void, E> =>
    value === "" ? Effect.void : emit({ runId: turn.runId, type: "delta", kind, text: value })
  const visit = (event: ModelEvent.ModelEvent): Effect.Effect<void, ModelError | E> => {
    switch (event.type) {
      case "text-delta":
        return emitDelta("text", text.push(event.text))
      case "thinking-delta":
        return emitDelta("reasoning", reasoning.push(event.text))
      case "tool-call-start":
        tools.set(event.id, { name: event.name, arguments: "" })
        return Effect.void
      case "tool-call-delta": {
        const pending = tools.get(event.id)
        if (pending === undefined) {
          return Effect.fail(
            new ModelError({ code: "invalid_provider_output", message: "tool delta preceded its start" })
          )
        }
        pending.arguments += event.arguments
        return Effect.void
      }
      case "tool-call-end": {
        const pending = tools.get(event.id)
        if (pending === undefined) {
          return Effect.fail(
            new ModelError({ code: "invalid_provider_output", message: "tool end preceded its start" })
          )
        }
        tools.delete(event.id)
        return emit({
          runId: turn.runId,
          type: "tool_call",
          call_id: event.id,
          name: cutModelCredential(pending.name, options.credential ?? ""),
          arguments: cutModelCredential(event.arguments ?? pending.arguments, options.credential ?? "")
        })
      }
      case "settle":
        if (settled) {
          return Effect.fail(new ModelError({ code: "invalid_provider_output", message: "model settled twice" }))
        }
        settled = true
        return Effect.gen(function*() {
          yield* emitDelta("reasoning", reasoning.finish())
          yield* emitDelta("text", text.finish())
          yield* emit(doneFrame(turn.runId, event, usage))
        })
      case "usage":
        usage = mergeUsage(usage, event)
        return Effect.void
      case "retry":
        // A retried call starts over; the abandoned attempt's counts are not this call's.
        usage = undefined
        return Effect.void
      default:
        return Effect.void
    }
  }
  return Stream.runForEach(model.stream(providerRequest(turn, options)), visit).pipe(
    Effect.flatMap(() =>
      settled
        ? Effect.void
        : Effect.fail(
          new ModelError({ code: "invalid_provider_output", message: "model stream ended without settlement" })
        )
    )
  )
}
