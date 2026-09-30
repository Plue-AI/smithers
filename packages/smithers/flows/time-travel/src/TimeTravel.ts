/**
 * The one door into time travel: replay, inspect, fork, rewind.
 *
 * `Replay`, `Fork`, `Rewind`, `Recovery`, `Compensation`, and the
 * effect-handler registry are machinery under `src/internal/`; a caller never
 * names them. This service fronts the verbs of
 * `docs/concepts/frames-and-lineage.md` and owns the wiring they used to make
 * the caller thread: the ownership claim a rewind rides, the jj workspace a
 * fork lands in, the compensation-handler registry, the cap on how much
 * history one read may materialize, and startup recovery of an interrupted
 * rewind or fork.
 *
 * Recovery is not an operation. {@link layer} finishes or rolls back every
 * pending rewind audit while it is being built, and forgets the jj lane of
 * every fork that reserved an id and never committed, so the service only
 * ever hands out a store whose interrupted work is already resolved. The one
 * thing it cannot resolve is an audit whose run another live process still
 * holds: that one is declined and left pending for a later build, rather than
 * closed on the strength of a race. {@link Options.isAlive} decides what
 * "still live" means.
 *
 * The tag key `@smthrs/time-travel/TimeTravel` is durable identity: step keys
 * digest the resolved service set, so renaming it invalidates recorded runs.
 *
 * @since 0.1.0
 */

import { Jj } from "@smthrs/jj"
import type * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Journal from "@smthrs/journal/Journal"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import type * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { CompensationHandlers } from "./CompensationHandlers.ts"
import { Frame } from "./Frame.ts"
import * as Compensation from "./internal/Compensation.ts"
import * as EffectHandlerRegistry from "./internal/EffectHandlerRegistry.ts"
import * as ForkOperation from "./internal/Fork.ts"
import * as HistoryLimit from "./internal/HistoryLimit.ts"
import * as Recovery from "./internal/Recovery.ts"
import * as Replay from "./internal/Replay.ts"
import * as Rewind from "./internal/Rewind.ts"
import * as SnapshotProjector from "./internal/SnapshotProjector.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
import { StepOverride, TimeTravelStore } from "./TimeTravelStore.ts"

/**
 * Where in history an operation acts: a run, and a frame inside it.
 *
 * A frame is only an address — the `(lineageId, seq)` journal position — never
 * a snapshot. Every operation derives state by replaying the prefix.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Position = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame
})
/**
 * The value form of {@link Position}.
 *
 * @since 0.1.0
 * @category models
 */
export type Position = typeof Position.Type

/**
 * A pure fold over durable journal evidence, handed to {@link Service.replay}
 * and {@link Service.inspect}.
 *
 * @since 0.1.0
 * @category models
 */
export type Projection<S> = Replay.Projection<S>

/**
 * How a replay reads.
 *
 * `pageSize` is a throughput knob only and never changes the derived state.
 * `maxHistoryEntries` caps the journal entries the fold reads at or below the
 * frame for this one call, overriding {@link Options.maxHistoryEntries}; a
 * replay that would read past it fails `limit_exceeded` and folds nothing
 * further.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReplayOptions {
  readonly pageSize?: number | undefined
  readonly maxHistoryEntries?: number | undefined
  /** Expected lineage coordinates and source allowlist for engine v2 history. */
  readonly engineEvents?: EngineEvent.Consumer | undefined
}

/**
 * The cap on journal entries one operation reads when neither the service
 * nor the call names one.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultMaxHistoryEntries: number = HistoryLimit.defaultMaxHistoryEntries

/**
 * The successful shape of {@link Service.fork}: the child run, its lineage
 * edge back to the parent frame, and everything the boundary assessment
 * disclosed. A non-empty `warnings` is a successful fork, not a refused one.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkResult = ForkOperation.Result

/**
 * The successful shape of {@link Service.rewind}: the audit row, the archived
 * suffix, and everything the boundary disclosed.
 *
 * @since 0.1.0
 * @category models
 */
export type RewindResult = Rewind.Result

