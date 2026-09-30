/**
 * The injectable consensus strategy arbitrating the journal's ownership rules.
 *
 * The journal owns the consensus rules — single writer per run, fenced and
 * unfenced appends, commit-time admission, the generation fence, and steal
 * only on staleness plus liveness evidence — and this service is how a deployment chooses *how* those rules are
 * arbitrated: where the lease lives, how liveness is probed, and how the
 * fence is checked at commit time. `Consensus` lives here beside `OwnerId`
 * for the same reason `OwnerId` does: the journal is what it fences.
 * `@smthrs/run-store`'s `Ownership` keeps its public API and rules but
 * delegates arbitration to this strategy.
 *
 * Every operation that reasons about staleness takes the caller's clock
 * reading (`nowMs`) rather than reading a clock itself: staleness (R5) and
 * the monotonic lease stamp are defined against the arbitrating caller's
 * reading, exactly as `RunStore`'s compare-and-swap operations always were,
 * so the recorded lease never differs from the outcome the caller observed.
 *
 * Governing design: `packages/smithers/flows/journal/docs/concepts/owner-fence.md`.
 * Rule constants and their provenance:
 * `packages/smithers/flows/run-store/docs/concepts/leases.md`.
 *
 * Prior art: Effect `EventJournal` (`reference/effect` `unstable/eventlog`)
 * resolves multi-writer by merge with conflict surfacing; driving a run is not
 * mergeable, so this surface deviates to exclusive-writer admission. The
 * fencing and generation semantics follow Temporal's shard `rangeID`
 * (`reference/temporal/service/history/shard/context_impl.go`).
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { OwnerId } from "./OwnerId.ts"

/**
 * How often the supervision loop pulses to renew the owner's lease.
 *
 * @since 1.0.0
 * @category constants
 */
export const heartbeatInterval: Duration.Duration = Duration.seconds(1)

/**
 * How old a persisted heartbeat must be before a peer may steal the run.
 * Every strategy judges R5 staleness against this one definition.
 *
 * @since 1.0.0
 * @category constants
 */
export const heartbeatStaleAfter: Duration.Duration = Duration.seconds(30)

/**
 * How far the owner's wall clock may run behind a peer's before the lease
 * reasoning stops holding.
 *
 * The owner stamps its heartbeat from *its* clock and a would-be stealer
 * compares that stamp against *its own*, so the two hosts' clock offset is
 * subtracted directly from the owner's real safety margin. This constant names
 * that allowance instead of leaving it implicit in a "two ticks" arithmetic
 * accident, and it is a budgeted allowance, not a guarantee: see
 * {@link heartbeatWriteTolerance} for what happens once it is exceeded.
 *
 * @since 1.0.0
 * @category constants
 */
export const heartbeatSkewAllowance: Duration.Duration = Duration.seconds(10)

/**
 * How long the owner may keep working through *failing* heartbeat writes.
 *
 * A peer judges staleness by the persisted heartbeat and may steal the run the
 * instant it is {@link heartbeatStaleAfter} old, so an owner that tolerated
 * write failures for exactly that long would still be executing side effects
 * when the steal is admitted. The budget is therefore
 * {@link heartbeatStaleAfter} minus {@link heartbeatSkewAllowance} (the peer's
 * clock may already read that much later than the owner's) minus one
 * {@link heartbeatInterval} (the owner only re-evaluates the budget once per
 * pulse, so it may notice the expiry a full tick late).
 *
 * This bounds, but does not eliminate, overlap. Beyond
 * {@link heartbeatSkewAllowance} of clock offset a peer can be admitted while
 * the old owner is still running. *Durable* writes stay safe regardless — they
 * are fenced by the strategy's commit-time admission, so the displaced owner's
 * writes fail rather than corrupt. Non-durable external side effects (an HTTP
 * call, a spawned process) can genuinely overlap. That is inherent to any
 * wall-clock lease and is stated here rather than asserted away; a caller that
 * cannot tolerate any overlap needs an external fencing token at the side
 * effect itself, not a larger timeout.
 *
 * @since 1.0.0
 * @category constants
 */
