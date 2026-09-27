/**
 * Pure accumulation of fragmented provider tool-call arguments.
 *
 * @since 0.1.0
 */

import { Chunk, Option, Schema } from "effect"
import { ModelError } from "./ModelError.ts"
import { JsonObject, type StopReason } from "./ModelRequest.ts"

/**
 * An unfinished streamed tool call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface OpenToolCall {
  readonly callId: string
  readonly name: string
  readonly fragments: Chunk.Chunk<string>
}

/**
 * Tool-call accumulator state.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface State {
  readonly open: ReadonlyArray<OpenToolCall>
}

/**
 * A completed provider tool call with its validated JSON argument text.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Completed {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/**
 * The result of completing one streamed tool call.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type EndResult = { readonly state: State; readonly completed: Completed } | ModelError

/**
 * The result of flushing all tool calls left open by an interrupted stream.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface FlushResult {
  readonly state: State
  readonly completed: ReadonlyArray<Completed>
}

const invalidOutput = (message: string): ModelError => new ModelError({ code: "invalid_provider_output", message })
const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonObject)
)

const find = (state: State, callId: string): OpenToolCall | undefined =>
  state.open.find((entry) => entry.callId === callId)

/**
 * Creates an empty tool-call accumulator.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const initial = (): State => ({ open: [] })

/**
 * Starts recording fragments for a provider tool call.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const start = (state: State, call: { readonly callId: string; readonly name: string }): State => ({
  open: [...state.open.filter((entry) => entry.callId !== call.callId), { ...call, fragments: Chunk.empty() }]
})

/**
 * Appends an argument fragment to an open provider tool call.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const delta = (state: State, callId: string, fragment: string): State => ({
  open: state.open.map((entry) =>
    entry.callId === callId ? { ...entry, fragments: Chunk.append(entry.fragments, fragment) } : entry
  )
})

/**
 * Completes a tool call and validates its reassembled argument JSON.
 *
 * This is the strict half of the package's two policies for one condition:
 * argument text that is not a JSON object fails with
 * `invalid_provider_output`, because a live stream that cannot say what the
 * model asked for must not hand a guess to a tool. {@link flushAborted} and
 * `ModelEvent.settledMessage` preserve the incomplete text for a stream that
 * has already ended, so the journal records what arrived without making it
 * executable.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const end = (state: State, callId: string): EndResult => {
  const call = find(state, callId)
  if (call === undefined) {
    return invalidOutput(`Received completion for unknown tool call ${callId}`)
  }
  const arguments_ = Chunk.toReadonlyArray(call.fragments).join("") || "{}"
  if (Option.isNone(decodeArguments(arguments_))) {
    return invalidOutput(`Invalid JSON input for streamed tool call ${call.name}`)
  }
  return {
    state: { open: state.open.filter((entry) => entry.callId !== callId) },
    completed: { callId: call.callId, name: call.name, arguments: arguments_ }
  }
}

/**
 * Settles unfinished calls after a stream halt. Empty or partial arguments are
 * preserved verbatim so the historical assistant turn records what arrived
 * instead of laundering malformed provider output into an empty object. This
 * is the non-executing half of the split documented on {@link end}: built-in
 * lowerings omit aborted turns, and the tool calls of {@link truncated} turns,
 * from continuations, while a live completion still passes through the strict
 * validator above.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const flushAborted = (state: State): FlushResult => ({
  state: initial(),
  completed: state.open.map((call) => ({
    callId: call.callId,
    name: call.name,
    arguments: Chunk.toReadonlyArray(call.fragments).join("")
  }))
})

/**
 * Whether a turn that settled with this reason was cut off before it finished:
 * the output budget ran out (`length`) or the provider stopped it
 * (`content-filter`).
 *
 * Every built-in protocol applies one policy to such a turn. A tool call still
 * open when it settles closes through {@link flushAborted}, with the argument
 * text that arrived, before the settle event, and the stream does not fail.
 * Every built-in lowering then omits that turn's tool calls from the next
 * request: they were never run, so they have no results to pair with.
 *
 * @category predicates
 * @since 1.0.0-rc.1
 */
export const truncated = (stopReason: StopReason | undefined): boolean =>
  stopReason === "length" || stopReason === "content-filter"
