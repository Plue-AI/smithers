/**
 * Fenced run persistence and ownership compare-and-swap operations.
 *
 * Operations that accept or verify `LivenessEvidence` (`claim`,
 * `claimAndOwn`, `steal`, `heartbeat`, `requestCancel`, and `recoverClaim`)
 * take the caller's `nowMs` and judge it literally, including the lease cutoff
 * and exact `evidence.checkedAtMs === nowMs` rule. The lease operations
 * (`claim`, `claimAndOwn`, `steal`, `heartbeat`, and `recoverClaim`) also
 * refuse a `nowMs` that runs ahead of the injected Effect `Clock` by more than
 * `heartbeatSkewAllowance`: no composition produces one honestly, because the
 * caller and the store share a process, and such a reading is the one lever
 * that steals a fresh owner or pins a lease past the cutoff. A reading behind
 * the clock is admitted, since it only makes staleness judgments more
 * conservative and the monotonic heartbeat absorbs it. `requestCancel` keeps
 * the literal reading because its timestamp is request data, never a lease
 * predicate. Lifecycle stamps use the Effect `Clock`: `create` writes
 * `created_at_ms`, `activate` writes `started_at_ms` and `heartbeat_at_ms`,
 * and `transitionOwned` writes `finished_at_ms`. A row can therefore carry
 * readings from two clocks. Within the allowance the store trusts the caller's
 * clock, which is right for an in-process library over local SQLite and must
 * not cross a trust boundary.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { afterCommit, DatabaseError, DurableWriter, fromSqlError } from "@smthrs/database/DurableWriter"
import { OwnerId } from "@smthrs/journal/OwnerId"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import { Clock, Context, Duration, Effect, Layer, Metric, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import { heartbeatSkewAllowance, heartbeatStaleAfter } from "./Heartbeat.ts"
import * as Boundary from "./internal/Boundary.ts"
import { observeExit, observeOutcome } from "./internal/SpanOutcome.ts"
import type { LivenessEvidence } from "./Ownership.ts"
import * as RunStoreMetrics from "./RunStoreMetrics.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * A UTF-16 surrogate without its partner. The journal uses the same ES2022
 * compatible check because `String.prototype.isWellFormed` needs ES2024.
 */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** A non-empty identifier whose UTF-16 encoding survives SQLite unchanged. */
const wellFormedIdentifier = (value: string): boolean => value.length > 0 && !loneSurrogate.test(value)

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const durableIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(Boundary.maximumIdentifierLength),
  Schema.makeFilter(
    (value: string) => wellFormedIdentifier(value) && Boundary.isDurableText(value),
    { title: "durableIdentifier" }
  )
)

/**
 * Maximum nesting admitted for executable run state.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const maximumRunJsonDepth = 128

/**
 * Maximum values and members admitted for executable run state.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const maximumRunJsonNodes = 100_000

const runJsonLimits: Boundary.JsonLimits = {
  maxDepth: maximumRunJsonDepth,
  maxMembers: maximumRunJsonNodes,
  maxNodes: maximumRunJsonNodes
}

/**
 * Stable run states understood by the durability layer.
 *
 * @since 0.1.0
 * @category models
 */
export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled"
])

/**
 * A stable run state.
 *
 * @since 0.1.0
 * @category models
 */
export type RunStatus = typeof RunStatus.Type

/**
 * The run states a run never leaves.
 *
 * Named because two rules are written against exactly this set: a settled run
 * refuses new cancellation intent ({@link RequestCancelOutcome}), and a
 * settled row is never claimed, activated, or swept.
 *
 * @since 0.1.0
 * @category models
 */
export const TerminalRunStatus = Schema.Literals(["completed", "failed", "cancelled"])

/**
 * The type of {@link TerminalRunStatus}.
 *
 * @since 0.1.0
 * @category models
 */
export type TerminalRunStatus = typeof TerminalRunStatus.Type

/**
 * Whether a status is one a run never leaves.
 *
 * @since 0.1.0
 * @category models
 */
export const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  status === "completed" || status === "failed" || status === "cancelled"

/**
 * Stable failure codes surfaced by `RunStore`.
 *
 * @since 0.1.0
 * @category errors
 */
export const RunStoreErrorCode = Schema.Literals([
  "invalid_run",
  "not_found_row",
  "constraint",
  "decode_failed",
  "persistence_failed"
])

/**
 * A stable `RunStore` failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type RunStoreErrorCode = typeof RunStoreErrorCode.Type

/**
 * A normalized run persistence failure.
 *
 * Compare-and-swap competition is represented by successful outcome values,
 * never by this error channel.
 *
 * The identity string equals the defining module path, which is how every
 * tagged identity in this package is named.
 *
 * @since 0.1.0
 * @category errors
 */
