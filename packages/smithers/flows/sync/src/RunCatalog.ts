/**
 * Workspace run enumeration for synchronization.
 *
 * @since 0.1.0
 */

import type { JournalEvent } from "@smthrs/journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { positiveInt } from "./internal/PolicyOptions.ts"
import type { SyncError } from "./SyncError.ts"

/**
 * Workspace run enumeration operations.
 *
 * `list` is the AUTHORITATIVE run set and `changes` is only a low-latency
 * wake: a subscriber that misses an announcement re-lists rather than losing
 * state, and a subscriber whose covered set must stay accurate re-lists on a
 * cadence of its own. Every implementation returns a fresh array from `list`,
 * so a caller may retain and sort what it receives without disturbing another
 * reader.
 *
 * `list` names each run AT MOST ONCE. Every implementation here deduplicates,
 * and `SyncServer` deduplicates again at the seam rather than trusting a
 * host's catalog, because both fan-out paths key a run's served position by
 * run id: a run named twice is read twice from the same position and its
 * entries are served twice.
 *
 * The catalog is supplied by the host rather than derived from the journal:
 * `@smthrs/journal` has no workspace-wide list or watch contract, and
 * `@smthrs/engine-store` owns the durable run set that {@link makePolling}
 * reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly list: Effect.Effect<ReadonlyArray<JournalEvent.RunId>>
  readonly changes: Stream.Stream<JournalEvent.RunId>
}

/**
 * Host-provided workspace run catalog.
 *
 * @category services
 * @since 0.1.0
 */
export class RunCatalog extends Context.Service<RunCatalog, Service>()("@smthrs/sync/RunCatalog") {}

/**
 * Provides an immutable run catalog.
 *
 * `list` answers with a fresh array each time, matching {@link makeMemory} and
 * {@link makePolling}. Handing every caller the same instance let one reader
 * sort or splice the catalog in place for every other reader, which is a
 * defect a `ReadonlyArray` type hides from TypeScript and not from JavaScript.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStatic = (
  ids: ReadonlyArray<JournalEvent.RunId>
): Layer.Layer<RunCatalog> => {
  const known = Array.from(new Set(ids))
  return Layer.succeed(
    RunCatalog,
    RunCatalog.of({
      list: Effect.sync(() => [...known]),
      changes: Stream.empty
    })
  )
}

/**
 * Announcements a stalled {@link Service.changes} subscriber may fall behind
 * by before the oldest are dropped.
 *
 * `changes` is a notification feed, not a log: a follower reads it to learn
 * that the workspace gained a run and then reads the run itself. Retaining an
 * unbounded backlog for a subscriber that has stopped pulling — a disconnected
 * tab whose socket has not timed out yet, a follower blocked behind a slow
 * consumer — is therefore pure cost, and the workspace's whole run history is
 * the upper bound on it. A subscriber that falls further behind than this
 * bound loses the oldest announcements; `list` still names every run, so a
 * follower that reconnects or re-lists converges.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultChangesCapacity = 1024

/**
 * Options for the in-memory run catalog.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryOptions {
  /**
   * Announcements a stalled subscriber may fall behind by. Defaults to
   * {@link defaultChangesCapacity}.
   */
  readonly changesCapacity?: number | undefined
}

/**
 * Constructs a mutable in-memory run catalog.
 *
 * A run is published exactly once, when it is first registered. The
 * announcement feed slides: registering never waits on a stalled subscriber,
 * and never grows the process on its behalf.
 *
 * Fails with `invalid_request` when `changesCapacity` is not a positive safe
 * integer, rather than handing it to `PubSub.sliding` as a capacity.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (options: MemoryOptions = {}): Effect.Effect<{
  readonly catalog: Service
  readonly register: (runId: JournalEvent.RunId) => Effect.Effect<void>
}, SyncError> =>
  Effect.gen(function*() {
    const known = new Set<JournalEvent.RunId>()
    const changes = yield* PubSub.sliding<JournalEvent.RunId>(
      yield* positiveInt("RunCatalog.MemoryOptions.changesCapacity", options.changesCapacity, defaultChangesCapacity)
    )
    return {
      catalog: RunCatalog.of({
        list: Effect.sync(() => Array.from(known)).pipe(Effect.withSpan("RunCatalog.list")),
        changes: Stream.fromPubSub(changes)
      }),
      register: Effect.fn("RunCatalog.register")((runId) =>
        Effect.suspend(() => {
          if (known.has(runId)) return Effect.void
          known.add(runId)
          return PubSub.publish(changes, runId).pipe(Effect.asVoid)
        })
      )
    }
  })

/**
 * How often {@link makePolling} re-reads its source when the caller names no
 * interval, in milliseconds.
 *
 * A workspace follower learns of a new run within one interval of it being
 * created, and the read costs one bounded query per interval per composition,
 * not per subscriber. A second is short enough that a run appears in a UI
 * while the operator is still looking at the command that started it, and
 * long enough that an idle workspace is close to free.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultPollIntervalMs = 1000

/**
 * Options for the polling run catalog.
 *
 * @category models
 * @since 0.1.0
 */
