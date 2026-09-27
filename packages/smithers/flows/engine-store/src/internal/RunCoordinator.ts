/**
 * Coordinates keyed drain executions.
 *
 * Adapted nearly verbatim from
 * `reference/opencode/packages/smithers/flows/core/src/session/run-coordinator.ts`:
 * `Deferred` joins, `FiberSet` ownership, coalesced wakes, and
 * `uninterruptibleMask` preserve its start-or-join semantics. This adaptation
 * drops the source's `force` drain argument because no engine-store drain has
 * a second execution mode; the successor flag carries coordinator scheduling.
 *
 * @since 0.1.0
 */
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, type Scope } from "effect"

/**
 * Serializes drain execution for each key while allowing distinct keys to run
 * concurrently.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunCoordinator<Key, E> {
  /**
   * Snapshots keys with an execution owned by this coordinator.
   *
   * @since 0.1.0
   * @category operations
   */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /**
   * Starts a drain while idle or joins the active drain for the key.
   *
   * @since 0.1.0
   * @category operations
   */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /**
   * Joins the active drain for the key, and starts none while idle.
   *
   * @since 1.0.0
   * @category operations
   */
  readonly join: (key: Key) => Effect.Effect<void, E>
  /**
   * Ensures one coalesced drain follows the active drain for the key.
   *
   * @since 0.1.0
   * @category operations
   */
  readonly wake: (key: Key) => Effect.Effect<void>
  /**
   * Interrupts the active drain for the key and waits for its cleanup.
   *
   * @since 0.1.0
   * @category operations
   */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /** Sends interruption without awaiting cleanup; safe for a short commit publication. */
  readonly requestInterrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

/**
 * Creates a scoped coordinator for keyed drain effects.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <Key, E, R>(options: {
  readonly drain: (key: Key) => Effect.Effect<void, E, R>
}): Effect.Effect<RunCoordinator<Key, E>, never, Scope.Scope | R> =>
  Effect.gen(function*() {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<R, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false
    })

    const start = (key: Key, entry: Entry<E>, successor = false): void => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key))),
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning(`engine-store: coordinated drain failed for ${String(key)}`, cause)
          ),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid
        )
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>): void => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          /* v8 ignore next -- stopping is a cooperative-scheduler handoff covered by the cleanup race test */
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next)
        return restore(Deferred.await(next.done))
      })

    const join = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        return entry === undefined ? Effect.void : Deferred.await(entry.done)
      })

    const wake = (key: Key): Effect.Effect<void> =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    const requestInterrupt = (key: Key): Effect.Effect<void> =>
      Effect.withFiber((fiber) =>
        Effect.sync(() => {
          const entry = active.get(key)
          if (entry?.owner === undefined) return
          entry.stopping = true
          entry.pendingWake = false
          entry.owner.interruptUnsafe(fiber.id)
        })
      )

    return {
      active: Effect.fn("RunCoordinator.active")(() => Effect.sync(() => new Set(active.keys())))(),
      run: Effect.fn("RunCoordinator.run")(run),
      join: Effect.fn("RunCoordinator.join")(join),
      wake: Effect.fn("RunCoordinator.wake")(wake),
      interrupt: Effect.fn("RunCoordinator.interrupt")(interrupt),
      requestInterrupt: Effect.fn("RunCoordinator.requestInterrupt")(requestInterrupt)
    }
  })