export class RunStoreError extends Schema.TaggedError<RunStoreError>()("@smthrs/run-store/RunStoreError", {
  code: RunStoreErrorCode,
  method: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * The exact persisted fields guarded by a claim and its later activation.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunSnapshot {
  readonly status: RunStatus
  readonly owner: OwnerId | null
  readonly heartbeatAtMs: number | null
}

/**
 * A decoded row in `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunRow extends RunSnapshot {
  readonly runId: string
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly claim: OwnerId | null
  readonly claimedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  /**
   * The trampoline lineage this run is a round of, and which round it is.
   * `null` on every run that is not part of a lineage, which reads as round 0
   * of a lineage of one.
   *
   * Optional on the interface so a caller that builds a `RunRow` by hand —
   * a time-travel fixture, a recovery double — keeps compiling: the pair was
   * added by an append-only migration, and every reader must already tolerate
   * a row written before it.
   */
  readonly lineageId?: string | null | undefined
  readonly roundOrdinal?: number | null | undefined
  readonly stateJson: string
}

/**
 * Metadata recorded when a run row is created.
 *
 * `parentRunId` is the ancestry edge a fork, rewind, child, or later
 * trampoline round carries. It is a column rather than a `state_json` field
 * because ancestry is walked in SQL.
 *
 * `lineageId` and `roundOrdinal` are the trampoline pair: which lineage a run
 * is a round of, and which round. Both absent — the ordinary case — means the
 * run is a lineage of one, and is read back as round 0 of itself.
 *
 * @since 0.1.0
 * @category models
 */
export interface CreateOptions {
  readonly parentRunId?: string | undefined
  readonly lineageId?: string | undefined
  readonly roundOrdinal?: number | undefined
}

/**
 * An extra compare-and-swap predicate over first-class run metadata.
 *
 * A guard is the seam for lifecycle rules a harness must enforce atomically —
 * `{ cancelRequested: "absent" }` is the "do not finalize a run someone asked
 * to cancel" rule, expressed as SQL rather than as a read-then-write race.
 *
 * @since 0.1.0
 * @category models
 */
export const TransitionGuard = Schema.Struct({
  cancelRequested: Schema.optional(Schema.Literals(["absent", "present"] as const))
})

/**
 * An extra compare-and-swap predicate over first-class run metadata.
 *
 * @since 0.1.0
 * @category models
 */
export type TransitionGuard = typeof TransitionGuard.Type

/**
 * Result of recording a cancellation request.
 *
 * The request is deliberately unfenced: any observer may ask, and the owner
 * decides. `requestedAtMs` is the winning request, so a repeat request reports
 * the original time rather than overwriting it.
 *
 * @since 0.1.0
 * @category models
 */
export type RequestCancelOutcome =
  | { readonly _tag: "CancelRequested"; readonly requestedAtMs: number }
  | { readonly _tag: "AlreadyRequested"; readonly requestedAtMs: number }
  | { readonly _tag: "NotFound" }
  /**
   * The run had already settled, so nothing was recorded. A terminal run has
   * no owner and no drive to observe a request, so writing one would leave
   * intent nothing ever acts on — and a reader that takes the column as live
   * intent (`RunDriver.inheritParentCancellation`) would cancel children a
   * `completed` parent had finished with. The status says which ending the
   * request lost to.
   */
  | { readonly _tag: "Terminal"; readonly status: TerminalRunStatus }

/**
 * Result of acquiring claim columns for a later activation.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimOutcome =
  | { readonly _tag: "Claimed"; readonly claimedAtMs: number }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of stealing an exact run snapshot after liveness evidence is checked.
 *
 * `LivenessUnconfirmed` means the supplied evidence did not match the
 * snapshot's owner, the host relation its `kind` requires, or `nowMs`, so the
 * steal was refused before any compare-and-swap ran. The other tags have the
 * same meaning as {@link ClaimOutcome} after the comparison runs.
 *
 * @since 1.0.0-rc.0
 * @category models
 */
export type StealOutcome = ClaimOutcome | { readonly _tag: "LivenessUnconfirmed" }

/**
 * Result of claiming and activating ownership in one compare-and-swap.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimAndOwnOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }
  /**
   * The caller's exact snapshot is still current, its different owner has a
   * stale heartbeat, and no matching `LivenessEvidence` was supplied, so no
   * compare-and-swap ran. Re-reading and retrying cannot make progress; supply
   * evidence, or use `steal`. A current fresh heartbeat instead reports
   * `HeartbeatFresh`, because evidence cannot satisfy the stale-lease predicate.
   */
  | { readonly _tag: "EvidenceRequired" }

type ClaimLossOutcome = Exclude<ClaimOutcome, { readonly _tag: "Claimed" }>

/**
 * Result of activating a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type ActivateOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "ClaimLost" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of clearing a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type AbandonClaimOutcome =
  | { readonly _tag: "Abandoned" }
  | { readonly _tag: "ClaimLost" }

/**
 * Result of clearing an exact stale claim after its claimant was proven dead.
 *
 * @since 0.1.0
 * @category models
 */
export type RecoverClaimOutcome =
  | { readonly _tag: "Recovered" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "ClaimFresh" }
  | { readonly _tag: "ClaimChanged" }
  | { readonly _tag: "LivenessUnconfirmed" }

/**
 * Result of a fenced ownership heartbeat.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatOutcome =
  | { readonly _tag: "Updated" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }

/**
 * Result of a fenced owned transition.
 *
 * @since 0.1.0
 * @category models
 */
export type TransitionOutcome =
  | { readonly _tag: "Transitioned" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "GuardFailed" }

/**
 * Fenced persistence operations for durable runs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly create: (
    runId: string,
    stateJson: string,
    options?: CreateOptions | undefined
  ) => Effect.Effect<void, RunStoreError>
  readonly get: (runId: string) => Effect.Effect<RunRow, RunStoreError>
  /**
   * Reads every persisted round of this run's trampoline lineage, in ordinal
   * order, from any member execution ID. An older root with null lineage
   * columns is included as round zero. Missing IDs return an empty array.
   * Fork ancestry alone does not join lineages. This is a snapshot read;
   * callers making lifecycle decisions must hold their shared write transaction.
   */
  readonly lineage: (runId: string) => Effect.Effect<ReadonlyArray<RunRow>, RunStoreError>
  /** Reads only the highest persisted round; fails with not_found_row for an unknown ID. */
  readonly latestRound: (runId: string) => Effect.Effect<RunRow, RunStoreError>
  /** Records an unfenced cancellation request that later guarded transitions observe. */
  readonly requestCancel: (runId: string, nowMs: number) => Effect.Effect<RequestCancelOutcome, RunStoreError>
  /**
   * Records the first owner observation of durable intent. Returns false if
   * intent is absent or the running owner fence no longer matches.
   */
  readonly acknowledgeCancel: (runId: string, owner: OwnerId, nowMs: number) => Effect.Effect<boolean, RunStoreError>
  /**
   * Resolves and requests every non-terminal round in one write transaction.
   * Terminal is returned only when the entire logical run has settled; its
   * status is the last round's status. Child-DAG cascading belongs to the
   * engine. Ordinary requestCancel remains the explicitly round-scoped port.
   */
  readonly requestCancelLineage: (runId: string, nowMs: number) => Effect.Effect<RequestCancelOutcome, RunStoreError>
  /**
   * Claims an exact pending or suspended snapshot for a later `activate`.
   * `nowMs` becomes `claimed_at_ms`, so it must not run ahead of the Effect
   * `Clock` by more than `heartbeatSkewAllowance`; a reading that does fails
   * with `invalid_run`.
   */
  readonly claim: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number
  ) => Effect.Effect<ClaimOutcome, RunStoreError>
  /**
   * Claims and activates an exact snapshot atomically under the supplied owner.
   * Replacing a different running owner also requires matching liveness evidence.
   * A composition builds that `LivenessEvidence` with a `LivenessProbe`.
   * `evidence.checkedAtMs` must equal `nowMs` exactly, so evidence probed at T
   * is refused when this operation is called at T+1. `nowMs` is the lease
   * cutoff and the new heartbeat, so it must not run ahead of the Effect
   * `Clock` by more than `heartbeatSkewAllowance`; a reading that does fails
   * with `invalid_run`.
   */
  readonly claimAndOwn: (
    runId: string,
    expected: RunSnapshot,
    owner: OwnerId,
    nowMs: number,
    evidence?: LivenessEvidence | undefined
  ) => Effect.Effect<ClaimAndOwnOutcome, RunStoreError>
  readonly activate: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number,
    expected: RunSnapshot
  ) => Effect.Effect<ActivateOutcome, RunStoreError>
  readonly abandonClaim: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number
  ) => Effect.Effect<AbandonClaimOutcome, RunStoreError>
  /**
   * Recovers an exact stale claim after matching its claimant and liveness
   * evidence. A composition builds `LivenessEvidence` with a `LivenessProbe`.
   * `evidence.checkedAtMs` must equal `nowMs` exactly, so evidence probed at T
   * is refused when this operation is called at T+1. `nowMs` is the staleness
   * cutoff, so it must not run ahead of the Effect `Clock` by more than
   * `heartbeatSkewAllowance`; a reading that does fails with `invalid_run`.
   * `claimedAtMs` is the fence token compared against the row and carries no
   * such bound.
   */
  readonly recoverClaim: (
    runId: string,
    staleClaimant: OwnerId,
    claimedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<RecoverClaimOutcome, RunStoreError>
  /**
   * Renews the owner's lease. The write is monotonic, so a reading behind the
   * persisted heartbeat still reports `Updated` without moving it back. `nowMs`
   * must not run ahead of the Effect `Clock` by more than
   * `heartbeatSkewAllowance`; a reading that does fails with `invalid_run`
   * instead of pinning the lease past the cutoff.
   */
  readonly heartbeat: (
    runId: string,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<HeartbeatOutcome, RunStoreError>
  readonly transitionOwned: (
    runId: string,
    owner: OwnerId,
    toStatus: RunStatus,
    stateJson?: string | undefined,
    guard?: TransitionGuard | undefined
  ) => Effect.Effect<TransitionOutcome, RunStoreError>
  /**
   * Steals an exact run snapshot after matching liveness evidence for its
   * recorded owner. A composition builds `LivenessEvidence` with a
   * `LivenessProbe`. `evidence.checkedAtMs` must equal `nowMs` exactly, so
   * evidence probed at T is refused when this operation is called at T+1.
   * `LivenessUnconfirmed` means the evidence did not match and no
   * compare-and-swap ran. `nowMs` is the staleness cutoff, so it must not run
   * ahead of the Effect `Clock` by more than `heartbeatSkewAllowance`; a
   * reading that does fails with `invalid_run` before any comparison.
   */
  readonly steal: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<StealOutcome, RunStoreError>
}

/**
 * Service tag for fenced run persistence.
 *
 * The identity string equals the defining module path, which is how every
 * service in this package is named.
 *
 * @since 0.1.0
 * @category services
 */
export class RunStore extends Context.Service<RunStore, Service>()("@smthrs/run-store/RunStore") {}

const claimed = (claimedAtMs: number): ClaimOutcome => ({ _tag: "Claimed", claimedAtMs })
const notFound = { _tag: "NotFound" } as const
const alreadyClaimed = { _tag: "AlreadyClaimed" } as const
const heartbeatFresh = { _tag: "HeartbeatFresh" } as const
const snapshotChanged = { _tag: "SnapshotChanged" } as const
const evidenceRequired = { _tag: "EvidenceRequired" } as const
const activated = { _tag: "Activated" } as const
const claimLost = { _tag: "ClaimLost" } as const
const abandoned = { _tag: "Abandoned" } as const
const recovered = { _tag: "Recovered" } as const
const claimFresh = { _tag: "ClaimFresh" } as const
const claimChanged = { _tag: "ClaimChanged" } as const
const livenessUnconfirmed = { _tag: "LivenessUnconfirmed" } as const
const updated = { _tag: "Updated" } as const
const fenceLost = { _tag: "FenceLost" } as const
const transitioned = { _tag: "Transitioned" } as const
const guardFailed = { _tag: "GuardFailed" } as const

/**
 * The staleness cutoff in milliseconds, derived from the one definition rather
 * than restated. `Ownership` imports `RunStore`, so the shared constants live
 * in the `Heartbeat` leaf both can reach.
 */
const heartbeatStaleAfterMs = Duration.toMillis(heartbeatStaleAfter)
const heartbeatSkewAllowanceMs = Duration.toMillis(heartbeatSkewAllowance)
const terminalStatuses: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"])

const DatabaseRunRow = Schema.Struct({
  runId: durableIdentifier,
  status: RunStatus,
  createdAtMs: NonNegativeSafeInt,
  startedAtMs: Schema.NullOr(NonNegativeSafeInt),
  finishedAtMs: Schema.NullOr(NonNegativeSafeInt),
  ownerHostId: Schema.NullOr(durableIdentifier),
  ownerPid: Schema.NullOr(NonNegativeSafeInt),
  ownerNonce: Schema.NullOr(durableIdentifier),
  heartbeatAtMs: Schema.NullOr(NonNegativeSafeInt),
  claimHostId: Schema.NullOr(durableIdentifier),
  claimPid: Schema.NullOr(NonNegativeSafeInt),
  claimNonce: Schema.NullOr(durableIdentifier),
  claimedAtMs: Schema.NullOr(NonNegativeSafeInt),
  parentRunId: Schema.NullOr(durableIdentifier),
  cancelRequestedAtMs: Schema.NullOr(NonNegativeSafeInt),
  lineageId: Schema.NullOr(durableIdentifier),
  roundOrdinal: Schema.NullOr(NonNegativeSafeInt),
  stateJson: Schema.String
})

type DatabaseRunRow = typeof DatabaseRunRow.Type

const runStoreError = (
  method: string,
  code: RunStoreErrorCode,
  message: string,
  cause: unknown
): RunStoreError =>
  new RunStoreError({
    code,
    method,
    message: `${code}: RunStore.${method}: ${message}`,
    cause
  })

const persistenceError = (method: string, cause: RunStoreError | DatabaseError): RunStoreError => {
  if (Schema.is(RunStoreError)(cause)) return cause
  const code = cause.code === "constraint"
    ? "constraint"
    : "persistence_failed"
  return runStoreError(method, code, "database operation failed", {
    category: code,
    // Keep the classification for outer transaction retries, never driver
    // causes that may contain executable state or bound SQL values.
    cause: new DatabaseError({ code: cause.code })
  })
}

const invalidRunError = (
  method: string,
  causeOrField: unknown,
  detail = "violates the durable contract"
): RunStoreError =>
  runStoreError(
    method,
    "invalid_run",
    "run input is invalid",
    typeof causeOrField === "string" ? { field: causeOrField, detail } : causeOrField
  )

const stateAdmission = (value: unknown) => Boundary.admitJsonText(value, runJsonLimits)

const isJsonString = (value: unknown): value is string =>
  Schema.decodeUnknownResult(UnknownFromJsonString)(value)._tag === "Success"

const validOwner = (value: unknown): value is OwnerId =>
  Schema.is(OwnerId)(value) &&
  Boundary.isDurableText(value.hostId) &&
  Boundary.isDurableText(value.nonce) &&
  Number.isSafeInteger(value.pid) &&
  value.pid >= 0

/** Caller timestamps are SQLite-safe, non-negative integer millisecond readings. */
const validTimestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const ownData = (input: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
    ? descriptor.value
    : undefined
}

const inertRecord = (input: unknown, allowed: ReadonlySet<string>): input is object => {
  if (typeof input !== "object" || input === null) return false
  try {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || !descriptor.enumerable) continue
      if (typeof key !== "string" || !allowed.has(key) || !("value" in descriptor)) return false
    }
    return true
  } catch {
    return false
  }
}

