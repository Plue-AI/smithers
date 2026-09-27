/**
 * The model-backed author seat.
 *
 * Requires `Model.Model` from context — production supplies a route stack,
 * tests supply a replay model — and maps an author input onto the sealed
 * request shape of the harness's sealed steps: prefix as the stable system
 * part, context lines as one user message, no tools, `toolChoice: "none"`
 * (https://chain.smithers.sh/contract/). Prior art, copied rather than
 * imported: the sealed steps in
 * packages/smithers/agent/harness/src/CellTurn.ts.
 *
 * @since 0.1.0
 */

import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Layer, Stream } from "effect"
import * as Author from "./Author.ts"
import { failureCode } from "./internal/failureCode.ts"

/**
 * Joins an assistant message's visible text parts — the one fold every
 * consumer of a settled message shares, so "what counts as visible text"
 * has exactly one definition.
 */
const visibleText = (message: ModelRequest.AssistantMessage): string =>
  message.content
    .filter((part): part is ModelRequest.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

/**
 * Which model the seat calls, and the generation parameters it calls with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Config {
  readonly modelId: string
  readonly params?: ModelRequest.GenerationParams | undefined
}

/**
 * The pure mapping from an author input to the wire-neutral request — the
 * same function derives test fixtures, so a mapping drift breaks the
 * replay match loudly instead of silently changing the step key.
 *
 * The prefix is host-supplied. `Prompt.assemble` places a fixed rule before
 * the catalog and encodes repository descriptions as labelled, untrusted
 * data; this mapping preserves that boundary in the system part.
 *
 * Degenerate inputs collapse to wire-valid shapes: an empty prefix emits
 * no system part at all, and an empty context (reachable from any script
 * via a garbage author payload) becomes one placeholder line — providers
 * reject empty system blocks and empty user content outright.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const requestFor = (config: Config) => (input: Author.Input): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: config.modelId,
    system: input.prefix === "" ? [] : [ModelRequest.SystemPart.make({ text: input.prefix })],
    messages: [
      ModelRequest.Message.user(
        (input.context.length === 0 ? ["(no context was provided)"] : input.context)
          .map((text) => ModelRequest.TextPart.make({ text }))
      )
    ],
    tools: [],
    toolChoice: "none",
    params: config.params ?? ModelRequest.GenerationParams.make()
  })

const unavailable = (message: string, cause: string): Author.AuthorError =>
  new Author.AuthorError({ cause, code: "author_unavailable", message })

// A route stack fails with tagged errors that often carry no code of their
// own, so the tag is the seat's last stable answer before "unknown".
const causeOf = (error: unknown): string => failureCode(error, ["code", "_tag"])

const describeFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly _tag?: unknown; readonly code?: unknown; readonly message?: unknown }
    const parts = [record._tag, record.code, record.message].filter(
      (part): part is string => typeof part === "string"
    )
    if (parts.length > 0) return parts.join(": ")
  }
  return String(error)
}

/**
 * Builds the author seat over the ambient model.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (config: Config): Effect.Effect<Author.Service, never, Model.Model> =>
  Effect.gen(function*() {
    const model = yield* Model.Model
    const request = requestFor(config)
    return Author.make({
      author: Effect.fn("ModelAuthor.author")((input) =>
        Effect.gen(function*() {
          const events = Array.from(yield* Stream.runCollect(model.stream(request(input))))
          const settled = ModelEvent.ModelEvent.settledMessage(events)
          // `settledMessage` folds an unsettled stream to stopReason
          // "aborted", so one guard covers interruption, truncation
          // ("length"), filtering, and provider errors alike — none of
          // them may pass as a complete authored output.
          if (settled.message.stopReason !== "stop") {
            return yield* unavailable(
              `the model stream settled with stopReason "${settled.message.stopReason}"`,
              settled.message.stopReason
            )
          }
          const text = visibleText(settled.message)
          if (text.trim() === "") {
            // A reasoning-only response is a seat failure, not an empty
            // authored script (the harness's sealed steps in
            // packages/smithers/agent/harness/src/CellTurn.ts fail the same way).
            return yield* unavailable("the model returned no visible text", "no_text")
          }
          return text
        }).pipe(
          Effect.mapError((error) =>
            error instanceof Author.AuthorError
              ? error
              : unavailable(describeFailure(error), causeOf(error))
          )
        )
      )
    })
  })

/**
 * The production author layer: `Author` from `Model.Model`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (config: Config): Layer.Layer<Author.Author, never, Model.Model> =>
  Layer.effect(Author.Author)(make(config))
