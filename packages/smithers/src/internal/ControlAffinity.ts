/**
 * Control ownership admission before the native engine takes an execution.
 * @since 1.0.0
 */

import { Ownership, type RunStore } from "@smthrs/run-store"
import { Cause, Clock, Duration, Effect } from "effect"

interface Options {
  readonly runs: RunStore.Service
  readonly claimant: Ownership.OwnerId
  readonly isAlive?: Ownership.LivenessCheck | undefined
}

/**
 * A released engine row does not release its separate control claim.
 * Read that claim before engine recovery; the control runtime still performs
 * the authoritative fenced takeover when the handler enters.
 * @since 1.0.0
 * @private
 */
export const make =
  ({ runs, claimant, isAlive = Ownership.sameHostPidProbe }: Options) => (runId: string): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const row = yield* runs.get(runId).pipe(
        Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.fail(error))
      )
      // Engine-only children have no control row. Suspended control rows have
      // released their claim and retain the session's resume delegation policy.
      if (row === undefined || row.status !== "running") return true
      if (row.owner === null) return false
      if (row.owner.hostId === claimant.hostId && row.owner.pid === claimant.pid) return true
      const nowMs = yield* Clock.currentTimeMillis
      if (row.heartbeatAtMs === null || row.heartbeatAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)) {
        return false
      }
      return !(yield* isAlive(row.owner, { claimant, heartbeatAtMs: row.heartbeatAtMs, nowMs }))
    }).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Control ownership admission failed; leaving the execution parked", { runId }).pipe(
          Effect.as(false)
        )
    ))