export const heartbeatWriteTolerance: Duration.Duration = Duration.millis(
  Duration.toMillis(heartbeatStaleAfter) -
    Duration.toMillis(heartbeatSkewAllowance) -
    Duration.toMillis(heartbeatInterval)
)

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * Defined here because R5 — steal requires staleness plus liveness evidence —
 * is a consensus rule every strategy validates. `@smthrs/run-store`'s
 * `Ownership` re-exports it alongside the probes that mint it.
 *
 * Two of the three kinds are collected outside the strategy:
 * `same-host-pid-dead` is a local process probe, and
 * `cross-host-unreachable-stale` is a reachability judgement the deployment
 * makes. `lease-expired` is different — it asserts only that the persisted
 * heartbeat is older than the staleness cutoff, which is the one claim a
 * strategy can check for itself, and `steal` checks it: the takeover refuses
 * any lease whose heartbeat is still inside the window. It is therefore
 * accepted from a claimant on any host, while the other two stay bound to the
 * host relation that makes them meaningful. The observation must carry the
 * exact instant supplied to the consuming operation: `checkedAtMs` must equal
 * that operation's `nowMs`. A caller that probes at T and calls at T+1 is
 * refused and must build fresh evidence.
 *
 * @since 1.0.0
 * @category models
 */
export const LivenessEvidence = Schema.Struct({
  expectedOwner: OwnerId,
  checkedAtMs: Schema.Number,
  kind: Schema.Literals(["same-host-pid-dead", "cross-host-unreachable-stale", "lease-expired"])
})

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * @since 1.0.0
 * @category models
 */
export type LivenessEvidence = typeof LivenessEvidence.Type

/**
 * Structural equality on the process identity tuple.
 *
 * @since 1.0.0
 * @category predicates
 */
export const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

/**
 * Validates liveness evidence against the owner it claims to disprove.
 *
 * The evidence must name the expected owner, carry the observer's current
 * clock reading, and respect the host rule: a `same-host-pid-dead` probe is
 * only meaningful from the same host, a `cross-host-unreachable-stale`
 * observation only from a different one, and `lease-expired` is host-neutral
 * because the strategy verifies the cutoff it names for itself.
 *
 * @since 1.0.0
 * @category predicates
 */
export const matchesEvidence = (
  expectedOwner: OwnerId,
  observer: OwnerId,
  nowMs: number,
  evidence: LivenessEvidence
): boolean => {
  if (!sameOwner(expectedOwner, evidence.expectedOwner) || evidence.checkedAtMs !== nowMs) return false
  switch (evidence.kind) {
    // A pid means nothing outside the host that owns the process namespace.
    case "same-host-pid-dead":
      return expectedOwner.hostId === observer.hostId
    // Unreachability is what a peer host observes; on the owner's own host it
    // would be an unprobed guess dressed as evidence.
    case "cross-host-unreachable-stale":
      return expectedOwner.hostId !== observer.hostId
    // The lease is host-neutral, and the strategy verifies the same
    // caller-clock cutoff named by this evidence.
    case "lease-expired":
      return true
  }
}

/**
 * Why a strategy refused a claim, steal, or recovery.
 *
 * @since 1.0.0
 * @category models
 */
export const RejectionReason = Schema.Literals([
  "already_claimed",
  "owner_held",
  "owner_live",
  "evidence_invalid",
  "claim_fresh",
  "claim_changed",
  "unavailable"
])

/**
 * Why a strategy refused a claim, steal, or recovery.
 *
 * @since 1.0.0
 * @category models
 */
export type RejectionReason = typeof RejectionReason.Type

/**
 * A granted claim, carrying the grant timestamp the later activation must
 * present (R4 — the generation fence).
 *
 * @since 1.0.0
 * @category models
 */
export const Claimed = Schema.TaggedStruct("Claimed", {
  grantedAtMs: Schema.Number
})

/**
 * A granted claim.
 *
 * @since 1.0.0
 * @category models
 */
export type Claimed = typeof Claimed.Type

/**
 * A refused claim, steal, or recovery, with the strategy's typed reason.
 *
 * @since 1.0.0
 * @category models
 */
export const Rejected = Schema.TaggedStruct("Rejected", {
  reason: RejectionReason
})

/**
 * A refused claim, steal, or recovery.
 *
 * @since 1.0.0
 * @category models
 */
export type Rejected = typeof Rejected.Type

/**
 * Outcome of `claim` and `steal`.
 *
 * @since 1.0.0
 * @category models
 */
