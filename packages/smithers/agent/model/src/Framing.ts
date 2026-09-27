/**
 * Bounded byte-stream framing, independent of provider protocol decoding.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Sse from "effect/unstable/encoding/Sse"
import { ModelError } from "./ModelError.ts"

/**
 * A byte-stream framing strategy selected independently of a protocol.
 *
 * @since 0.1.0
 * @category models
 */
export interface Framing<Frame> {
  readonly id: string
  readonly frame: <E, R>(
    stream: Stream.Stream<Uint8Array, E, R>
  ) => Stream.Stream<Frame, E | Sse.SseError | ModelError, R>
}

/**
 * Inclusive default UTF-8 byte budget for one pending record (4 MiB).
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxRecordBytes = 4 * 1024 * 1024

/**
 * Inclusive raw response budget (64 MiB), including delimiters and comments.
 * This also bounds argument text accumulated across separate tool-call frames.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMaxResponseBytes = 64 * 1024 * 1024

/**
 * Finite framing budgets. Record bytes exclude a line's terminator for NDJSON;
 * SSE counts the event's lines with normalized LF terminators, excluding the
 * terminating blank line. The response budget counts every original byte.
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  readonly maxRecordBytes?: number | undefined
  readonly maxResponseBytes?: number | undefined
}

// Guard BEFORE decodeText/splitLines can retain an unterminated line. This
// guard retains only counters. Upstream owns its currently supplied chunk;
// downstream retention per record is O(maxRecordBytes), independently of byte
// partitioning. Terminal failure stops pulls and closes the producer's scope.
const bounded = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, sse: boolean, limits: Limits) =>
  Stream.suspend(() => {
    const recordLimit = limits.maxRecordBytes ?? defaultMaxRecordBytes
    const responseLimit = limits.maxResponseBytes ?? defaultMaxResponseBytes
    if (
      !Number.isSafeInteger(recordLimit) || recordLimit <= 0 || !Number.isSafeInteger(responseLimit) ||
      responseLimit <= 0
    ) {
      return Stream.fail(
        new ModelError({ code: "invalid_request", message: "Framing limits must be positive safe integers" })
      )
    }
    let responseBytes = 0
    let recordBytes = 0
    let lineBytes = 0
    let afterCr = false
    return stream.pipe(Stream.mapEffect((chunk) => {
      responseBytes += chunk.byteLength
      if (responseBytes > responseLimit) {
        return Effect.fail(
          new ModelError({ code: "invalid_provider_output", message: `Model response exceeds ${responseLimit} bytes` })
        )
      }
      for (const byte of chunk) {
        if (byte === 10 && afterCr) {
          afterCr = false
          continue
        }
        afterCr = byte === 13
        if (byte === 10 || byte === 13) {
          recordBytes = sse && lineBytes !== 0 ? recordBytes + 1 : 0
          lineBytes = 0
        } else {
          lineBytes += 1
          recordBytes += 1
        }
        if (recordBytes > recordLimit) {
          return Effect.fail(
            new ModelError({
              code: "invalid_provider_output",
              message: `Model stream record exceeds ${recordLimit} bytes`
            })
          )
        }
      }
      return Effect.succeed(chunk)
    }))
  })

/**
 * Creates bounded SSE framing. Incomplete final events are discarded; malformed
 * UTF-8 uses the TextDecoder replacement policy. Budget failures are terminal
 * invalid_provider_output errors and never contain response text.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeSse = (limits: Limits = {}): Framing<string> => ({
  id: "sse",
  frame: (stream) =>
    Stream.suspend(() => {
      let frames: Array<string> = []
      // `bounded` owns the record budget: it counts every line of the event in
      // UTF-8 bytes and fails upstream, while the parser's own cap counts only
      // the data values in UTF-16 units, so that cap can never fire first. It
      // stays off rather than leave a failure path no input reaches.
      const parser = Sse.makeParser((event) => {
        if (event._tag === "Event" && event.data !== "" && event.data !== "[DONE]") frames.push(event.data)
      }, { maxEventSize: Number.POSITIVE_INFINITY })
      return bounded(stream, true, limits).pipe(
        Stream.decodeText,
        Stream.map((text) => {
          parser.feed(text)
          const emitted = frames
          frames = []
          return emitted
        }),
        Stream.flattenIterable
      )
    })
})

/**
 * Incrementally decodes bounded UTF-8 SSE. Empty events and the [DONE] sentinel
 * are discarded. See makeSse for limits and the incomplete-event policy.
 *
 * @since 0.1.0
 * @category framing
 */
export const sse: Framing<string> = makeSse()

/**
 * Creates bounded NDJSON framing. Blank lines are discarded. A partial final
 * line is emitted so protocol JSON decoding can report truncation. Malformed
 * UTF-8 follows the TextDecoder replacement policy, as SSE does.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNdjson = (limits: Limits = {}): Framing<string> => ({
  id: "ndjson",
  frame: (stream) =>
    bounded(stream, false, limits).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== "")
    )
})

/**
 * One JSON document per line, under the default record and response budgets.
 * See makeNdjson for the intentional partial-final-record policy.
 *
 * @since 0.1.0
 * @category framing
 */
export const ndjson: Framing<string> = makeNdjson()
