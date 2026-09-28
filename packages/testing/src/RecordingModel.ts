/**
 * A live model wrapped so every call it makes is recorded.
 *
 * This is the other half of `RecordedModel`: it produces the fixtures that
 * module replays. The recorder is a `/model/Model`, not a `ModelLike`, because
 * it wraps the real provider seam the code under test already talks to.
 *
 * @since 0.0.0
 */

import { defaultRules } from "@smthrs/journal/Redaction"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { Effect, Exit, type Layer, Stream } from "effect"
import { type RecordedCall, recordedRequest } from "./Fixture.ts"
import { snapshot } from "./internal/Structural.ts"
import type { ModelErrorLike, ModelEventLike } from "./ModelLike.ts"

/**
 * Where a recorder sends each completed call.
 *
 * The sink cannot fail and needs no services, so wrapping a model never widens
 * its stream's error channel or its requirements.
 *
 * @category models
 * @since 0.0.0
 */
export type Sink = (call: RecordedCall) => Effect.Effect<void>

const recordedFailure = (error: Model.ModelFailure): ModelErrorLike | undefined =>
  error instanceof ModelError
    ? {
      code: error.code,
      message: error.message,
      path: error.path,
      retryAfterMillis: error.retryAfterMillis,
      resetAtEpochMillis: error.resetAtEpochMillis,
      resetSource: error.resetSource,
      providerCode: error.providerCode,
      requestId: error.requestId,
      httpStatus: error.httpStatus
    }
    : undefined

// A recording is meant to be committed, and it holds the system prompt, every
// message, tool arguments and results, and the provider's error text verbatim.
// These are the journal's token-shaped rules only: its name and assignment
// rules would also match ordinary tool schemas (`"token": {...}`, `maxTokens`).
// A match refuses the whole call rather than redacting it, because a redacted
// request no longer has the digest its replay will look up.
const credentialRules = new Set([
  "private-key-block",
  "jwt",
  "api-key",
  "github-token",
  "github-fine-grained-token",
  "aws-access-key",
  "slack-token",
  "google-api-key"
])
const credentialPatterns = defaultRules
  .filter((rule) => credentialRules.has(rule.id))
  .map((rule) => ({ id: rule.id, pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")) }))

// Providers stream output a few characters per delta, so a key the model
// emitted is split across events and never contiguous in the serialized call.
// Each text, thinking and tool-call stream is joined in event order and scanned
// as one string beside the serialized call.
const streamedTexts = (events: ReadonlyArray<ModelEventLike>): Array<string> => {
  const joined = new Map<string, string>()
  const append = (key: string, piece: string) => joined.set(key, (joined.get(key) ?? "") + piece)
  for (const event of events) {
    if (event.type === "text-delta" || event.type === "thinking-delta") {
      append(`${event.type}\u0000${event.id}`, event.text)
    } else if (event.type === "tool-call-delta") {
      append(`${event.type}\u0000${event.id}`, event.arguments)
    }
  }
  return [...joined.values()]
}

const guarded = (call: RecordedCall, sink: Sink): Effect.Effect<void> =>
  Effect.suspend(() => {
    const texts = [JSON.stringify(call), ...streamedTexts(call.events)]
    const found = credentialPatterns.find((rule) => texts.some((text) => rule.pattern.test(text)))
    return found === undefined ? sink(call) : Effect.die(
      new Error(
        `Refusing to record a ${call.model} call: it contains a value shaped like a credential (${found.id}). ` +
          "Remove it from the request, tool results, or provider output before recording."
      )
    )
  })

/**
 * Wraps a live model so each call is written to `sink` when its stream ends.
 *
 * The recorder flushes only on an exhausted stream and on a provider failure,
 * and stays silent otherwise. Interruption, a defect, and a consumer that stops
 * pulling early all leave a truncated exchange: recording one would write a
 * stream with no `settle` event, which replays as an aborted turn and poisons
 * any cache built from the same fixture. A `PermissionRequired`,
 * `PermissionDenied`, or `GrantStoreError` failure is not recorded either,
 * because the kernel refused the call before the provider saw it, so there is
 * no provider exchange to record; the failure still reaches the caller
 * unchanged.
 *
 * A call whose serialized form holds a credential-shaped value (a private key
 * block, a JWT, or an `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox`, or `AIza`
 * key, including one streamed across several deltas) never reaches `sink`:
 * the stream dies with a defect naming the rule, not the value, so a recording
 * run cannot write a secret into a fixture.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (live: Model.Model, sink: Sink): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        // Projected here, at stream acquisition, rather than in `onExit` after
        // the whole exchange has run. The projection copies, and a caller that
        // mutates its own request while the exchange is in flight would
        // otherwise have recorded a request the provider never saw.
        const recorded = recordedRequest(request)
        const events: Array<ModelEventLike> = []
        let failure: ModelErrorLike | undefined
        let exhausted = false
        return live.stream(request).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              // Snapshot at emission for the same reason: the array used to be
              // copied but its elements aliased, so an event object the
              // provider reused or the caller mutated changed what the fixture
              // recorded.
              events.push(snapshot(event))
            })
          ),
          Stream.tapError((error) =>
            Effect.sync(() => {
              failure = recordedFailure(error)
            })
          ),
          // A successful scope exit can also mean the consumer stopped early
          // (`runHead`, `take`). Only the upstream done signal proves exhaustion.
          Stream.onEnd(
            Effect.sync(() => {
              exhausted = true
            })
          ),
          Stream.onExit((exit) =>
            (Exit.isSuccess(exit) && exhausted) || failure !== undefined
              ? guarded({
                request: recorded,
                model: recorded.modelId,
                events: [...events],
                ...(failure === undefined ? {} : { failure })
              }, sink)
              : Effect.void
          )
        )
      })
  })

/**
 * Provides a recording model over a live one.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (live: Model.Model, sink: Sink): Layer.Layer<Model.Model> => Model.layer(make(live, sink))
