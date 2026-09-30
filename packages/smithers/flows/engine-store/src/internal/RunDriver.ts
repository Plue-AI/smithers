/**
 * Claim-gated durable flow run lifecycle.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as EngineStoreMetrics from "../EngineStoreMetrics.ts"
import { EventTypes } from "../EventTypes.ts"
import * as ExecutionFacts from "../ExecutionFacts.ts"
import { type OnParentExit, RunState } from "../RunState.ts"
import * as WakeBus from "../WakeBus.ts"
import * as ActionPersistence from "./ActionPersistence.ts"
import * as EffectRecords from "./EffectRecords.ts"
import * as ExitEncoding from "./ExitEncoding.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as RunCoordinator from "./RunCoordinator.ts"
import * as RunLifecycle from "./RunLifecycle.ts"
import * as StateTransaction from "./StateTransaction.ts"

const RunStateJson = Schema.fromJsonString(RunState)

/**
 * Re-channels every typed reason of a cause as a defect, identity intact.
 *
 * A boundary whose declared error type cannot describe what happened has two
 * honest options: widen the type, or stop calling the failure typed. Casting
 * the cause is the third, dishonest one — it left a raw `DatabaseError`
 * escaping an `Effect<void, CancelRequestFailed>`. Demotion keeps the error
 * object, every other reason and every interruption, and no caller can
 * mistake the result for a failure its handler declared.
 */
const asDefects = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  Cause.fromReasons(
    cause.reasons.map((reason) =>
      Cause.isFailReason(reason)
        ? Cause.makeDieReason(reason.error).annotate(Cause.reasonAnnotations(reason))
        : reason
    )
  )

/**
 * Raised when a flow (directly or through mutual ancestry) attempts to
 * execute an execution id that already appears in its own persisted
 * `parentExecutionId` chain.
 *
 * Detection walks the already-persisted parent chain from the requesting
 * parent upward — an O(depth) check, not a dependency-graph DFS — because
 * `parentExecutionId` is the only edge our runtime model can express.
 *
 * The class is declared by `@smthrs/flow` (it is part of the `execute`
 * contract) and re-exported here for the detector's callers.
 *
 * @since 0.1.0
 * @category errors
 */
export const FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * The value form of {@link FlowCycleDetected}.
 *
 * @since 0.1.0
 * @category errors
 */
export type FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * Why the engine itself asked a parked execution to resume.
 *
 * The operator's own resume is absent on purpose: it is the one wake a host
 * has already claimed before the engine hears about it.
 *
 * @since 0.1.0
 * @category models
 */
export type RequestedResumeReason = "deferred" | "clock" | "parent"

/**
 * Dependencies for the run driver.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  /**
   * Liveness arbitration before a steal, consulted only for a run whose lease
   * has already expired. Optional: the default is
   * `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`, which has no
   * evidence beyond the lease and therefore reports the owner gone, so a
   * composition that supplies nothing still reclaims hard-killed runs.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that this driver has asked a
   * SUSPENDED execution to resume.
   *
   * Every wake the engine itself initiates passes through here: a durable
   * clock firing, a durable deferred completing (a signal, a queue offer, a
   * registration-time sweep of completions taken while the host was down),
   * and a child settling under a parent that parked on it. A host that guards
   * re-entry into a parked run — `AgentSession` refuses a round for a parked
   * control row that nobody asked for — otherwise cannot tell those from its
   * own heartbeat sweep, and a run that slept never settled.
   *
   * An operator resume is NOT recorded: `Control.resume` and
   * `ControlLive.decide` claim the control row themselves, and recording a
   * second request for the resume a host is already taking up would buy that
   * park a second re-drive.
   *
   * Optional. A composition with no such host leaves it undefined and the
   * wake is exactly what it was.
   */
  readonly requestResume?:
    | ((executionId: string, reason: RequestedResumeReason) => Effect.Effect<void>)
    | undefined
  readonly engine: Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
  /**
   * In-process wake bus announced to whenever a durable write makes a run
   * runnable — a scheduled resume (deferred, clock, operator) and a run
   * settling terminally. Optional so a direct construction without one keeps
   * the pre-existing polling-only behavior: the default drops every wake,
   * which the engine's suspension polling schedule already covers.
   */
  readonly wakeBus?: WakeBus.Service | undefined
  /**
   * Runs inside the uninterruptible finalizer that retains a suspended run's
   * flow scope, immediately after the entry is inserted and before the round's
   * settlement can start.
   *
   * Private to `packages/smithers/flows/engine-store/test`. That boundary is where a pending
   * interruption first becomes observable again, and no public seam reaches
   * it, so the regression proving the retention is released there — rather
   * than stranded until the driver's own scope closes — raises the
   * interruption from here. This module is not exported from the package
   * (`"./internal/*": null`), and production compositions leave the hook
   * undefined, which costs one `undefined` check per suspension.
   */
  readonly unsafeOnScopeRetained?: ((runId: string) => Effect.Effect<void>) | undefined
}

/**
 * Claim-gated operations composed into the encoded flow engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly register: FlowEngine.Encoded["register"]
  /**
   * The encoded `execute`, widened for direct driver callers: an absent
   * `round` admits the execution as round zero of its own lineage. Nested
   * direct callers observe its latest round; encoded callers read one round.
   * To decode a terminal result, direct nested callers must register the
   * terminal flow's codec in this driver, even if another worker ran it.
   * A missing codec is a wiring defect, as with the typed Trampoline; it
   * fails fast rather than suspending terminal work with no future wake.
   */
  readonly execute: <const Discard extends boolean>(
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
      readonly round?: Parameters<FlowEngine.Encoded["execute"]>[1]["round"] | undefined
      readonly follow?: boolean | undefined
    }
  ) => Effect.Effect<Discard extends true ? void : Flow.Result<unknown, unknown>, FlowCycleDetected>
  readonly poll: FlowEngine.Encoded["poll"]
  readonly interrupt: FlowEngine.Encoded["interrupt"]
  readonly interruptUnsafe: FlowEngine.Encoded["interruptUnsafe"]
  readonly resume: FlowEngine.Encoded["resume"]
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: "deferred" | "clock" | "parent" | "operator",
    sourceId?: string | undefined
  ) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<string>>
  /**
   * The runs whose parked flow scope this driver still holds. Cancellation
   * and re-drive both release; the set is the leak assertion's observation
   * point.
   */
  readonly retainedRuns: Effect.Effect<ReadonlySet<string>>
}

interface Registration {
  readonly flow: Flow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
}

/**
 * The effect kind a detached child spawn is journaled under, and therefore the
 * kind an engine composition registers a spawn-compensation handler for.
 *
 * @since 0.1.0
 * @category constants
 */
export const spawnEffectKind = EventTypes.childSpawnKind

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Compares encoded JSON payloads structurally. Object key order is not part
 * of JSON identity, while array order and array length are.
 *
 * Values outside JSON compare unequal unless both arguments are the same
 * reference.
 *
 * @since 1.0.0
 * @category guards
 * @private
 */
export const samePayload = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left === "number" && typeof right === "number") {
    return left === 0 && right === 0
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!samePayload(left[index], right[index])) return false
    }
    return true
  }
  if (Array.isArray(right) || !isPlainObject(left) || !isPlainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !samePayload(left[key], right[key])) return false
  }
  return true
}

/**
 * Sentinel produced when the cancel-request poll observes a durable
 * cancellation before the flow settles.
 */
const cancelRequested = { _tag: "CancelRequested" } as const

/**
 * How many stale-running rows one heartbeat tick may wake (issue #79).
 * Oldest heartbeats surface first, so a backlog larger than the batch
 * drains across ticks; each successful steal removes the row from the
 * stale window, and losing drivers see a shrinking batch next tick.
 */
const staleRunningSweepBatch = 64

/**
 * How long a run waits before its live owner is probed again, and how far
 * that wait doubles.
 *
 * A refusal is evidence: the recorded owner answered, so the one thing the
 * sweep knows is that re-asking immediately is waste. Without a wait the
 * oldest batch is re-probed every heartbeat forever and nothing behind it is
 * ever reached (issue #79 follow-up). The first wait is two ticks, which is
 * already enough for the batch to move on, and it doubles up to the lease
 * window: an owner that stops heartbeating is therefore re-probed within one
 * `heartbeatStaleAfter` of the last refusal, which is the same window every
 * other reclaim decision is made against.
 */
const stealRefusalBackoffFirst = Duration.times(Ownership.heartbeatInterval, 2)
const stealRefusalBackoffMax = Ownership.heartbeatStaleAfter

/**
 * A refusal this driver remembers: which lease it was refused against, when
 * the owner may be probed again, and how many consecutive refusals that
 * lease has produced (the backoff exponent).
 *
 * Keyed by run id and holding the heartbeat it was collected against, so an
 * owner that resumes heartbeating — a new lease — restarts the ladder rather
 * than inheriting a long wait from the stall that preceded it.
 */
interface StealRefusal {
  readonly heartbeatAtMs: number | null
  readonly nextProbeAtMs: number
  readonly attempt: number
}

/**
 * The type of {@link cancelRequested}: the settlement a round takes when the
 * cancel-request poll wins the race against the flow.
 */
type CancelRequested = typeof cancelRequested

const withoutResult = (state: RunState): RunState => {
  const { cancellation: _, result: __, ...rest } = state
  return rest
}