const snapshotOwner = (method: string, field: string, input: unknown): Effect.Effect<OwnerId, RunStoreError> =>
  Effect.suspend(() => {
    if (!inertRecord(input, new Set(["hostId", "pid", "nonce"]))) {
      return Effect.fail(invalidRunError(method, field, "must be an inert owner record"))
    }
    const owner = Object.freeze({
      hostId: ownData(input, "hostId"),
      pid: ownData(input, "pid"),
      nonce: ownData(input, "nonce")
    })
    return validOwner(owner)
      ? Effect.succeed(owner)
      : Effect.fail(invalidRunError(method, field, "must be a valid owner identity"))
  })

const snapshotRunId = (method: string, input: unknown): Effect.Effect<string, RunStoreError> =>
  typeof input === "string" && wellFormedIdentifier(input) && Boundary.isDurableText(input)
    ? Effect.succeed(input)
    : Effect.fail(invalidRunError(method, "runId", "must be well-formed durable text"))

const snapshotTimestamp = (
  method: string,
  field: string,
  input: unknown
): Effect.Effect<number, RunStoreError> =>
  typeof input === "number" && validTimestamp(input)
    ? Effect.succeed(input)
    : Effect.fail(
      invalidRunError(method, field, "must be a non-negative safe integer")
    )

/**
 * Admits a caller's lease reading. Once admitted the reading is authoritative:
 * it is the cutoff the lease predicate compares against and the stamp the row
 * keeps. The store refuses only a reading that runs ahead of its own `Clock`
 * by more than `heartbeatSkewAllowance`, because no composition produces one
 * honestly (the caller and the store share a process) and it is the one lever
 * that steals a fresh owner or pins a lease past the cutoff. A reading behind
 * the clock is admitted: it makes every staleness judgment more conservative,
 * and `heartbeat`'s monotonic write absorbs it.
 */
const snapshotLeaseReading = (
  method: string,
  field: string,
  input: unknown,
  cause: { readonly runId: string; readonly claimedAtMs?: number }
): Effect.Effect<number, RunStoreError> =>
  Effect.gen(function*() {
    const nowMs = yield* snapshotTimestamp(method, field, input)
    const clockMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    if (nowMs > clockMs + heartbeatSkewAllowanceMs) {
      return yield* Effect.fail(
        invalidRunError(method, {
          ...cause,
          field,
          nowMs,
          clockMs,
          detail: "runs ahead of the store clock by more than the heartbeat skew allowance"
        })
      )
    }
    return nowMs
  })

const snapshotState = (
  method: string,
  input: unknown,
  cause: unknown
): Effect.Effect<string, RunStoreError> => {
  const admitted = stateAdmission(input)
  return admitted.ok
    ? Effect.succeed(admitted.value)
    : Effect.fail(
      invalidRunError(
        method,
        cause,
        admitted.complaint
      )
    )
}

const snapshotCreateOptions = (
  input: unknown
): Effect.Effect<
  Readonly<{ parentRunId: string | null; lineageId: string | null; roundOrdinal: number | null }>,
  RunStoreError
