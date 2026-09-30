/**
 * The one provider seam: a request in, a stream of typed events out.
 *
 * Everything a consumer needs to reach a provider is behind this service, so a
 * flow, a harness or a test swaps the implementation without knowing which
 * protocol, endpoint or credential answers the call.
 *
 * @since 0.1.0
 */

import type { GrantStoreError, PermissionDenied, PermissionRequired } from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Stream } from "effect"
import type { ModelError } from "./ModelError.ts"
import { ModelError as ModelErrorClass } from "./ModelError.ts"
import type { ModelEvent } from "./ModelEvent.ts"
import type { ModelRequest } from "./ModelRequest.ts"

/**
 * Provider and kernel failures surfaced by a model stream.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export type ModelFailure = ModelError | PermissionRequired | PermissionDenied | GrantStoreError

/**
 * The one provider seam: a request in, a stream of events out.
 * Cancellation is fiber interruption, so there is no abort parameter.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Model {
  /** OpenTelemetry provider name declared by the deployment. */
  readonly providerName?: string

  /** Streams model progress; cancellation is fiber interruption only. */
  readonly stream: (request: ModelRequest) => Stream.Stream<ModelEvent, ModelFailure>
}

/**
 * The {@link Model} service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Model: Context.Service<Model, Model> = Context.Service("/model/Model")

/**
 * Builds a {@link Model} from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Model): Model => Model.of(implementation)

/**
 * Provides {@link Model} from an implementation of its one method.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: Model): Layer.Layer<Model> => Layer.succeed(Model)(make(implementation))

/**
 * A {@link Model} that fails every stream with `no_route`, so an
 * environment with no provider configured reports that rather than hanging.
 * Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Model> = {}): Model =>
  Model.of({
    stream: () => Stream.fail(new ModelErrorClass({ code: "no_route", message: "no model route in this environment" })),
    ...overrides
  })

/**
 * Wraps one model call in an OpenTelemetry GenAI client span.
 *
 * The span is named `chat <model>` and carries `gen_ai.operation.name`,
 * `gen_ai.request.model`, the declared `gen_ai.provider.name`, the provider's `gen_ai.usage.input_tokens` and
 * `gen_ai.usage.output_tokens` as they stream in, and
 * `gen_ai.response.finish_reasons` from the settlement. Prompt and response
 * content never reach the span.
 *
 * @category tracing
 * @since 1.0.0
 */
export const withGenAiSpan =
  (request: ModelRequest, providerName?: string) =>
  <E, R>(stream: Stream.Stream<ModelEvent, E, R>): Stream.Stream<ModelEvent, E, R> =>
    stream.pipe(
      Stream.tap((event) => {
        switch (event.type) {
          case "usage":
            return Effect.annotateCurrentSpan({
              ...(event.inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": event.inputTokens }),
              ...(event.outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": event.outputTokens })
            })
          case "settle":
            return Effect.annotateCurrentSpan({
              "gen_ai.response.finish_reasons": [event.stopReason],
              ...(event.responseId === undefined ? {} : { "gen_ai.response.id": event.responseId })
            })
          default:
            return Effect.void
        }
      }),
      Stream.withSpan(`chat ${request.modelId}`, {
        kind: "client",
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": request.modelId,
          ...(providerName === undefined ? {} : { "gen_ai.provider.name": providerName })
        }
      })
    )

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Model> = {}): Layer.Layer<Model> =>
  Layer.succeed(Model)(makeNoop(overrides))