/**
 * How a fork chooses its workspace, and how much history it may assess.
 *
 * The workspace name is derived from the child run id the fork mints, never
 * supplied; `workspaceRoot` only moves which lane that derived name lands in,
 * and defaults to `.flows/forks`. `maxHistoryEntries` caps the suffix the
 * fork assesses for this one call, overriding {@link Options.maxHistoryEntries}.
 * `pageSize` pages that suffix read exactly as it pages a replay or a rewind.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly workspaceRoot?: string | undefined
  readonly pageSize?: number | undefined
  readonly maxHistoryEntries?: number | undefined
  /** Keep the child workspace registered after this service scope closes. */
  readonly retainWorkspace?: boolean | undefined
  /**
   * Replace one step's recorded result on the child. The child replays every
   * step up to the frame, that step with `result`, and runs everything after
   * the frame again. The step must have succeeded at or before the frame.
   */
  readonly override?: StepOverride | undefined
}

/**
 * Stable workspace name derived from a fork's durable child identity.
 * @since 1.0.0
 * @category constructors
 */
export const forkWorkspaceName = ForkOperation.workspaceNameFor

/**
 * How a rewind treats what it crosses, and how much of it it may cross.
 *
 * `detachedChildren` defaults to `"block"`: a live detached child refuses the
 * rewind rather than being cancelled behind the operator's back.
 * `maxHistoryEntries` caps the suffix the rewind may truncate for this one
 * call, overriding {@link Options.maxHistoryEntries}; a longer suffix is
 * refused `limit_exceeded` before the run is claimed.
 *
 * @since 0.1.0
 * @category models
 */
export interface RewindOptions {
  readonly detachedChildren?: "block" | "cancel" | undefined
  readonly pageSize?: number | undefined
  readonly maxHistoryEntries?: number | undefined
  /**
   * Restore the whole repository to the jj operation the frame recorded,
   * rather than only the working-copy tree. Bookmark moves, rebases,
   * `describe`, and `abandon` after the frame are undone with it. A frame
   * with no recorded operation refuses with `irreversible`.
   */
  readonly wholeRepo?: boolean | undefined
}

/**
 * Replay, inspect, fork, and rewind over a journal.
 *
 * `replay` and `inspect` are one fold: `replay` takes the read knobs and
 * `inspect` is the same fold under the service defaults, kept so a caller
 * that never tunes a read has a shorter door. Both fold committed evidence
 * only and dispatch nothing. `inspect` takes no options, so versioned engine
 * history needs `replay` with {@link ReplayOptions.engineEvents}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly replay: <S>(
    position: Position,
    projection: Projection<S>,
    options?: ReplayOptions
  ) => Effect.Effect<S, TimeTravelError>
  readonly inspect: <S>(
    position: Position,
    projection: Projection<S>
  ) => Effect.Effect<S, TimeTravelError>
  readonly fork: (
    position: Position,
    options?: ForkOptions
  ) => Effect.Effect<ForkResult, TimeTravelError>
  readonly rewind: (
    position: Position,
    options?: RewindOptions
  ) => Effect.Effect<RewindResult, TimeTravelError>
}

/**
 * History reads that cannot recover, fork, rewind, or otherwise write a run.
 *
 * @since 1.0.0
 * @category services
 */
export class ReadOnlyTimeTravel extends Context.Service<ReadOnlyTimeTravel, Pick<Service, "replay" | "inspect">>()(
  "@smthrs/time-travel/ReadOnlyTimeTravel"
) {}

/** Decode caller coordinates before reading history or starting a mutation. */
const validatePosition = (position: Position) =>
  Schema.decodeUnknownEffect(Position)(position).pipe(
    Effect.mapError((cause) => error("invalid", "invalid history position", cause))
  )

/**
 * Refuses a journal page size before a verb reads anything: a safe integer
 * from 1 through `Journal.maxEntriesLimit`, or absent for the default.
 */
const validatePageSize = (verb: string, pageSize: number | undefined): Effect.Effect<void, TimeTravelError> => {
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1)) {
    return Effect.fail(error("invalid", `${verb} pageSize must be a positive integer, not ${String(pageSize)}`))
  }
  if (pageSize !== undefined && pageSize > Journal.maxEntriesLimit) {
    return Effect.fail(
      error("invalid", `${verb} pageSize must be at most ${Journal.maxEntriesLimit}, not ${String(pageSize)}`)
    )
  }
  return Effect.void
}