/**
 * Constructs a scoped run driver.
 *
 * Every start and wake enters the same keyed coordinator and then the same
 * exact-snapshot claim/activation path.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<
  Service,
  never,
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | DurableWriter
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const writer = yield* DurableWriter
    const store = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    const lifecycle = RunLifecycle.make(store, engineState)
    const wakeBus = dependencies.wakeBus ?? WakeBus.makeNoop()
    /**
     * The deployment's own liveness answer, if it gave one.
     *
     * Kept separate from {@link isAlive} because the two differ in what they
     * PROVE, and the journal says which was used: a supplied probe reports on
     * the process (or the host it lives on), while the default reports only
     * that the lease it stopped renewing has expired.
     */
    const suppliedIsAlive = dependencies.isAlive
    const isAlive: Ownership.LivenessCheck = suppliedIsAlive ??
      Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)
    /**
     * The evidence kind a steal admitted by {@link isAlive} carries.
     *
     * `steal` is only reached for a run whose lease has already expired, so
     * `lease-expired` is always true here; what the supplied-probe kinds add
     * is WHY the deployment believes the owner is gone, which is the
     * distinction `RunStore` binds to the host relation.
     */
    const livenessEvidenceKind = (
      expectedOwner: Ownership.OwnerId
    ): Ownership.LivenessEvidence["kind"] =>
      suppliedIsAlive === undefined
        ? "lease-expired"
        : Ownership.sameHostIncarnation(expectedOwner, dependencies.owner)
        ? "same-host-pid-dead"
        : "cross-host-unreachable-stale"
    /** Owner identity equality, the fence's own notion of "the same process". */
    const sameOwner = (left: Ownership.OwnerId, right: Ownership.OwnerId): boolean =>
      left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce
    const registrations = new Map<string, Registration>()
    /**
     * Runs already warned about waking without a registered flow (issue
     * #62): the sweep retries every heartbeat, so the warning is emitted
     * once per run, not once per tick. Cleared on every registration — a
     * newly registered flow makes previously dropped runs drivable again.
     */
    const warnedUnregistered = new Set<string>()
    /**
     * Runs whose owner answered a probe (or held a fresh lease) and are
     * therefore not worth re-arbitrating yet. See {@link StealRefusal}.
     *
     * Bounded by the stale set the sweep can see: every tick drops the entries
     * whose rows are no longer in the window it read, so a run that is stolen,
     * released, or settled takes its entry with it.
     */
    const stealRefusals = new Map<string, StealRefusal>()

    /**
     * Records that a run's recorded owner was found alive, and when it may be
     * asked about again.
     */
    const deferSteal = (
      runId: string,
      heartbeatAtMs: number | null,
      nowMs: number
    ): void => {
      const previous = stealRefusals.get(runId)
      // A moved lease is new evidence about a different state of the world, so
      // it starts the ladder over instead of inheriting the old wait.
      const attempt = previous !== undefined && previous.heartbeatAtMs === heartbeatAtMs ? previous.attempt + 1 : 1
      const waitMs = Math.min(
        Duration.toMillis(stealRefusalBackoffFirst) * Math.pow(2, attempt - 1),
        Duration.toMillis(stealRefusalBackoffMax)
      )
      stealRefusals.set(runId, { heartbeatAtMs, nextProbeAtMs: nowMs + waitMs, attempt })
    }

    /**
     * The journal address of one refusal.
     *
     * Refusals were emitted through the driver's default source id with no
     * `sourceSeq`, so nothing deduplicated them: a live owner cost one durable
     * journal row per refused run per heartbeat, indefinitely. Addressing the
     * record by the run, the owner, and the lease it was refused against makes
     * the journal's own first-writer admission the deduplication — the same
     * mechanism the registration-time wake records use — so a repeated refusal
     * about an unchanged lease says nothing twice.
     *
     * The evidence is part of the address because one lease can be refused for
     * two different reasons, and they are different records. A wake that
     * arrives while the owner is still pulsing is refused by the lease alone
     * (`lease-fresh`); the same owner, still alive but stalled past the
     * window, is refused by the probe (`probe`). Addressing both to one key
     * made the second write a different payload under the first one's address,
     * which the journal rejects as `idempotency_conflict` — a defect that
     * killed the drive fiber, dropped the probe refusal, and took down any
     * `execute` joined to that run. One address per (run, owner, lease,
     * evidence) keeps every reason sayable and still admits each of them once.
     *
     * That makes this driver's own payload a pure function of its address, so
     * it can no longer conflict with itself. It is not the only writer at
     * these addresses, and a conflict raised by another one is no longer fatal
     * either: refusals are emitted through {@link emitEvidence}.
     */
    const stealRefusedSourceId = (
      owner: Ownership.OwnerId,
      heartbeatAtMs: number | null,
      evidence: "lease-fresh" | "probe"
    ): string =>
      `${dependencies.journalSource}:steal-refused:${evidence}:${
        JSON.stringify([owner.hostId, owner.pid, owner.nonce])
      }:${heartbeatAtMs}`
    const liveInstances = new Map<string, FlowRuntime.FlowInstance["Service"]>()
    /**
     * Flow scopes retained past a round's settlement.
     *
     * `Flow.intoResult` closes the flow scope for every settlement EXCEPT a
     * suspension — a parked flow keeps its scope so the resources its body
     * acquired outlive the park (`packages/smithers/flows/flow/src/Flow/Runtime.ts`). Nothing
     * then owned that scope: the instance left `liveInstances` on the way out
     * and the `Scope.Closeable` became unreachable, so a cancelled parked flow
     * never ran its finalizers and every park leaked one scope for the
     * process's lifetime.
     *
     * The map is that owner. It holds at most one scope per run — an entry is
     * a state, not a queue — and every removal goes through
     * `releaseRetainedScope`, which deletes before it closes. That makes the
     * close idempotent by construction rather than by a flag: a second caller
     * finds no entry and does nothing, so concurrent cancel, resume, and
     * shutdown paths cannot double-finalize.
     */
    const retainedScopes = new Map<string, Scope.Closeable>()

    /**
     * Closes a run's retained flow scope exactly once, if it has one.
     *
     * `exit` decides what the finalizers see. A cancellation closes with an
     * interrupt exit so `Flow.withRollback` compensations run; a supersede
     * (the run re-entered execution under a fresh instance and scope) closes
     * with `Exit.void` so ordinary finalizers release resources while
     * rollbacks correctly stay out — a re-driven round is not an unsuccessful
     * exit.
     */
    const releaseRetainedScope = (
      runId: string,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const scope = retainedScopes.get(runId)
        if (scope === undefined) return Effect.void
        retainedScopes.delete(runId)
        return Scope.close(scope, exit).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `engine-store: finalizers of parked run ${runId} failed while closing its retained flow scope`,
              cause
            )
          )
        )
      })

    /**
     * Snapshots the runs whose flow scope this driver is currently holding.
     * Exposed for the leak assertions in `packages/smithers/flows/engine-store/test`, which
     * would otherwise have to reach into driver internals.
     */
    const retainedRuns = Effect.sync(() => new Set(retainedScopes.keys()))

    // Process shutdown must not strand parked scopes either: closing the
    // driver's own scope releases every scope still retained. `Exit.void`,
    // because a shutdown is a reclaimable release (issue #26) and not a
    // cancellation, so compensations must not fire.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(retainedScopes.keys()),
        (runId) => releaseRetainedScope(runId, Exit.void),
        { discard: true }
      )
    )
    const encodeState = (state: RunState): Effect.Effect<string> =>
      Schema.encodeEffect(RunStateJson)(state).pipe(Effect.orDie)

    const decodeState = (stateJson: string): Effect.Effect<RunState> =>
      Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(Effect.orDie)

    /**
     * Tells the host that this driver is asking a PARKED execution to resume.
     *
     * Only a parked one. A wake against a run that is still running is
     * already covered by the round it is in, and a request recorded for it
     * would be a delegation no park ever takes up: the host polls it for as
     * long as the run lives, and every poll pays a park wait for a run that
     * is not parked.
     *
     * See {@link Dependencies.requestResume} for which wakes reach here.
     */
    const recordResume = (
      executionId: string,
      parked: boolean,
      reason: RequestedResumeReason
    ): Effect.Effect<void> =>
      dependencies.requestResume === undefined || !parked
        ? Effect.void
        : dependencies.requestResume(executionId, reason)

    /**
     * {@link recordResume} for the parent a settling child is waking.
     *
     * The waiting row is the park: it is written in the same transaction as
     * the suspended transition and cleared by the claim that ends it, so a
     * parent that has one is parked and a parent mid-round has none. It is
     * read only for a host that records, so a composition without one pays
     * nothing per child settlement.
     */
    const recordParentResume = (parentExecutionId: string): Effect.Effect<void> =>
      dependencies.requestResume === undefined ? Effect.void : Effect.flatMap(
        engineState.waiting(parentExecutionId),
        (waiting) =>
          recordResume(
            parentExecutionId,
            Option.isSome(waiting) && waiting.value.reason !== "quarantine",
            "parent"
          )
      )

    /**
     * Run decisions are lifecycle records: they take the journal's durable
     * channel so a saturated lossy queue can never drop them (issue #10).
     * They stay ownerless because several decisions — `claim-lost`,
     * `steal-refused-owner-alive`, post-transition `transitioned` — are
     * legitimately recorded by a process that does not (or no longer does)
     * own the run; the ownership fence for these paths is the run-row CAS
     * that precedes each emit.
     *
     * `meta.lineageId` is a JOURNAL lineage id (`FlowEngine.Lineage`,
     * `<runId>/root`), because that is the space a time-travel frame addresses:
     * time travel (`packages/smithers/flows/time-travel/docs/README.md`) makes a frame `(lineageId, seq)`, and
     * replay skips an entry whose `meta.lineageId` names a different lineage.
     * The run row's `lineageId` column is a different space — the TRAMPOLINE
     * lineage of `packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`, round 0's execution
     * id.
     *
     * DECIDED (2026-08-12): decisions address the journal lineage of the run
     * that records them, one per round, the same lineage that run's attempt
     * and snapshot records already carry. Reading the run row's trampoline
     * lineage here put a run's decisions in a lineage its own attempts do not
     * address, so a rewind of that run skipped them. The trampoline lineage is
     * not lost: `created` and `handed-off` carry `lineageId` and
     * `roundOrdinal` in the decision payload, which is what walks a whole
     * trampoline chain.
     */
    const executionFacts = ExecutionFacts.make({
      runs: store,
      state: engineState,
      journal,
      sourceId: dependencies.journalSource
    })
    const requestCancellation = (runId: string, at: number) =>
      executionFacts.requestCancel(runId, at).pipe(
        Effect.catchIf(
          (error) => error._tag === "@smthrs/journal/JournalError" || error instanceof DatabaseError,
          Effect.die
        )
      )

    const decisionRecord = (runId: string, payload: unknown, sourceId: string) =>
      // Unfenced by design: a decision record commits in the SAME transaction
      // as the store-level owner CAS that is its fence (`transitionOwned`,
      // `activate`, `claim`/`steal` outcomes), and by then the run is often no
      // longer `running` under this owner, which is the exact predicate the
      // journal fence asserts. Several call sites (claim-lost,
      // steal-refused-owner-alive, activation-lost) also record decisions for
      // runs this driver never owned at all — first-writer-wins evidence,
      // which is what the unfenced channel exists for.
      JournalRecords.runDecision({
        runId,
        lineageId: FlowEngine.Lineage.root(runId),
        sourceId,
        ...(sourceId === dependencies.journalSource ? {} : { sourceSeq: 0 })
      }, payload)

    /**
     * Records a decision this driver's own write transaction is responsible
     * for: the `transitioned` record that commits with its run-row CAS, and
     * the `claimed-and-activated` / `stolen-and-activated` record that commits
     * with the activation CAS.
     *
     * These stay fatal. They take the driver's default source id, so the
     * journal allocates them a fresh `sourceSeq` and no address can collide;
     * a failure here is the storage layer failing under a transaction whose
     * other half is a run-row write, and the transaction has to take the
     * driver down with it rather than commit a terminal row whose decision
     * never reached the journal.
     */
    const emitDecision = (
      runId: string,
      payload: unknown,
      sourceId = dependencies.journalSource
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const decision = payload as Readonly<Record<string, unknown>>
        const authoritative = sourceId === dependencies.journalSource && decision.decision !== "wake-scheduled" &&
          decision.decision !== "child-policy-applied"
        const recorded = authoritative
          ? {
            ...decision,
            executionFact: yield* executionFacts.fact(runId, decision.decision === "created" ? "created" : "legacy")
          }
          : payload
        yield* journal.emitDurableUnfenced(decisionRecord(runId, recorded, sourceId))
      }).pipe(Effect.orDie)

    /**
     * Records evidence ABOUT a run this driver does not own, and never raises
     * on the drive fiber.
     *
     * `claim-lost`, `activation-lost` and `steal-refused-owner-alive` are the
     * three decisions taken about a run another process holds. They are
     * observations, not commitments: the arbitration they describe already
     * happened in the store, the caller has already lost, and the very next
     * thing every one of these call sites does is answer `false`. Routing them
     * through {@link emitDecision} put an audit write on the failure path of
     * the loop that drives every run in the process — an `idempotency_conflict`
     * on a shared refusal address killed the drive fiber, dropped the record
     * anyway, and took down any `execute` joined to that run.
     *
     * So the receipt is folded into a log, the shape `ActionPersistence`'s
     * `emitConverging` uses for the same reason on the replay branches:
     *
     * - `Accepted`: the observation is durable. Nothing to say.
     * - `Duplicate`: an identical observation is already durable — the
     *   per-heartbeat deduplication the refusal address exists for. Debug.
     * - `idempotency_conflict`: this address already holds a DIFFERENT
     *   observation, so someone (another process, an earlier evidence shape,
     *   a copied journal after a time-travel fork) said something else about
     *   the same (run, owner, lease, evidence). The durable record wins and
     *   the divergence is worth a warning, but it is still only evidence.
     *
     * Any other journal failure is folded the same way and for the same
     * reason: an audit record must never be the thing that stops a driver
     * from driving. A journal that is genuinely broken still fails the very
     * next decision write that IS a fence, which is where it belongs.
     */
    const emitEvidence = (
      runId: string,
      payload: unknown,
      sourceId = dependencies.journalSource
    ): Effect.Effect<void> =>
      journal.emitDurableUnfenced(decisionRecord(runId, payload, sourceId)).pipe(
        Effect.flatMap((receipt) =>
          receipt._tag === "Duplicate"
            ? Effect.logDebug(
              `engine-store: run ${runId} already recorded this evidence`,
              { runId, sourceId, seq: receipt.seq }
            )
            : Effect.void
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            `engine-store: evidence about run ${runId} was not admitted to the journal (${error.code}); the run is unaffected`,
            { runId, sourceId, code: error.code, payload }
          )
        )
      )

    /**
     * The package's ordered state-and-journal boundary: engine state first,
     * the journal's write transaction inside it. See
     * {@link StateTransaction.make} for the order and what it guarantees.
     */
    const transactState = StateTransaction.make(engineState, journal)

    /**
     * Commits a run-row transition and the decision describing it in ONE write
     * transaction, reporting the store outcome.
     *
     * `RunStore` and the journal write through the same `DurableWriter`, so the CAS
     * becomes a savepoint of this transaction: a crash can no longer leave a
     * terminal run row whose `transitioned` decision never reached the
     * journal, nor a decision for a CAS that lost. Temporal commits mutable
     * state and its history events as one persistence request
     * (`reference/temporal/service/history/workflow/transaction_impl.go`);
     * this is the same unit of work for a run transition.
     *
     * The decision is emitted only for a `Transitioned` outcome: a lost CAS
     * changed nothing, and its `claim-lost`/`activation-lost` records are
     * emitted by the caller, outside the transaction, so they survive.
     *
     * `waiting` parks before the CAS releases ownership, inside this same
     * transaction. A refused park or transition FAILS the transaction, so SQL
     * rolls back and the memory state's serialized snapshot is restored too.
     * Only outside both boundaries is the refusal returned as an outcome.
     * No former owner reads or clears a replacement's waiting marker.
     *
     * `afterTransitioned` is the seam for work that must commit WITH the
     * transition or not at all: today, ending the run's linked children on a
     * terminal exit. It runs only after a successful CAS, so a lost fence
     * touches nothing, and inside the transaction, so a crash between the two
     * writes rolls both back.
     */
    const transitionAndRecord = (
      runId: string,
      toStatus: RunStore.RunStatus,
      stateJson: string,
      decision: unknown,
      guard?: RunStore.TransitionGuard | undefined,
      afterTransitioned?: Effect.Effect<void> | undefined,
      waiting?: DurableEngineState.Waiting | null | undefined
    ): Effect.Effect<RunStore.TransitionOutcome> =>
      transactState(
        Effect.gen(function*() {
          if (waiting !== undefined && waiting !== null) {
            const parked = yield* engineState.park(runId, waiting, dependencies.owner)
            if (parked._tag === "NotFound") {
              return yield* Effect.fail({ _tag: "TransitionRefused" as const, outcome: parked })
            }
          }
          const transitioned = yield* store.transitionOwned(
            runId,
            dependencies.owner,
            toStatus,
            stateJson,
            guard
          ).pipe(Effect.orDie)
          if (transitioned._tag !== "Transitioned") {
            return yield* Effect.fail({ _tag: "TransitionRefused" as const, outcome: transitioned })
          }
          if (waiting === null) yield* engineState.wake(runId)
          if (afterTransitioned !== undefined) yield* afterTransitioned
          // Every terminal round closes its own deadlines, including a
          // handoff whose successor and linked children continue separately.
          if (toStatus === "completed" || toStatus === "failed") {
            yield* engineState.completeRunClocks(
              runId,
              yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
            )
          }
          // The decision carries the state it committed, so run state at a
          // frame is DERIVED by replaying decisions rather than read off the
          // run row's current `state_json`
          // (Temporal's
          // `ndc/state_rebuilder.go` is the model). Without it a fork at an
          // early frame silently inherited the parent's *latest* state.
          yield* emitDecision(runId, { ...(decision as object), state: JSON.parse(stateJson) })
          return transitioned
        })
      ).pipe(
        Effect.catchTag("TransitionRefused", ({ outcome }) => Effect.succeed(outcome)),
        Effect.orDie
      )

    const abandon = (runId: string, claimedAtMs: number): Effect.Effect<void> =>
      store.abandonClaim(runId, dependencies.owner, claimedAtMs).pipe(
        Effect.asVoid,
        Effect.orDie
      )

    const claimAndActivate: (row: RunStore.RunRow) => Effect.Effect<boolean> = Effect.fn(
      "RunDriver.claimAndActivate"
    )(function*(row: RunStore.RunRow) {
      return yield* Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ runId: row.runId, status: row.status })
        if (dependencies.canExecute !== undefined && !(yield* dependencies.canExecute(row))) return false
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
          yield* Effect.annotateCurrentSpan({ outcome: "terminal" })
          yield* Metric.update(EngineStoreMetrics.claim.Terminal, 1)
          return false
        }

        // Every drive, including a fresh execute or a queued wake, must
        // preserve quarantine. Cancellation still claims the row to close it.
        if (row.cancelRequestedAtMs === null) {
          const waiting = yield* engineState.waiting(row.runId)
          if (Option.isSome(waiting) && waiting.value.reason === "quarantine") return false
        }

        const expected = snapshot(row)
        const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        let claim: RunStore.StealOutcome
        let stealEvidenceKind: Ownership.LivenessEvidence["kind"] | undefined
        let recoveredClaim: { readonly claimant: Ownership.OwnerId; readonly claimedAtMs: number } | undefined

        if (row.status === "running") {
          if (
            row.owner === null ||
            row.heartbeatAtMs === null ||
            row.heartbeatAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)
          ) {
            // The lease is the refusal, and no probe is consulted for it: a
            // probe may be a remote call, and a fresh heartbeat already
            // answers the question. It is journaled anyway — but only when
            // another owner holds the run, because refusing to steal from
            // ourselves is routine re-entry rather than arbitration — so an
            // operator whose `resume` did nothing can see that a live owner
            // was in the way (issue #53 follow-up).
            if (row.owner !== null && !sameOwner(row.owner, dependencies.owner)) {
              deferSteal(row.runId, row.heartbeatAtMs, nowMs)
              yield* emitEvidence(row.runId, {
                decision: "steal-refused-owner-alive",
                evidence: "lease-fresh",
                expectedOwner: row.owner,
                heartbeatAtMs: row.heartbeatAtMs
              }, stealRefusedSourceId(row.owner, row.heartbeatAtMs, "lease-fresh"))
            }
            yield* Effect.annotateCurrentSpan({ outcome: "heartbeat_fresh" })
            yield* Metric.update(EngineStoreMetrics.claim.HeartbeatFresh, 1)
            return false
          }
          if (yield* isAlive(row.owner, { claimant: dependencies.owner, heartbeatAtMs: row.heartbeatAtMs, nowMs })) {
            deferSteal(row.runId, row.heartbeatAtMs, nowMs)
            yield* emitEvidence(row.runId, {
              decision: "steal-refused-owner-alive",
              // Always a supplied probe. The default check is the lease, and
              // the lease already refused above for every row that could still
              // be fresh, so reaching this arm means the deployment answered
              // for the owner with something the store cannot see.
              evidence: "probe",
              expectedOwner: row.owner,
              heartbeatAtMs: row.heartbeatAtMs
            }, stealRefusedSourceId(row.owner, row.heartbeatAtMs, "probe"))
            yield* Effect.annotateCurrentSpan({ outcome: "steal_refused_owner_alive" })
            yield* Metric.update(EngineStoreMetrics.claim.StealRefusedOwnerAlive, 1)
            yield* Effect.logDebug("run steal refused, recorded owner is alive", {
              runId: row.runId,
              heartbeatAtMs: row.heartbeatAtMs
            })
            return false
          }
          stealEvidenceKind = livenessEvidenceKind(row.owner)
          claim = yield* store.steal(
            row.runId,
            expected,
            dependencies.owner,
            nowMs,
            {
              expectedOwner: row.owner,
              checkedAtMs: nowMs,
              kind: stealEvidenceKind
            }
          ).pipe(Effect.orDie)
        } else {
          // A process that died between `claim` and `activate` leaves its
          // claim on a parked or pending row, and every later claim loses to
          // it: the run could never be driven again. A claim older than the
          // lease whose claimant is gone is released first, by the same
          // liveness rule a steal applies to a running owner.
          if (
            row.claim !== null && row.claimedAtMs !== null && !sameOwner(row.claim, dependencies.owner) &&
            row.claimedAtMs < nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter) &&
            !(yield* isAlive(row.claim, { claimant: dependencies.owner, heartbeatAtMs: row.claimedAtMs, nowMs }))
          ) {
            const recovered = yield* store.recoverClaim(
              row.runId,
              row.claim,
              row.claimedAtMs,
              dependencies.owner,
              nowMs,
              { expectedOwner: row.claim, checkedAtMs: nowMs, kind: livenessEvidenceKind(row.claim) }
            ).pipe(Effect.orDie)
            if (recovered._tag === "Recovered") {
              recoveredClaim = { claimant: row.claim, claimedAtMs: row.claimedAtMs }
            }
          }
          claim = yield* store.claim(
            row.runId,
            expected,
            dependencies.owner,
            nowMs
          ).pipe(Effect.orDie)
        }

        if (claim._tag !== "Claimed") {
          yield* emitEvidence(row.runId, {
            decision: "claim-lost",
            outcome: claim._tag,
            expected
          })
          yield* Effect.annotateCurrentSpan({ outcome: "claim_lost" })
          yield* Metric.update(EngineStoreMetrics.claim.ClaimLost, 1)
          yield* Effect.logDebug("run claim lost", { runId: row.runId, outcome: claim._tag })
          return false
        }

        // The activation CAS and the decision recording it commit together:
        // a crash between them left a run durably running under this owner
        // with no journal entry saying who took it.
        const activation = yield* transactState(
          Effect.gen(function*() {
            // Another owner can quarantine and return to the same suspended
            // snapshot between preflight and claim. Fence that park in the
            // activation transaction too; the rejected claim is abandoned below.
            if (row.cancelRequestedAtMs === null) {
              const waiting = yield* engineState.waiting(row.runId)
              if (Option.isSome(waiting) && waiting.value.reason === "quarantine") {
                return { _tag: "SnapshotChanged" as const }
              }
            }
            const activation = yield* store.activate(
              row.runId,
              dependencies.owner,
              claim.claimedAtMs,
              expected
            ).pipe(Effect.orDie)
            if (activation._tag !== "Activated") return activation
            yield* emitDecision(row.runId, {
              decision: row.status === "running" ? "stolen-and-activated" : "claimed-and-activated",
              previousStatus: row.status,
              owner: dependencies.owner,
              // What admitted the takeover, so an operator reading the journal
              // can tell a lease that simply expired from a probe that
              // positively reported the owner gone.
              ...(stealEvidenceKind === undefined ? {} : { evidence: stealEvidenceKind }),
              ...(recoveredClaim === undefined ? {} : { recoveredClaim })
            })
            return activation
          })
        ).pipe(Effect.orDie)
        if (activation._tag !== "Activated") {
          yield* abandon(row.runId, claim.claimedAtMs)
          yield* emitEvidence(row.runId, {
            decision: "activation-lost",
            outcome: activation._tag,
            expected
          })
          yield* Effect.annotateCurrentSpan({ outcome: "activation_lost" })
          yield* Metric.update(EngineStoreMetrics.claim.ActivationLost, 1)
          yield* Effect.logDebug("run activation lost", { runId: row.runId, outcome: activation._tag })
          return false
        }
        yield* Effect.annotateCurrentSpan({ outcome: "activated" })
        yield* Metric.update(EngineStoreMetrics.claim.Activated, 1)
        // The run is this driver's now, so whatever it was told about the
        // previous owner is spent.
        stealRefusals.delete(row.runId)
        return true
      })
    })

    /**
     * Collects other rounds and transitive descendants of the logical run.
     *
     * Round membership and the edge table represent the logical job that every
     * owner process and every restart can see (issues #40/#41), which is
     * exactly why the cascade reads it instead of an in-process instance map:
     * a cross-process cancellation is observed by a driver that never spawned
     * the children and holds no `FlowInstance` for any of them.
     *
     * Deduplicated by run id, so the diamond the edge set permits is visited
     * once and a (rejected, but defensively handled) cycle terminates. Work and
     * memory are bounded by the finite durable edge set; there is deliberately
     * no arbitrary fan-out cap, because truncating a wide generation would
     * leave linked children uncancelled forever.
     */
    const descendantsOf = lifecycle.descendants

    /**
     * Records a durable cancellation request against every linked descendant
     * of a cancelled run.
     *
     * `requestCancel` is unfenced and first-writer-wins, so this is idempotent
     * by construction: re-running the cascade — a re-drive, a second operator
     * cancel, a child that also cascades from its own cancellation — writes
     * nothing the second time and answers `AlreadyRequested`. A row that no
     * longer exists answers `NotFound`, which is equally fine.
     *
     * `cancelOwned` calls it inside the same transaction as the parent's
     * terminal `cancelled` transition, so a crash cannot commit a cancelled
     * parent whose children were never asked to stop.
     *
     * Both callers record the run's OWN cancellation BEFORE this walk —
     * `interrupt` writes the request, `cancelOwned` commits the terminal
     * `cancelled` transition — and that order is load-bearing rather than
     * incidental. A late admission inherits by reading the parent row after it
     * has created the child row (`inheritParentCancellation`), so a walk that
     * ran before the parent was marked could miss an edge whose admission also
     * missed the mark. Both the SQL engine state and
     * `DurableEngineState.makeMemory` serialize their transactions. The memory
     * implementation snapshots and restores its maps on failure; the shared
     * writer transaction supplies the run-store write boundary. The ordering
     * also lets a child admitted within the cascade inherit cancellation.
     */
    const requestCancelDescendants = (
      runId: string,
      nowMs: number
    ): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
      Effect.gen(function*() {
        const descendants = yield* descendantsOf(runId)
        yield* Effect.forEach(
          descendants,
          (childId) => requestCancellation(childId, nowMs),
          { discard: true }
        )
        return descendants
      })

    /** The exit policy a child recorded for itself when it was spawned. */
    const exitPolicyOf = (row: RunStore.RunRow): Effect.Effect<OnParentExit> =>
      decodeState(row.stateJson).pipe(
        // A row written before the policy existed, or created outside
        // `ensureRun` (a seeded edge, an external admission), names none. It
        // is a LINKED child either way, and the contract for a linked child is
        // that it ends with the run it belongs to; `detach` is the deliberate
        // exception and has to be recorded to hold.
        Effect.map((state) => state.onParentExit ?? "cancel")
      )

    /**
     * Applies the per-child exit policy when a run ends on its own terms.
     *
     * Cancellation is not this path. A cancelled run cascades to every linked
     * descendant unconditionally (`requestCancelDescendants`): an operator who
     * cancels a run is asking for the subtree to stop, and a child cannot opt
     * out of that. What this closes is the other half — a parent that
     * COMPLETED or FAILED used to leave every linked child running, so a
     * `.child()` boundary whose parent died on an unrelated branch left a
     * durable orphan nothing would ever wait for or cancel.
     *
     * Three shapes are left alone, and each for its own reason:
     *
     * - A child that recorded `detach` was spawned fire-and-forget. Outliving
     *   the parent is the whole point, so it is reported, not touched, and its
     *   own subtree is not walked — those runs hang off a run that is still
     *   going.
     * - A child that already settled has nothing to cancel, and it applied
     *   this same policy to its own children when it settled.
     * - A child whose row is gone leaves only an edge.
     *
     * The requests are written by the caller's transaction — the parent's
     * terminal compare-and-swap — so a crash cannot commit a completed parent
     * whose children were never asked to stop.
     */
    const endLinkedChildren = (
      runId: string,
      nowMs: number
    ): Effect.Effect<
      {
        readonly cancelled: ReadonlyArray<string>
        readonly detached: ReadonlyArray<string>
      },
      RunStore.RunStoreError
    > =>
      Effect.gen(function*() {
        const roots = (yield* lifecycle.rounds(runId)).map((row) => row.runId)
        const seen = new Set<string>(roots)
        const cancelled: Array<string> = []
        const detached: Array<string> = []
        let frontier: ReadonlyArray<string> = roots
        while (frontier.length > 0) {
          const next: Array<string> = []
          for (const parentId of frontier) {
            for (const edge of yield* engineState.runChildren(parentId)) {
              if (seen.has(edge.childId)) continue
              const rounds = yield* lifecycle.rounds(edge.childId)
              for (const round of rounds) seen.add(round.runId)
              seen.add(edge.childId)
              const row = rounds.find((round) =>
                round.status !== "completed" && round.status !== "failed" && round.status !== "cancelled"
              )
              if (row === undefined) continue
              // The edge belongs to the creating round. Its ownership policy
              // survives the child's handoffs; do not infer it from a later
              // round written by a version that omitted onParentExit.
              // A nonempty lineage read includes its requested member.
              if ((yield* exitPolicyOf(rounds.find((round) => round.runId === edge.childId)!)) === "detach") {
                detached.push(edge.childId)
                continue
              }
              for (const round of rounds) {
                if (round.status !== "completed" && round.status !== "failed" && round.status !== "cancelled") {
                  cancelled.push(round.runId)
                }
                next.push(round.runId)
              }
            }
          }
          frontier = next
        }
        yield* Effect.forEach(
          cancelled,
          (childId) => requestCancellation(childId, nowMs),
          { discard: true }
        )
        return { cancelled, detached }
      })

    /**
     * The effect a terminal transition runs inside its own transaction to end
     * the children it is responsible for, journaling what it decided.
     *
     * The record is emitted only when there was a linked child to decide
     * about, so an ordinary childless run adds nothing to its journal.
     */
    const applyChildExitPolicy = (runId: string): Effect.Effect<void> =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        const outcome = yield* endLinkedChildren(runId, nowMs).pipe(Effect.orDie)
        if (outcome.cancelled.length === 0 && outcome.detached.length === 0) return
        yield* emitDecision(runId, {
          decision: "child-policy-applied",
          appliedAtMs: nowMs,
          cancelled: outcome.cancelled,
          detached: outcome.detached
        })
      })

    /**
     * Carries a parent's durable cancellation onto a child that was linked
     * AFTER the parent's cascade had already run.
     *
     * Admission and cancellation are two separate serialized write
     * transactions over the same store, so they interleave in both orders and
     * neither order may leak a live child (issue #83):
     *
     * - Admission first. The edge is committed before the cancellation
     *   transaction opens, so `requestCancelDescendants` sees the child and
     *   requests it. Nothing more is needed here.
     * - Cancellation first. The cascade walked `flows_run_parents` while the
     *   edge did not exist yet, so it could not have seen this child — and
     *   the parent's drive may already be gone, so nothing will walk the
     *   edge table again on its behalf. The child would be created fresh and
     *   uncancelled, and would run to completion under a cancelled parent.
     *
     * The second order is closed by reading the parent row inside the SAME
     * outer storage transaction that recorded the edge and created the child
     * row, after the child row exists. Either the cancellation transaction
     * committed before this read, in which case the request is visible here
     * and is inherited atomically with the child's own creation, or it has
     * not committed yet, in which case it commits after this transaction and
     * its own cascade sees the edge. There is no third interleaving, so no
     * ephemeral hand-off flag and no timing-based retry is involved. The
     * argument rests on the store's serialized writes and the order inside
     * `requestCancelDescendants`: a cancellation marks its own run before it
     * walks the edge table. Memory durable-state transactions also serialize
     * access and restore their snapshots on failure; they do not provide
     * persistence across process crashes.
     *
     * Nesting falls out of this: the inherited request is written to the
     * child's own row, so a grandchild admitted later reads a cancel-requested
     * parent and inherits in turn.
     *
     * `requestCancel` is unfenced and first-writer-wins, so a repeated
     * admission writes nothing the second time; a parent row that is gone,
     * or one with no rounds at all, inherits nothing. Both ways a parent can
     * exit are inherited here, and they differ in whether the child's own
     * `onParentExit` can spare it. An explicit cancellation in ANY round is
     * inherited unconditionally, whether it is a pending
     * `cancel_requested_at_ms` or a round already settled terminally
     * `cancelled` whose request column a compaction could have cleared. A
     * parent that instead stopped normally, with EVERY round `completed` or
     * `failed`, cancels a late child that was admitted attached and leaves an
     * `onParentExit === "detach"` child to outlive it.
     *
     * The child does not need its own cascade here: it was just created, so
     * it has no descendants of its own, and once it observes the inherited
     * request `cancelOwned` cascades from it like any other cancellation.
     */
    const inheritParentCancellation = (
      parentId: string,
      childId: string
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const rounds = yield* lifecycle.rounds(parentId).pipe(Effect.orDie)
        if (rounds.length === 0) return
        const cancelled = rounds.find((round) => round.cancelRequestedAtMs !== null || round.status === "cancelled")
        if (cancelled !== undefined) {
          // The parent's own request timestamp, so the inherited request reads
          // as the same operator intent rather than as a later, independent one.
          const nowMs = cancelled.cancelRequestedAtMs ?? (yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor)))
          yield* requestCancellation(childId, nowMs).pipe(Effect.orDie)
          return
        }
        // The same interleaving, for the other way a parent stops: a parent
        // that had already COMPLETED or FAILED ran `applyChildExitPolicy`
        // before this edge existed, so its walk could not have seen this
        // child and nothing will walk again on its behalf. The child applies
        // its own recorded policy here instead, in the transaction that made
        // it a child, so an attached child admitted a moment too late cannot
        // run on under a parent that is already gone.
        if (rounds.some((round) => round.status !== "completed" && round.status !== "failed")) return
        // Admission reads the child's recorded policy in this transaction.
        // A later caller awaiting a detached execution cannot change the
        // policy chosen by its original spawn.
        if ((yield* exitPolicyOf(yield* store.get(childId).pipe(Effect.orDie))) === "detach") return
        yield* requestCancellation(childId, yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))).pipe(
          Effect.orDie
        )
      })

    const cancelOwned = (
      runId: string,
      state: RunState
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const interruptedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        const stateJson = yield* encodeState({
          ...withoutResult(state),
          cancellation: { interruptedAtMs }
        })
        let cascaded: ReadonlyArray<string> = []
        let settled = false
        yield* transactState(
          Effect.gen(function*() {
            yield* store.acknowledgeCancel(runId, dependencies.owner, interruptedAtMs).pipe(Effect.orDie)
            const transitioned = yield* store.transitionOwned(
              runId,
              dependencies.owner,
              "cancelled",
              stateJson
            ).pipe(Effect.orDie)
            if (transitioned._tag !== "Transitioned") return
            settled = true
            // Cancellation cascades to linked children (`Flow.interrupt` is
            // documented to preserve "child-flow handling"). It is recorded
            // durably, in this transaction, off the durable edge table, so the
            // cascade is identical whether the cancellation was requested in
            // this process or observed from another one — the pre-existing
            // in-process linkage in `FlowEngine.make` fires off the ephemeral
            // `instance.interrupted` flag, which a durable observation never
            // sets and a second driver instance never has.
            cascaded = yield* requestCancelDescendants(runId, interruptedAtMs)
            // The run has no future, so neither do its timers. Completing the
            // clock rows in this transaction is what stops a durable timer
            // from outliving the run it belongs to: the sweep queries already
            // skip a settled run's rows, and this stops them being pending at
            // all — including under an in-memory state with no run view to
            // join against.
            yield* engineState.completeRunClocks(runId, interruptedAtMs)
            // A cancel can race the final poll after the run already parked
            // (park precedes the guarded terminal CAS). Clear the waiting row so
            // the terminally cancelled run never surfaces to a sweeper again
            // (issue #28). It shares the transition's transaction, so a crash
            // can no longer land between them.
            yield* engineState.wake(runId).pipe(Effect.asVoid)
            // Durable channel (issue #10): the interruption record must survive
            // the process exiting right after cancellation. Unfenced because the
            // `cancelled` transition above has already released ownership; the
            // fence is the transition CAS itself, which now commits with this
            // record rather than before it.
            yield* journal.emitDurableUnfenced(
              JournalRecords.interrupted({
                runId,
                lineageId: FlowEngine.Lineage.root(runId),
                sourceId: dependencies.journalSource
              }, {
                outcome: "cancelled",
                interruptedAtMs,
                owner: dependencies.owner,
                executionFact: yield* executionFacts.fact(runId),
                ...(cascaded.length === 0 ? {} : { cascadedTo: cascaded })
              })
            ).pipe(Effect.orDie)
          })
        ).pipe(Effect.orDie)
        // Post-commit, and only reachable after a transition that actually
        // happened. Closing the parked flow scope runs the finalizers the
        // suspension retained, with an interrupt exit so `Flow.withRollback`
        // compensations fire — cancellation is exactly the unsuccessful exit
        // they exist for. The run is durably cancelled first, so a crash
        // inside a finalizer cannot resurrect it.
        yield* releaseRetainedScope(runId, Exit.failCause(Cause.interrupt()))
        // Waking a cascaded child is in-process scheduling: a child this
        // process owns or has parked re-enters claim/activate now and the
        // activation cancel guard closes it, instead of waiting out a poll
        // interval. A child owned elsewhere ignores the wake and is reached by
        // its own owner's cancel poll or by that owner's parked-run sweep.
        if (cascaded.length > 0) {
          const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
          yield* Effect.forEach(cascaded, (childId) => activeCoordinator.wake(childId), { discard: true })
        }
        // A cancelled round is a terminal settlement like a completed or
        // failed one, so every parent already parked on it — through any round
        // of its lineage — is woken to read the cancellation (#2758). Only
        // after the transition this call committed: a lost fence woke nobody.
        if (settled) yield* announceSettled(runId, state)
      })

    /**
     * Releases an interrupted run reclaimably instead of closing it
     * (issue #26). A drive-fiber interruption is not evidence of operator
     * cancellation — process shutdown closes the coordinator scope, and the
     * heartbeat loop self-interrupts on any heartbeat error — so the run
     * transitions back to `suspended` while the fence is still validly held,
     * leaving it claimable by any worker (Temporal worker-shutdown
     * semantics). On genuine fence loss the owned transition fails
     * harmlessly.
     */
    /**
     * The waiting reason an interrupted round parks under.
     *
     * A flow that has ALREADY asked to suspend is parked, not released. The
     * round's own settlement derives the same three answers a few statements
     * later ({@link drive}'s `settleRound`), and losing the race to a
     * shutdown must not lose the classification with it: a `released` row
     * carries no wake time and no token, so a run that suspended on a
     * 150-second clock came back as a run whose owner merely went away, and
     * the sweeper had to re-drive it blind instead of waking it when its
     * deadline fell due (release rehearsal).
     *
     * A flow that has NOT asked to suspend is a genuine shutdown or heartbeat
     * self-interrupt, and `released` is exactly what it is (issue #39).
     */
    const interruptedWaiting = (
      runId: string,
      instance: FlowRuntime.FlowInstance["Service"] | undefined
    ): Effect.Effect<DurableEngineState.Waiting> =>
      Effect.gen(function*() {
        if (instance === undefined || !instance.suspended) return { reason: "released" } as const
        const declared = instance.waiting
        if (declared !== undefined) return declared
        const pendingClocks = yield* engineState.pendingClocks({ executionId: runId })
        return pendingClocks.length > 0
          ? {
            reason: "timer",
            wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
          } as const
          : { reason: "event" } as const
      })

    const releaseOwned = (
      runId: string,
      state: RunState,
      round?: {
        readonly flow: Flow.Any
        readonly instance: FlowRuntime.FlowInstance["Service"]
      } | undefined
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Park atomically with releasing ownership (`park` is owner-fenced). The
        // durable waiting row is what makes a released run visible to the
        // parked-run sweeper: without it nothing ever re-drives the run and
        // a durable `requestCancel` against it is write-only forever
        // (issue #39). On genuine fence loss the park reports NotFound
        // harmlessly, exactly like the transition below.
        const waiting = yield* interruptedWaiting(runId, round?.instance)
        // A run whose flow asked to suspend carries the suspension on its row,
        // exactly as the round's own settlement writes it. `poll` publishes a
        // state with no `result` as "not settled yet", so a park recorded
        // without one was invisible to every resumer: `AgentSession`'s
        // `awaitParked` polls `poll` and answers `unknown` for anything but a
        // published `Suspended`, so `smithers approve` and `smithers run
        // --resume` accepted the request and then drove nothing in the release rehearsal.
        const suspension = round !== undefined && waiting.reason !== "released"
          ? (yield* encodeResult(
            round.flow,
            new Flow.Suspended({ cause: round.instance.cause })
          )).encoded
          : undefined
        yield* transitionAndRecord(
          runId,
          "suspended",
          yield* encodeState(
            suspension === undefined
              ? withoutResult(state)
              : { ...withoutResult(state), result: suspension }
          ),
          { decision: "interrupt-released", owner: dependencies.owner },
          undefined,
          undefined,
          waiting
        )
      })

    /**
     * Discriminates an interruption cause by durable state: only an
     * interruption backed by a recorded cancel request closes the run;
     * anything else releases it for reclaim (issue #26), under the waiting
     * reason the flow had already declared for itself when it has one.
     */
    const settleInterrupted = (
      runId: string,
      state: RunState,
      round?: {
        readonly flow: Flow.Any
        readonly instance: FlowRuntime.FlowInstance["Service"]
      } | undefined
    ): Effect.Effect<void> =>
      store.get(runId).pipe(
        Effect.flatMap((row) => {
          // Shutdown can arrive after the claim CAS but before activation, or
          // after activation but before/after the execution race. Release only
          // this incarnation's persisted fence; a settled or foreign row stays
          // untouched, including its waiting reason.
          if (row.claim !== null && row.claimedAtMs !== null && sameOwner(row.claim, dependencies.owner)) {
            return abandon(runId, row.claimedAtMs)
          }
          if (row.status !== "running" || row.owner === null || !sameOwner(row.owner, dependencies.owner)) {
            return Effect.void
          }
          return row.cancelRequestedAtMs !== null ? cancelOwned(runId, state) : releaseOwned(runId, state, round)
        }),
        Effect.catch((error) => error.code === "not_found_row" ? Effect.void : Effect.die(error))
      )

    /**
     * Encodes a settlement for the row, and never fails.
     *
     * The encode used to be guarded with `Effect.orDie`, which made a
     * settlement the flow's own codec rejects fatal for the drain rather than
     * terminal for the run. `agent/run` declares both channels
     * `Schema.Unknown`, so every `Data.TaggedError` an agent body fails with
     * is such a settlement, and the release validation watched the whole
     * chain: the drain died with `SchemaError: Expected JSON value at
     * ["exit"]["cause"][0]["error"]`, `engine.db` kept the run `running`
     * under a pid that had exited while `control.db` said `failed`, and the
     * next process's stale-running sweep stole the row and billed the
     * provider seat a second time. `ExitEncoding.encode` fails closed
     * instead: on rejection it answers a JSON projection of the settlement
     * and a `note`, and a noted settlement is written `failed`.
     */
    const encodeResult = (
      flow: Flow.Any,
      result: Flow.Result<unknown, unknown>
    ): Effect.Effect<ExitEncoding.EncodedResult> => ExitEncoding.encode(flow, result)

    /**
     * Re-encodes a handoff payload through the target flow's own codec, so the
     * bytes the next round's row holds are the bytes `ensureRun` would write
     * for the same invocation.
     */
    const normalizePayload = (
      flow: Flow.Any,
      payload: unknown
    ): Effect.Effect<unknown> => {
      const codec = Schema.toCodecJson(flow.payloadSchema)
      return (Schema.decodeUnknownEffect(codec)(payload).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => Schema.encodeEffect(codec)(decoded)),
        Effect.orDie
      ) as Effect.Effect<unknown>)
    }

    /**
     * Creates one run row, tolerating only an existing row with identical
     * execution identity and encoded invocation data.
     */
    const ensureCreatedRun = (options: {
      readonly flowName: string
      readonly executionId: string
      readonly stateJson: string
      readonly payload: unknown
      readonly lineageId: string
      readonly roundOrdinal: number
      readonly parentRunId?: string | undefined
      readonly onCreated: Effect.Effect<void, never, never>
    }): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        const created = yield* store.create(options.executionId, options.stateJson, {
          ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
          lineageId: options.lineageId,
          roundOrdinal: options.roundOrdinal
        }).pipe(Effect.exit)
        if (Exit.isSuccess(created)) {
          return yield* options.onCreated
        }

        // A cause carrying no `Fail` reason — an interrupt-only cause, or a
        // bare defect — used to reach `Option.getOrThrow(Exit.findErrorOption(...))`,
        // which threw a raw `NoSuchElementError` defect and discarded the
        // original cause. A caller that interrupted the fiber while
        // `store.create` was inside its write transaction saw a crash rather
        // than the cancellation it asked for. `Cause.findFail` hands back
        // that residual cause typed `Cause<never>`, so re-raising it verbatim
        // keeps an interrupt an interrupt (issue #151).
        const failure = Cause.findFail(created.cause)
        if (Result.isFailure(failure)) {
          return yield* Effect.failCause(failure.failure)
        }
        const error = failure.success.error
        if (!(error instanceof RunStore.RunStoreError) || error.code !== "constraint") {
          return yield* Effect.die(error)
        }
        const existing = yield* store.get(options.executionId).pipe(Effect.orDie)
        const persisted = yield* decodeState(existing.stateJson)
        const sameParent = options.parentRunId === undefined ||
          existing.parentRunId === options.parentRunId
        const conflict = persisted.flowName !== options.flowName
          ? {
            field: "flow" as const,
            expected: persisted.flowName,
            actual: options.flowName
          }
          : !samePayload(persisted.payload, options.payload)
          ? {
            field: "payload" as const,
            expected: "the encoded payload the execution was admitted with",
            actual: "a different encoded payload"
          }
          : existing.lineageId !== options.lineageId
          ? {
            field: "lineage" as const,
            expected: existing.lineageId ?? "no lineage",
            actual: options.lineageId
          }
          : existing.roundOrdinal !== options.roundOrdinal
          ? {
            field: "round" as const,
            expected: String(existing.roundOrdinal),
            actual: String(options.roundOrdinal)
          }
          : !sameParent
          ? {
            field: "parent" as const,
            expected: existing.parentRunId ?? "no parent",
            // `!sameParent` implies the requested parent is present: an
            // omitted parent is deliberately compatible with any persisted
            // parent when joining an already-created root.
            actual: options.parentRunId
          }
          : undefined
        if (conflict !== undefined) {
          return yield* Effect.die(
            new FlowEngine.ExecutionIdentityConflict({
              executionId: options.executionId,
              ...conflict,
              message: `execution ${options.executionId} already belongs to ${conflict.field} identity ` +
                `${conflict.expected}; it cannot be reused for ${conflict.actual}`
            })
          )
        }
      })

    const coordinatorDeferred = yield* Deferred.make<RunCoordinator.RunCoordinator<string, never>>()

    /**
     * Observes a durably recorded cancellation request
     * (`RunStore.requestCancel` / `cancel_requested_at_ms`) from another
     * process. Polls on the heartbeat cadence — the request is unfenced, so
     * only the owner can act on it, and it must act within a poll interval
     * (issue #11). Completes when a request is observed; races against the
     * flow like the heartbeat loop.
     */
    const cancelPollLoop = (executionId: string): Effect.Effect<CancelRequested> =>
      Effect.gen(function*() {
        // Check-first: a request that raced in just before activation is
        // observed without waiting out a full heartbeat (issue #27).
        while (true) {
          const requested = yield* store.get(executionId).pipe(
            Effect.map((row) => row.cancelRequestedAtMs !== null),
            Effect.catch(() => Effect.succeed(false))
          )
          if (requested) {
            yield* store.acknowledgeCancel(
              executionId,
              dependencies.owner,
              yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
            ).pipe(Effect.orDie)
            return cancelRequested
          }
          yield* Effect.sleep(Ownership.heartbeatInterval)
        }
      })

    /**
     * What one handoff has to settle: the round that produced it, the row it
     * runs under (which carries the lineage columns), the state it was
     * activated with, its declaration, and the invocation it named.
     */
    interface HandoffSeam {
      readonly executionId: string
      readonly row: RunStore.RunRow
      readonly state: RunState
      readonly flow: Flow.Any
      readonly handoff: Flow.Handoff
    }

    /**
     * Opens the next round, and closes this one, in ONE transaction.
     *
     * `ensureRun`'s parent-edge/run-row pairing (issue #80) is the precedent
     * and the reason: a crash between the two writes would leave a terminal
     * round whose successor was never created, and nothing would ever look for
     * it again — the lineage would end silently at a round that says it handed
     * off. The stores' own writes become savepoints of this transaction, so
     * either both commit or neither.
     *
     * The next round is a run row chained through the RESERVED
     * `parent_run_id` column, not a `flows_run_parents` edge: that table is
     * the subflow DAG cycle detection walks, and a round is the same run
     * continuing rather than a child being spawned
     * (`packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`).
     */
    const continueLineage = (
      seam: HandoffSeam,
      advanced: { readonly round: FlowEngine.Round.Round; readonly executionId: string }
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // The handoff payload travels encoded, and the next round's row has to
        // hold the same value `ensureRun` would write for it: the root caller
        // re-enters `execute` for this round, and its identical-create check
        // compares encoded payloads structurally, so object key order cannot
        // separate two encodings of the same value. The execution id itself
        // uses canonical RFC 8785 JSON, so the identity and payload checks
        // agree by construction.
        //
        // A target this process does not run has no codec to normalize
        // through, and the round is still created with the payload verbatim —
        // the same posture the wake path takes for an unregistered flow, and
        // the reason a lineage survives a worker that only knows some of its
        // legs.
        const target = registrations.get(seam.handoff.flow)
        const payload = target === undefined
          ? seam.handoff.payload
          : yield* normalizePayload(target.flow, seam.handoff.payload)
        const nextStateJson = yield* encodeState({
          version: 1,
          flowName: seam.handoff.flow,
          payload,
          capabilityCeilings: [
            // The execution guard rejects missing persisted authority before a handler can hand off.
            ...seam.state.capabilityCeilings!,
            ...(seam.handoff.capabilityCeilings ?? [[]])
          ],
          ...(seam.state.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: seam.state.parentExecutionId }),
          ...(seam.state.onParentExit === undefined ? {} : { onParentExit: seam.state.onParentExit }),
          ...(seam.state.maxRounds === undefined ? {} : { maxRounds: seam.state.maxRounds })
        })
        const settledStateJson = yield* encodeState({
          ...seam.state,
          result: (yield* encodeResult(seam.flow, seam.handoff)).encoded
        })
        const cancelled = { _tag: "HandoffCancelled" } as const
        const fenceLost = { _tag: "HandoffFenceLost" } as const
        const committed = yield* Effect.result(
          transactState(Effect.gen(function*() {
            // The next round's id is DERIVED from (lineage, ordinal), so a
            // re-drive finds the exact row it already opened. Only an
            // identical create is tolerated; a collision in flow, payload,
            // parent, lineage, or ordinal is a defect.
            yield* ensureCreatedRun({
              flowName: seam.handoff.flow,
              executionId: advanced.executionId,
              stateJson: nextStateJson,
              payload,
              lineageId: advanced.round.rootExecutionId,
              roundOrdinal: advanced.round.ordinal,
              parentRunId: seam.executionId,
              onCreated: emitDecision(advanced.executionId, {
                decision: "created",
                state: JSON.parse(nextStateJson),
                lineageId: advanced.round.rootExecutionId,
                roundOrdinal: advanced.round.ordinal,
                parentExecutionId: seam.executionId
              })
            })
            // DECIDED (2026-08-11, pending review): a handed-off round settles
            // `completed`. The round did finish, and adding a `Continued`
            // status would widen every status reader for a distinction the
            // `handed-off` decision and lineage columns already record.
            //
            // DECIDED (2026-08-11, pending review): cancellation guards the
            // handoff transition. If it raced the last poll, failing the outer
            // transaction rolls successor creation back before the ordinary
            // cancellation path closes the owned round.
            const transitioned = yield* transitionAndRecord(
              seam.executionId,
              "completed",
              settledStateJson,
              {
                decision: "handed-off",
                status: "completed",
                flow: seam.handoff.flow,
                lineageId: advanced.round.rootExecutionId,
                roundOrdinal: advanced.round.ordinal,
                nextExecutionId: advanced.executionId,
                owner: dependencies.owner
              },
              { cancelRequested: "absent" }
            )
            if (transitioned._tag === "Transitioned") return
            return yield* Effect.fail(
              transitioned._tag === "GuardFailed" ? cancelled : fenceLost
            )
          })).pipe(Effect.catchTag("@smthrs/journal/JournalError", Effect.die))
        )
        if (Result.isFailure(committed)) {
          if (committed.failure._tag === "HandoffCancelled") {
            yield* cancelOwned(seam.executionId, seam.state)
          }
          return
        }
        // The root caller follows the lineage itself, but a discarded (or
        // orphaned) one does not exist to follow it, so the successor is woken
        // here rather than left for a sweep that has no reason to look at it.
        const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
        yield* activeCoordinator.wake(advanced.executionId)
      })

    /**
     * Announces a committed terminal settlement: to any in-process caller
     * parked on this run's poll loop, and to every parent attached to the
     * logical run, which is runnable now. That wake is the only thing that
     * says so: a child settlement never passes through `scheduleResume`.
     *
     * A diamond's second parent lives only in its durable edge (issue #2500),
     * and `ensureRun` records an edge under the round the parent joined, so
     * the edges are gathered from every round of the lineage, deduplicated
     * with the creating parent `state_json` carries. Each is recorded for the
     * same reason `scheduleResume` records: the round this wake schedules is
     * the one a host's park guard has to recognize.
     */
    const announceSettled = (executionId: string, state: RunState): Effect.Effect<void> =>
      Effect.gen(function*() {
        yield* wakeBus.wake(executionId)
        const parents = new Set<string>()
        if (state.parentExecutionId !== undefined) parents.add(state.parentExecutionId)
        const rounds = yield* lifecycle.rounds(executionId).pipe(Effect.orDie)
        for (const roundId of new Set([executionId, ...rounds.map((round) => round.runId)])) {
          for (const edge of yield* engineState.runParents(roundId)) parents.add(edge.parentId)
        }
        if (parents.size === 0) return
        const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
        for (const parentId of parents) {
          yield* recordParentResume(parentId)
          yield* activeCoordinator.wake(parentId)
          yield* wakeBus.wake(parentId)
        }
      })

    /**
     * Ends a lineage that asked for one round past its declared budget.
     *
     * The round itself ran to completion; what is refused is the handoff, so
     * the round settles `failed` carrying the typed refusal and no successor
     * is created (`packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`).
     */
    const endLineage = (
      seam: HandoffSeam,
      error: Flow.MaxRoundsExceeded
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stateJson = yield* encodeState({
          ...seam.state,
          result: (yield* encodeResult(seam.flow, new Flow.Complete({ exit: Exit.die(error) }))).encoded
        })
        const transitioned = yield* transitionAndRecord(
          seam.executionId,
          "failed",
          stateJson,
          {
            decision: "lineage-exhausted",
            status: "failed",
            lineageId: error.lineageId,
            maxRounds: error.maxRounds,
            owner: dependencies.owner
          },
          { cancelRequested: "absent" },
          // The lineage is over, not continuing: this round is the last one,
          // so it ends its children like any other terminal exit. A round that
          // HANDS OFF settles through `continueLineage` instead and deliberately
          // does not, because the lineage — and therefore the parent the
          // children are linked to — carries on.
          applyChildExitPolicy(seam.executionId)
        )
        if (transitioned._tag === "GuardFailed") {
          yield* cancelOwned(seam.executionId, seam.state)
        } else if (transitioned._tag === "Transitioned") {
          yield* announceSettled(seam.executionId, seam.state)
        }
      })

    /** Fails a run whose persisted round identity or budget is malformed. */
    const endInvalidRound = (
      seam: HandoffSeam,
      error: FlowEngine.Round.InvalidRound
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stateJson = yield* encodeState({
          ...seam.state,
          result: (yield* encodeResult(seam.flow, new Flow.Complete({ exit: Exit.die(error) }))).encoded
        })
        const transitioned = yield* transitionAndRecord(
          seam.executionId,
          "failed",
          stateJson,
          {
            decision: "round-invalid",
            status: "failed",
            message: error.message,
            owner: dependencies.owner
          },
          { cancelRequested: "absent" },
          applyChildExitPolicy(seam.executionId)
        )
        if (transitioned._tag === "GuardFailed") {
          yield* cancelOwned(seam.executionId, seam.state)
        } else if (transitioned._tag === "Transitioned") {
          yield* announceSettled(seam.executionId, seam.state)
        }
      })

    /**
     * The handoff seam: the one place a round's terminal settlement and its
     * successor are decided together.
     */
    const handOff = (seam: HandoffSeam): Effect.Effect<void, never, Crypto.Crypto> =>
      FlowEngine.Round.next(
        {
          // The row's lineage_id was written from a round's rootExecutionId,
          // so this rehydrates the brand; `Round.next` still validates it.
          rootExecutionId: seam.row.lineageId! as FlowEngine.Round.RootExecutionId,
          ordinal: seam.row.roundOrdinal!
        },
        // The origin persisted its budget into every round's state, so a
        // multi-flow handoff cannot reset the lineage by changing targets.
        { flowName: seam.flow._tag, maxRounds: seam.state.maxRounds }
      ).pipe(
        Effect.flatMap((advanced) => continueLineage(seam, advanced)),
        Effect.catch((error) =>
          error instanceof FlowEngine.Round.InvalidRound
            ? endInvalidRound(seam, error)
            : endLineage(seam, error)
        )
      )

    const drive = (executionId: string): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.suspend(() => {
        let interruptState: RunState | undefined
        let round: { readonly flow: Flow.Any; readonly instance: FlowRuntime.FlowInstance["Service"] } | undefined
        let durableParkAccepted = false
        return Effect.gen(function*() {
          const initial = yield* store.get(executionId).pipe(
            Effect.catch((error) =>
              error.code === "not_found_row"
                ? Effect.succeed(undefined)
                : Effect.die(error)
            )
          )
          if (initial === undefined) return

          const state = yield* decodeState(initial.stateJson)
          interruptState = state
          const registration = registrations.get(state.flowName)
          if (registration === undefined) {
            // Cancelling needs no handler. A parked run whose cancellation was
            // durably requested used to be dropped here with everything else,
            // and nothing else could ever reach it: the sweep woke the row every
            // heartbeat and every wake bailed at this line, so a cancel written
            // by a control-only process — the operator CLI, a second engine that
            // registers other flows — stayed write-only forever while the run's
            // linked children kept going. The terminal transition, the cascade
            // over the durable edge table, and the interruption record are all
            // written from the run ROW, so a process that could never execute
            // this flow can still close it. Claiming first is what makes the
            // close fenced: `cancelOwned` is owner-fenced, so exactly one of the
            // sweeping processes wins and the rest see a lost CAS.
            //
            // `running` is here for the same reason `suspended` is. The row a
            // hard-killed owner leaves behind is `running` with a frozen
            // heartbeat and no waiting row, so the stale-running sweep is the
            // only thing that reaches it, and it arrives through this same
            // function: without this arm a control-only process could close a
            // PARKED run of an unregistered flow and not a hard-killed one,
            // though the two closes are the identical durable write. Nothing is
            // weakened by admitting it, because the arbitration is
            // `claimAndActivate`'s and not this guard's: a fresh lease or a live
            // owner refuses the takeover and the run is left exactly as it was.
            if (
              (initial.status === "suspended" || initial.status === "running") &&
              initial.cancelRequestedAtMs !== null
            ) {
              if (!(yield* claimAndActivate(initial))) return
              return yield* cancelOwned(executionId, withoutResult(state))
            }
            // A wake for a flow this process has not registered — after a full
            // restart the sweep re-drives released rows before (or without)
            // the flow ever registering here. Dropping the wake silently made
            // the #39 reclaim guarantee invisibly conditional on registration
            // (issue #62): warn (once per run, the sweep retries every
            // heartbeat) and leave the durable waiting row untouched so any
            // process that does register the flow still reclaims the run.
            if (!warnedUnregistered.has(executionId)) {
              warnedUnregistered.add(executionId)
              yield* Effect.logWarning(
                `engine-store: run ${executionId} woke for flow ${state.flowName}, which is not registered in this process; leaving it parked for a worker that registers the flow`,
                { runId: executionId, flowName: state.flowName }
              )
            }
            return
          }
          if (!(yield* claimAndActivate(initial))) return
          yield* Effect.logDebug("run activated", { flowName: state.flowName })

          const activeState = withoutResult(state)
          // The activation transition carries the cancel guard: a run whose
          // cancellation was durably requested while it was parked must cancel
          // here instead of re-executing flow side effects (issue #27).
          const cleared = yield* transitionAndRecord(
            executionId,
            "running",
            yield* encodeState(activeState),
            { decision: "resumed", status: "running" },
            { cancelRequested: "absent" },
            undefined,
            null
          )
          if (cleared._tag === "GuardFailed") {
            return yield* cancelOwned(executionId, withoutResult(state))
          }
          if (cleared._tag !== "Transitioned") return

          const payload = yield* (Schema.decodeUnknownEffect(
            Schema.toCodecJson(registration.flow.payloadSchema)
          )(activeState.payload).pipe(Effect.orDie) as Effect.Effect<unknown>)
          // A previous round of this run may have parked and retained its flow
          // scope. That instance is now superseded — this round runs under the
          // fresh instance below, with a scope of its own — so release the old
          // one instead of orphaning it. `Exit.void`: a re-drive is a successful
          // continuation, so ordinary finalizers release resources while
          // `Flow.withRollback` compensations correctly stay out.
          yield* releaseRetainedScope(executionId, Exit.void)
          const instance = FlowEngine.makeInstance(
            registration.flow,
            executionId
          )
          round = { flow: registration.flow, instance }
          const flowEngine = yield* dependencies.engine
          // ONE cleanup region, registered before the race starts and spanning
          // everything that can retain a scope or make its park durable: the
          // suspension surfacing, the retention insertion in the race's exit,
          // `encodeResult`, the pending-clock read, `engineState.park`, the
          // guarded transition and the journal write it commits with, and the
          // durable-park decision itself. Registering it here is what closes the
          // last window: retention is inserted by an uninterruptible finalizer,
          // and the fiber becomes interruptible again the instant that finalizer
          // returns, so any cleanup piped onto the settlement alone would never
          // be registered when an interrupt is already pending at that boundary —
          // the scope would stay retained until the driver's own scope closed,
          // which for a long-lived driver is not a release at all.
          //
          // `Exit.void` is the release exit, for the reason shutdown and a
          // supersede use it (issue #26): a park that never committed leaves the
          // run owned-but-stale or already re-owned, so it is reclaimed and
          // replayed, and the replay re-registers its `Flow.withRollback`
          // compensations under the reclaiming owner. Compensating here would
          // undo work the journal still reports as done — and would then do it
          // twice. Only a cancellation closes with an interrupt exit, and only
          // `cancelOwned` does that.
          yield* Effect.gen(function*() {
            // Published inside the region for the same reason: the entry used to
            // be written before `dependencies.engine` was awaited, one
            // interruptible step ahead of the `ensuring` that removes it, so an
            // interrupt landing there left this round's instance in the map for
            // the driver's lifetime — a slow leak, and a stale instance for
            // `interrupt` to mark interrupted.
            liveInstances.set(executionId, instance)
            const result = yield* Effect.scoped(
              Effect.raceFirst(
                Effect.raceFirst(
                  Effect.suspend(() =>
                    activeState.capabilityCeilings === undefined
                      ? Effect.die(new Error("Missing persisted capabilityCeilings; execution cannot safely resume"))
                      : registration.execute(payload as object, executionId)
                  ).pipe(
                    CapabilitySet.attenuateGroups(activeState.capabilityCeilings ?? [[]]),
                    Flow.intoResult,
                    Effect.provideService(FlowRuntime.FlowInstance, instance),
                    Effect.provideService(FlowRuntime.FlowRuntime, flowEngine)
                  ),
                  Ownership.heartbeatLoop(executionId, dependencies.owner).pipe(
                    Effect.provideService(RunStore.RunStore, store)
                  )
                ),
                cancelPollLoop(executionId)
              )
            ).pipe(
              Effect.ensuring(Effect.sync(() => liveInstances.delete(executionId))),
              // A suspension is the ONE settlement `Flow.intoResult` leaves the
              // flow scope open for, so from the instant it surfaces the scope
              // needs an owner. Retention is taken HERE, inside the race's own
              // exit processing — `Effect.onExit` finalizers run uninterruptibly —
              // because taking it any later crosses an interruptible boundary: an
              // interrupt landing there would end the drive with the scope never
              // retained, unreachable, and its finalizers never run at all. The
              // entry is inserted into a cleanup region that was registered before
              // this race started, so it is owned from this instant on: every
              // ending, including an interrupt observed at the boundary between
              // this finalizer and the settlement below, releases it there.
              Effect.onExit((exit) =>
                Effect.suspend(() => {
                  if (!(Exit.isSuccess(exit) && exit.value._tag === "Suspended")) return Effect.void
                  retainedScopes.set(executionId, instance.scope)
                  return dependencies.unsafeOnScopeRetained?.(executionId) ?? Effect.void
                })
              )
            )
            /**
             * Settles this round durably.
             *
             * A suspension that the guarded terminal transition durably accepts
             * sets `durableParkAccepted`, and that flag is the only thing that lets
             * a retained flow scope outlive this round. Every other ending — an
             * alternative settlement, a cancellation, a lost fence, a defect, an
             * interruption — leaves it unset, so the cleanup region registered
             * around the round releases the scope.
             */
            const settleRound = Effect.gen(function*() {
              if (result._tag === "CancelRequested") {
                yield* cancelOwned(executionId, activeState)
                return
              }

              // Corrupt evidence on a SUCCEEDED attempt row is an operator-visible
              // event, not a terminal run failure (issue #171): the row cannot be
              // evicted and re-executed like a corrupt cache row (#164) without
              // breaking exactly-once. ActionPersistence has already journalled
              // the corruption and quarantined only its boundary evidence off the
              // row. Park this first strict detection so it remains visible; the
              // next explicit resume returns the durable outcome without replaying
              // the poison or re-executing the action.
              const quarantine = result._tag === "Complete" && Exit.isFailure(result.exit)
                ? ActionPersistence.evidenceQuarantined(result.exit.cause)
                : undefined
              if (quarantine !== undefined) {
                const parked = yield* transitionAndRecord(
                  executionId,
                  "suspended",
                  yield* encodeState(withoutResult(activeState)),
                  {
                    decision: "quarantined",
                    status: "suspended",
                    keyDigest: quarantine.keyDigest,
                    owner: dependencies.owner
                  },
                  { cancelRequested: "absent" },
                  undefined,
                  { reason: "quarantine", token: quarantine.keyDigest }
                )
                if (parked._tag === "GuardFailed") {
                  yield* cancelOwned(executionId, activeState)
                }
                return
              }

              // A round that handed off settles through the seam instead: its
              // terminal transition and its successor's creation are one write, so
              // it cannot share the ordinary terminal path below.
              if (result._tag === "Handoff") {
                yield* handOff({
                  executionId,
                  row: initial,
                  state: activeState,
                  flow: registration.flow,
                  handoff: result
                })
                return
              }

              const encodedResult = yield* encodeResult(registration.flow, result)
              const nextState: RunState = { ...activeState, result: encodedResult.encoded }
              // A settlement the flow's codec rejected is written `failed`
              // whatever it claimed to be: the row must reach a terminal status
              // in this process, because the alternative — the `running` row the
              // release validation found — is re-executed by the next one.
              const status: RunStore.RunStatus = encodedResult.note !== undefined
                ? "failed"
                : result._tag === "Suspended"
                ? "suspended"
                : Exit.isSuccess(result.exit)
                ? "completed"
                : "failed"
              let waiting: DurableEngineState.Waiting | null = null
              if (status === "suspended") {
                // Park atomically with the suspended transition while this
                // process still owns the row (`park` is owner-fenced). The
                // reason is derived from durable state: a pending
                // clock row means a timer wake with a known deadline; anything
                // else waits on an external event (deferred completion). This is
                // what makes `waitingRuns` sweepers and the 0004 partial index
                // match real suspensions (issue #12).
                // A flow-declared classification (FlowRuntime.annotateWaiting) wins:
                // it is the only way an approval or quota wait — and its wake
                // token — reaches the parked row (issue #31). The durable-state
                // derivation stays the fallback.
                const declared = instance.waiting
                const pendingClocks = yield* engineState.pendingClocks({ executionId })
                waiting = declared !== undefined
                  ? declared
                  : pendingClocks.length > 0
                  ? {
                    reason: "timer",
                    wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
                  }
                  : { reason: "event" }
              }
              // Finalize is guarded on `cancel_requested_at_ms` inside the same
              // CAS: a cancellation request that raced past the last poll turns
              // the terminal transition into GuardFailed, and the run cancels
              // instead of finalizing (issue #11).
              const transitioned = yield* transitionAndRecord(
                executionId,
                status,
                yield* encodeState(nextState),
                { decision: "transitioned", status, owner: dependencies.owner },
                { cancelRequested: "absent" },
                // A suspension is not an exit: the run is parked and will settle
                // later, so its children keep going and its timers stay armed. A
                // `completed` or `failed` run is done, so its attached children
                // end with it. The transition closes its own clock rows.
                status === "suspended" ? undefined : applyChildExitPolicy(executionId),
                waiting
              ).pipe(
                // The park becomes durable the instant this transition commits, so
                // the flag that records it is set in the transition's own exit
                // processing. `Effect.onExit` finalizers run uninterruptibly and
                // before the fiber can observe an interruption again, so no
                // interrupt can land between the durable commit and the flag and
                // make the cleanup region discard a scope the park still needs.
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (status === "suspended" && Exit.isSuccess(exit) && exit.value._tag === "Transitioned") {
                      durableParkAccepted = true
                    }
                  })
                )
              )
              if (transitioned._tag === "GuardFailed") {
                // `cancelOwned` closes the retained scope itself, with the
                // interrupt exit cancellation compensations exist for. Leaving
                // `durableParkAccepted` unset therefore releases nothing a second
                // time: the entry is already gone from the map.
                yield* cancelOwned(executionId, activeState)
                return
              }
              // A lost fence (`NotFound`, a mismatched CAS) settles nothing: the
              // run is someone else's now, so a suspension holds no durable park
              // and the cleanup region releases the scope rather than holding it
              // until shutdown.
              if (transitioned._tag !== "Transitioned") return
              if (status !== "suspended") {
                // The settle is durable; tell any in-process caller parked on this
                // run's poll loop, so a run driven to completion by a sweep or a
                // coordinator wake is observed now rather than on the next tick.
                yield* announceSettled(executionId, activeState)
                return
              }
            })

            yield* settleRound
          })
        }).pipe(
          // Install ownership cleanup before the claim itself. Limiting it to
          // the execution race strands an activated row if shutdown lands in
          // setup or settlement; a replacement host in the same process then
          // correctly refuses to steal from the still-live PID forever.
          Effect.onInterrupt(() =>
            interruptState === undefined
              ? Effect.void
              : settleInterrupted(executionId, interruptState, round)
          ),
          Effect.onExit(() =>
            Effect.suspend(() => {
              liveInstances.delete(executionId)
              // Cancellation settles first so its compensations still see the
              // retained scope. A successful durable park alone retains it.
              return round === undefined || durableParkAccepted
                ? Effect.void
                : releaseRetainedScope(executionId, Exit.void)
            })
          ),
          Effect.annotateLogs({ runId: executionId })
        )
      })

    const coordinator = yield* RunCoordinator.make<string, never, Crypto.Crypto>({
      drain: drive
    })
    yield* Deferred.succeed(coordinatorDeferred, coordinator)

    /**
     * Delivers cancellation to parked runs (issue #27). A suspended run has
     * no owner and therefore no cancel poll, so `requestCancel` against it
     * is write-only until something re-drives the run — a run parked on a
     * deferred that never completes could otherwise never be cancelled. The
     * sweep lists parked rows, and wakes any whose cancel was durably
     * requested; the re-activation cancel guard then closes the run without
     * re-executing the flow.
     *
     * The same sweep reclaims interrupt-released runs (issue #39): a run
     * parked with reason `released` was interrupted mid-action by shutdown
     * or a heartbeat self-interrupt, has no pending clock and no completed
     * deferred, and would otherwise never be re-driven. Waking it re-enters
     * the ordinary claim/activate path, which also delivers any pending
     * cancel via the activation guard.
     */
    const sweepCancelRequested: Effect.Effect<void> = Effect.gen(function*() {
      // Fetch only actionable rows (issue #68): the sweep acts solely on
      // released rows and rows whose cancellation was durably requested, so
      // a large quota/event-parked fleet must cost it nothing per tick. The
      // per-row `store.get` below is a status guard over the (small)
      // actionable set, not a probe over every parked run — the in-memory
      // implementation without a `runs` view stays permissive on the cancel
      // predicate and relies on exactly this guard.
      const released = yield* engineState.waitingRuns({ reason: "released" })
      const cancelRequestedRows = yield* engineState.waitingRuns({ cancelRequested: true })
      const candidates = new Map<string, DurableEngineState.WaitingRow>()
      for (const waiting of released) candidates.set(waiting.runId, waiting)
      for (const waiting of cancelRequestedRows) candidates.set(waiting.runId, waiting)
      for (const waiting of candidates.values()) {
        const row = yield* store.get(waiting.runId).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        if (
          row !== undefined &&
          row.status === "suspended" &&
          (row.cancelRequestedAtMs !== null || waiting.reason === "released")
        ) {
          yield* coordinator.wake(row.runId)
        }
      }
    })
    // Admissions committed before a host crash have no lease to go stale.
    // Reuse the normal coordinator and claim/activate path for these rows.
    const pendingCycles = new Map<string, {
      readonly through: DurableEngineState.PendingRunCursor
      readonly eligibleBeforeMs: number
      after?: DurableEngineState.PendingRunCursor
    }>()
    let pendingFlowOffset = 0
    const sweepPending = (): Effect.Effect<void> =>
      Effect.gen(function*() {
        let remaining = staleRunningSweepBatch
        const allNames = Array.from(registrations.keys())
        const offset = allNames.length === 0 ? 0 : pendingFlowOffset % allNames.length
        const names = [...allNames.slice(offset), ...allNames.slice(0, offset)]
        pendingFlowOffset++
        for (const name of names) {
          const registration = registrations.get(name)
          if (registration === undefined || remaining === 0) continue
          let cycle = pendingCycles.get(name)
          if (cycle === undefined) {
            const eligibleBeforeMs = (yield* Clock.currentTimeMillis) - Duration.toMillis(Ownership.heartbeatStaleAfter)
            const tail = yield* engineState.pendingRunTail(name, eligibleBeforeMs)
            if (Option.isNone(tail)) continue
            cycle = { through: tail.value, eligibleBeforeMs }
            pendingCycles.set(name, cycle)
          }
          const requested = remaining
          const pending = yield* engineState.pendingRuns(
            name,
            requested,
            cycle.after,
            cycle.through,
            cycle.eligibleBeforeMs
          )
          for (const cursor of pending) {
            if (remaining === 0 || registrations.get(name) !== registration) break
            remaining--
            const row = yield* store.get(cursor.runId).pipe(
              Effect.catch((error) =>
                error.code === "not_found_row" ? Effect.succeed(undefined) : error.code === "decode_failed"
                  ? Effect.logWarning("engine-store: unreadable pending admission skipped", {
                    runId: cursor.runId,
                    flowName: name,
                    error
                  }).pipe(Effect.as(undefined))
                  : Effect.die(error)
              )
            )
            // Advance after successful reads or permanent row errors; transient failures retry this
            // position, while a retained query cursor skips deleted rows safely.
            cycle.after = cursor
            if (row === undefined || row.status !== "pending" || (yield* coordinator.active).has(cursor.runId)) continue
            if (dependencies.canExecute !== undefined && !(yield* dependencies.canExecute(row))) continue
            if (registrations.get(name) !== registration || (yield* coordinator.active).has(cursor.runId)) continue
            yield* coordinator.schedule(cursor.runId)
          }
          const last = pending.at(-1)
          if (pending.length < requested || (last !== undefined && last.runId === cycle.through.runId)) {
            pendingCycles.delete(name)
          }
        }
      })

    /**
     * Reclaims hard-killed runs (issue #53). An owner that dies without
     * releasing (SIGKILL, OOM, power loss) leaves a `running` row with a
     * frozen heartbeat and no waiting row, so the parked-run sweep above
     * never sees it, and the steal path — reachable only through `drive()` —
     * is never entered. Enumerate stale-running rows and re-drive them: the
     * ordinary claim/steal path (liveness check, exact-snapshot steal CAS)
     * then decides whether the owner is genuinely dead — the analog of
     * Temporal's task-timeout re-dispatch. A pending durable cancel is
     * delivered by the re-activation guard, same as for parked runs.
     */
    const sweepStaleRunning: Effect.Effect<void> = Effect.gen(function*() {
      const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      // Rows this driver has already arbitrated and been refused. They are the
      // oldest heartbeats in the window, so they sort first and would fill the
      // batch every tick; the read asks for enough extra rows to see past
      // exactly the ones it is going to skip.
      const deferred = Array.from(stealRefusals.values()).filter((entry) => entry.nextProbeAtMs > nowMs).length
      // Capped per tick (issue #79): oldest heartbeats come back first, so a
      // mass owner death drains across successive ticks — batch after batch
      // as each stolen run's heartbeat leaves the stale window — instead of
      // every surviving driver waking every stale run every second and
      // contending N-drivers × M-runs on the claim/steal CAS.
      const stale = yield* engineState.staleRunningRuns(
        nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter),
        staleRunningSweepBatch + deferred
      )
      // A refusal is remembered only while its row is still in the window this
      // read covers. A run that was stolen, released, or settled leaves the
      // stale set, and its entry leaves with it, so the map cannot outgrow the
      // backlog it describes.
      const visible = new Set(stale.map((row) => row.runId))
      for (const runId of stealRefusals.keys()) {
        if (!visible.has(runId)) stealRefusals.delete(runId)
      }
      let woken = 0
      for (const { heartbeatAtMs, runId } of stale) {
        if (woken >= staleRunningSweepBatch) break
        // A refusal defers only the lease it was refused against. An owner
        // that pulsed and stalled again between two ticks never left this
        // read's window, so the lease is what says the stall is a new one.
        const refusal = stealRefusals.get(runId)
        if (refusal !== undefined && refusal.heartbeatAtMs === heartbeatAtMs && refusal.nextProbeAtMs > nowMs) continue
        woken = woken + 1
        yield* coordinator.wake(runId)
      }
    })
    const resilientSweep = (sweep: Effect.Effect<void>, name: string) =>
      sweep.pipe(
        Effect.sandbox,
        Effect.catchCause((cause) => Effect.logWarning(`engine-store: ${name} sweep failed; retrying next tick`, cause))
      )
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Ownership.heartbeatInterval).pipe(
          Effect.andThen(
            // One transient defect (a `SQLITE_BUSY` escaping `waitingRuns()`'s
            // `orDie`, a wake failure) must not kill the sweeper for the rest
            // of the process lifetime (issue #44) — that would silently revert
            // to pre-#27 behavior where cancel of parked runs is never
            // delivered. Mirror `armClock`'s hardening: expose the full cause,
            // log it, and keep ticking.
            resilientSweep(sweepCancelRequested, "parked-run cancel").pipe(
              Effect.andThen(resilientSweep(sweepStaleRunning, "stale-running")),
              Effect.andThen(resilientSweep(sweepPending(), "pending admission"))
            )
          )
        )
      )
    )

    const ensureRun = (
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly payload: object
        /**
         * Whether the caller discarded this execution's result. It is what
         * separates the two child shapes: a caller that waits for the child's
         * value holds it attached, and a caller that threw the value away
         * spawned it detached. See {@link RunState.OnParentExit}.
         */
        readonly discard?: boolean | undefined
        readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
        readonly round?:
          | (FlowEngine.Round.Round & {
            readonly previousExecutionId?: string | undefined
          })
          | undefined
      }
    ): Effect.Effect<void, FlowCycleDetected> =>
      Effect.gen(function*() {
        const payload = yield* (Schema.encodeEffect(
          Schema.toCodecJson(flow.payloadSchema)
        )(
          options.payload
        ).pipe(Effect.orDie) as Effect.Effect<unknown>)
        // Every requested parent — first (creating) parent and a diamond's
        // second parent alike — is recorded as a durable edge BEFORE the run
        // row is created. `recordRunParent` inserts the edge and checks for
        // a cycle inside one storage transaction (issues #29/#40/#54/#56),
        // so a rejected request fails here and never creates a run row — no
        // `state_json` parent can outlive a rejected edge (issue #55). The
        // edge table is the single source of truth for cycle detection in
        // every owner process and across restarts (issues #40/#41).
        //
        // The edge record and the run-row creation share one outer storage
        // transaction (issue #80): a crash between them used to commit a
        // durable orphan edge for a child run that never existed — never
        // GC'd, permanently walked by cycle detection, and able to force a
        // false FlowCycleDetected if the execution id was later reused
        // under an inverted topology. The stores' own writes become
        // savepoints of this transaction, so either both commit or neither.
        yield* transactState(Effect.gen(function*() {
          let parentRecorded = false
          if (options.parent !== undefined) {
            const parentEdge = yield* engineState.recordRunParent(
              options.executionId,
              options.parent.executionId
            ).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new FlowCycleDetected({ code: "flow_cycle_detected", path: error.path })
                )
              )
            )
            parentRecorded = parentEdge._tag === "Recorded"
          }
          const round = options.round ?? FlowEngine.Round.initial(options.executionId)
          const previousExecutionId = options.round?.previousExecutionId
          // Decided once, at spawn, from what the caller did with the result:
          // a caller waiting for the value keeps the child attached, and a
          // caller that discarded it detached the child on purpose. Nothing
          // later rewrites this.
          const onParentExit: OnParentExit = options.discard === true ? "detach" : "cancel"
          const state: RunState = {
            version: 1,
            flowName: flow._tag,
            payload,
            capabilityCeilings:
              (yield* Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations))(CapabilitySet.current))
                .groups,
            onParentExit,
            ...(options.parent === undefined
              ? {}
              : { parentExecutionId: options.parent.executionId }),
            ...(flow.maxRounds === undefined ? {} : { maxRounds: flow.maxRounds })
          }
          const createdStateJson = yield* encodeState(state)
          yield* ensureCreatedRun({
            flowName: flow._tag,
            executionId: options.executionId,
            stateJson: createdStateJson,
            payload,
            lineageId: round.rootExecutionId,
            roundOrdinal: round.ordinal,
            ...(previousExecutionId === undefined
              ? {}
              : { parentRunId: previousExecutionId }),
            onCreated: Effect.gen(function*() {
              // The run's opening frame. `store.create` used to be the one
              // durable write with no journal record at all, which left the
              // replay-derived state projection with no base to fold onto —
              // `flowName` and `payload` exist nowhere else in the journal.
              // The state travels ENCODED, exactly as every later decision
              // carries it: `stateAt` folds these payloads and hands the winner
              // back as the run row's own `state_json`, so a base recorded in the
              // decoded shape would be a schema the caller cannot decode.
              yield* emitDecision(options.executionId, {
                decision: "created",
                state: JSON.parse(createdStateJson),
                ...(options.parent === undefined ? {} : { parentExecutionId: options.parent.executionId })
              })
              if (options.parent !== undefined) {
                // A spawn is a lineage edge, and a DETACHED spawn is a tier-3
                // effect: nothing the parent's rewind can undo, because the child
                // is its own claim and its own journal. The record
                // is boundary-shaped so the same assessment that classifies a
                // sent webhook classifies an orphaned child, and it is emitted at
                // `succeeded` because by this point the child run durably exists.
                // Unfenced: the creator of a detached child is not necessarily
                // the parent's current owner (an external spawn admission
                // creates child rows without holding the parent's fence), so
                // this lineage-edge record is first-writer-wins evidence keyed
                // by its spawn identity.
                yield* journal.emitDurableUnfenced(
                  EffectRecords.boundary(
                    {
                      id: `${options.parent.executionId}:spawn:${options.executionId}`,
                      kind: spawnEffectKind,
                      tier: "irreversible",
                      runId: options.parent.executionId,
                      lineageId: FlowEngine.Lineage.root(options.parent.executionId),
                      sourceId: dependencies.journalSource,
                      attempt: 1,
                      residue:
                        `Child run ${options.executionId} exists and keeps its own journal; rewinding past its spawn orphans it.`
                    },
                    "succeeded",
                    // `attached` is written even though it is always false: the
                    // lineage-tree bridge in `@smthrs/time-travel` reads it off
                    // this payload, and an absent field there would make "this
                    // spawn is detached" indistinguishable from "this producer
                    // predates the field". A run created with a parent is a
                    // separate run row with its own claim, which is what detached
                    // means; attached nesting
                    // never reaches `create` because it is one journal.
                    { childRunId: options.executionId, flowName: flow._tag, attached: false }
                  )
                ).pipe(Effect.orDie)
              }
            })
          })
          // The row already exists; the durable edge recorded above is the
          // only place a diamond's second parent lives (issues #41/#48): a
          // driver-local side table would be invisible to other owners over
          // the same store, lost across restart, and would grow without
          // bound for the driver's lifetime.
          //
          // Which is also why the parent's cancellation is inherited HERE,
          // last and inside this same transaction: the child row must already
          // exist for `requestCancel` to have anything to write to, and the
          // inheritance must commit or roll back with the edge that made this
          // run a child in the first place. The inherited request is what the
          // activation guard reads, so the child cancels instead of executing
          // the flow body.
          if (options.parent !== undefined) {
            yield* inheritParentCancellation(
              options.parent.executionId,
              options.executionId
            )
            if (parentRecorded) {
              yield* emitDecision(options.executionId, {
                decision: "parent-recorded",
                parentExecutionId: options.parent.executionId
              })
            }
          }
        })).pipe(
          Effect.catchIf((error) => error instanceof Journal.JournalError || error instanceof DatabaseError, Effect.die)
        )
      })

    const readResult = (flow: Flow.Any, executionId: string, followLineage = false) =>
      Effect.annotateCurrentSpan({ executionId, flow: flow._tag }).pipe(
        Effect.andThen(
          followLineage
            ? store.latestRound(executionId)
            : store.get(executionId)
        ),
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(undefined)
            : Effect.die(error)
        ),
        Effect.flatMap((row) => {
          if (row === undefined) {
            // No run row at all is a typed not-found; `Option.none` is
            // reserved for a known run that has not settled yet.
            return Effect.fail(
              new FlowRuntime.FlowExecutionNotFound({
                code: "execution_not_found",
                executionId
              })
            )
          }
          return decodeState(row.stateJson).pipe(
            Effect.flatMap((state) => {
              if (
                (!followLineage && state.flowName !== flow._tag) ||
                state.result === undefined
              ) {
                return Effect.succeedNone
              }
              const resultFlow = state.flowName === flow._tag ? flow : registrations.get(state.flowName)?.flow
              if (resultFlow === undefined) {
                // Direct nested callers must register the terminal flow's
                // codec here, even when another worker executed that flow.
                // This is the typed Trampoline's fail-fast wiring contract:
                // terminal work has no future wake to justify Suspended.
                return Effect.die(new Error(`Flow ${state.flowName} is not registered`))
              }
              return (Schema.decodeUnknownEffect(
                Schema.toCodecJson(Flow.Result({
                  success: resultFlow.successSchema,
                  error: resultFlow.errorSchema
                }))
              )(state.result).pipe(
                Effect.orDie,
                Effect.map(Option.some)
              ) as Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>)
            }),
            Effect.map((result) => ({ result, status: row.status }))
          )
        })
      )

    const poll: Service["poll"] = Effect.fn("FlowEngine.poll")((flow, executionId) =>
      Effect.map(readResult(flow, executionId), (observed) => observed.result)
    )

    const execute: Service["execute"] = Effect.fn("FlowEngine.execute")(
      function*<const Discard extends boolean>(
        flow: Flow.Any,
        options: {
          readonly executionId: string
          readonly payload: object
          readonly discard: Discard
          readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
          readonly round?:
            | (FlowEngine.Round.Round & {
              readonly previousExecutionId?: string | undefined
            })
            | undefined
          readonly follow?: boolean | undefined
        }
      ) {
        yield* Effect.annotateCurrentSpan({ executionId: options.executionId, flow: flow._tag })
        if (!registrations.has(flow._tag)) {
          return yield* Effect.die(
            new Error(`Flow ${flow._tag} is not registered`)
          )
        }
        // Cycle rejection happens atomically inside `ensureRun`'s call to
        // `DurableEngineState.recordRunParent`: the storage transaction that
        // inserts the edge also walks the parent chain and rolls back on a
        // hit, so no in-process gate, cross-owner arbitration, or withdrawal
        // protocol is needed here (issues #29/#40/#54/#55/#56) and the
        // mutual `coordinator.run` deadlock cannot form.
        if (options.discard) {
          // Keep durable admission and scheduling together across caller cancellation.
          // The coordinator owns the drive in the engine scope, so a
          // detached child outlives the caller's action and execution.
          yield* Effect.uninterruptible(
            ensureRun(flow, options).pipe(Effect.andThen(coordinator.schedule(options.executionId)))
          )
          return undefined as Discard extends true ? void : never
        }
        yield* ensureRun(flow, options)
        // Admission, handoff, or a wake normally scheduled this drive. A
        // replacement host may instead find an admitted pending row with no
        // drive, so schedule that row before joining. An idle suspended row
        // stays passive until its actual wake or elapsed poll resumes it.
        if (options.follow === true) {
          yield* coordinator.scheduleIf(
            options.executionId,
            store.get(options.executionId).pipe(
              Effect.orDie,
              Effect.map((row) => row.status === "pending")
            )
          )
          yield* coordinator.join(options.executionId)
        } else {
          yield* coordinator.run(options.executionId)
        }
        // `ensureRun` created the row above, so a not-found here is a broken
        // store invariant, not a caller-recoverable state.
        // The trampoline supplies `round` and consumes each raw handoff itself.
        // A nested direct caller instead needs the child's current lineage row,
        // including its own codec and cancellation status. `follow` schedules an
        // undriven pending row before joining; it does not select the result's scope.
        const observed = yield* Effect.orDie(readResult(
          flow,
          options.executionId,
          options.parent !== undefined && options.round === undefined
        ))
        if (Option.isSome(observed.result)) {
          return observed.result.value as Discard extends true ? void : Flow.Result<unknown, unknown>
        }
        // A cancelled run has no `Flow.Result` on its row — cancellation is
        // recorded as `cancellation`, not as a settlement — so answering the
        // absence with `Suspended` told the caller to wait for a run that was
        // over. The engine's suspended-retry loop then did what that answer
        // means: slept, resumed, re-drove, and asked again, for as long as the
        // caller lived. A run cancelled underneath its caller interrupts the
        // caller instead, which is what the memory engine already does
        // (`layerMemory.ts` `interrupt` settles the round `Complete` with an
        // interrupt cause) and what a cancellation means: the work the caller
        // asked for is not going to happen.
        // Result and cancellation status come from the same row snapshot.
        return (observed.status === "cancelled"
          ? new Flow.Complete({ exit: Exit.failCause(Cause.interrupt()) })
          : new Flow.Suspended({})) as Discard extends true ? void
            : Flow.Result<unknown, unknown>
      }
    )

    const interrupt = Effect.fn("FlowEngine.interrupt")((
      _flow: Flow.Any,
      executionId: string
    ): Effect.Effect<void, FlowRuntime.CancelRequestFailed> =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ executionId })
        // Operator intent is recorded durably before the fiber interrupt so
        // the interruption handler can tell cancellation apart from shutdown
        // (issue #26), and so the request survives if this process dies
        // before the interrupt lands.
        //
        // The write used to be `Effect.ignore`d, which answered success for a
        // cancellation that was never recorded: the fiber interrupt that
        // follows is then read as a shutdown by `settleInterrupted`, the run
        // is RELEASED for reclaim rather than cancelled, another worker picks
        // it up, and the caller was told the run was cancelled. The failure is
        // typed instead, so the caller can retry against a state that is still
        // truthful — the run is still running and still cancellable.
        const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        // The package's one lock order, the same one every settlement takes:
        // engine state first, then the journal. The descendant walk reads
        // engine state while holding the SQL writer, so the alternative would
        // deadlock against any fiber that ordered the two boundaries the
        // other way.
        const requested = yield* transactState(
          Effect.gen(function*() {
            yield* requestCancellation(executionId, nowMs)
            return [executionId, ...yield* requestCancelDescendants(executionId, nowMs)]
          }),
          // Capture the shared writer directly. SqlJournal.transact catches a
          // selected failure and can discard the rest of a composite cause.
          (write) => Effect.flatMap(Effect.exit(writer.write(write)), (exit) => exit)
        ).pipe(
          Effect.catchCause((cause) => {
            // A composite is never a retryable CancelRequestFailed: retain
            // every original reason, including defect identity and interruption.
            const failure = (error: { readonly message: string }) =>
              new FlowRuntime.CancelRequestFailed({
                code: "cancel_request_failed",
                executionId,
                reason: error.message
              })
            if (cause.reasons.length === 1) {
              const reason = cause.reasons[0]!
              if (Cause.isDieReason(reason) && reason.defect instanceof DatabaseError) {
                return Effect.fail(failure(reason.defect))
              }
              // The typed channel is the normalized writer/store/journal union.
              if (Cause.isFailReason(reason)) {
                return Effect.fail(failure(reason.error))
              }
            }
            // A composite is not the retryable request failure the typed
            // channel promises, so every typed reason is re-channelled as a
            // defect rather than cast through `CancelRequestFailed`. The error
            // objects, the accompanying defects and the interruptions all
            // survive; only the channel changes, and it changes to the one the
            // declared type actually admits.
            return Effect.failCause(asDefects(cause))
          })
        )
        // Only after the durable write succeeds may the ephemeral surface say
        // this instance was interrupted or stop its drive fiber. If the write
        // failed, changing either would make a typed failure observably mutate
        // the run (and could spuriously trigger the in-process child path).
        // The transaction above records the parent and every durable
        // descendant together. A run this process does not drive — parked
        // here, owned elsewhere, or already settled — therefore receives the
        // same child-flow handling without a partial-cascade state if any
        // request write fails. `requestCancel` is first-writer-wins, so the
        // owning driver's own cascade later writes nothing.
        yield* journal.whenCommitted(Effect.gen(function*() {
          for (const targetId of requested) {
            const instance = liveInstances.get(targetId)
            if (instance !== undefined) instance.interrupted = true
            // Publication only sends the request. Awaiting user finalizers
            // here would make an outer commit uninterruptibly wait on them.
            yield* coordinator.requestInterrupt(targetId)
          }
        }))
      })
    )

    const scheduleResume: Service["scheduleResume"] = Effect.fn("FlowEngine.scheduleResume")((
      flowName,
      executionId,
      reason,
      sourceId
    ) =>
      transactState(Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ executionId, flow: flowName, reason })
        const row = yield* store.get(executionId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (row === undefined) return
        // A settled run is not woken and then refused: it is not woken. The
        // terminal reject used to live one layer down, in `claimAndActivate`,
        // so a timer armed before its run was cancelled and an external
        // trigger arriving after the run finished both wrote a
        // `wake-scheduled` decision into the journal of a run that can never
        // wake again — one per event, forever, on a durable channel.
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") return
        const state = yield* decodeState(row.stateJson)
        if (state.flowName !== flowName) return
        const waiting = yield* engineState.waiting(executionId)
        if (Option.isSome(waiting) && waiting.value.reason === "quarantine") {
          if (reason !== "operator") return
          // Recovery consent and its journal receipt commit together. A
          // queued drive cannot consume quarantined evidence before consent.
          yield* engineState.wake(executionId)
        }
        yield* emitDecision(executionId, {
          decision: "wake-scheduled",
          reason
        }, sourceId)
        return { parked: row.status === "suspended" }
      })).pipe(
        Effect.orDie,
        // A host can write a separate database. Release the engine transaction
        // before calling it, but record its request before publishing the wake.
        Effect.flatMap((scheduled) =>
          scheduled === undefined
            ? Effect.void
            : (reason === "operator" ? Effect.void : recordResume(executionId, scheduled.parked, reason)).pipe(
              Effect.andThen(coordinator.wake(executionId)),
              Effect.andThen(wakeBus.wake(executionId))
            )
        )
      )
    )

    return {
      register: Effect.fn("FlowEngine.register")((flow, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const registration = { flow, execute: handler }
            registrations.set(flow._tag, registration)
            pendingCycles.delete(flow._tag)
            warnedUnregistered.clear()
            return registration
          }),
          (registration) =>
            Effect.sync(() => {
              if (registrations.get(flow._tag) === registration) {
                registrations.delete(flow._tag)
                pendingCycles.delete(flow._tag)
              }
            })
        ).pipe(Effect.asVoid)
      ),
      execute,
      poll,
      interrupt,
      // The durable engine has ONE cancellation path (the release policy). The
      // port promises forced cancellation without cleanup; nothing here can
      // deliver that — a durable run is closed by a fenced transition whose
      // finalizers, cascade, and interruption record are the point — and
      // answering with `interrupt` silently reinterpreted the caller's
      // request as the safe one. Refusing is what keeps the excluded feature
      // from appearing to half-work; `interrupt` is the supported request and
      // is still available to the same caller. The memory engine, which does
      // have two behaviors, is unchanged.
      //
      // The reason is the release policy "Durable interruptUnsafe" verbatim, not a
      // paraphrase of it: the release note and the failure a caller catches
      // are the same statement, so an operator who reads one and a developer
      // who logs the other are reading the same sentence.
      interruptUnsafe: Effect.fn("FlowEngine.interruptUnsafe")((
        _flow: Flow.Any,
        executionId: string
      ) =>
        Effect.fail(
          new FlowRuntime.CancelRequestFailed({
            code: "unsafe_interrupt_unsupported",
            executionId,
            reason:
              "The durable engine has one cancellation path, interrupt, which is durable and cascades to linked children. FlowRuntime.interruptUnsafe on the durable engine fails with unsafe_interrupt_unsupported instead of forcing cancellation without cleanup."
          })
        )
      ),
      resume: Effect.fn("FlowEngine.resume")((flow, executionId, options) =>
        Effect.annotateCurrentSpan({ executionId, flow: flow._tag }).pipe(
          Effect.andThen(options?.poll === true ? Effect.void : scheduleResume(flow._tag, executionId, "operator")),
          Effect.andThen(coordinator.run(executionId))
        )
      ),
      scheduleResume,
      active: Effect.fn("FlowEngine.active")(() => coordinator.active)(),
      retainedRuns
    }
  })