> =>
  Effect.suspend(() => {
    const value = input ?? {}
    if (!inertRecord(value, new Set(["parentRunId", "lineageId", "roundOrdinal"]))) {
      return Effect.fail(invalidRunError("create", "options", "must be an inert data record"))
    }
    const rawParent = ownData(value, "parentRunId")
    const rawLineage = ownData(value, "lineageId")
    const rawRound = ownData(value, "roundOrdinal")
    const parentRunId = rawParent === undefined ? null : rawParent
    const lineageId = rawLineage === undefined ? null : rawLineage
    const roundOrdinal = rawRound === undefined ? null : rawRound
    if (
      (parentRunId !== null &&
        (typeof parentRunId !== "string" ||
          !wellFormedIdentifier(parentRunId) ||
          !Boundary.isDurableText(parentRunId))) ||
      (lineageId !== null &&
        (typeof lineageId !== "string" ||
          !wellFormedIdentifier(lineageId) ||
          !Boundary.isDurableText(lineageId))) ||
      (roundOrdinal !== null && (typeof roundOrdinal !== "number" || !validTimestamp(roundOrdinal))) ||
      (lineageId === null) !== (roundOrdinal === null)
    ) return Effect.fail(invalidRunError("create", "options", "contains invalid ancestry or lineage"))
    return Effect.succeed(Object.freeze({ parentRunId, lineageId, roundOrdinal }))
  })

/**
 * Structural admission for a value typed as a required-field record. `RunRow`
 * extends `RunSnapshot`, so a row from `get` must pass wherever an expected
 * snapshot is typed: extra own data fields are ignored, while a non-plain
 * prototype, any enumerable accessor, or a missing or inherited required field
 * is still refused. Only the required fields are read, and only as own data.
 */
const inertFields = (input: unknown, required: ReadonlyArray<string>): input is object => {
  if (typeof input !== "object" || input === null) return false
  try {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor !== undefined && descriptor.enumerable && !("value" in descriptor)) return false
    }
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (descriptor === undefined || !descriptor.enumerable) return false
    }
    return true
  } catch {
    return false
  }
}

const snapshotExpected = (
  method: string,
  input: unknown
): Effect.Effect<RunSnapshot, RunStoreError> =>
  Effect.gen(function*() {
    if (!inertFields(input, ["status", "owner", "heartbeatAtMs"])) {
      return yield* Effect.fail(invalidRunError(method, "expected", "must be an inert snapshot record"))
    }
    const status = ownData(input, "status")
    const rawOwner = ownData(input, "owner")
    const heartbeatAtMs = ownData(input, "heartbeatAtMs")
    if (
      !Schema.is(RunStatus)(status) ||
      (heartbeatAtMs !== null && (typeof heartbeatAtMs !== "number" || !validTimestamp(heartbeatAtMs)))
    ) {
      return yield* Effect.fail(invalidRunError(method, "expected", "contains an invalid status or heartbeat"))
    }
    const owner = rawOwner === null ? null : yield* snapshotOwner(method, "expected.owner", rawOwner)
    if (
      status === "running"
        ? owner === null || heartbeatAtMs === null
        : owner !== null || heartbeatAtMs !== null
    ) {
      return yield* Effect.fail(invalidRunError(method, "expected", "violates ownership invariants"))
    }
    return Object.freeze({ status, owner, heartbeatAtMs })
  })

const snapshotEvidence = (
  method: string,
  input: unknown
): Effect.Effect<LivenessEvidence, RunStoreError> =>
  Effect.gen(function*() {
    if (!inertRecord(input, new Set(["expectedOwner", "checkedAtMs", "kind"]))) {
      return yield* Effect.fail(invalidRunError(method, "evidence", "must be an inert evidence record"))
    }
    const expectedOwner = yield* snapshotOwner(method, "evidence.expectedOwner", ownData(input, "expectedOwner"))
    const checkedAtMs = yield* snapshotTimestamp(method, "evidence.checkedAtMs", ownData(input, "checkedAtMs"))
    const kind = ownData(input, "kind")
    if (
      kind !== "same-host-pid-dead" &&
      kind !== "cross-host-unreachable-stale" &&
      kind !== "lease-expired"
    ) return yield* Effect.fail(invalidRunError(method, "evidence.kind"))
    return Object.freeze({ expectedOwner, checkedAtMs, kind })
  })

const snapshotGuard = (
  input: unknown
): Effect.Effect<TransitionGuard | undefined, RunStoreError> =>
  Effect.suspend(() => {
    if (input === undefined) return Effect.succeed(undefined)
    if (!inertRecord(input, new Set(["cancelRequested"]))) {
      return Effect.fail(invalidRunError("transitionOwned", "guard", "must be an inert exact guard"))
    }
    const cancelRequested = ownData(input, "cancelRequested")
    if (cancelRequested !== undefined && cancelRequested !== "absent" && cancelRequested !== "present") {
      return Effect.fail(invalidRunError("transitionOwned", "guard.cancelRequested"))
    }
    return Effect.succeed(Object.freeze(cancelRequested === undefined ? {} : { cancelRequested }))
  })

const ownerFromColumns = (
  hostId: string | null,
  pid: number | null,
  nonce: string | null
): OwnerId | null | undefined => {
  if (hostId === null && pid === null && nonce === null) return null
  if (hostId !== null && pid !== null && nonce !== null) {
    // DatabaseRunRow already admitted all three columns through the stricter
    // durable identifier and safe-integer schemas.
    return Object.freeze({ hostId, pid, nonce })
  }
  return undefined
}

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

const rowMatchesClaim = (row: DatabaseRunRow, claimant: OwnerId, claimedAtMs: number): boolean =>
  row.claimHostId === claimant.hostId &&
  row.claimPid === claimant.pid &&
  row.claimNonce === claimant.nonce &&
  row.claimedAtMs === claimedAtMs

const rowMatchesSnapshot = (row: DatabaseRunRow, expected: RunSnapshot): boolean =>
  row.status === expected.status &&
  row.ownerHostId === (expected.owner?.hostId ?? null) &&
  row.ownerPid === (expected.owner?.pid ?? null) &&
  row.ownerNonce === (expected.owner?.nonce ?? null) &&
  row.heartbeatAtMs === expected.heartbeatAtMs

const decodeRunRow = (method: string, runId: string, input: unknown): Effect.Effect<RunRow, RunStoreError> =>
  Schema.decodeUnknownEffect(DatabaseRunRow)(input).pipe(
    Effect.mapError(() =>
      runStoreError(method, "decode_failed", "could not decode flows_runs row", { runId, stage: "row-schema" })
    ),
    Effect.flatMap((row) => {
      const owner = ownerFromColumns(row.ownerHostId, row.ownerPid, row.ownerNonce)
      const claim = ownerFromColumns(row.claimHostId, row.claimPid, row.claimNonce)
      const admittedState = stateAdmission(row.stateJson)
      const stateJsonValid = isJsonString(row.stateJson)
      const invalidOwner = owner === undefined ||
        (owner === null && row.heartbeatAtMs !== null) ||
        (owner !== null && row.heartbeatAtMs === null) ||
        (row.status === "running" ? owner === null : owner !== null)
      const invalidClaim = claim === undefined ||
        (claim === null && row.claimedAtMs !== null) ||
        (claim !== null && row.claimedAtMs === null)
      if (invalidOwner || invalidClaim || !admittedState.ok) {
        // The cause is published to logs, spans, and telemetry. Executable
        // state may carry credentials, so report only the invariants read here.
        return Effect.fail(
          runStoreError(method, "decode_failed", "flows_runs row violates durable invariants", {
            runId,
            status: row.status,
            heartbeatAtMs: row.heartbeatAtMs,
            claimedAtMs: row.claimedAtMs,
            hasClaimColumns: row.claimHostId !== null || row.claimPid !== null || row.claimNonce !== null,
            hasOwnerColumns: row.ownerHostId !== null || row.ownerPid !== null || row.ownerNonce !== null,
            stateJsonValid
          })
        )
      }
      return Effect.succeed(Object.freeze({
        runId: row.runId,
        status: row.status,
        createdAtMs: row.createdAtMs,
        startedAtMs: row.startedAtMs,
        finishedAtMs: row.finishedAtMs,
        owner,
        heartbeatAtMs: row.heartbeatAtMs,
        claim,
        claimedAtMs: row.claimedAtMs,
        parentRunId: row.parentRunId,
        cancelRequestedAtMs: row.cancelRequestedAtMs,
        lineageId: row.lineageId,
        roundOrdinal: row.roundOrdinal,
        stateJson: row.stateJson
      }))
    })
  )

/**
 * Rows that belong to the logical run containing `runId`: every round that
 * names the resolved lineage, plus the root itself when its own lineage
 * columns are null or name that lineage. A same-named run in an independent
 * lineage is excluded. Shared by every lineage read and write so membership
 * cannot drift between them.
 */
