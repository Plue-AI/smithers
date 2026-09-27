/**
 * A typed JSON settlement at the engine persistence boundary. The existing
 * terminal fallback remains the encoder, so a rejected class cannot leave a
 * run live. This module does not change existing result bytes or writers.
 *
 * @since 1.0.0
 */

import type { Flow } from "@smthrs/flow"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as ExitEncoding from "./ExitEncoding.ts"

/**
 * Encoded success or a classified failure.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResultEnvelope = EngineEvent.ResultEnvelope
/**
 * Encoded success or a classified failure.
 *
 * @category models
 * @since 1.0.0
 */
export type ResultEnvelope = EngineEvent.ResultEnvelope
/**
 * Validate untrusted encoded state without dropping contradictory fields.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decode = (input: unknown) =>
  Effect.suspend(() => Schema.decodeUnknownEffect(ResultEnvelope, { onExcessProperty: "error" })(input)).pipe(
    Effect.catchCause((cause) =>
      Effect.fail(
        new EngineEvent.EventError({
          code: "malformed",
          message: "invalid result envelope",
          cause: Cause.squash(cause)
        })
      )
    )
  )

/**
 * The encoded settlement and whether the existing encoder required terminal
 * fallback. Encoded domain failure is still an Encoded settlement; callers
 * read its exit, never infer domain success from this discriminant.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Settlement = Schema.Union([
  Schema.TaggedStruct("Encoded", { value: Schema.Json }),
  Schema.TaggedStruct("EncodingFailure", { value: Schema.Json, note: Schema.String })
])
/**
 * Encoded terminal settlement and its encoding-failure status.
 *
 * @category models
 * @since 1.0.0
 */
export type Settlement = typeof Settlement.Type

/**
 * Admit an encoded settlement without introducing an error channel on the
 * terminal write path. A corrupt codec output becomes a terminal failure.
 *
 * @category decoders
 * @since 1.0.0
 */
export const fromEncoded = (encoded: unknown, note?: string): Effect.Effect<Settlement> =>
  Effect.suspend(() => Schema.decodeUnknownEffect(Schema.Json)(encoded)).pipe(
    Effect.map((value): Settlement =>
      note === undefined ? { _tag: "Encoded", value } : { _tag: "EncodingFailure", value, note }
    ),
    Effect.catchCause((_cause) => {
      const note = "the encoded settlement was not JSON"
      // This is the same terminal-only policy as ExitEncoding.encode: record
      // a failed settlement even when pure codec validation defects. No I/O
      // or authority decision is retried by recovering this validation cause.
      return Effect.as(Effect.logWarning(`${note}; preserving a terminal failure`), {
        _tag: "EncodingFailure" as const,
        note,
        value: {
          _tag: "Complete",
          exit: {
            _tag: "Failure",
            cause: [{
              _tag: "Die",
              defect: {
                _tag: ExitEncoding.projectionTag,
                result: "Complete",
                note,
                reasons: [],
                value: null
              }
            }]
          }
        }
      })
    })
  )

/**
 * Wrap the established no-fail terminal encoder without changing its bytes.
 *
 * @category conversions
 * @since 1.0.0
 */
export const encode = (flow: Flow.Any, result: Flow.Result<unknown, unknown>) =>
  ExitEncoding.encode(flow, result).pipe(
    Effect.flatMap(({ encoded, note }) => fromEncoded(encoded, note))
  )
