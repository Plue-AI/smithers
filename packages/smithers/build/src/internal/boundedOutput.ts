/**
 * The byte bound every version probe collects its standard output under.
 *
 * Two seams in this package spawn a tool and read one line of version back.
 * Both are handed a stream by a child they do not control, so both need the
 * same refusal: stop at a fixed number of bytes rather than buffer whatever a
 * misbehaving or hostile executable decides to print. The bound lived beside
 * one of the two probes and was applied by that one alone, while the other
 * exported an identically named constant that nothing read.
 *
 * Decoding happens after the bound, never before, so a stream is refused on the
 * bytes it actually produced rather than on a decoder's view of them.
 *
 * Nothing here is reachable from outside the package: the export map maps
 * `./internal/*` to `null`.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

/**
 * Maximum stdout bytes accepted from a version probe.
 *
 * @private
 * @since 0.1.0
 */
export const maximumVersionOutputBytes = 64 * 1024

interface ByteState {
  buffer: Uint8Array
  length: number
}

/**
 * Collects a stream into memory, failing at the first byte past the bound.
 *
 * The refusal is raised from inside the fold, so the stream is torn down at the
 * chunk that crossed the line rather than after the producer finishes.
 *
 * @private
 * @since 0.1.0
 */
export const boundedOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>
): Effect.Effect<Uint8Array, E | Error> =>
  Stream.runFoldEffect(
    stream,
    (): ByteState => ({ buffer: new Uint8Array(1024), length: 0 }),
    (state, chunk) => {
      const length = state.length + chunk.byteLength
      if (!Number.isSafeInteger(length) || length > maximumVersionOutputBytes) {
        return Effect.fail(new Error(`version output exceeds ${maximumVersionOutputBytes} bytes`))
      }
      if (length > state.buffer.byteLength) {
        let capacity = state.buffer.byteLength
        while (capacity < length) capacity = Math.min(maximumVersionOutputBytes, capacity * 2)
        const grown = new Uint8Array(capacity)
        grown.set(state.buffer.subarray(0, state.length))
        state.buffer = grown
      }
      state.buffer.set(chunk, state.length)
      state.length = length
      return Effect.succeed(state)
    }
  ).pipe(Effect.map((state) => state.buffer.subarray(0, state.length)))

/**
 * Decodes bytes as strict UTF-8, refusing anything a decoder would replace.
 *
 * @private
 * @since 0.1.0
 */
export const decodedText = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${path} is not valid UTF-8`)
  }
}
