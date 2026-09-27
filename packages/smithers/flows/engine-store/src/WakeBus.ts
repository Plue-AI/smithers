/**
 * The in-process wake bus: durable writes that make a run runnable — a
 * deferred completed, a durable clock fired, an operator resume — announce
 * the run id here, and in-process waiters parked on that run resume
 * immediately instead of waiting out a poll tick.
 *
 * The bus is EDGE-TRIGGERED and MISS-TOLERANT by design. A wake published
 * while nobody waits is dropped, not queued: durable state already records
 * that the run is runnable, and the engine's suspension polling schedule
 * (`suspendedRetryPolicy`) remains the bounded fallback that re-drives any
 * run whose wake the bus missed. Temporal's scheduled task queue takes the
 * same position — `NotifyNewTasks` is a coalesced, non-blocking channel send
 * and `MaxPollInterval` bounds the polling fallback (`reference/temporal`
 * `service/history/queues/queue_scheduled.go`) — because a lossless bus
 * would have to be durable, and the durable record already exists. Waiter
 * registration follows opencode's in-process job registry: one `Deferred`
 * per waiter, succeeded on completion, removed when the waiter's own scope
 * closes (`reference/opencode` `packages/smithers/flows/core/src/background-job.ts`).
 *
 * Cross-process wakes never reach this bus: another process's deferred
 * completion is observed through the store, on the polling schedule and the
 * heartbeat sweeps. That split is deliberate v1 scope — an event-driven
 * cross-process wake needs a committed journal subscription, which is a
 * separate seam.
 *
 * The bus holds no host access at all — a `Map` of `Deferred`s — so it is
 * browser-safe without a platform layer.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Wake bus operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Announces that a durable write made the run runnable. Every waiter
   * currently parked on `executionId` resumes; with no waiters the wake is
   * dropped and the polling fallback covers the run.
   */
  readonly wake: (executionId: string) => Effect.Effect<void>
  /**
   * Parks until the next {@link wake} for `executionId`. Registration is
   * removed when the waiting fiber is interrupted — including scope closure
   * and losing a race against the polling sleep — so an abandoned wait
   * leaks nothing.
   *
   * The wait is keyed by execution id alone: execution ids are unique
   * across flows, so the flow tag adds no discrimination.
   */
  readonly awaitWake: (executionId: string) => Effect.Effect<void>
  /**
   * How many waiters are currently parked on `executionId`. This is
   * observability for tests and diagnostics, not a coordination primitive:
   * a count observed now says nothing about a moment later.
   */
  readonly waiters: (executionId: string) => Effect.Effect<number>
}

/**
 * Service tag for the in-process wake bus.
 *
 * @category services
 * @since 0.1.0
 */
export class WakeBus extends Context.Service<WakeBus, Service>()("@smthrs/engine-store/WakeBus") {}

/**
 * Constructs a wake bus. Registration and delivery are plain in-memory
 * operations on the constructing process; nothing is durable.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnsafe = (): Service => {
  const parked = new Map<string, Set<Deferred.Deferred<void>>>()
  return WakeBus.of({
    wake: (executionId) =>
      Effect.suspend(() => {
        const waiters = parked.get(executionId)
        if (waiters === undefined) return Effect.void
        // Snapshot before succeeding: each woken waiter's release removes it
        // from the live set, and delivery must not observe that mutation.
        return Effect.forEach(
          Array.from(waiters),
          (waiter) => Deferred.succeed(waiter, undefined),
          { discard: true }
        )
      }),
    awaitWake: (executionId) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const waiter = Deferred.makeUnsafe<void>()
          let waiters = parked.get(executionId)
          if (waiters === undefined) {
            waiters = new Set()
            parked.set(executionId, waiters)
          }
          waiters.add(waiter)
          return { waiter, waiters }
        }),
        ({ waiter }) => Deferred.await(waiter),
        // The registration's own set is closed over rather than re-fetched:
        // the map entry can only be deleted by the release that empties it,
        // so the set this waiter joined is the set it must leave.
        ({ waiter, waiters }) =>
          Effect.sync(() => {
            waiters.delete(waiter)
            if (waiters.size === 0) parked.delete(executionId)
          })
      ),
    waiters: (executionId) => Effect.sync(() => parked.get(executionId)?.size ?? 0)
  })
}

/**
 * Constructs a wake bus effectfully. Prefer this in compositions;
 * {@link makeUnsafe} exists for construction outside a fiber.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service> = Effect.sync(makeUnsafe)

/**
 * A bus that never delivers: wakes are dropped and waiters park forever.
 * With it in place every resume travels the polling fallback — which is
 * exactly what a test asserting the fallback provides it for.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides?: Partial<Service>): Service =>
  WakeBus.of({
    wake: () => Effect.void,
    awaitWake: () => Effect.never,
    waiters: () => Effect.succeed(0),
    ...overrides
  })

/**
 * Provides a fresh wake bus. An engine composition resolves the bus
 * optionally, so providing this layer is how a host shares one bus between
 * the engine and its own wake sources; a composition given none builds a
 * private bus.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<WakeBus> = Layer.sync(WakeBus)(makeUnsafe)

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides?: Partial<Service>): Layer.Layer<WakeBus> =>
  Layer.sync(WakeBus)(() => makeNoop(overrides))
