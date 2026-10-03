/**
 * Struct-field helpers shared by every review boundary schema.
 *
 * The review boundary is `effect/Schema` because that is what `Action.make`,
 * `AgentAction.make`, and `Flow.make` accept: an action's payload and success
 * are decoded by it, and a model-backed step renders its `output` schema into
 * the run's system teaching as JSON Schema. Two habits from the 0.x schemas
 * carry over, so this module states both once.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * A field that fills in `value` when the key is absent or `undefined`.
 *
 * Agent answers are the reason. A model that omits `thinking` has still
 * answered the question, and failing the decode over a missing optional field
 * would burn a correction re-prompt on nothing. The strict invariants live in
 * the normalizers (`normalizeStory`, `finalizeNativeReview`),
 * which is where they were in 0.x too.
 *
 * @since 1.0.0
 * @category constructors
 */
export const withDefault = <S extends Schema.Codec<any, any> & Schema.WithoutConstructorDefault>(
  schema: S,
  value: S["Encoded"]
) =>
  // Both halves, because both are real entry points. `Flow.execute` and
  // `Action.call` build a payload through the CONSTRUCTOR, so a caller that
  // omits `narrate` must get the declared default there; decoding is what a
  // model answer and a stored payload come back through.
  Schema.withDecodingDefaultKey<Schema.withConstructorDefault<S>>(Effect.succeed(value))(
    Schema.withConstructorDefault<S>(Effect.succeed(value))(schema)
  )

/**
 * A mutable array field with an empty-array default.
 *
 * `Schema.Array` decodes to `ReadonlyArray`. The review pipeline builds its
 * comment and warning lists by pushing into them, so the declared type has to
 * be the mutable one rather than every consumer copying.
 *
 * @since 1.0.0
 * @category constructors
 */
export const arrayOf = <S extends Schema.Codec<any, any>>(item: S) =>
  withDefault(Schema.mutable(Schema.Array(item)), [])
