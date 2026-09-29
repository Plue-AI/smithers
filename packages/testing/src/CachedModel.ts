/**
 * A model that answers from a fixture and records what the fixture is missing.
 *
 * This is the record-and-replay loop as one layer: a call whose canonical
 * request digest is already in the fixture replays from it, and a call that is
 * not runs against the live model and is appended. The first run records, every
 * run after it replays, and neither the test nor the flow changes shape.
 *
 * @since 0.0.0
 */

import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { Effect, type Layer, Option, Stream } from "effect"
import { canonicalRequestDigest, type Fixture, index, type RecordedCall } from "./Fixture.ts"
import type { FixtureStore } from "./FixtureStore.ts"
import type { ModelErrorLike, ModelRequestLike } from "./ModelLike.ts"
import * as RecordingModel from "./RecordingModel.ts"

/**
 * What a cached model is built from.
 *
 * @category models
 * @since 0.0.0
 */
export interface Options {
  /** The model a cache miss runs against. */
  readonly live: Model.Model
  /** The fixture the cache reads and records into. */
  readonly fixture: FixtureStore
}

/**
 * The recorded call for a request, if the fixture holds one.
 *
 * The key is the full canonical request digest, `modelId` included, so
 * switching models is an ordinary miss that records a second entry rather than
 * a mismatch. That is what separates this from `RecordedModel`, which erases
 * `modelId` to match by request shape and dies when the fixture was recorded
 * against a different model.
 */
const hit = (fixture: Fixture, request: ModelRequestLike): Option.Option<RecordedCall> =>
  Option.fromUndefinedOr(index(fixture).get(canonicalRequestDigest(request)))

const asModelError = (failure: ModelErrorLike): ModelError =>
  new ModelError({
    code: failure.code,
    message: failure.message,
    path: failure.path,
    retryAfterMillis: failure.retryAfterMillis,
    resetAtEpochMillis: failure.resetAtEpochMillis,
    resetSource: failure.resetSource,
    quotaScope: failure.quotaScope,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    httpStatus: failure.httpStatus
  })

const replay = (call: RecordedCall): Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure> => {
  const events: Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure> = Stream.fromIterable(call.events)
  return call.failure === undefined
    ? events
    : Stream.concat(Stream.fail(asModelError(call.failure)))(events)
}

/**
 * Builds a model that replays a fixture hit and records a miss.
 *
 * The fixture is consulted per call rather than once, so a miss recorded by one
 * call is a hit for the next identical one inside the same run. Nothing is
 * claimed: a cache serves the same recording to every request that matches it,
 * which is what makes a retried step deterministic.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (options: Options): Model.Model => {
  const recording = RecordingModel.make(options.live, options.fixture.append)
  return Model.make({
    stream: (request) =>
      Stream.unwrap(
        options.fixture.load().pipe(
          Effect.map((loaded) =>
            Option.match(Option.flatMap(loaded, (fixture) => hit(fixture, request)), {
              onNone: () => recording.stream(request),
              onSome: replay
            })
          )
        )
      )
  })
}

/**
 * Provides {@link make} as the `/model/Model` seam.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (options: Options): Layer.Layer<Model.Model> => Model.layer(make(options))
