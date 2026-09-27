/**
 * Bounded-chunk file streaming over a ZenFS file handle.
 *
 * @since 1.0.0-rc.0
 */

import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { platformError } from "./platformError.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * The chunk a caller gets when it asks for no particular size.
 *
 * @private
 */
const defaultChunkSize = 64 * 1024

/**
 * The largest single allocation a caller may ask for. A chunk size is a
 * buffer this adapter allocates on the caller's behalf, and a tab has one
 * heap for the whole page, so the ceiling is stated rather than left to the
 * allocator to discover.
 *
 * @private
 */
const maximumChunkSize = 64 * 1024 * 1024

/**
 * Caller input that is not a byte count, refused before anything is opened.
 *
 * @private
 */
const rejected = (description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: "FileSystem", method: "stream", description })

/**
 * A caller-supplied byte count, or its default. Clamping a nonsense bound
 * would answer a question the caller did not ask: a negative `offset` is not
 * "the start", and a fractional `chunkSize` is not a buffer length.
 *
 * @private
 */
const count = (
  name: string,
  value: ByteSize.Input | undefined,
  fallback: number
): Effect.Effect<number, PlatformError.PlatformError> => {
  if (value === undefined) return Effect.succeed(fallback)
  const numeric = Number(Option.getOrUndefined(ByteSize.fromInput(value)))
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? Effect.succeed(numeric)
    : Effect.fail(rejected(`${name} must be a whole, non-negative number of bytes`))
}

/**
 * The chunk size to allocate, refused when it is not a length this adapter
 * will allocate.
 *
 * @private
 */
const chunk = (
  value: ByteSize.Input | undefined
): Effect.Effect<number, PlatformError.PlatformError> => {
  if (value === undefined) return Effect.succeed(defaultChunkSize)
  const numeric = Number(Option.getOrUndefined(ByteSize.fromInput(value)))
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= maximumChunkSize
    ? Effect.succeed(numeric)
    : Effect.fail(rejected(`chunkSize must be a whole number of bytes between 1 and ${maximumChunkSize}`))
}

/**
 * The refusal for a backend that reports having read a length that cannot
 * have gone into the buffer it was handed. Trusting it would move the read
 * position backwards and grow the remaining count, so the unfold would never
 * terminate.
 *
 * @private
 */
const misreported = (path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "BadResource",
    module: "FileSystem",
    method: "stream.read",
    pathOrDescriptor: path,
    description: "the backend reported a read length outside the requested buffer"
  })

/**
 * Streams a file in bounded file-handle chunks rather than loading the whole
 * file, honouring `offset`, `bytesToRead`, and `chunkSize`.
 *
 * @private
 * @since 1.0.0-rc.0
 * @slop
 */
export const streamFile = (
  fs: ZenFsPromisesLike,
  path: string,
  options?: {
    readonly bytesToRead?: ByteSize.Input | undefined
    readonly chunkSize?: ByteSize.Input | undefined
    readonly offset?: ByteSize.Input | undefined
  }
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  Stream.unwrap(
    Effect.gen(function*() {
      const start = yield* count("offset", options?.offset, 0)
      const bytesToRead = yield* count("bytesToRead", options?.bytesToRead, Number.POSITIVE_INFINITY)
      const chunkSize = yield* chunk(options?.chunkSize)
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => fs.open(path, "r"),
          catch: platformError("stream", path)
        }),
        (open) =>
          Effect.orDie(
            Effect.tryPromise({
              try: () => open.close(),
              catch: platformError("stream.close", path)
            })
          )
      )
      return Stream.unfold(
        { position: start, remaining: bytesToRead },
        ({ position, remaining }) => {
          if (remaining === 0) return Effect.succeed(undefined)
          const size = Math.min(chunkSize, remaining)
          const buffer = new Uint8Array(size)
          return Effect.tryPromise({
            try: () => handle.read(buffer, 0, size, position),
            catch: platformError("stream.read", path)
          }).pipe(
            // Keep the handle open until this non-cancellable read settles.
            Effect.uninterruptible,
            Effect.flatMap(({ bytesRead }) =>
              !Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > size
                ? Effect.fail(misreported(path))
                : Effect.succeed(
                  bytesRead === 0
                    ? undefined
                    : [
                      bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
                      {
                        position: position + bytesRead,
                        remaining: remaining - bytesRead
                      }
                    ] as const
                )
            )
          )
        }
      )
    })
  )
