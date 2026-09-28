/**
 * A cross-process lease on one lock file.
 *
 * The lock is a file created with `wx` (exclusive create) that holds a unique
 * owner token. The holder refreshes its mtime every `heartbeatEvery`; a lock
 * whose mtime is older than `staleAfterMs` belongs to a crashed or hard-killed
 * owner and is reclaimed. Reclaimers of one lock generation race for a `wx`
 * claim file first, so a stale generation is moved away at most once and a
 * fresh lock is never displaced. Acquisition is bounded by `acquireWithin`,
 * so a waiter fails with a typed error instead of waiting forever on a lock
 * nothing will release.
 *
 * | Setting          | Default     |
 * | ---------------- | ----------- |
 * | `heartbeatEvery` | 10 seconds  |
 * | `staleAfterMs`   | 60 000 ms   |
 * | `acquireWithin`  | 2 minutes   |
 * | `retryEvery`     | 25 millis   |
 *
 * The fence is bounded, not absolute: a holder stalled past `staleAfterMs`
 * (a suspended laptop, a stopped debugger) is reaped while it still runs. Its
 * heartbeat then logs `<label> was reclaimed while its holder was still
 * running`, and the protected effect continues unfenced.
 *
 * A directory at the lock path, left by a release that used an exclusive
 * `makeDirectory` as its lock, is treated as a lock with no readable owner:
 * it is reclaimed once its mtime is past `staleAfterMs`, and waited on
 * before that.
 *
 * The host needs exclusive `wx` file creation, `readFileString`, `stat` with
 * an mtime, `utimes`, `rename`, and `remove`. The claim file and the tombstone
 * a reclaim renames the stale lock to are siblings of the lock:
 * `<lockPath>.reclaim-<token>` and `<lockPath>.stale-<token>`.
 *
 * @since 1.0.0-rc.1
 */

import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Random from "effect/Random"

/**
 * Tuning for one lease.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Options {
  /** Names the lock in the reclaimed-holder warning. Defaults to `"File lease"`. */
  readonly label?: string | undefined
  /** Extra fields logged with the reclaimed-holder warning. */
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
  /** How often the holder refreshes the lock's mtime. Defaults to 10 seconds. */
  readonly heartbeatEvery?: Duration.Input | undefined
  /** Age past which a lock or claim is stale. Defaults to 60 000 ms. */
  readonly staleAfterMs?: number | undefined
  /** How long acquisition may wait. Defaults to 2 minutes. */
  readonly acquireWithin?: Duration.Input | undefined
  /** How long a waiter sleeps between attempts. Defaults to 25 millis. */
  readonly retryEvery?: Duration.Input | undefined
}

/**
 * {@link Options} for {@link hold}, which leaves the deadline to its caller.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface HoldOptions extends Omit<Options, "acquireWithin"> {
  /** Runs once, the moment the lease is held and before `effect` starts. */
  readonly onAcquired?: Effect.Effect<void> | undefined
  /**
   * Runs before every create, heartbeat, rename, and remove of the lock, its
   * claim, or its tombstone. A failure refuses that step through `failure`,
   * so a caller can re-check that the lock directory was not replaced (for
   * example by a symlink) after it was created.
   */
  readonly guard?: Effect.Effect<void, unknown> | undefined
}

/**
 * The default acquisition deadline.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const defaultAcquireWithin: Duration.Input = "2 minutes"

/**
 * The default stale bound, in milliseconds.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const defaultStaleAfterMs = 60_000

const isReason = (cause: unknown, tag: PlatformError.SystemErrorTag): boolean =>
  cause instanceof PlatformError.PlatformError && cause.reason._tag === tag

/** The generation name of a lock with no readable owner: a directory. */
const directoryGeneration = "legacy-directory"

const token = Effect.gen(function*() {
  const first = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  const second = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
  return `${first.toString(36)}-${second.toString(36)}-${yield* Clock.currentTimeMillis}`
})

/**
 * Runs `effect` while holding the lease at `lockPath`, with no acquisition
 * deadline. Use it when the caller already bounds a wider wait (an
 * in-process semaphore plus this lease) with its own deadline; otherwise use
 * {@link withLease}.
 *
 * @category combinators
 * @since 1.0.0-rc.1
 */
