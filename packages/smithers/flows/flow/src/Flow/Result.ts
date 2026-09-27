// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Serializable completion and suspension states returned by flow executions.
 *
 * @since 0.1.0
 */

import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaParser from "effect/SchemaParser"
import * as Transformation from "effect/SchemaTransformation"
import type { ExitEncoded } from "effect/unstable/rpc/RpcMessage"

const ResultTypeId = "@smthrs/flow/Flow/Result"

/**
 * Returns `true` when a value is a flow `Result`.
 *
 * @category results
 * @since 0.1.0
 */
export const isResult = <A = unknown, E = unknown>(
  u: unknown
): u is Result<A, E> => {
  if (u !== Object(u)) return false
  const marker = Object.getOwnPropertyDescriptor(u, ResultTypeId)
  if (marker === undefined || !("value" in marker) || marker.value !== ResultTypeId) return false
  const tag = Object.getOwnPropertyDescriptor(u, "_tag")
  return tag !== undefined && "value" in tag &&
    (tag.value === "Complete" || tag.value === "Suspended" || tag.value === "Handoff")
}

/**
 * Result of a flow execution: a completed exit, a suspended flow state, or a
 * handoff to the next round of a trampoline lineage.
 *
 * @category results
 * @since 0.1.0
 */
export type Result<A, E> = Complete<A, E> | Suspended | Handoff

/**
 * Encoded representation of a flow `Result`.
 *
 * @category results
 * @since 0.1.0
 */
export type ResultEncoded<A, E> =
  | CompleteEncoded<A, E>
  | typeof Suspended.Encoded
  | typeof Handoff.Encoded

/**
 * Encoded representation of a completed flow result containing an encoded
 * `Exit`.
 *
 * @category results
 * @since 0.1.0
 */
export interface CompleteEncoded<A, E> {
  readonly _tag: "Complete"
  readonly exit: ExitEncoded<A, E>
}

/**
 * Schema constructor for `Complete` flow results using the supplied
 * success and error schemas.
 *
 * @category schemas
 * @since 0.1.0
 */
export interface CompleteSchema<
  Success extends Schema.Constraint,
  Error extends Schema.Constraint
> extends
  Schema.declareConstructor<
    Complete<Success["Type"], Error["Type"]>,
    Complete<Success["Encoded"], Error["Encoded"]>,
    readonly [Schema.Exit<Success, Error, Schema.Defect>]
  >
{
  readonly success: Success
  readonly error: Error
}

/**
 * Represents a completed flow execution with its success or failure `Exit`.
 *
 * @category results
 * @since 0.1.0
 */
export class Complete<A, E> extends Data.TaggedClass("Complete")<{
  readonly exit: Exit.Exit<A, E>
}> {
  /**
   * Marks this value as a flow result for runtime guards.
   *
   * @since 0.1.0
   */
  readonly [ResultTypeId] = ResultTypeId

  /**
   * Builds the schema for completed flow results from success and error schemas.
   *
   * @since 0.1.0
   */
  static Schema<Success extends Schema.Constraint, Error extends Schema.Constraint>(options: {
    readonly success: Success
    readonly error: Error
  }): CompleteSchema<Success, Error> {
    // The declaration stays inline because it closes over this constructor's schemas.
    const schema = Schema.declareConstructor<
      Complete<Success["Type"], Error["Type"]>,
      Complete<Success["Encoded"], Error["Encoded"]>
    >()(
      [Schema.Exit(options.success, options.error, Schema.Defect())],
      ([exit]) => (input, ast, options) => {
        if (!(isResult(input) && input._tag === "Complete")) {
          return Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
        }
        return Effect.mapBothEager(
          SchemaParser.decodeEffect(exit)(input.exit, options),
          {
            onSuccess: (exit) => new Complete({ exit }),
            onFailure: (issue) =>
              new SchemaIssue.Composite(
                ast,
                [
                  new SchemaIssue.Pointer(["exit"], issue)
                ],
                input,
                options
              )
          }
        )
      },
      {
        expected: "Flow.Complete",
        toCodecJson: ([exit]) =>
          Schema.link<Complete<Success["Encoded"], Error["Encoded"]>>()(
            Schema.Struct({
              _tag: Schema.tag("Complete"),
              exit
            }),
            Transformation.transform({
              decode: (encoded) => new Complete({ exit: encoded.exit }),
              encode: (result) => (({
                _tag: "Complete",
                exit: result.exit
              }) as const)
            })
          )
      }
    )
    return Schema.make(schema.ast, {
      success: options.success,
      error: options.error
    })
  }
}

/**
 * Represents a suspended flow execution, optionally carrying the cause that
 * triggered suspension.
 *
 * @category results
 * @since 0.1.0
 */
export class Suspended extends Schema.Class<Suspended>(
  "@smthrs/flow/Flow/Suspended"
)({
  _tag: Schema.tag("Suspended"),
  cause: Schema.optional(Schema.Cause(Schema.Never, Schema.Defect()))
}) {
  /**
   * Marks this value as a flow result for runtime guards.
   *
   * @since 0.1.0
   */
  readonly [ResultTypeId] = ResultTypeId
}

/**
 * Represents a flow round that ended by handing off to the next round of its
 * trampoline lineage.
 *
 * A round settles this way when its body's root value is a `to` invocation
 * (`docs/concepts/trampoline-rounds.md`): the round produced no answer of
 * its own, it produced the NEXT flow to run. `flow` is the target's tag, so the
 * value survives the journal and the run row unchanged.
 *
 * DECIDED: `payload` is the target's payload in
 * ENCODED form. The target's `to` method accepts its ordinary constructor
 * shape so authoring stays aligned with `call` and `execute`; the body
 * interpreter resolves planned references and encodes the invocation through
 * the target declaration before constructing `Handoff`. The receiving round
 * decodes those bytes through the same schema.
 *
 * It is a third settlement rather than a `Complete` carrying a magic value
 * because the engine has to tell "this run answered" from "this run continues
 * elsewhere" without decoding against a success schema the handoff never
 * satisfies.
 *
 * @category results
 * @since 0.1.0
 */
export class Handoff extends Schema.Class<Handoff>(
  "@smthrs/flow/Flow/Handoff"
)({
  _tag: Schema.tag("Handoff"),
  flow: Schema.NonEmptyString,
  payload: Schema.Unknown
}) {
  /**
   * Marks this value as a flow result for runtime guards.
   *
   * @since 0.1.0
   */
  readonly [ResultTypeId] = ResultTypeId
}

/**
 * Creates a schema for flow results using the supplied success and error
 * schemas.
 *
 * @category results
 * @since 0.1.0
 */
export const Result = <
  Success extends Schema.Constraint,
  Error extends Schema.Constraint
>(options: {
  readonly success: Success
  readonly error: Error
}) => Schema.Union([Complete.Schema(options), Suspended, Handoff])

const AnyOrVoid = Schema.Union([Schema.Any, Schema.Void])

/**
 * Schema for encoded flow results with generic success and error payloads.
 *
 * @category results
 * @since 0.1.0
 */
export const ResultEncoded: Schema.Codec<ResultEncoded<any, any>> = Schema.toEncoded(
  Schema.toCodecJson(
    Result({
      success: AnyOrVoid,
      error: AnyOrVoid
    })
  )
) as any
