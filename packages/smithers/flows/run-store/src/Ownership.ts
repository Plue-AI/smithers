/**
 * Run ownership arbitration: liveness evidence, probes, and heartbeat
 * supervision.
 *
 * The identity being arbitrated — {@link OwnerId} — is defined by
 * `@smthrs/journal`, because it is the fencing token the journal accepts on
 * durable appends. It is re-exported here so ownership callers keep reading it
 * as one vocabulary.
 *
 * @since 0.1.0
 */

import { LivenessEvidence } from "@smthrs/journal/Consensus"
import { OwnerId } from "@smthrs/journal/OwnerId"
import { Cause, Clock, Duration, Effect, Semaphore } from "effect"
import { heartbeatInterval, heartbeatStaleAfter, heartbeatWriteTolerance } from "./Heartbeat.ts"
import { RunStore } from "./RunStore.ts"

export {
  /**
   * A process identity scoped to a host and a unique ownership nonce, defined
   * by `@smthrs/journal` as the fence on durable appends.
   *
   * @since 0.1.0
   * @category models
   */
  OwnerId
}

export {
  /**
   * Evidence that the owner in an exact run snapshot is no longer live.
   *
   * Defined by `@smthrs/journal`'s `Consensus`, because R5 — steal requires
   * staleness plus liveness evidence — is a consensus rule every strategy
   * validates. Two of the three kinds are collected outside the store:
   * `same-host-pid-dead` is a local process probe, and
   * `cross-host-unreachable-stale` is a reachability judgement the deployment
   * makes. `lease-expired` is different — it asserts only that the persisted
   * heartbeat is older than the staleness cutoff, which is the one claim the
   * strategy can check for itself, and `steal` checks it: the takeover
   * refuses any lease whose heartbeat is still inside the window. It is
   * therefore accepted from a claimant on any host, while the other two stay
   * bound to the host relation that makes them meaningful. The observation
   * must carry the exact instant supplied to the consuming operation:
   * `checkedAtMs` must equal that operation's `nowMs`. A caller that probes
   * at T and calls at T+1 is refused and must build fresh evidence.
   *
   * @since 0.1.0
   * @category models
   */
  LivenessEvidence
}

/**
 * Evidence-factory signature a composition uses for ownership arbitration.
 *
 * A `LivenessProbe` returns `LivenessEvidence` or `undefined` for `steal`,
 * `claimAndOwn`, and `recoverClaim` to verify. {@link LivenessCheck} is the
 * separate alive-or-not question the engine asks before it decides to steal.
 * `RunStore` validates supplied evidence and never probes a process or network
 * itself.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessProbe<E = never, R = never> = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
) => Effect.Effect<LivenessEvidence | undefined, E, R>

/**
 * What a liveness check knows about the run it is asked about, beyond the
 * owner recorded on it.
 *
 * The lease is here because it is the only liveness signal every deployment
 * has: `heartbeatAtMs` is the last heartbeat the owner persisted, `nowMs` is
 * the reading the arbitration is made against, and `claimant` is the identity
 * that would take the run over. A check that wants to probe a pid compares
 * hosts with {@link sameHostIncarnation} first; a check that has nothing but
 * the lease uses {@link leaseLiveness}.
 *
 * @since 0.1.0
 * @category models
 */
export interface LivenessContext {
  readonly claimant: OwnerId
  readonly heartbeatAtMs: number | null
  readonly nowMs: number
}

/**
 * The question ownership arbitration asks before it steals a run: is the
 * recorded owner still working?
 *
 * Answering `true` refuses the takeover. The engine consults this only for a
 * run whose lease has already expired, so a check that has no better evidence
 * than the lease answers `false` there — which is exactly what
 * {@link leaseLiveness} does.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessCheck = (
  expectedOwner: OwnerId,
  context: LivenessContext
) => Effect.Effect<boolean>

/**
 * Whether two owner identities are incarnations on the same host.
 *
 * The predicate a probe applies before it inspects a pid: `owner.pid` names a
 * process in the claimant's own process namespace only when the hosts match,
 * so a cross-host probe that read it would be answering about an unrelated
 * process. Exposed because the check that needs it — a
 * `process.kill(pid, 0)` probe — belongs to a platform package rather than
 * here.
 *
 * @since 0.1.0
 * @category ownership
 */