/** The shared fold and input contract behind both history-reading layers. */
const replayWith =
  (historyLimit: number) => <S>(position: Position, projection: Projection<S>, options?: ReplayOptions) =>
    Effect.gen(function*() {
      const decoded = yield* validatePosition(position)
      yield* Effect.annotateCurrentSpan({
        runId: decoded.runId,
        lineageId: decoded.frame.lineageId,
        seq: decoded.frame.seq
      })
      const pageSize = options?.pageSize
      yield* validatePageSize("replay", pageSize)
      const maxEntries = yield* HistoryLimit.resolve(options?.maxHistoryEntries, historyLimit)
      return yield* Replay.rederive(decoded.frame, projection, {
        runId: decoded.runId,
        engineEvents: options?.engineEvents,
        ...(pageSize === undefined ? {} : { pageSize }),
        maxEntries
      })
    })

/**
 * Composes history reads without startup recovery or mutation dependencies.
 * A viewer can provide a read-only database connection underneath this layer.
 *
 * @since 1.0.0
 * @category layers
 */
export const readOnly: Layer.Layer<
  ReadOnlyTimeTravel,
  never,
  Journal.Journal | CacheStore.CacheStore
> = Layer.effect(ReadOnlyTimeTravel)(Effect.gen(function*() {
  const services = yield* Effect.context<Journal.Journal | CacheStore.CacheStore>()
  const rederive = replayWith(defaultMaxHistoryEntries)
  const replay = <S>(position: Position, projection: Projection<S>, options?: ReplayOptions) =>
    rederive(position, projection, options).pipe(Effect.provideContext(services))
  return { replay, inspect: <S>(position: Position, projection: Projection<S>) => replay(position, projection) }
}))

/**
 * The injectable contracts the three operations read and write through.
 *
 * The store is the only time-travel-specific one; the rest are the journal,
 * run, cache, and jj services the engine already provides.
 */
type Requirements =
  | CacheStore.CacheStore
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore

/** The default lane a derived fork workspace lands in. */
const workspaceRoot = ".flows/forks"

/**
 * Mints the ownership identity every rewind and every recovery rides.
 *
 * Browser-safe on purpose: `Clock` and `Random` are services, so this never
 * reaches for `process.pid` or `node:crypto` the way an engine incarnation
 * does.
 *
 * `hostId` is per-incarnation rather than a constant `"time-travel"`, and
 * `pid` is 0 because there is no process behind this identity. Ownership
 * doctrine lets a liveness probe inspect a local PID only when two owners
 * share a `hostId` (`@smthrs/run-store`'s `Ownership.LivenessProbe`); a shared
 * constant would make two services on two machines look same-host and invite a
 * probe of PID 0. Two incarnations never claim the same host.
 */
const mintOwner: Effect.Effect<OwnerId> = Effect.gen(function*() {
  const nowMs = yield* Clock.currentTimeMillis
  const entropy = yield* Random.nextIntBetween(0, 0x7fffffff)
  const incarnation = `${nowMs}:${entropy}`
  return { hostId: `time-travel:${incarnation}`, pid: 0, nonce: `time-travel:${incarnation}` }
})

/**
 * What a rewind rate limiter answers: whether one more rewind may start, and
 * an optional `detail` the audit row records in place of the default
 * `{ allowed, checkedAtMs }`.
 *
 * @since 0.1.0
 * @category models
 */
export type RateLimitDecision = Rewind.RateLimitDecision

