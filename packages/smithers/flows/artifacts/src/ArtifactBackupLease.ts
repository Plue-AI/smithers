/**
 * Cross-process exclusion between a filesystem artifact backup and garbage
 * collection.
 *
 * A backup holds one heartbeat-backed marker for the duration of its database
 * snapshot and blob copy. Sweep deletion checks that marker while holding the
 * same short-lived global gate. Publication remains unconstrained: new blobs
 * may appear during a backup, but a blob already referenced by the frozen
 * database cannot disappear underneath it.
 *
 * @since 1.0.0-rc.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"
import * as ArtifactLocks from "./internal/ArtifactLocks.ts"

const markerName = ".backup-lease"
const gateName = ".backup-lease-gate"
const heartbeatEvery = "10 seconds"
const staleAfterMs = 60_000
const acquireWithin = "2 minutes"
const retryEvery = "25 millis"

const isReason = (cause: unknown, tag: PlatformError.SystemErrorTag): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === tag

const token = Effect.gen(function*() {
  const first = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  const second = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  return `${first.toString(36)}-${second.toString(36)}-${yield* Clock.currentTimeMillis}`
})

const gate = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2
): Effect.Effect<A, E | E2, R> => ArtifactLocks.withDigest(fs, directory, gateName, effect, failure)

const activeMarker = <E>(
  fs: FileSystem.FileSystem,
  directory: string,
  failure: (cause: unknown) => E
): Effect.Effect<boolean, E> =>
  Effect.gen(function*() {
    const path = `${directory}/${markerName}`
    const info = yield* fs.stat(path).pipe(
      Effect.map(Option.some),
      Effect.catch((cause): Effect.Effect<Option.Option<FileSystem.File.Info>, E> =>
        isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : Effect.fail(failure(cause))
      )
    )
    if (Option.isNone(info)) return false
    const modified = Option.getOrUndefined(info.value.mtime)
    const now = yield* Clock.currentTimeMillis
    if (modified === undefined || now - modified.getTime() <= staleAfterMs) return true
    yield* fs.remove(path).pipe(
      Effect.catch((cause): Effect.Effect<void, E> =>
        isReason(cause, "NotFound") ? Effect.void : Effect.fail(failure(cause))
      )
    )
    return false
  })

/**
 * Runs `effect` while sweep deletion is fenced across every process using
 * this objects directory. A crashed holder is recovered after its heartbeat
 * becomes stale.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const withLease = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2
): Effect.Effect<A, E | E2, R> =>
  Effect.gen(function*() {
    const owner = yield* token
    const marker = `${directory}/${markerName}`
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure))

    let ownsMarker = false
    const acquire = Effect.gen(function*() {
      while (true) {
        const acquired = yield* gate(
          fs,
          directory,
          Effect.gen(function*() {
            if (yield* activeMarker(fs, directory, failure)) return false
            return yield* Effect.uninterruptible(
              fs.writeFileString(marker, owner, { flag: "wx", mode: 0o600 }).pipe(
                Effect.andThen(Effect.sync(() => {
                  ownsMarker = true
                  return true
                })),
                Effect.catch((cause): Effect.Effect<boolean, E2> =>
                  isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
                )
              )
            )
          }),
          failure
        )
        if (acquired) return
        yield* Effect.sleep(retryEvery)
      }
    }).pipe(
      Effect.timeout(acquireWithin),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(failure(cause)))
    )

    // Install marker cleanup before acquisition, including gate release. The
    // marker write and ownership bookkeeping complete in one interruption mask.
    return yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        acquire.pipe(Effect.andThen(
          Effect.scoped(Effect.gen(function*() {
            yield* Effect.forkScoped(
              Effect.forever(
                Effect.sleep(heartbeatEvery).pipe(
                  Effect.andThen(gate(
                    fs,
                    directory,
                    fs.readFileString(marker).pipe(
                      Effect.map(Option.some),
                      Effect.catch((cause) =>
                        isReason(cause, "NotFound") ? Effect.succeed(Option.none<string>()) : Effect.fail(cause)
                      ),
                      Effect.flatMap((found) => {
                        // A missing or foreign marker means a sweep judged this
                        // lease stale and reaped it: deletion is no longer
                        // fenced while the backup still copies. The sibling
                        // `internal/ArtifactLocks.ts` heartbeat reports the same
                        // loss the same way.
                        if (Option.getOrUndefined(found) !== owner) {
                          return Effect.logWarning(
                            "Artifact backup lease was reclaimed while its backup was still running"
                          )
                        }
                        return Effect.flatMap(Clock.currentTimeMillis, (now) => {
                          const timestamp = new Date(now)
                          return fs.utimes(marker, timestamp, timestamp)
                        })
                      }),
                      Effect.mapError(failure)
                    ),
                    failure
                  )),
                  // A failed heartbeat is retried on the next tick, but a
                  // minute of them lets the marker go stale, so each one is
                  // reported rather than dropped.
                  Effect.catch((cause) => Effect.logWarning("Artifact backup lease heartbeat failed", cause))
                )
              )
            )
            return yield* effect
          }))
        )),
      () =>
        ownsMarker
          ? gate(
            fs,
            directory,
            fs.readFileString(marker).pipe(
              Effect.flatMap((found) => found === owner ? fs.remove(marker) : Effect.void),
              // A backup whose heartbeat lapsed has its marker reaped by whoever
              // noticed, so `NotFound` is the ordinary end of a slow lease, not a
              // fault: there is nothing left to release and nothing left to leak.
              // The sibling release in `internal/ArtifactLocks.ts` classifies the
              // same cause the same way.
              Effect.catch((cause): Effect.Effect<void, PlatformError.PlatformError> =>
                isReason(cause, "NotFound") ? Effect.void : Effect.fail(cause)
              )
            ),
            failure
          ).pipe(
            Effect.catch((cause) => Effect.logWarning("Artifact backup lease release failed", cause))
          )
          : Effect.void
    )
  })

/**
 * Runs one sweep deletion only when no live backup lease exists. The marker
 * check and `effect` share the global gate, closing the check/delete race.
 * `None` means a backup deliberately fenced the operation.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const unlessActive = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  directory: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2
): Effect.Effect<Option.Option<A>, E | E2, R> =>
  gate(
    fs,
    directory,
    Effect.gen(function*() {
      if (yield* activeMarker(fs, directory, failure)) return Option.none<A>()
      return Option.some(yield* effect)
    }),
    failure
  )
