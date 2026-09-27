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
    stream: () =>
      Stream.unwrap(
        Effect.fn("Model.stream")(() =>
          Effect.succeed(
            Stream.fail(new ModelErrorClass({ code: "no_route", message: "no model route in this environment" }))
          )
        )()
      ),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Model> = {}): Layer.Layer<Model> =>
  Layer.succeed(Model)(makeNoop(overrides))