export const sameHostIncarnation = (
  expectedOwner: OwnerId,
  claimant: OwnerId
): boolean => expectedOwner.hostId === claimant.hostId

/**
 * The default liveness check: the lease, and nothing else.
 *
 * An owner is treated as alive for as long as its persisted heartbeat is
 * younger than `staleAfter`, and as gone once it is not. That is the weakest
 * honest answer, and it is the one every host can give: a fresh process with
 * no application code at all can reclaim a hard-killed owner's runs once the
 * lease it stopped renewing has expired. A deployment that can say more — a
 * pid probe on the owner's host, an orchestrator that reports pod liveness —
 * supplies its own {@link LivenessCheck} and refuses the takeover for longer.
 *
 * An owner with no recorded heartbeat holds no lease and is reported gone; the
 * steal it enables is still gated by the store's own snapshot compare-and-swap.
 *
 * @since 0.1.0
 * @category ownership
 */
export const leaseLiveness = (
  staleAfter: Duration.Input = heartbeatStaleAfter
): LivenessCheck => {
  const staleAfterMs = Duration.toMillis(staleAfter)
  return (_expectedOwner, context) =>
    Effect.succeed(
      context.heartbeatAtMs !== null &&
        context.heartbeatAtMs >= context.nowMs - staleAfterMs
    )
}

/**
 * The Node hosts' liveness check: does the owner's process still exist?
 *
 * {@link leaseLiveness} is the honest floor — every host can read a persisted
 * heartbeat — but it is only a timeout, so two engine processes over one
 * database steal each other's running rows `heartbeatStaleAfter` after any
 * heartbeat stall: a stop-the-world pause, a swapped-out process, a disk that
 * blocked longer than the window. This answers the question the lease is
 * standing in for, by asking the operating system whether the recorded pid is
 * still there.
 *
 * `process.kill(pid, 0)` sends no signal; it performs only the delivery
 * checks. Three answers matter:
 *
 * - It returns: the process exists and is signalable. The owner is alive.
 * - It throws `ESRCH`: no such process exists. This is the sole death answer,
 *   so the owner is gone.
 * - It throws anything else, including `EPERM`, `EINVAL`, or an unrecognized
 *   value: the owner is treated as alive because an unknown answer is not
 *   death.
 *
 * This `ESRCH`-only death rule deliberately aligns with
 * `@smthrs/platform-node`'s `HostLiveness`.
 *
 * A pid is only meaningful inside one process namespace, so a recorded owner
 * on another host is never probed: the answer is `false` and the arbitration
 * falls back to the evidence that does cross hosts — the expired lease, which
 * `RunStore.steal` verifies for itself. The engine consults this check only
 * for a run whose lease has ALREADY expired, so answering `false` here does
 * not weaken anything; it declines to add evidence.
 *
 * Node hosts only. It is not part of the browser promise: this entry point
 * bundles for the browser because it never imports a `node:` built-in, and a
 * browser composition has no process table to ask, so it keeps
 * {@link leaseLiveness}.
 *
 * `@smthrs/platform-node`'s `HostLiveness.isAlive` asks the same question of
 * the same process table and differs in one deliberate place: it answers
 * `true` for an owner on another host, which refuses the steal outright, while
 * this check answers `false` and lets the expired lease decide. The difference
 * matters after a host dies for good — under the refusing answer its runs are
 * never reclaimed by anyone, because no other machine can ever produce
 * evidence about its pids.
 *
 * Two limits are inherent to asking a pid, and they bound what reclaim can
 * promise. Both are shared with `HostLiveness.isAlive`.
 *
 * - An owner recorded with the CLAIMANT'S OWN pid is always alive. A previous
 *   incarnation of this process, or a second engine composed inside it, differs
 *   from the claimant only by `nonce`, and the process it names is this one.
 *   Such a row is never stolen while the process lives, so an embedded host
 *   that re-creates its engine in place should keep {@link leaseLiveness},
 *   whose timeout does expire. Reading same-pid-different-nonce as death is
 *   not the alternative: it would let two engines in one process — the exact
 *   shape this check exists to arbitrate — steal each other's live runs.
 * - A pid the operating system has REUSED reports the unrelated process that
 *   now holds it. The dead owner's row stays refused for as long as that
 *   process lives, which delays reclaim rather than breaking it: the row is
 *   still `running` under an expired lease, and the next probe after the pid
 *   is free reclaims it.
 *
 * @since 0.1.0
 * @category ownership
 */