export const ClaimOutcome = Schema.Union([Claimed, Rejected])

/**
 * Outcome of `claim` and `steal`.
 *
 * @since 1.0.0
 * @category models
 */
export type ClaimOutcome = typeof ClaimOutcome.Type

/**
 * A claim promoted to ownership.
 *
 * @since 1.0.0
 * @category models
 */
export const Activated = Schema.TaggedStruct("Activated", {})

/**
 * A claim promoted to ownership.
 *
 * @since 1.0.0
 * @category models
 */
export type Activated = typeof Activated.Type

/**
 * The claim or lease the caller presented no longer exists.
 *
 * @since 1.0.0
 * @category models
 */
export const Lost = Schema.TaggedStruct("Lost", {})

/**
 * The claim or lease the caller presented no longer exists.
 *
 * @since 1.0.0
 * @category models
 */
export type Lost = typeof Lost.Type

/**
 * Outcome of `activate`.
 *
 * @since 1.0.0
 * @category models
 */
export const ActivateOutcome = Schema.Union([Activated, Lost])

/**
 * Outcome of `activate`.
 *
 * @since 1.0.0
 * @category models
 */
export type ActivateOutcome = typeof ActivateOutcome.Type

/**
 * A renewed lease, carrying the monotonic heartbeat stamp the strategy
 * recorded — the maximum of the stored stamp and the caller's reading, so a
 * late pulse never moves the lease backwards.
 *
 * @since 1.0.0
 * @category models
 */
export const Renewed = Schema.TaggedStruct("Renewed", {
  heartbeatAtMs: Schema.Number
})

/**
 * A renewed lease.
 *
 * @since 1.0.0
 * @category models
 */
export type Renewed = typeof Renewed.Type

/**
 * Outcome of `heartbeat`.
 *
 * @since 1.0.0
 * @category models
 */
export const HeartbeatOutcome = Schema.Union([Renewed, Lost])

/**
 * Outcome of `heartbeat`.
 *
 * @since 1.0.0
 * @category models
 */
export type HeartbeatOutcome = typeof HeartbeatOutcome.Type

/**
 * A stale claim cleared after its claimant was proven dead.
 *
 * @since 1.0.0
 * @category models
 */
export const Recovered = Schema.TaggedStruct("Recovered", {})

/**
 * A stale claim cleared after its claimant was proven dead.
 *
 * @since 1.0.0
 * @category models
 */
export type Recovered = typeof Recovered.Type

/**
 * Outcome of `recover`.
 *
 * @since 1.0.0
 * @category models
 */
export const RecoverOutcome = Schema.Union([Recovered, Rejected])

/**
 * Outcome of `recover`.
 *
 * @since 1.0.0
 * @category models
 */
export type RecoverOutcome = typeof RecoverOutcome.Type

/**
 * Failure raised by a consensus strategy.
 *
 * `fence_lost` is `guard`'s refusal: the supplied owner no longer holds the
 * run, so the fenced write it joins must not commit. `persistence_failed`
 * wraps a strategy's storage failure; the original cause is preserved so the
 * durable writer's retry classification still sees a transient conflict
 * through the wrapper.
 *
 * @since 1.0.0
 * @category errors
 */