/**
 * How the service is composed.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /**
   * Deadline per handler revert/rollback and jj compensation call. Defaults to
   * three minutes. Must be finite and positive. Timeout failures carry
   * `compensation_failed` with the cause.
   */
  readonly compensationTimeout?: Duration.Input | undefined
  /**
   * Deadline for startup recovery of every pending audit together. One audit
   * may spend a compensation deadline on its jj restore and another on each
   * handler rollback, so this is a separate budget. Defaults to ten
   * compensation deadlines (thirty minutes by default). Must be finite and
   * positive. A timeout fails the build with `compensation_failed`.
   */
  readonly recoveryTimeout?: Duration.Input | undefined
  /**
   * Whether the owner recorded on a run is still working, asked before startup
   * recovery takes an interrupted rewind's run over or rewind cancels a running
   * detached child under `detachedChildren: "cancel"`.
   *
   * Defaults to `Ownership.leaseLiveness()`: an owner is alive while its
   * persisted heartbeat is younger than `Ownership.heartbeatStaleAfter`. That
   * is the same default the engine's own run driver applies to the same rows,
   * and it is the weakest honest answer every host can give. A deployment that
   * can say more supplies its own check and refuses the takeover for longer.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  /**
   * The most journal entries one replay, fork, or rewind may read: the prefix
   * a replay folds, or the suffix a fork or rewind assesses. An operation that
   * would read past it fails `limit_exceeded`, and a rewind does so before it
   * claims the run. Defaults to {@link defaultMaxHistoryEntries}; a call may
   * override it through its own options. Refused `invalid` at build unless it
   * is a positive integer.
   */
  readonly maxHistoryEntries?: number | undefined
  /**
   * Whether one more rewind of this run may start, asked once per rewind under
   * the claim and before the audit row is written, so the decision is durable
   * whichever way it goes. A decision that is not `allowed` fails the rewind
   * `rate_limited` before anything is compensated, archived, or truncated.
   *
   * Defaults to no limiter: every rewind is allowed, and the audit records
   * `{ allowed: true, checkedAtMs }`.
   */
  readonly rateLimit?:
    | ((input: {
      readonly runId: string
      readonly frame: Frame
      readonly nowMs: number
    }) => Effect.Effect<RateLimitDecision, TimeTravelError>)
    | undefined
}

/**
 * Turns a liveness check into the evidence recovery and child cancellation
 * hand `RunStore`.
 *
 * The kind is always `lease-expired`, and deliberately so. It is the only
 * host-neutral kind, and it is the one claim `RunStore.steal` re-verifies for
 * itself inside the same write (`heartbeat_at_ms < nowMs - staleAfter`), so a
 * supplied check can only ever REFUSE a takeover here, never widen one. The
 * two pid-shaped kinds would be a lie anyway: {@link mintOwner} gives every
 * incarnation its own `hostId`, so no two time-travel owners ever look
 * same-host, and `pid` is 0 because no process stands behind the identity.
 *
 * A `running` row that records no owner yields no evidence: there is nothing
 * to be alive or dead, and `steal` refuses such a snapshot regardless.
 */
const recoveryEvidence = (isAlive: Ownership.LivenessCheck) =>
(
  row: RunStore.RunRow,
  claimant: OwnerId,
  nowMs: number
): Effect.Effect<Ownership.LivenessEvidence | undefined> => {
  const expectedOwner = row.owner
  if (expectedOwner === null) return Effect.succeed(undefined)
  return Effect.map(
    isAlive(expectedOwner, { claimant, heartbeatAtMs: row.heartbeatAtMs, nowMs }),
    (alive) => alive ? undefined : { expectedOwner, checkedAtMs: nowMs, kind: "lease-expired" as const }
  )
}