export const hold = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  options: HoldOptions = {}
): Effect.Effect<A, E | E2, R> =>
  Effect.gen(function*() {
    const label = options.label ?? "File lease"
    const heartbeatEvery = options.heartbeatEvery ?? "10 seconds"
    const staleAfterMs = options.staleAfterMs ?? defaultStaleAfterMs
    const retryEvery = options.retryEvery ?? "25 millis"
    const owner = yield* token
    /**
     * Whether this call created the lock file, and therefore owes a release.
     * It is set in the same uninterruptible step that creates the file, so
     * interruption striking between the two cannot leak a lock nothing
     * releases — the only party that would ever reclaim it is a later
     * acquirer of the same path, which may never come.
     */
    let acquired = false

    const guard = options.guard === undefined ? Effect.void : options.guard.pipe(Effect.mapError(failure))
    const guarded = <B, F, S>(mutation: Effect.Effect<B, F, S>): Effect.Effect<B, F | E2, S> =>
      Effect.andThen(guard, mutation)

    const statIfPresent = (path: string): Effect.Effect<Option.Option<FileSystem.File.Info>, E2> =>
      fs.stat(path).pipe(
        Effect.map(Option.some),
        Effect.catch((cause): Effect.Effect<Option.Option<FileSystem.File.Info>, E2> =>
          isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : Effect.fail(failure(cause))
        )
      )

    const refuse = (cause: unknown): Effect.Effect<never, E2> => Effect.fail(failure(cause))

    const readOwner = (
      path: string,
      onRefused: (cause: unknown) => Effect.Effect<Option.Option<string>, E2> = refuse
    ): Effect.Effect<Option.Option<string>, E2> =>
      fs.readFileString(path).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) => isReason(cause, "NotFound") ? Effect.succeed(Option.none()) : onRefused(cause))
      )

    /**
     * Names the lock generation at `path`: its owner token, or
     * `directoryGeneration` for a directory, which has no readable owner.
     * A read refused for any other reason is propagated, not guessed at.
     */
    const observe = (path: string): Effect.Effect<Option.Option<string>, E2> =>
      readOwner(path, (cause) =>
        fs.stat(path).pipe(
          Effect.matchEffect({
            onFailure: () => refuse(cause),
            onSuccess: (info) =>
              info.type === "Directory" ? Effect.succeed(Option.some(directoryGeneration)) : refuse(cause)
          })
        ))

    const isStale = (path: string): Effect.Effect<boolean, E2> =>
      Effect.gen(function*() {
        const info = yield* statIfPresent(path)
        const modified = Option.isSome(info) ? Option.getOrUndefined(info.value.mtime) : undefined
        return modified !== undefined && (yield* Clock.currentTimeMillis) - modified.getTime() > staleAfterMs
      })

    const removeIfOwnedBy = (path: string, expected: string): Effect.Effect<void> =>
      fs.readFileString(path).pipe(
        Effect.flatMap((found) => found === expected ? guarded(fs.remove(path)) : Effect.void),
        Effect.ignore
      )

    const acquire = Effect.gen(function*() {
      while (true) {
        const created = yield* Effect.uninterruptible(
          guarded(fs.writeFileString(lockPath, owner, { flag: "wx", mode: 0o600 })).pipe(
            Effect.andThen(Effect.sync(() => {
              acquired = true
              return true
            })),
            Effect.catch((cause): Effect.Effect<boolean, E2> =>
              isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
            )
          )
        )
        if (created) return

        // The owner is read before the age, so a stale verdict always
        // belongs to the lock generation this read named.
        const observed = yield* observe(lockPath)
        if (Option.isNone(observed)) continue
        if (yield* isStale(lockPath)) {
          const reclaimed = yield* reclaim(observed.value)
          if (reclaimed) continue
        }
        yield* Effect.sleep(retryEvery)
      }
    })

    /**
     * Moves away the stale lock generation `observed` names, at most once.
     *
     * Measuring a lock and renaming it are two steps, so two contenders
     * that both measure the same generation as stale would otherwise both
     * rename, and the second would move away the fresh lock the first just
     * took. Reclaimers of one generation therefore race for a `wx` claim
     * named after its owner token first. Only the winner renames, and only
     * after re-reading that the path still holds that stale generation. A
     * loser, or a winner whose generation is already gone, moves nothing.
     * Owner tokens are unique per acquisition, so a claim never outlives
     * the generation it names in any way that matters.
     */
    const reclaim = (observed: string): Effect.Effect<boolean, E2> => {
      const claimPath = `${lockPath}.reclaim-${observed.replace(/[^0-9A-Za-z-]/g, "_").slice(0, 96)}`
      return Effect.acquireUseRelease(
        guarded(fs.writeFileString(claimPath, owner, { flag: "wx", mode: 0o600 })).pipe(
          Effect.as(true),
          Effect.catch((cause): Effect.Effect<boolean, E2> =>
            isReason(cause, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(failure(cause))
          )
        ),
        (claimed) =>
          Effect.gen(function*() {
            if (!claimed) {
              // A claimant that died mid-reclaim leaves its claim behind.
              // It ages out on the same bound as a lock.
              const holder = yield* readOwner(claimPath)
              if (Option.isSome(holder) && (yield* isStale(claimPath))) {
                yield* removeIfOwnedBy(claimPath, holder.value)
              }
              return false
            }
            const current = yield* observe(lockPath)
            if (Option.isNone(current) || current.value !== observed || !(yield* isStale(lockPath))) return true
            const tombstone = `${lockPath}.stale-${owner}`
            const moved = yield* guarded(fs.rename(lockPath, tombstone)).pipe(
              Effect.as(true),
              Effect.catch((cause): Effect.Effect<boolean, E2> =>
                isReason(cause, "NotFound") ? Effect.succeed(false) : Effect.fail(failure(cause))
              )
            )
            if (!moved) return true
            // Only a stalled owner releasing between the re-read and the
            // rename, and a new owner acquiring in that gap, puts a live
            // lock here. Hand it back with an atomic create, which cannot
            // displace anyone who took the path since.
            const displaced = yield* observe(tombstone)
            if (
              Option.isSome(displaced) && displaced.value !== observed && displaced.value !== directoryGeneration
            ) {
              yield* guarded(fs.writeFileString(lockPath, displaced.value, { flag: "wx", mode: 0o600 })).pipe(
                Effect.ignore
              )
            }
            yield* guarded(fs.remove(tombstone, { recursive: true })).pipe(Effect.ignore)
            return true
          }),
        (claimed) => claimed ? removeIfOwnedBy(claimPath, owner) : Effect.void
      )
    }

    const release = fs.readFileString(lockPath).pipe(
      Effect.flatMap((found) => found === owner ? guarded(fs.remove(lockPath)) : Effect.void),
      // A concurrent stale-lock reaper can win release. `NotFound`
      // means no lock remains for this owner to release or leak.
      Effect.catch((cause): Effect.Effect<void, E2> =>
        isReason(cause, "NotFound") ? Effect.void : Effect.fail(failure(cause))
      )
    )

    // The finalizer is attached around acquisition itself, not just around
    // the protected effect, so a lock created moments before an interruption
    // is still released. A call that never created one owes nothing and must
    // not touch a file another owner holds.
    return yield* acquire.pipe(
      Effect.andThen(options.onAcquired ?? Effect.void),
      Effect.andThen(Effect.scoped(Effect.gen(function*() {
        yield* Effect.forkScoped(
          Effect.gen(function*() {
            while (true) {
              yield* Effect.sleep(heartbeatEvery)
              // Freshen only a lock this call still owns, the same comparison
              // the release below makes. A holder stalled past the stale
              // bound has already been reaped and replaced, and touching that
              // pathname anyway would hold a stranger's lock fresh forever: a
              // replacement that is then hard-killed could never be judged
              // stale while this zombie ran, so every later acquirer would
              // burn the full acquisition deadline and fail.
              const beat = yield* fs.readFileString(lockPath).pipe(
                Effect.map((found) => found === owner ? "own" as const : "foreign" as const),
                Effect.catch((cause) =>
                  Effect.succeed(isReason(cause, "NotFound") ? "gone" as const : "unreadable" as const)
                )
              )
              if (beat === "own") {
                const timestamp = new Date(yield* Clock.currentTimeMillis)
                yield* Effect.ignore(guarded(fs.utimes(lockPath, timestamp, timestamp)))
                continue
              }
              // A read the host refused for any other reason is no evidence
              // either way, so this beat is skipped and the next one retries.
              // Ending the heartbeat on it would retire a lock this call
              // still holds: the file goes stale within the minute, another
              // process reaps it, and this holder keeps working unfenced.
              if (beat === "unreadable") continue
              // `gone` and `foreign` are the two states worth an operator
              // signal: this call's lock was reaped, and possibly already
              // replaced, while the effect it fences is still running, so
              // the rest of that effect proceeds unfenced against every other
              // process. The heartbeat is the only party that ever observes
              // it — the protected effect is not interrupted and the caller
              // is not failed — so retiring the fiber silently would leave no
              // trace at all.
              yield* Effect.logWarning(
                `${label} was reclaimed while its holder was still running`,
                { ...options.annotations, state: beat }
              )
              return
            }
          })
        )
        return yield* effect
      }))),
      Effect.onExit(() => acquired ? release : Effect.void)
    )
  })

/**
 * Runs `effect` while holding the lease at `lockPath`.
 *
 * Acquisition fails with `failure(TimeoutError)` once `acquireWithin` passes
 * without the lease; every other host refusal reaches `failure` with the
 * refusing `PlatformError`. The deadline ends when the lease is held: the
 * protected effect and its release are never timed out.
 *
 * @category combinators
 * @since 1.0.0-rc.1
 */
export const withLease = <A, E, R, E2>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  effect: Effect.Effect<A, E, R>,
  failure: (cause: unknown) => E2,
  options: Options = {}
): Effect.Effect<A, E | E2, R> =>
  Effect.suspend(() => {
    const ready = Deferred.makeUnsafe<void>()
    const deadline = Deferred.await(ready).pipe(
      Effect.timeout(options.acquireWithin ?? defaultAcquireWithin),
      Effect.catchTag("TimeoutError", (cause) => Effect.fail(failure(cause))),
      Effect.andThen(Effect.never)
    )
    return hold(fs, lockPath, effect, failure, {
      ...options,
      onAcquired: Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
    }).pipe(Effect.raceFirst(deadline))
  })
