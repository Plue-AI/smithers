/**
 * A recorded, non-networking `ModelLike` implementation.
 *
 * @since 0.0.0
 */

import { Context, Effect, Layer, Ref, Stream } from "effect"
import { canonicalRequestDigest, type Fixture, type RecordedCall } from "./Fixture.ts"
import {
  modelErrorTag,
  type ModelEventLike,
  ModelLike,
  type ModelLike as ModelLikeService,
  type ModelLikeError,
  type ModelRequestLike
} from "./ModelLike.ts"
import { ReplayHarnessMismatchError, UnscriptedModelError } from "./TestingError.ts"

/**
 * Options for recorded-model replay.
 *
 * @category models
 * @since 0.0.0
 */
export interface Options {
  /** Require calls to be consumed in their fixture order. */
  readonly strictRequestOrder?: boolean | undefined
}

/**
 * Controller for inspecting a recorded-model replay.
 *
 * @category services
 * @since 0.0.0
 */
export interface RecordedModel {
  /** Returns fixture calls that have not been selected for replay. */
  readonly unconsumed: () => Effect.Effect<ReadonlyArray<RecordedCall>>
}

/**
 * The recorded-model controller service.
 *
 * @category services
 * @since 0.0.0
 */
export const RecordedModel: Context.Service<RecordedModel, RecordedModel> = Context.Service(
  "/testing/RecordedModel"
)

/**
 * The model and controller constructed from a fixture.
 *
 * @category models
 * @since 0.0.0
 */
export interface Replay {
  readonly model: ModelLikeService
  readonly controller: RecordedModel
}

// A request with no recording, and a fixture recorded against another model,
// both say the fixture does not describe this run. Neither is a provider
// failure, so both are defects rather than typed errors: see `ModelLikeError`.
//
// The error names the request rather than carrying it. A defect is printed in
// full by the runner, and a fixture miss in a hundred-turn agent test used to
// dump the entire transcript — system prompt, every message, every tool
// schema — into CI logs.
const noCall = (request: ModelRequestLike) =>
  Stream.die(
    new UnscriptedModelError({
      modelId: request.modelId,
      messageCount: request.messages.length,
      toolNames: request.tools.map((tool) => tool.name)
    })
  )

type Selection =
  | { readonly _tag: "Call"; readonly call: RecordedCall }
  | { readonly _tag: "Mismatch"; readonly expected: string; readonly actual: string }
  | { readonly _tag: "Unscripted" }

const requestShapeDigest = (request: ModelRequestLike): string => canonicalRequestDigest({ ...request, modelId: "" })

/**
 * Builds a replay model and its controller. Calls are claimed before the
 * returned stream starts, so stream interruption leaves no pending claim or
 * background replay fiber. A request the fixture does not describe dies with
 * `UnscriptedModelError`, and a fixture recorded against another model dies
 * with `ReplayHarnessMismatchError`.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (fixture: Fixture, options: Options = {}): Effect.Effect<Replay> =>
  Effect.gen(function*() {
    const consumed = yield* Ref.make<ReadonlyArray<boolean>>(fixture.calls.map(() => false))
    // Encoded once per fixture rather than once per recorded call per model
    // invocation, and read back by index rather than re-derived after the
    // candidate is found.
    const shapes = fixture.calls.map((call) => requestShapeDigest(call.request))
    const claim = (request: ModelRequestLike): Effect.Effect<Selection> => {
      const digest = requestShapeDigest(request)
      return Ref.modify<ReadonlyArray<boolean>, Selection>(consumed, (used) => {
        const candidate = options.strictRequestOrder
          ? used.findIndex((value) => !value)
          : shapes.findIndex((shape, index) => !used[index] && shape === digest)
        if (candidate < 0 || shapes[candidate] !== digest) {
          return [{ _tag: "Unscripted" as const }, used] as const
        }
        const call = fixture.calls[candidate]!
        if (call.model !== request.modelId) {
          return [{
            _tag: "Mismatch" as const,
            expected: call.model,
            actual: request.modelId
          }, used] as const
        }
        return [
          { _tag: "Call" as const, call },
          used.map((value, index) => index === candidate || value)
        ] as const
      })
    }
    const model = ModelLike.of({
      stream: (request) => {
        const selection = claim(request).pipe(Effect.map((selected): Stream.Stream<ModelEventLike, ModelLikeError> => {
          if (selected._tag === "Unscripted") return noCall(request)
          if (selected._tag === "Mismatch") {
            return Stream.die(
              new ReplayHarnessMismatchError({ expected: selected.expected, actual: selected.actual })
            )
          }
          const call = selected.call
          const events = Stream.fromIterable(call.events)
          // The recorded failure ends the recorded events; `Stream.concat` is
          // data-last, so the failure is the argument and the events the self.
          // Stamped with the tag: a fixture stores a refusal's FIELDS, and a
          // consumer that classifies one — the agent's quota park matches
          // `_tag` — would not recognize a bare structural object as the
          // failure the recording captured.
          return call.failure === undefined
            ? events
            : Stream.concat(Stream.fail<ModelLikeError>({ _tag: modelErrorTag, ...call.failure }))(events)
        }))
        return Stream.unwrap(selection)
      }
    })
    const controller = RecordedModel.of({
      unconsumed: () =>
        Ref.get(consumed).pipe(
          Effect.map((used) => fixture.calls.filter((_, index) => !used[index]))
        )
    })
    return { model, controller }
  })

/**
 * Provides both `ModelLike` and the recorded-model controller.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (fixture: Fixture, options: Options = {}): Layer.Layer<ModelLikeService | RecordedModel> =>
  Layer.effectContext(
    make(fixture, options).pipe(
      Effect.map((services) => Context.add(Context.make(ModelLike, services.model), RecordedModel, services.controller))
    )
  )

/**
 * Creates a fixture-backed model from handwritten calls.
 *
 * @category constructors
 * @since 0.0.0
 */
export const scripted = (...calls: ReadonlyArray<RecordedCall>): Effect.Effect<Replay> => make({ calls })