/**
 * Builds the service over the ambient contracts under an explicit policy,
 * recovering first.
 *
 * The scope this is built in owns every fork workspace the service adds: a
 * fork lane is forgotten when the service is released, not when the call that
 * created it returns.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeWith = (
  options: Options = {}
): Effect.Effect<Service, TimeTravelError, Requirements | Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const compensationTimeout = yield* Effect.try({
      try: () => Duration.fromInputUnsafe(options.compensationTimeout ?? Compensation.defaultTimeout),
      catch: (cause) => error("invalid", "compensationTimeout must be a finite positive duration", cause)
    })
    if (!Duration.isFinite(compensationTimeout) || Duration.toMillis(compensationTimeout) <= 0) {
      return yield* Effect.fail(error("invalid", "compensationTimeout must be a finite positive duration"))
    }
    const recoveryTimeout = yield* Effect.try({
      try: () =>
        options.recoveryTimeout === undefined
          ? Duration.times(compensationTimeout, 10)
          : Duration.fromInputUnsafe(options.recoveryTimeout),
      catch: (cause) => error("invalid", "recoveryTimeout must be a finite positive duration", cause)
    })
    if (!Duration.isFinite(recoveryTimeout) || Duration.toMillis(recoveryTimeout) <= 0) {
      return yield* Effect.fail(error("invalid", "recoveryTimeout must be a finite positive duration"))
    }
    const services = yield* Effect.context<Requirements>()
    const historyLimit = yield* HistoryLimit.resolve(options.maxHistoryEntries, HistoryLimit.defaultMaxHistoryEntries)
    const owner = yield* mintOwner
    const liveness = recoveryEvidence(options.isAlive ?? Ownership.leaseLiveness())
    const rateLimit = options.rateLimit
    // The contribution door (see `CompensationHandlers`): handlers come from the composition that owns the effect boundary, and the
    // registry itself stays internal. Absent service means no handlers, which is
    // the pre-existing behaviour: every crossed irreversible effect blocks.
    // The contributed handler IS the registered handler. This used to copy
    // every declared member across into a second registry-only shape, and a
    // member dropped from that copy — the descriptor, say — silently widened
    // resolution to kind alone, which is exactly the drift the descriptor
    // exists to refuse. One shape cannot drop anything.
    const contributed = yield* Effect.serviceOption(CompensationHandlers)
    const registry = yield* EffectHandlerRegistry.make(Option.getOrElse(contributed, () => []))

    const provided = <A>(
      effect: Effect.Effect<
        A,
        TimeTravelError,
        Requirements | EffectHandlerRegistry.EffectHandlerRegistry | Scope.Scope
      >
    ): Effect.Effect<A, TimeTravelError> =>
      effect.pipe(
        Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
        Effect.provideService(Scope.Scope, scope),
        Effect.provideContext(services)
      )

    // Recovery is wiring, never an operation: a rewind interrupted by a crash is
    // finished or rolled back before this service accepts new work. An audit
    // whose run is still held elsewhere is declined rather than closed, so it
    // survives for the next build to pick up.
    const recovery = yield* Effect.forkChild(
      Effect.interruptible(provided(Recovery.recover({
        owner,
        compensationTimeout,
        livenessEvidence: (_audit, row, claimant, nowMs) => liveness(row, claimant, nowMs)
      }))),
      { startImmediately: true }
    )
    const outcomes = yield* Fiber.join(recovery).pipe(
      Effect.timeout(recoveryTimeout),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(error("compensation_failed", "startup recovery exceeded its deadline", cause))),
      Effect.onError(() =>
        Fiber.interrupt(recovery)
      )
    )
    // A `Failed` outcome closes an audit terminally. Discarding the array made
    // that invisible to the composition, so an operator learned about a rewind
    // recovery could not finish only by reading the audit table by hand.
    yield* Effect.forEach(
      outcomes.filter((outcome) => outcome._tag === "Failed"),
      (outcome) =>
        Effect.logError("time-travel: startup recovery closed an audit as failed").pipe(
          Effect.annotateLogs({
            auditId: outcome.auditId,
            code: outcome.error.code,
            reason: outcome.error.message
          })
        ),
      { discard: true }
    )

    /**
     * Forgets the jj lanes of forks that never committed.
     *
     * A fork reserves its child id, provisions the lane, then commits; a
     * process that dies between the last two steps leaves a registered lane
     * behind and a reservation every later mint has already counted past. The
     * reservation is what says which lanes are abandoned, and the staleness
     * window is what keeps a fork still in flight elsewhere out of the sweep.
     * A lane that cannot be forgotten is reported and left: its name is never
     * handed out again, so it blocks nothing.
     */
    const reclaimForkLanes = Effect.gen(function*() {
      const store = yield* TimeTravelStore
      const jj = yield* Jj
      const nowMs = yield* Clock.currentTimeMillis
      const abandoned = yield* store.abandonForkIntents(
        nowMs - Duration.toMillis(ForkOperation.intentStaleAfter)
      )
      yield* Effect.forEach(
        abandoned,
        (intent) => {
          const workspaceName = ForkOperation.workspaceNameFor(intent.childRunId)
          return jj.workspaceForget(workspaceName).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("time-travel: could not forget an abandoned fork workspace", cause).pipe(
                Effect.annotateLogs({ childRunId: intent.childRunId, workspaceName })
              )
            )
          )
        },
        { discard: true }
      )
    })
    yield* provided(reclaimForkLanes)

    /**
     * Folds the run's journal into its frame anchors before a verb reads them.
     *
     * The projector resumes from the anchors already recorded and stops at the
     * verb's frame, so the read is the unanchored entries at or below the frame
     * and nothing else; `maxEntries` caps it like every other read.
     *
     * BEST EFFORT on purpose. The anchor table is a cache of facts the journal
     * already holds, so a journal that cannot project — a composition wired
     * without the projection channel, a partial test double — must not turn a
     * fork or a rewind into a failure. What it does instead is leave the anchors
     * as they were, and the verbs already say what that costs: a fork with no
     * anchor at the frame reports a warning naming the workspace it could not
     * restore, and a rewind restores no pointer rather than a wrong one.
     */
    const refreshAnchors = (runId: string, upTo: number, maxEntries: number) =>
      SnapshotProjector.project(runId, { upTo, maxEntries }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("time-travel: could not refresh frame anchors", cause).pipe(
            Effect.annotateLogs({ runId })
          )
        )
      )

    const replay = replayWith(historyLimit)
    const rederive = <S>(position: Position, projection: Projection<S>, options?: ReplayOptions) =>
      provided(replay(position, projection, options))

    return {
      replay: <S>(position: Position, projection: Projection<S>, options?: ReplayOptions) =>
        Effect.fn("TimeTravel.replay")(() => rederive(position, projection, options))(),
      inspect: <S>(position: Position, projection: Projection<S>) =>
        Effect.fn("TimeTravel.inspect")(() => rederive(position, projection, undefined))(),
      fork: (position, options) =>
        Effect.fn("TimeTravel.fork")(function*() {
          const decoded = yield* validatePosition(position)
          yield* Effect.annotateCurrentSpan({
            runId: decoded.runId,
            lineageId: decoded.frame.lineageId,
            seq: decoded.frame.seq
          })
          yield* validatePageSize("fork", options?.pageSize)
          // Decoded before anything durable, like the page size: an untyped
          // caller's malformed override refuses rather than editing nothing.
          const override = options?.override === undefined ? undefined : yield* Schema.decodeUnknownEffect(
            StepOverride
          )(options.override).pipe(
            Effect.mapError((cause) =>
              error("invalid", "fork override must name a step key digest and a JSON result", cause)
            )
          )
          const maxEntries = yield* HistoryLimit.resolve(options?.maxHistoryEntries, historyLimit)
          return yield* provided(
            // The anchors a fork restores from are a projection of the engine's
            // own records, folded on demand: an ordinary engine run writes
            // journal rows, never this package's tables.
            ForkOperation.fork({
              parentRunId: decoded.runId,
              frame: decoded.frame,
              workspaceRoot: options?.workspaceRoot ?? workspaceRoot,
              retainWorkspace: options?.retainWorkspace,
              override,
              pageSize: options?.pageSize,
              maxEntries,
              refreshAnchors: refreshAnchors(decoded.runId, decoded.frame.seq, maxEntries)
            })
          )
        })(),
      rewind: (position, options) =>
        Effect.fn("TimeTravel.rewind")(function*() {
          const decoded = yield* validatePosition(position)
          yield* Effect.annotateCurrentSpan({
            runId: decoded.runId,
            lineageId: decoded.frame.lineageId,
            seq: decoded.frame.seq
          })
          const maxEntries = yield* HistoryLimit.resolve(options?.maxHistoryEntries, historyLimit)
          return yield* provided(
            // The validation phase runs before anything durable: a refused page
            // size, a history past the cap, or a frame that is not on this run's
            // lineage leaves no claim, no audit row, and no refreshed anchor
            // behind.
            Schema.decodeUnknownEffect(Rewind.DetachedChildPolicy)(
              options?.detachedChildren ?? "block"
            ).pipe(
              // The policy is decoded before anything durable happens. An
              // untyped caller writing "blcok" used to select the DESTRUCTIVE
              // branch, because the assessment treated every value other than
              // the literal "block" as cancel.
              Effect.mapError(() =>
                error(
                  "invalid",
                  `detachedChildren must be "block" or "cancel", not ${JSON.stringify(options?.detachedChildren)}`
                )
              ),
              Effect.flatMap((detachedChildPolicy) =>
                Rewind.validate({
                  runId: decoded.runId,
                  frame: decoded.frame,
                  maxEntries,
                  ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize })
                }).pipe(
                  Effect.flatMap((expectedTail) =>
                    refreshAnchors(decoded.runId, decoded.frame.seq, maxEntries).pipe(
                      Effect.andThen(Rewind.rewind({
                        runId: decoded.runId,
                        frame: decoded.frame,
                        owner,
                        compensationTimeout,
                        detachedChildPolicy,
                        ...(options?.wholeRepo === true ? { wholeRepo: true } : {}),
                        childLivenessEvidence: (_childRunId, row, claimant, nowMs) => liveness(row, claimant, nowMs),
                        maxEntries,
                        // The tail validation observed, re-checked under the
                        // claim: nothing else binds the refusal to the
                        // truncation it was asked about.
                        expectedTail,
                        ...(rateLimit === undefined ? {} : { rateLimit }),
                        ...(options?.pageSize === undefined ? {} : { pageSize: options.pageSize })
                      }))
                    )
                  )
                )
              )
            )
          )
        })()
    }
  })