export class ConsensusError extends Schema.TaggedError<ConsensusError>()("@smthrs/journal/ConsensusError", {
  code: Schema.Literals(["fence_lost", "persistence_failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Consensus operations.
 *
 * The rules being arbitrated are strategy-independent; a strategy
 * chooses where the lease lives and how the fence is checked at commit time.
 * The claim lifecycle is two-phase, exactly as `RunStore`'s always was:
 * `claim` (or `steal`, its evidence-gated form) reserves the run and returns
 * the grant timestamp, `activate` presents that grant to take ownership, and
 * `release` clears whichever of the caller's claim or ownership still stands.
 * `recover` clears a *third party's* stale claim after its claimant was proven
 * dead — the relocated `recoverClaim` mechanic. `guard` is the commit-time
 * admission check (R3) `Journal.emitDurable`, `checkpoint`, and `compact`
 * join: it succeeds while the owner holds the run and fails with `fence_lost`
 * otherwise.
 *
 * Heartbeats and lease state are the strategy's private evidence and never
 * enter the journal.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly claim: (
    runId: string,
    claimant: OwnerId,
    nowMs: number
  ) => Effect.Effect<ClaimOutcome, ConsensusError>
  readonly activate: (
    runId: string,
    owner: OwnerId,
    grantedAtMs: number,
    nowMs: number
  ) => Effect.Effect<ActivateOutcome, ConsensusError>
  readonly heartbeat: (
    runId: string,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<HeartbeatOutcome, ConsensusError>
  readonly release: (runId: string, owner: OwnerId) => Effect.Effect<void, ConsensusError>
  readonly steal: (
    runId: string,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<ClaimOutcome, ConsensusError>
  readonly recover: (
    runId: string,
    staleClaimant: OwnerId,
    grantedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<RecoverOutcome, ConsensusError>
  readonly guard: (runId: string, owner: OwnerId) => Effect.Effect<void, ConsensusError>
}

/**
 * Context service for the injected consensus strategy.
 *
 * @since 1.0.0
 * @category services
 */
export class Consensus extends Context.Service<Consensus, Service>()("@smthrs/journal/Consensus") {}

/**
 * Constructs a consensus service from an implementation.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (implementation: Service): Service => Consensus.of(implementation)

const rejected = (reason: RejectionReason): Rejected => ({ _tag: "Rejected", reason })
const claimed = (grantedAtMs: number): Claimed => ({ _tag: "Claimed", grantedAtMs })
const lost: Lost = { _tag: "Lost" }
const activated: Activated = { _tag: "Activated" }
const recovered: Recovered = { _tag: "Recovered" }

/**
 * The refusal `guard` raises for an owner that no longer holds the run.
 *
 * @since 1.0.0
 * @category errors
 */
export const fenceLost = (runId: string, owner: OwnerId): ConsensusError =>
  new ConsensusError({
    code: "fence_lost",
    message: `run ${runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`
  })

/**
 * Constructs a strategy that arbitrates nothing: claims are refused, leases
 * are never held, and every fenced write is rejected.
 *
 * @since 1.0.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  Consensus.of({
    claim: Effect.fn("Consensus.claim")(() => Effect.succeed(rejected("unavailable"))),
    activate: Effect.fn("Consensus.activate")(() => Effect.succeed(lost)),
    heartbeat: Effect.fn("Consensus.heartbeat")(() => Effect.succeed(lost)),
    release: Effect.fn("Consensus.release")(() => Effect.void),
    steal: Effect.fn("Consensus.steal")(() => Effect.succeed(rejected("unavailable"))),
    recover: Effect.fn("Consensus.recover")(() => Effect.succeed(rejected("unavailable"))),
    guard: Effect.fn("Consensus.guard")((runId: string, owner: OwnerId) => Effect.fail(fenceLost(runId, owner))),
    ...overrides
  })

/**
 * Provides the refusing strategy stub.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Consensus> =>
  Layer.succeed(Consensus)(makeNoop(overrides))

interface LocalLease {
  owner: { readonly id: OwnerId; readonly grantedAtMs: number; heartbeatAtMs: number } | undefined
  claim: { readonly id: OwnerId; readonly claimedAtMs: number } | undefined
}

/**
 * Constructs the in-memory single-process strategy.
 *
 * @since 1.0.0
 * @category constructors
 */
export const makeLocal: Effect.Effect<Service> = Effect.sync(() => {
  const leases = new Map<string, LocalLease>()

  const leaseOf = (runId: string): LocalLease => {
    const existing = leases.get(runId)
    if (existing !== undefined) return existing
    const fresh: LocalLease = { owner: undefined, claim: undefined }
    leases.set(runId, fresh)
    return fresh
  }

  const prune = (runId: string, lease: LocalLease): void => {
    if (lease.owner === undefined && lease.claim === undefined) {
      leases.delete(runId)
    }
  }

  return Consensus.of({
    claim: Effect.fn("Consensus.claim")((runId: string, claimant: OwnerId, nowMs: number) =>
      Effect.sync(() => {
        const lease = leaseOf(runId)
        if (lease.claim !== undefined) return rejected("already_claimed")
        if (lease.owner !== undefined) return rejected("owner_held")
        lease.claim = { id: claimant, claimedAtMs: nowMs }
        return claimed(nowMs)
      })
    ),
    activate: Effect.fn("Consensus.activate")((
      runId: string,
      owner: OwnerId,
      grantedAtMs: number,
      nowMs: number
    ) =>
      Effect.sync(() => {
        const lease = leaseOf(runId)
        if (
          lease.claim === undefined ||
          !sameOwner(lease.claim.id, owner) ||
          lease.claim.claimedAtMs !== grantedAtMs
        ) {
          prune(runId, lease)
          return lost
        }
        lease.claim = undefined
        lease.owner = { id: owner, grantedAtMs, heartbeatAtMs: nowMs }
        return activated
      })
    ),
    heartbeat: Effect.fn("Consensus.heartbeat")((runId: string, owner: OwnerId, nowMs: number) =>
      Effect.sync(() => {
        const lease = leases.get(runId)
        if (lease?.owner === undefined || !sameOwner(lease.owner.id, owner)) return lost
        lease.owner.heartbeatAtMs = Math.max(lease.owner.heartbeatAtMs, nowMs)
        return ({ _tag: "Renewed", heartbeatAtMs: lease.owner.heartbeatAtMs } satisfies Renewed)
      })
    ),
    release: Effect.fn("Consensus.release")((runId: string, owner: OwnerId) =>
      Effect.sync(() => {
        const lease = leases.get(runId)
        if (lease === undefined) return
        if (lease.claim !== undefined && sameOwner(lease.claim.id, owner)) {
          lease.claim = undefined
        }
        if (lease.owner !== undefined && sameOwner(lease.owner.id, owner)) {
          lease.owner = undefined
        }
        prune(runId, lease)
      })
    ),
    steal: Effect.fn("Consensus.steal")((
      runId: string,
      claimant: OwnerId,
      nowMs: number,
      evidence: LivenessEvidence
    ) =>
      Effect.sync(() => {
        if (!matchesEvidence(evidence.expectedOwner, claimant, nowMs, evidence)) {
          return rejected("evidence_invalid")
        }
        const lease = leases.get(runId)
        if (lease?.claim !== undefined) return rejected("already_claimed")
        if (lease?.owner === undefined || !sameOwner(lease.owner.id, evidence.expectedOwner)) {
          return rejected("evidence_invalid")
        }
        if (lease.owner.heartbeatAtMs >= nowMs - staleAfterMs) return rejected("owner_live")
        lease.claim = { id: claimant, claimedAtMs: nowMs }
        return claimed(nowMs)
      })
    ),
    recover: Effect.fn("Consensus.recover")((
      runId: string,
      staleClaimant: OwnerId,
      grantedAtMs: number,
      observer: OwnerId,
      nowMs: number,
      evidence: LivenessEvidence
    ) =>
      Effect.sync(() => {
        if (!matchesEvidence(staleClaimant, observer, nowMs, evidence)) return rejected("evidence_invalid")
        const lease = leases.get(runId)
        if (
          lease?.claim === undefined ||
          !sameOwner(lease.claim.id, staleClaimant) ||
          lease.claim.claimedAtMs !== grantedAtMs
        ) {
          return rejected("claim_changed")
        }
        if (lease.claim.claimedAtMs >= nowMs - staleAfterMs) return rejected("claim_fresh")
        lease.claim = undefined
        prune(runId, lease)
        return recovered
      })
    ),
    guard: Effect.fn("Consensus.guard")((runId: string, owner: OwnerId) =>
      Effect.suspend(() => {
        const lease = leases.get(runId)
        return lease?.owner !== undefined && sameOwner(lease.owner.id, owner)
          ? Effect.void
          : Effect.fail(fenceLost(runId, owner))
      })
    )
  })
})

/**
 * Provides the in-memory single-process strategy.
 *
 * The lease lives in process memory, so R3 is exact within the process — the
 * strategy's transitions and the serialized append transactions interleave
 * atomically on one event loop — and browser support needs nothing beyond
 * this layer plus the browser-safe journal. State is per layer build: provide
 * one instance to every service that must agree on it, which is what
 * `SqlJournal.layerWith` and `RunStore.layerWith` exist for.
 *
 * The lease is not part of any database transaction: a transition made inside
 * a `Journal.transact` that later rolls back stays applied in memory, so the
 * lease and a rolled-back run row can disagree until the next transition.
 * `SqlConsensus` keeps the two in one transaction; prefer it wherever a
 * database is present.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerLocal: Layer.Layer<Consensus> = Layer.effect(Consensus, makeLocal)