const lineageMembership = (sql: SqlClient.SqlClient, runId: string) =>
  sql`(
    lineage_id = (SELECT COALESCE(lineage_id, run_id) FROM flows_runs WHERE run_id = ${runId})
    OR (
      run_id = (SELECT COALESCE(lineage_id, run_id) FROM flows_runs WHERE run_id = ${runId})
      AND (
        lineage_id IS NULL
        OR lineage_id = (SELECT COALESCE(lineage_id, run_id) FROM flows_runs WHERE run_id = ${runId})
      )
    )
  )`

/** The status and request columns a cancellation miss is classified from. */
interface CancellationRow {
  readonly requestedAtMs: number | null
  readonly status: string
}

/**
 * Names the outcome of a guarded cancellation UPDATE that matched nothing.
 *
 * `rows` are the lineage members in round order; an absent set is `NotFound`.
 * Status is read before the request column, so a settled run reports how it
 * ended even when its own closing request is still on the row. A live
 * unrequested row cannot survive the UPDATE inside one serialized writer
 * transaction, so it is a persistence invariant failure rather than a retry.
 */
const classifyCancellationMiss = (
  method: string,
  runId: string,
  rows: ReadonlyArray<CancellationRow>
): Effect.Effect<RequestCancelOutcome, RunStoreError> =>
  Effect.gen(function*() {
    let outcome: RequestCancelOutcome = notFound
    for (const row of rows) {
      const status = yield* Schema.decodeUnknownEffect(RunStatus)(row.status).pipe(
        Effect.mapError((cause) => runStoreError(method, "decode_failed", "could not decode flows_runs status", cause))
      )
      if (isTerminalRunStatus(status)) {
        // A terminal predecessor never hides a live round's request.
        if (outcome._tag !== "AlreadyRequested") outcome = { _tag: "Terminal", status }
        continue
      }
      if (row.requestedAtMs === null) {
        return yield* Effect.fail(
          runStoreError(method, "persistence_failed", "guarded cancellation update missed a live unrequested row", {
            runId,
            stage: "write-invariant"
          })
        )
      }
      outcome = { _tag: "AlreadyRequested", requestedAtMs: Number(row.requestedAtMs) }
    }
    return outcome
  })

const selectRun = (sql: SqlClient.SqlClient, runId: string, mode: "single" | "lineage" | "latest" = "single") =>
  sql<DatabaseRunRow>`
    SELECT
      run_id AS "runId",
      status AS "status",
      created_at_ms AS "createdAtMs",
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      owner_host_id AS "ownerHostId",
      owner_pid AS "ownerPid",
      owner_nonce AS "ownerNonce",
      heartbeat_at_ms AS "heartbeatAtMs",
      claim_host_id AS "claimHostId",
      claim_pid AS "claimPid",
      claim_nonce AS "claimNonce",
      claimed_at_ms AS "claimedAtMs",
      parent_run_id AS "parentRunId",
      cancel_requested_at_ms AS "cancelRequestedAtMs",
      lineage_id AS "lineageId",
      round_ordinal AS "roundOrdinal",
      state_json AS "stateJson"
    FROM flows_runs
    WHERE ${
    mode === "latest"
      ? sql`run_id = COALESCE(
        (SELECT run_id FROM flows_runs
         WHERE lineage_id = (SELECT COALESCE(lineage_id, run_id) FROM flows_runs WHERE run_id = ${runId})
         ORDER BY round_ordinal DESC LIMIT 1),
        (SELECT run_id FROM flows_runs WHERE run_id = ${runId})
      )`
      : mode === "lineage"
      ? lineageMembership(sql, runId)
      : sql`run_id = ${runId}`
  }
    ORDER BY COALESCE(round_ordinal, 0), run_id
  `

const classifyClaimLoss = (
  row: DatabaseRunRow | undefined,
  nowMs: number
): ClaimLossOutcome => {
  if (row === undefined) return notFound
  if (row.claimHostId !== null) return alreadyClaimed
  if (
    row.status === "running" &&
    row.heartbeatAtMs !== null &&
    row.heartbeatAtMs >= nowMs - heartbeatStaleAfterMs
  ) {
    return heartbeatFresh
  }
  return snapshotChanged
}

const evidenceMatches = (
  expected: RunSnapshot,
  claimant: OwnerId,
  checkedAtMs: number,
  evidence: LivenessEvidence
): boolean =>
  expected.status === "running" &&
  expected.owner !== null &&
  evidenceMatchesOwner(expected.owner, claimant, checkedAtMs, evidence)

const evidenceMatchesOwner = (
  expectedOwner: OwnerId,
  observer: OwnerId,
  checkedAtMs: number,
  evidence: LivenessEvidence
): boolean => {
  if (!sameOwner(expectedOwner, evidence.expectedOwner) || evidence.checkedAtMs !== checkedAtMs) return false
  switch (evidence.kind) {
    // A pid means nothing outside the host that owns the process namespace.
    case "same-host-pid-dead":
      return expectedOwner.hostId === observer.hostId
    // Unreachability is what a peer host observes; on the owner's own host it
    // would be an unprobed guess dressed as evidence.
    case "cross-host-unreachable-stale":
      return expectedOwner.hostId !== observer.hostId
    // The lease is host-neutral, and the write verifies the same caller-clock
    // cutoff named by this evidence. The in-process caller owns that clock.
    case "lease-expired":
      return true
  }
}