export const sameHostPidProbe: LivenessCheck = (expectedOwner, context) =>
  Effect.sync(() => {
    if (!sameHostIncarnation(expectedOwner, context.claimant)) return false
    if (!Number.isSafeInteger(expectedOwner.pid) || expectedOwner.pid <= 0) return true
    try {
      process.kill(expectedOwner.pid, 0)
      return true
    } catch (error) {
      return (error as { readonly code?: string | undefined } | null)?.code !== "ESRCH"
    }
  })

export {
  /**
   * How often the supervision loop pulses to renew the owner's lease.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatInterval,
  /**
   * How far the owner's wall clock may run behind a peer's before the lease
   * reasoning stops holding.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatSkewAllowance,
  /**
   * How old a persisted heartbeat must be before a peer may steal the run.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatStaleAfter,
  /**
   * How long the owner may keep working through failing or stalled heartbeat writes.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatWriteTolerance
} from "./Heartbeat.ts"

/**
 * Hooks a {@link heartbeatLoop} caller may supply.
 *
 * @since 1.0.0
 * @category models
 */
export interface HeartbeatLoopOptions {
  /** Called after the same unclaimed owner reconfirms an expired heartbeat budget. */
  readonly onReconfirm?: ((unconfirmedMs: number) => Effect.Effect<void>) | undefined
  /** Called with the unconfirmed milliseconds when the lease lapses, before the loop interrupts itself. */
  readonly onLapse?: ((unconfirmedMs: number) => Effect.Effect<void>) | undefined
}

/**
 * Runs heartbeats until the persisted ownership fence is lost, then interrupts
 * itself. Race this effect with owned work so structured concurrency
 * interrupts the work when ownership disappears.
 *
 * Each pulse drives the injected `Consensus` strategy's `heartbeat` through
 * `RunStore.heartbeat`, which renews the strategy's lease and mirrors the
 * recorded stamp onto the run row in the same transaction. Heartbeats are
 * lease evidence, never journal events.
 *
 * Pulses are delayed by `heartbeatInterval` and read the Effect `Clock`, so the
 * loop is fully driveable with `TestClock`.
 *
 * A lost fence — any outcome other than `Updated` — is durable evidence and
 * interrupts immediately. A failed heartbeat *write* is not: the persisted
 * heartbeat is still there and no other process may steal the run until it is
 * `heartbeatStaleAfter` old, so transient write errors are tolerated for
 * `heartbeatWriteTolerance` — deliberately shorter than the steal cutoff by a
 * pulse plus `heartbeatSkewAllowance`. The reserved pulse bounds a final
 * reconfirmation; a pending claim or changed owner fails that check. Past that allowance
 * the fence still protects durable writes but non-durable side effects may
 * overlap; see {@link heartbeatWriteTolerance}.
 *
 * An independent deadline races the pulse loop. At expiry it reconfirms the
 * same owner with no pending claim, bounded by one heartbeat interval. A
 * renewed lease continues supervision; loss, error, or timeout interrupts
 * even when an ordinary heartbeat write never returns. Each successful
 * pulse re-arms the deadline from the timestamp sent to the store, not from
 * its completion time. The deadline re-reads the clock after waking, so delayed
 * writes cannot hide expiry behind a stale clock reading.
 *
 * `options.onReconfirm` records a successful reconfirmation after a gap and
 * shares its heartbeat-interval deadline. A blocked or failed receipt lapses
 * the lease instead of stranding supervision.
 * `options.onLapse` runs once, before the self-interrupt, when reconfirmation
 * fails: it receives how long the lease went unconfirmed, so the caller can
 * record why its work stopped. A lost fence does not call it.
 *
 * @since 0.1.0
 * @category supervision
 */
export const heartbeatLoop = (
  runId: string,
  owner: OwnerId,
  options: HeartbeatLoopOptions = {}
): Effect.Effect<never, never, RunStore> =>
  Effect.gen(function*() {
    const runStore = yield* RunStore
    const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
    const intervalMs = Duration.toMillis(heartbeatInterval)
    let lastConfirmedPulseMs = yield* Clock.currentTimeMillis
    let failing = false
    // Both overdue timers may wake after a host stall. Serialize expiry and
    // recheck the budget so they cannot reconfirm or journal the same gap twice.
    const expiry = yield* Semaphore.make(1)
    const expire = (nowMs: number) =>
      expiry.withPermit(Effect.gen(function*() {
        if (nowMs - lastConfirmedPulseMs < toleranceMs) return
        const unconfirmedMs = nowMs - lastConfirmedPulseMs
        const renewed = yield* runStore.reconfirm(runId, owner, Math.floor(nowMs)).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Updated"
              ? (options.onReconfirm?.(unconfirmedMs) ?? Effect.void).pipe(Effect.as(true))
              : Effect.succeed(false)
          ),
          // The receipt shares the renewal budget: a blocked audit must not
          // strand the independent deadline after the lease was refreshed.
          Effect.timeout(heartbeatInterval),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.succeed(false)
          )
        )
        if (renewed) {
          lastConfirmedPulseMs = Math.max(lastConfirmedPulseMs, nowMs)
          failing = false
          return
        }
        yield* Effect.logWarning("run lease lapsed; interrupting owned work").pipe(
          Effect.annotateLogs({ runId, unconfirmedMs }),
          Effect.andThen(options.onLapse?.(unconfirmedMs) ?? Effect.void),
          Effect.andThen(Effect.interrupt)
        )
      }))
    const deadline = Effect.gen(function*() {
      while (true) {
        const nowMs = yield* Clock.currentTimeMillis
        const remainingMs = lastConfirmedPulseMs + toleranceMs - nowMs
        if (remainingMs <= 0) {
          yield* expire(nowMs)
          continue
        }
        // Check alongside pulse intervals, with a shorter final wait when needed.
        yield* Effect.sleep(Math.min(remainingMs, intervalMs))
      }
    })
    const pulses = Effect.sleep(heartbeatInterval).pipe(
      Effect.andThen(Clock.currentTimeMillis.pipe(Effect.map(Math.floor))),
      Effect.flatMap((nowMs) =>
        nowMs - lastConfirmedPulseMs >= toleranceMs ? expire(nowMs) : runStore.heartbeat(runId, owner, nowMs).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Updated"
              ? Effect.sync(() => {
                lastConfirmedPulseMs = Math.max(lastConfirmedPulseMs, nowMs)
                failing = false
              })
              : Effect.interrupt
          ),
          // A failed write keeps the confirmed lease; the independent deadline
          // supervises its expiry. Warn on the first failure of an outage.
          Effect.catch((error) => {
            if (failing) return Effect.void
            failing = true
            return Effect.logWarning("run heartbeat write failed").pipe(
              Effect.annotateLogs({ runId, code: error.code })
            )
          })
        )
      ),
      Effect.forever
    )
    return yield* Effect.raceFirst(pulses, deadline)
  })
