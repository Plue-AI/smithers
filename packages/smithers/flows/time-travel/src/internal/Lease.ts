/**
 * Ownership-lease helpers rewind and recovery share while they hold a run.
 *
 * @since 0.1.0
 */

import * as Journal from "@smthrs/journal/Journal"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import type * as RunStore from "@smthrs/run-store/RunStore"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import * as RunRow from "./RunRow.ts"

/**
 * Runs a `RunStore` ownership operation with the `Journal` masked out of the
 * fiber context, so it fences through the consensus lease without appending
 * an ownership-transition event.
 *
 * Time travel's fencing is administrative, not run history: a rewind's
 * `claimed`/`activated` pair would land inside the very suffix window
 * `archiveAndTruncate` cuts, its closing `released` would dangle past the
 * restored frame, and recovery's archive-commit check reads "no live entries
 * after the frame" as commit evidence. The durable record of who drove a
 * rewind is the audit row. Ordinary drivers keep appending their transitions;
 * only the surgery's own fencing on the run under the knife is silent —
 * cancelling a detached child is a real transition in a journal that
 * survives, so it stays recorded.
 *
 * @since 1.0.0
 * @category combinators
 */
export const unjournaled = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E, Journal.Journal> =>
  Effect.updateContext(effect, (context: Context.Context<Journal.Journal>) => Context.omit(Journal.Journal)(context))

/**
 * A run lease held by {@link withHeldLease}.
 *
 * @since 0.1.0
 * @category models
 */
export interface HeldLease {
  /**
   * Runs `body` until it settles or the heartbeat loses the fence, whichever
   * comes first. Losing the fence fails with `fence_lost` unless
   * {@link HeldLease.releasing} ran first.
   */
  readonly guard: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | TimeTravelError, R>
  /**
   * Marks the ownership release as intentional. The transition that gives the
   * run back ends the heartbeat, and that loss is then expected, not a fault.
   */
  readonly releasing: Effect.Effect<void>
}

/**
 * Holds the lease on `runId` for the whole of `use`.
 *
 * The claim stamps one heartbeat and nothing else renews it, so a compensation
 * handler, a jj restore, or an archive slower than `heartbeatStaleAfter` would
 * leave the row looking abandoned and let another engine steal it. A heartbeat
 * fiber pulses for as long as `use` runs, including any cleanup `use` performs
 * after its guarded body, and is interrupted on every exit.
 *
 * @since 0.1.0
 * @category combinators
 */
export const withHeldLease = <A, E, R>(
  runId: string,
  owner: OwnerId,
  use: (lease: HeldLease) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | RunStore.RunStore> =>
  Effect.acquireUseRelease(
    Effect.forkChild(Ownership.heartbeatLoop(runId, owner), { startImmediately: true }),
    (heartbeat) => {
      let released = false
      return use({
        guard: (body) =>
          Effect.raceFirst(
            body,
            Fiber.await(heartbeat).pipe(
              Effect.flatMap(() =>
                released ? Effect.never : Effect.fail(error("fence_lost", `run ${runId} lost its ownership lease`))
              )
            )
          ),
        releasing: Effect.sync(() => {
          released = true
        })
      })
    },
    (heartbeat) => Fiber.interrupt(heartbeat)
  )

/**
 * One claim-then-activate request against an exact row snapshot.
 *
 * @since 0.1.0
 * @category models
 */
export interface ClaimRequest {
  readonly runId: string
  readonly expected: RunStore.RunSnapshot
  readonly claimant: OwnerId
  readonly nowMs: number
  /** Present: steal from a dead owner. Absent: claim an unowned row. */
  readonly evidence?: LivenessEvidence | undefined
  /** Operation names for run-store failures, e.g. `claim run`. */
  readonly operations: { readonly claim: string; readonly activate: string }
  /** The refusal for a claim that did not return `Claimed`. */
  readonly refused: (outcome: RunStore.StealOutcome) => TimeTravelError
  /** The refusal for an activation that lost the claim. */
  readonly lost: TimeTravelError
}

/**
 * Claims (or steals) a row, then activates it, abandoning the claim when the
 * activation loses. Returns the claim timestamp the activated lease carries.
 *
 * @since 0.1.0
 * @category constructors
 */
export const claimAndActivate = (
  runs: RunStore.Service,
  request: ClaimRequest
): Effect.Effect<number, TimeTravelError> =>
  Effect.gen(function*() {
    const { claimant, evidence, expected, nowMs, runId } = request
    const claimed = yield* (evidence === undefined
      ? runs.claim(runId, expected, claimant, nowMs)
      : runs.steal(runId, expected, claimant, nowMs, evidence)).pipe(
        Effect.mapError((cause) => RunRow.failure(request.operations.claim, cause))
      )
    if (claimed._tag !== "Claimed") return yield* Effect.fail(request.refused(claimed))
    const activated = yield* runs.activate(runId, claimant, claimed.claimedAtMs, expected).pipe(
      Effect.mapError((cause) => RunRow.failure(request.operations.activate, cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(runId, claimant, claimed.claimedAtMs))
      return yield* Effect.fail(request.lost)
    }
    return claimed.claimedAtMs
  })