/**
 * Constructs the production `RunStore` implementation.
 *
 * `state_json` is executable state: it is decoded and re-entered on every
 * resume, so it is persisted and returned byte-for-byte. Nothing rewrites it
 * on the way through — a redactor here would silently change what the flow
 * re-reads (issue #72). `Schema.Redacted` hides inspection but allows schema
 * JSON encoding by default. Use `Schema.Redacted(Schema.String, {
 * disallowJsonEncode: true })` to refuse JSON encoding, or exclude credentials
 * from the persistence schema and store a secret reference resolved from a
 * secret provider on resume. Publication hygiene belongs on journal-event
 * and export surfaces.
 *
 * `state_json` and `flows_attempts.outcome_json` therefore hold unredacted
 * run inputs and results, so the run's SQLite file (`.flows/*.db`) must be
 * handled as a secret store.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  const write = <A, R>(
    method: string,
    effect: Effect.Effect<A, SqlError.SqlError | RunStoreError, R>
  ): Effect.Effect<A, RunStoreError, R> =>
    writer.write(effect).pipe(Effect.mapError((cause) => persistenceError(method, cause)))

  // A bare SELECT needs no write transaction and no replay; only the error
  // vocabulary stays shared with `write`.
  const read = <A, R>(
    method: string,
    effect: Effect.Effect<A, SqlError.SqlError, R>
  ): Effect.Effect<A, RunStoreError, R> =>
    effect.pipe(Effect.mapError((cause) => persistenceError(method, fromSqlError(cause))))

  const create = Effect.fn("RunStore.create")(
    (
      runIdInput: string,
      stateInput: string,
      optionsInput?: CreateOptions | undefined
    ): Effect.Effect<void, RunStoreError> =>
      Effect.gen(function*() {
        const runId = yield* snapshotRunId("create", runIdInput)
        const { lineageId, parentRunId, roundOrdinal } = yield* snapshotCreateOptions(optionsInput)
        // This cause is published to logs, spans, and telemetry. Executable
        // state may carry credentials, so include its shape but never its text.
        const stateJson = yield* snapshotState("create", stateInput, {
          runId,
          parentRunId,
          lineageId,
          roundOrdinal,
          stateJsonLength: typeof stateInput === "string" ? stateInput.length : null,
          stateJsonValid: isJsonString(stateInput)
        })
        yield* Effect.annotateCurrentSpan({ runId })
        const createdAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        yield* write(
          "create",
          sql`
            INSERT INTO flows_runs (
              run_id,
              status,
              created_at_ms,
              started_at_ms,
              finished_at_ms,
              owner_host_id,
              owner_pid,
              owner_nonce,
              heartbeat_at_ms,
              claim_host_id,
              claim_pid,
              claim_nonce,
              claimed_at_ms,
              parent_run_id,
              lineage_id,
              round_ordinal,
              state_json
            ) VALUES (
              ${runId},
              'pending',
              ${createdAtMs},
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              ${parentRunId},
              ${lineageId},
              ${roundOrdinal},
              ${stateJson}
            )
          `.pipe(Effect.asVoid)
        )
      }).pipe(observeExit)
  )

  const get = Effect.fn("RunStore.get")((runIdInput: string): Effect.Effect<RunRow, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("get", runIdInput)
      yield* Effect.annotateCurrentSpan({ runId })
      const rows = yield* read("get", selectRun(sql, runId))
      return rows[0] === undefined
        ? yield* Effect.fail(
          runStoreError("get", "not_found_row", `run ${runId} was not found`, { runId })
        )
        : yield* decodeRunRow("get", runId, rows[0])
    }).pipe(observeExit)
  )

  const lineage = Effect.fn("RunStore.lineage")((runIdInput: string) =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("lineage", runIdInput)
      yield* Effect.annotateCurrentSpan({ runId })
      const rows = yield* read("lineage", selectRun(sql, runId, "lineage"))
      return yield* Effect.forEach(rows, (row) => decodeRunRow("lineage", row.runId, row))
    }).pipe(observeExit)
  )

  const latestRound = Effect.fn("RunStore.latestRound")((runIdInput: string) =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("latestRound", runIdInput)
      yield* Effect.annotateCurrentSpan({ runId })
      const rows = yield* read("latestRound", selectRun(sql, runId, "latest"))
      return rows[0] === undefined
        ? yield* Effect.fail(runStoreError("latestRound", "not_found_row", `run ${runId} was not found`, { runId }))
        : yield* decodeRunRow("latestRound", rows[0].runId, rows[0])
    }).pipe(observeExit)
  )

  const requestCancel = Effect.fn("RunStore.requestCancel")((
    runIdInput: string,
    nowMsInput: number
  ): Effect.Effect<RequestCancelOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("requestCancel", runIdInput)
      const nowMs = yield* snapshotTimestamp("requestCancel", "nowMs", nowMsInput)
      yield* Effect.annotateCurrentSpan({ runId })
      return yield* write(
        "requestCancel",
        Effect.gen(function*() {
          // The status predicate is part of the compare-and-swap rather than
          // a read-then-write check: a run that settles between a caller's
          // read and this UPDATE must lose the write, not race it. The writer
          // serializes the whole transaction, so a miss is classified by one
          // read of the same columns and never retried.
          const rows = yield* sql<{ readonly requestedAtMs: number }>`
          UPDATE flows_runs
          SET cancel_requested_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND cancel_requested_at_ms IS NULL
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING cancel_requested_at_ms AS "requestedAtMs"
        `
          if (rows[0] !== undefined) {
            return { _tag: "CancelRequested", requestedAtMs: Number(rows[0].requestedAtMs) } as const
          }
          const current = yield* sql<CancellationRow>`
          SELECT cancel_requested_at_ms AS "requestedAtMs", status AS "status"
          FROM flows_runs WHERE run_id = ${runId}
        `
          return yield* classifyCancellationMiss("requestCancel", runId, current)
        })
      )
    }).pipe(observeOutcome<RequestCancelOutcome>())
  )

  const requestCancelLineage = Effect.fn("RunStore.requestCancelLineage")((runIdInput: string, nowMsInput: number) =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("requestCancelLineage", runIdInput)
      const nowMs = yield* snapshotTimestamp("requestCancelLineage", "nowMs", nowMsInput)
      yield* Effect.annotateCurrentSpan({ runId })
      return yield* write(
        "requestCancelLineage",
        Effect.gen(function*() {
          // One set-based guarded UPDATE over the lineage: cost follows the
          // members' metadata, never their state payloads, and a settled
          // history of any length adds no statements.
          const rows = yield* sql<{ readonly requestedAtMs: number }>`
          UPDATE flows_runs
          SET cancel_requested_at_ms = ${nowMs}
          WHERE ${lineageMembership(sql, runId)}
            AND cancel_requested_at_ms IS NULL
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING cancel_requested_at_ms AS "requestedAtMs"
        `
          if (rows[0] !== undefined) {
            return { _tag: "CancelRequested", requestedAtMs: Number(rows[0].requestedAtMs) } as const
          }
          // A previous request on any live round dominates a terminal
          // predecessor; otherwise the latest round's ending is reported.
          const members = yield* sql<CancellationRow>`
          SELECT cancel_requested_at_ms AS "requestedAtMs", status AS "status"
          FROM flows_runs
          WHERE ${lineageMembership(sql, runId)}
          ORDER BY COALESCE(round_ordinal, 0), run_id
        `
          return yield* classifyCancellationMiss("requestCancelLineage", runId, members)
        })
      )
    }).pipe(observeOutcome<RequestCancelOutcome>())
  )

  const claim = Effect.fn("RunStore.claim")((
    runIdInput: string,
    expectedInput: RunSnapshot,
    claimantInput: OwnerId,
    nowMsInput: number
  ): Effect.Effect<ClaimOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("claim", runIdInput)
      const expected = yield* snapshotExpected("claim", expectedInput)
      const claimant = yield* snapshotOwner("claim", "claimant", claimantInput)
      const nowMs = yield* snapshotLeaseReading(
        "claim",
        "nowMs",
        nowMsInput,
        { runId }
      )
      yield* Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId })
      return yield* write(
        "claim",
        Effect.gen(function*() {
          // `claim` never admits a running run, so it needs no staleness
          // disjunction. `status IN ('pending', 'suspended')` already excludes
          // 'running', which made the preceding `status <> 'running'` redundant
          // and the trailing `(status <> 'running' OR heartbeat IS NULL OR
          // heartbeat < cutoff)` a tautology — its first branch was already
          // known true. `claimAndOwn` is the method that genuinely needs the
          // staleness test, because it does admit 'running'.
          const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status IN ('pending', 'suspended')
            AND status = ${expected.status}
            AND owner_host_id IS NOT DISTINCT FROM ${expected.owner?.hostId ?? null}
            AND owner_pid IS NOT DISTINCT FROM ${expected.owner?.pid ?? null}
            AND owner_nonce IS NOT DISTINCT FROM ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS NOT DISTINCT FROM ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
          RETURNING run_id AS "runId"
        `
          if (rows.length > 0) return claimed(nowMs)
          const current = yield* selectRun(sql, runId)
          return classifyClaimLoss(current[0], nowMs)
        })
      )
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.claim[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "claim" })
    ))
  )

  const claimAndOwn = Effect.fn("RunStore.claimAndOwn")((
    runIdInput: string,
    expectedInput: RunSnapshot,
    ownerInput: OwnerId,
    nowMsInput: number,
    evidenceInput?: LivenessEvidence | undefined
  ): Effect.Effect<ClaimAndOwnOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("claimAndOwn", runIdInput)
      const expected = yield* snapshotExpected("claimAndOwn", expectedInput)
      const owner = yield* snapshotOwner("claimAndOwn", "owner", ownerInput)
      const nowMs = yield* snapshotLeaseReading(
        "claimAndOwn",
        "nowMs",
        nowMsInput,
        { runId }
      )
      const evidence = evidenceInput === undefined
        ? undefined
        : yield* snapshotEvidence("claimAndOwn", evidenceInput)
      yield* Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId })
      return yield* Effect.suspend((): Effect.Effect<ClaimAndOwnOutcome, RunStoreError> => {
        const canReplaceExpectedOwner = expected.status !== "running" ||
          (expected.owner !== null && sameOwner(expected.owner, owner)) ||
          (evidence !== undefined && evidenceMatches(expected, owner, nowMs, evidence))

        if (!canReplaceExpectedOwner) {
          return read("claimAndOwn", selectRun(sql, runId)).pipe(
            Effect.map((current) => {
              const row = current[0]
              // Classify the lease before upgrading an unchanged stale
              // snapshot. Evidence cannot displace a fresh heartbeat, so
              // naming evidence first would advise a retry the SQL must refuse.
              const loss = classifyClaimLoss(row, nowMs)
              return loss === snapshotChanged && row !== undefined && rowMatchesSnapshot(row, expected)
                ? evidenceRequired
                : loss
            })
          )
        }

        return write(
          "claimAndOwn",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            status = 'running',
            started_at_ms = COALESCE(started_at_ms, ${nowMs}),
            finished_at_ms = NULL,
            owner_host_id = ${owner.hostId},
            owner_pid = ${owner.pid},
            owner_nonce = ${owner.nonce},
            heartbeat_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status IN ('pending', 'suspended', 'running')
            AND status = ${expected.status}
            AND owner_host_id IS NOT DISTINCT FROM ${expected.owner?.hostId ?? null}
            AND owner_pid IS NOT DISTINCT FROM ${expected.owner?.pid ?? null}
            AND owner_nonce IS NOT DISTINCT FROM ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS NOT DISTINCT FROM ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
            AND (
              status <> 'running'
              OR heartbeat_at_ms IS NULL
              OR heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            )
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return activated
            const current = yield* selectRun(sql, runId)
            return classifyClaimLoss(current[0], nowMs)
          })
        )
      })
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.claimAndOwn[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "claim_and_own" })
    ))
  )

  const activate = Effect.fn("RunStore.activate")((
    runIdInput: string,
    claimantInput: OwnerId,
    claimedAtMsInput: number,
    expectedInput: RunSnapshot
  ): Effect.Effect<ActivateOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("activate", runIdInput)
      const claimant = yield* snapshotOwner("activate", "claimant", claimantInput)
      const claimedAtMs = yield* snapshotTimestamp(
        "activate",
        "claimedAtMs",
        claimedAtMsInput
      )
      const expected = yield* snapshotExpected("activate", expectedInput)
      yield* Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId })
      const activatedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      return yield* write(
        "activate",
        Effect.gen(function*() {
          const rows = yield* sql<{ readonly runId: string }>`
              UPDATE flows_runs
              SET
                status = 'running',
                started_at_ms = COALESCE(started_at_ms, ${activatedAtMs}),
                finished_at_ms = NULL,
                owner_host_id = ${claimant.hostId},
                owner_pid = ${claimant.pid},
                owner_nonce = ${claimant.nonce},
                heartbeat_at_ms = ${activatedAtMs},
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND status = ${expected.status}
                AND owner_host_id IS NOT DISTINCT FROM ${expected.owner?.hostId ?? null}
                AND owner_pid IS NOT DISTINCT FROM ${expected.owner?.pid ?? null}
                AND owner_nonce IS NOT DISTINCT FROM ${expected.owner?.nonce ?? null}
                AND heartbeat_at_ms IS NOT DISTINCT FROM ${expected.heartbeatAtMs}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
              RETURNING run_id AS "runId"
            `
          if (rows.length > 0) return activated

          const current = yield* selectRun(sql, runId)
          if (current[0] === undefined || !rowMatchesClaim(current[0], claimant, claimedAtMs)) return claimLost

          yield* sql`
              UPDATE flows_runs
              SET
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
            `
          return snapshotChanged
        })
      )
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.activate[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "activate" })
    ))
  )

  const abandonClaim = Effect.fn("RunStore.abandonClaim")((
    runIdInput: string,
    claimantInput: OwnerId,
    claimedAtMsInput: number
  ): Effect.Effect<AbandonClaimOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("abandonClaim", runIdInput)
      const claimant = yield* snapshotOwner("abandonClaim", "claimant", claimantInput)
      const claimedAtMs = yield* snapshotTimestamp("abandonClaim", "claimedAtMs", claimedAtMsInput)
      yield* Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId })
      return yield* write(
        "abandonClaim",
        Effect.map(
          sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${claimant.hostId}
            AND claim_pid = ${claimant.pid}
            AND claim_nonce = ${claimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
          RETURNING run_id AS "runId"
        `,
          (rows) => rows.length > 0 ? abandoned : claimLost
        )
      )
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.abandonClaim[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "abandon_claim" })
    ))
  )

  const recoverClaim = Effect.fn("RunStore.recoverClaim")((
    runIdInput: string,
    staleClaimantInput: OwnerId,
    claimedAtMsInput: number,
    observerInput: OwnerId,
    nowMsInput: number,
    evidenceInput: LivenessEvidence
  ): Effect.Effect<RecoverClaimOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("recoverClaim", runIdInput)
      const staleClaimant = yield* snapshotOwner("recoverClaim", "staleClaimant", staleClaimantInput)
      const claimedAtMs = yield* snapshotTimestamp(
        "recoverClaim",
        "claimedAtMs",
        claimedAtMsInput
      )
      const observer = yield* snapshotOwner("recoverClaim", "observer", observerInput)
      const nowMs = yield* snapshotLeaseReading("recoverClaim", "nowMs", nowMsInput, { runId, claimedAtMs })
      const evidence = yield* snapshotEvidence("recoverClaim", evidenceInput)
      yield* Effect.annotateCurrentSpan({ runId, observerHostId: observer.hostId })
      return yield* Effect.suspend((): Effect.Effect<RecoverClaimOutcome, RunStoreError> => {
        if (!evidenceMatchesOwner(staleClaimant, observer, nowMs, evidence)) {
          return Effect.succeed(livenessUnconfirmed)
        }
        return write(
          "recoverClaim",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${staleClaimant.hostId}
            AND claim_pid = ${staleClaimant.pid}
            AND claim_nonce = ${staleClaimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
            AND claimed_at_ms < ${nowMs - heartbeatStaleAfterMs}
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return recovered
            const current = yield* selectRun(sql, runId)
            if (current[0] === undefined) return notFound
            return rowMatchesClaim(current[0], staleClaimant, claimedAtMs) &&
                claimedAtMs >= nowMs - heartbeatStaleAfterMs
              ? claimFresh
              : claimChanged
          })
        )
      })
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.recoverClaim[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "recover_claim" })
    ))
  )

  const heartbeat = Effect.fn("RunStore.heartbeat")((
    runIdInput: string,
    ownerInput: OwnerId,
    nowMsInput: number
  ): Effect.Effect<HeartbeatOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("heartbeat", runIdInput)
      const owner = yield* snapshotOwner("heartbeat", "owner", ownerInput)
      const nowMs = yield* snapshotLeaseReading(
        "heartbeat",
        "nowMs",
        nowMsInput,
        { runId }
      )
      yield* Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId })
      return yield* write(
        "heartbeat",
        Effect.gen(function*() {
          // The lease timestamp is monotonic: MAX() keeps a heartbeat that
          // arrives late — delayed past a newer one from the same owner —
          // from moving `heartbeat_at_ms` backwards and making a live run
          // look stale to `claimAndOwn`/`steal`'s cutoff. The outcome is
          // still `Updated`: the fence held, and the write proves liveness
          // regardless of which caller clock reading it carried. Prior art:
          // Temporal's shard `rangeID` only ever advances
          // (`reference/temporal/service/history/shard/context_impl.go`,
          // `renewRangeLocked`).
          const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET heartbeat_at_ms = ${Dialect.greatest(sql)}(heartbeat_at_ms, ${nowMs})
          WHERE run_id = ${runId}
            AND status = 'running'
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING run_id AS "runId"
        `
          if (rows.length > 0) return updated
          const current = yield* selectRun(sql, runId)
          return current.length === 0 ? notFound : fenceLost
        })
      )
    }).pipe(observeOutcome((outcome) => RunStoreMetrics.heartbeat[outcome._tag], RunStoreMetrics.heartbeats))
  )

  const transitionOwned = Effect.fn("RunStore.transitionOwned")((
    runIdInput: string,
    ownerInput: OwnerId,
    toStatusInput: RunStatus,
    stateInput?: string | undefined,
    guardInput?: TransitionGuard | undefined
  ): Effect.Effect<TransitionOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("transitionOwned", runIdInput)
      const owner = yield* snapshotOwner("transitionOwned", "owner", ownerInput)
      if (!Schema.is(RunStatus)(toStatusInput) || toStatusInput === "pending") {
        return yield* Effect.fail(invalidRunError("transitionOwned", "toStatus"))
      }
      const toStatus = toStatusInput
      const state = stateInput === undefined
        ? null
        : yield* snapshotState("transitionOwned", stateInput, {
          runId,
          stateJsonLength: typeof stateInput === "string" ? stateInput.length : null,
          stateJsonValid: isJsonString(stateInput)
        })
      const guard = yield* snapshotGuard(guardInput)
      yield* Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId, to: toStatus })
      // A guard is compiled into the same UPDATE as the ownership fence, so a
      // concurrent cancellation request can never slip between check and write.
      const requireCancelAbsent = guard?.cancelRequested === "absent" ? 1 : 0
      const requireCancelPresent = guard?.cancelRequested === "present" ? 1 : 0
      const transitionedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      const outcome = yield* write(
        "transitionOwned",
        Effect.gen(function*() {
          const rows = toStatus === "running"
            ? yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = 'running',
                  finished_at_ms = NULL,
                  state_json = COALESCE(${state}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                  AND (${requireCancelAbsent} = 0 OR cancel_requested_at_ms IS NULL)
                  AND (${requireCancelPresent} = 0 OR cancel_requested_at_ms IS NOT NULL)
                RETURNING run_id AS "runId"
              `
            : yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = ${toStatus},
                  finished_at_ms = ${terminalStatuses.has(toStatus) ? transitionedAtMs : null},
                  owner_host_id = NULL,
                  owner_pid = NULL,
                  owner_nonce = NULL,
                  heartbeat_at_ms = NULL,
                  claim_host_id = NULL,
                  claim_pid = NULL,
                  claim_nonce = NULL,
                  claimed_at_ms = NULL,
                  state_json = COALESCE(${state}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                  AND (${requireCancelAbsent} = 0 OR cancel_requested_at_ms IS NULL)
                  AND (${requireCancelPresent} = 0 OR cancel_requested_at_ms IS NOT NULL)
                RETURNING run_id AS "runId"
              `
          /* v8 ignore next -- both CAS outcomes are asserted; V8 reports a synthetic implicit branch */
          if (rows.length > 0) {
            if (terminalStatuses.has(toStatus)) {
              yield* afterCommit(Metric.update(ObservabilityMetric.runThroughput, 1), sql)
            }
            return transitioned
          }
          const current = yield* selectRun(sql, runId)
          const row = current[0]
          if (row === undefined) return notFound
          const ownsRow = row.status === "running" &&
            row.ownerHostId === owner.hostId &&
            row.ownerPid === owner.pid &&
            row.ownerNonce === owner.nonce
          return ownsRow ? guardFailed : fenceLost
        })
      )
      return outcome
    }).pipe(
      observeOutcome((outcome) =>
        Metric.withAttributes(RunStoreMetrics.transition[outcome._tag], {
          to: toStatusInput
        }), Metric.withAttributes(RunStoreMetrics.transitions, { to: toStatusInput }))
    )
  )

  const steal = Effect.fn("RunStore.steal")((
    runIdInput: string,
    expectedInput: RunSnapshot,
    claimantInput: OwnerId,
    nowMsInput: number,
    evidenceInput: LivenessEvidence
  ): Effect.Effect<StealOutcome, RunStoreError> =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("steal", runIdInput)
      const expected = yield* snapshotExpected("steal", expectedInput)
      const claimant = yield* snapshotOwner("steal", "claimant", claimantInput)
      const nowMs = yield* snapshotLeaseReading(
        "steal",
        "nowMs",
        nowMsInput,
        { runId }
      )
      const evidence = yield* snapshotEvidence("steal", evidenceInput)
      yield* Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId })
      return yield* Effect.suspend((): Effect.Effect<StealOutcome, RunStoreError> => {
        if (!evidenceMatches(expected, claimant, nowMs, evidence)) {
          return Effect.succeed(livenessUnconfirmed)
        }
        const expectedOwner = expected.owner!
        return write(
          "steal",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status = ${expected.status}
            AND owner_host_id IS NOT DISTINCT FROM ${expectedOwner.hostId}
            AND owner_pid IS NOT DISTINCT FROM ${expectedOwner.pid}
            AND owner_nonce IS NOT DISTINCT FROM ${expectedOwner.nonce}
            AND heartbeat_at_ms IS NOT DISTINCT FROM ${expected.heartbeatAtMs}
            AND heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return claimed(nowMs)
            const current = yield* selectRun(sql, runId)
            return classifyClaimLoss(current[0], nowMs)
          })
        )
      })
    }).pipe(observeOutcome(
      (outcome) => RunStoreMetrics.steal[outcome._tag],
      Metric.withAttributes(RunStoreMetrics.claims, { op: "steal" })
    ))
  )

  const acknowledgeCancel: Service["acknowledgeCancel"] = Effect.fn("RunStore.acknowledgeCancel")((
    id,
    ownerInput,
    time
  ) =>
    Effect.gen(function*() {
      const runId = yield* snapshotRunId("acknowledgeCancel", id)
      const owner = yield* snapshotOwner("acknowledgeCancel", "owner", ownerInput)
      const observedAtMs = yield* snapshotTimestamp("acknowledgeCancel", "nowMs", time)
      yield* Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId })
      const acknowledgement = JSON.stringify({ observedAtMs, owner })
      return yield* write(
        "acknowledgeCancel",
        sql`
        UPDATE flows_runs
        SET cancel_acknowledgement_json = COALESCE(cancel_acknowledgement_json, ${acknowledgement})
        WHERE run_id = ${runId} AND status = 'running' AND cancel_requested_at_ms IS NOT NULL
          AND owner_host_id = ${owner.hostId} AND owner_pid = ${owner.pid} AND owner_nonce = ${owner.nonce}
        RETURNING run_id
      `.pipe(Effect.map((rows) => rows.length > 0))
      )
    }).pipe(observeExit)
  )

  return RunStore.of({
    create,
    get,
    lineage,
    latestRound,
    requestCancel,
    acknowledgeCancel,
    requestCancelLineage,
    claim,
    claimAndOwn,
    activate,
    abandonClaim,
    recoverClaim,
    heartbeat,
    transitionOwned,
    steal
  })
})