export interface PollingOptions<E, R> {
  /**
   * Reads the workspace's current run set. `@smthrs/engine-store` supplies
   * the durable one over `flows_runs`; anything that answers the same
   * question works, and the catalog holds no assumption about which.
   */
  readonly read: Effect.Effect<ReadonlyArray<JournalEvent.RunId>, E, R>
  /** Milliseconds between reads. Defaults to {@link defaultPollIntervalMs}. */
  readonly intervalMs?: number | undefined
  /**
   * Announcements a stalled subscriber may fall behind by. Defaults to
   * {@link defaultChangesCapacity}.
   */
  readonly changesCapacity?: number | undefined
}

/**
 * Constructs a run catalog that polls a durable source.
 *
 * Polling, not waking. rc.0 has no cross-process event delivery, so a
 * follower learns of a run another engine created by asking the workspace
 * again, and the interval is the whole of the policy.
 *
 * The catalog primes itself before it returns, so the first read a follower
 * makes is already current and a workspace that cannot be read at all fails
 * the composition instead of serving an empty run set. After that a failed
 * read is a warning and nothing else: the previous view stands, the interval
 * holds, and no subscription attached to the catalog is torn down for it.
 * The warning is written once per outage, with the first failure's cause, and
 * one info line marks the read that ends it; the polls in between are silent.
 *
 * A run is announced once, when it first appears. A run the read stops
 * naming, which is what retention collecting it looks like, leaves the view;
 * `list` is the workspace's run set, not a log of every run it ever had.
 *
 * `list` answers with a fresh array each time, matching {@link layerStatic} and
 * {@link makeMemory}. Handing back the stored snapshot let a caller sort or
 * splice the authoritative run set in place under the poll fiber that owns it,
 * which is a defect a `ReadonlyArray` type hides from TypeScript and not from
 * JavaScript.
 *
 * The poll fiber belongs to the caller's scope. Closing the scope stops it.
 *
 * Both numeric options are validated here, before the first read: an
 * `intervalMs` of `NaN` or zero reached `Effect.delay` as the whole of the
 * poll cadence, which is a loop with no interval rather than a refusal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makePolling = <E, R>(
  options: PollingOptions<E, R>
): Effect.Effect<Service, E | SyncError, R | Scope.Scope> =>
  Effect.gen(function*() {
    const intervalMs = yield* positiveInt(
      "RunCatalog.PollingOptions.intervalMs",
      options.intervalMs,
      defaultPollIntervalMs
    )
    const changes = yield* PubSub.sliding<JournalEvent.RunId>(
      yield* positiveInt("RunCatalog.PollingOptions.changesCapacity", options.changesCapacity, defaultChangesCapacity)
    )
    const snapshot = yield* Ref.make<ReadonlyArray<JournalEvent.RunId>>([])

    const refresh = Effect.gen(function*() {
      const read = yield* options.read
      const next = Array.from(new Set(read))
      const previous = new Set(yield* Ref.get(snapshot))
      yield* Ref.set(snapshot, next)
      for (const runId of next) {
        // Publishing never waits on a stalled subscriber, and never grows the
        // process on its behalf: the feed slides.
        if (!previous.has(runId)) yield* PubSub.publish(changes, runId)
      }
    })

    yield* refresh
    // The log follows the outage's transitions, not the poll cadence. With
    // the default interval a workspace that stays unreadable would otherwise
    // write one identical warning per second per catalog for as long as it
    // lasts, and the line that says it ended would never be written.
    const consecutiveFailures = yield* Ref.make(0)
    const poll = refresh.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.flatMap(Ref.updateAndGet(consecutiveFailures, (count) => count + 1), (count) =>
            count === 1
              ? Effect.logWarning("The workspace run catalog could not be read; the previous view stands", cause)
              : Effect.void),
        onSuccess: () =>
          Effect.flatMap(Ref.getAndSet(consecutiveFailures, 0), (count) =>
            count === 0
              ? Effect.void
              : Effect.logInfo(`The workspace run catalog is readable again after ${count} failed reads`))
      })
    )
    yield* poll.pipe(
      Effect.delay(intervalMs),
      Effect.forever,
      Effect.forkScoped
    )

    return RunCatalog.of({
      list: Effect.map(Ref.get(snapshot), (ids) => [...ids]).pipe(Effect.withSpan("RunCatalog.list")),
      changes: Stream.fromPubSub(changes)
    })
  })

/**
 * Provides a run catalog that polls a durable source. The poll fiber lives as
 * long as the layer's scope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPolling = <E, R>(
  options: PollingOptions<E, R>
): Layer.Layer<RunCatalog, E | SyncError, R> => Layer.effect(RunCatalog, makePolling(options))

/**
 * Provides the mutable in-memory run catalog, matching how every other
 * implementation here is provided. Fails with `invalid_request` when
 * `changesCapacity` is not a positive safe integer.
 *
 * The layer provides the catalog alone. A composition that also registers runs
 * builds {@link makeMemory} itself and keeps its `register`.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerMemory = (options: MemoryOptions = {}): Layer.Layer<RunCatalog, SyncError> =>
  Layer.effect(RunCatalog, Effect.map(makeMemory(options), ({ catalog }) => catalog))

/**
 * Provides an empty run catalog.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<RunCatalog> = layerStatic([])
