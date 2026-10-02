/*
 * The bounded configured-model turn the local host serves, and the one
 * line a card shows for a model failure. Planning, credentials, the catalog,
 * the redirect-refusing transport and the failure mapping live in
 * @smthrs/model-host/LocalModel.
 */
import { ModelError } from "@smthrs/model/ModelError"
import { Message, ModelRequest, SystemPart } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { cutModelCredential } from "@smthrs/rpc/ConfiguredModel"
import type { ModelTestFailure } from "@smthrs/rpc/ConfiguredModel"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect, Layer, Redacted, Stream } from "effect"
import { toModel } from "@smthrs/model-host/ConfiguredModelRoute"
import { manualRedirects, modelFailureOf } from "@smthrs/model-host/LocalModel"
import type { LocalPlanned } from "@smthrs/model-host/LocalModel"

/** The most a configured-model answer may run to. */
const SEALED_TURN_MAX_TOKENS = 1024
const SEALED_TURN_MAX_CHARS = 64 * 1024

/** A failure as the one line a card shows: the code and its number, no sentence. */
export const modelFailureLine = (failure: ModelTestFailure): string => {
  switch (failure.code) {
    case "refused":
      return `${failure.code} · ${failure.status}`
    case "timeout":
      return `${failure.code} · ${failure.deadlineMs} ms`
    case "invalid":
      return `${failure.code} · ${failure.field}`
    case "credential_missing":
    case "credential_unknown":
      return `${failure.code} · ${failure.credential}`
    case "host_refused":
      return failure.status === null ? failure.code : `${failure.code} · ${failure.status}`
    case "unreachable":
    case "empty_output":
    case "endpoint_forbidden":
    case "model_not_allowed":
      return failure.code
  }
}

/** The plain transcript a sealed turn carries, or undefined when it continues a tool call. */
export const sealedMessages = (
  messages: StartAgentTurnRequest["messages"]
): ReadonlyArray<Message> | undefined => {
  const plain: Array<Message> = []
  for (const message of messages) {
    if (!("role" in message)) return undefined
    plain.push(message.role === "user" ? Message.user(message.content) : Message.assistant(message.content))
  }
  return plain
}

export interface SealedTurn {
  readonly runId: string
  readonly instructions: string
  readonly context?: StartAgentTurnRequest["context"]
  readonly messages: ReadonlyArray<Message>
}

/**
 * The configured model's turn through the planned model: one bounded answer,
 * then one `done`. A provider failure ends the turn with its typed
 * line; it never falls back to another model. Interrupting the fiber cancels
 * the request and publishes nothing. Text is the only thing published, and
 * only through the shared credential cut, including partial text on failure.
 * Nothing is published early: cutting an echo can join the halves of another.
 */
export const sealedTurn = (
  planned: Extract<LocalPlanned, { ok: true }>,
  turn: SealedTurn,
  publish: (frame: AgentTurnFrame) => void,
  fetchImpl?: typeof globalThis.fetch
): Effect.Effect<void> => {
  const http = manualRedirects(fetchImpl)
  let buffered = ""
  const say = (text: string): void => {
    if (text !== "") publish({ runId: turn.runId, type: "delta", kind: "text", text })
  }
  const done = (failure?: ModelTestFailure): void => {
    const text = cutModelCredential(buffered, Redacted.value(planned.apiKey))
    buffered = ""
    say(text)
    publish({
      runId: turn.runId,
      type: "done",
      reason: "stop",
      ...(failure === undefined ? {} : { error: modelFailureLine(failure) })
    })
  }
  return Effect.gen(function*() {
    const model = yield* toModel(planned.plan, planned.apiKey)
    const request = ModelRequest.make({
      modelId: planned.plan.modelId,
      system: [SystemPart.make({ text: composeAgentInstructions(turn.instructions, turn.context) })],
      messages: turn.messages,
      tools: [],
      params: { maxTokens: SEALED_TURN_MAX_TOKENS }
    })
    yield* Stream.runForEach(model.stream(request), (event) =>
      Effect.suspend(() => {
        if (event.type !== "text-delta") return Effect.void
        if (buffered.length + event.text.length > SEALED_TURN_MAX_CHARS) {
          return Effect.fail(new ModelError({ code: "invalid_provider_output", message: "The configured answer exceeded its limit" }))
        }
        buffered += event.text
        return Effect.void
      }))
  }).pipe(
    Effect.provide(RequestExecutor.layer.pipe(Layer.provide(http.layer))),
    Effect.match({
      onSuccess: () => {
        const status = http.redirected()
        done(status === undefined ? undefined : { code: "refused", status })
      },
      onFailure: (error) => {
        const status = http.redirected()
        done(status === undefined ? modelFailureOf(error) : { code: "refused", status })
      }
    }),
    // A defect's cause may hold a signed request, so it is dropped, never logged or published.
    Effect.catchDefect(() => Effect.sync(() => done({ code: "unreachable" })))
  )
}