/**
 * Constructs a stub `RunStore` whose direct operations fail and whose
 * compare-and-swap operations report typed losses until overridden.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(runStoreError(method, "persistence_failed", "no run store in this environment", method))
  return RunStore.of({
    create: Effect.fn("RunStore.create")(() => unavailable("create")),
    get: Effect.fn("RunStore.get")(() => unavailable("get")),
    lineage: Effect.fn("RunStore.lineage")(() => unavailable("lineage")),
    latestRound: Effect.fn("RunStore.latestRound")(() => unavailable("latestRound")),
    requestCancel: Effect.fn("RunStore.requestCancel")(() => Effect.succeed(notFound)),
    acknowledgeCancel: Effect.fn("RunStore.acknowledgeCancel")(() => Effect.succeed(false)),
    requestCancelLineage: Effect.fn("RunStore.requestCancelLineage")(() => unavailable("requestCancelLineage")),
    claim: Effect.fn("RunStore.claim")(() => Effect.succeed(notFound)),
    claimAndOwn: Effect.fn("RunStore.claimAndOwn")(() => Effect.succeed(notFound)),
    activate: Effect.fn("RunStore.activate")(() => Effect.succeed(claimLost)),
    abandonClaim: Effect.fn("RunStore.abandonClaim")(() => Effect.succeed(claimLost)),
    recoverClaim: Effect.fn("RunStore.recoverClaim")(() => Effect.succeed(notFound)),
    heartbeat: Effect.fn("RunStore.heartbeat")(() => Effect.succeed(notFound)),
    transitionOwned: Effect.fn("RunStore.transitionOwned")(() => Effect.succeed(notFound)),
    steal: Effect.fn("RunStore.steal")(() => Effect.succeed(notFound)),
    ...overrides
  })
}

/**
 * Provides a stub `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<RunStore> =>
  Layer.succeed(RunStore)(makeNoop(overrides))

/**
 * Provides the database-backed `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<RunStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(RunStore, make)
