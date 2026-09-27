/**
 * Replay of captured interpreter output under the caller's stream handling.
 *
 * @since 1.0.0-rc.0
 */

import type * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"

/**
 * Shared encoder for turning captured interpreter text back into bytes.
 *
 * @private
 */
const encoder = new TextEncoder()

/**
 * Captured output as a stream of at most one chunk, with the caller's
 * handling for that stream applied.
 *
 * The options mean here what they mean under `NodeChildProcessSpawner`.
 * Node only hands back a readable for `"pipe"`; `"inherit"` and `"ignore"`
 * leave `childProcess.stdout` null, which that implementation turns into
 * `Stream.empty` — so they do the same here, even though the interpreter has
 * already captured the text either way. A `Sink` is transduced through, the way
 * Node transduces the readable it wrapped.
 *
 * @private
 * @since 1.0.0-rc.0
 * @slop
 */
export const captured = (
  text: string,
  option: ChildProcess.CommandOutput | { readonly stream?: ChildProcess.CommandOutput | undefined } | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const handling = option === undefined || typeof option === "string" || Sink.isSink(option)
    ? option
    : option.stream
  if (handling === "ignore" || handling === "inherit") return Stream.empty
  const stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.fromArray(
    text === "" ? [] : [encoder.encode(text)]
  )
  if (Sink.isSink(handling)) return Stream.transduce(stream, handling)
  return stream
}
