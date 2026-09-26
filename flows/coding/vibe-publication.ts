/** Finalization uses the existing guest publication route and native receipt. */
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { NativeCoding, NativeCodingError, requestIdFor, SourcePublication } from "./native.ts"
import { CodingError } from "./schema.ts"
import { PublicationInput } from "./vibe-schema.ts"
export { PublicationInput } from "./vibe-schema.ts"

const RetainSource = Action.make("coding/publish-vibe-source", {
  payload: PublicationInput,
  success: SourcePublication,
  error: CodingError,
  nondeterministic: true
})

/** A native child receipt gives the same recursive debugger an exact source. */
export const PublishVibeSource = Flow.make("coding/PublishVibeSource", {
  payload: PublicationInput,
  success: SourcePublication,
  error: CodingError,
  body: (input) => RetainSource.call(input)
})

export const publicationLayers = Layer.mergeAll(
  Interpreter.layer(PublishVibeSource),
  RetainSource.toLayer(({ source, phase }) =>
    Effect.gen(function*() {
      const native = yield* NativeCoding
      if (native.sourcePublication !== "cloud") {
        return yield* new CodingError({
          code: "unavailable",
          message: "This workspace has local-only source capability; cloud finalization is unavailable"
        })
      }
      const instance = yield* FlowRuntime.FlowInstance
      // The original may no longer be the local head. The existing helper checks
      // its exact remote ACK first; an absent pin plus a moved source refuses.
      return yield* native.publishOriginalSource({
        requestId: requestIdFor(instance.executionId, `vibe-source/${phase}`),
        source: { ...source, kind: "resolved" }
      })
    }).pipe(Effect.mapError((error) =>
      error instanceof CodingError ? error : error instanceof NativeCodingError && error.code === "revision_conflict"
        ? new CodingError({
          code: "stale_revision",
          message:
            `The ${phase} source was not retained before it changed; this finalization cannot use a newer source in its place`
        })
        : new CodingError({
          code: "unavailable",
          message: "Exact source retention could not be acknowledged; finalization cannot continue"
        })
    ))
  )
)