/**
 * Builds the service over the ambient contracts under the default policy,
 * recovering first.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, TimeTravelError, Requirements | Scope.Scope> = makeWith()

/**
 * The one injectable time-travel surface.
 *
 * The frame's lineage comes from `FlowEngine.Lineage`, the one place a journal
 * lineage id is minted. It is a versioned encoding rather than a path, so a
 * hand-spelled address names no record and `rewind` refuses it as `not_found`.
 *
 * ```ts
 * import { Engine, TimeTravel } from "@smthrs/flows"
 * import * as Effect from "effect/Effect"
 *
 * const program = Effect.gen(function*() {
 *   const timeTravel = yield* TimeTravel
 *   const lineageId = Engine.FlowEngine.Lineage.root("ledger-1")
 *   return yield* timeTravel.rewind({ runId: "ledger-1", frame: { lineageId, seq: 2 } })
 * })
 * ```
 *
 * @since 0.1.0
 * @category services
 */
export class TimeTravel extends Context.Service<TimeTravel, Service>()(
  "@smthrs/time-travel/TimeTravel"
) {
  /** History reads without constructing recovery or mutation services. */
  static readonly readOnly = readOnly
  /**
   * Wires the machinery over the injectable contracts and recovers on build.
   *
   * Carried as a static so the umbrella barrel can export the service key
   * itself — `yield* Flows.TimeTravel` — without losing the way to provide it.
   *
   * @since 0.1.0
   * @category layers
   */
  static readonly layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = Layer.effect(TimeTravel)(make)

  /**
   * The same wiring under an explicit policy. {@link Options} carries the
   * knobs: `isAlive` decides what startup recovery is allowed to conclude
   * about a run an interrupted rewind left `running`, `maxHistoryEntries` is
   * the default read cap every verb applies, `rateLimit` gates each rewind,
   * and `compensationTimeout` bounds each compensation handler.
   *
   * @since 0.1.0
   * @category layers
   */
  static readonly layerWith = (
    options: Options
  ): Layer.Layer<TimeTravel, TimeTravelError, Requirements> => Layer.effect(TimeTravel)(makeWith(options))
}

/**
 * Wires the machinery over the injectable contracts and recovers on build.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<TimeTravel, TimeTravelError, Requirements> = TimeTravel.layer

/**
 * Wires the machinery under an explicit policy and recovers on build.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (
  options: Options
): Layer.Layer<TimeTravel, TimeTravelError, Requirements> => TimeTravel.layerWith(options)
