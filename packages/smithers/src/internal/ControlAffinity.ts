/**
 * Control ownership admission before the native engine takes an execution.
 * @since 1.0.0
 */

import { RunState } from "@smthrs/engine-store/RunState"
import { Ownership, type RunStore } from "@smthrs/run-store"
import { Cause, Clock, Duration, Effect, Schema } from "effect"

interface Options {
  readonly runs: RunStore.Service
  readonly engineRuns?: RunStore.Service | undefined
  readonly claimant: Ownership.OwnerId
  readonly isAlive?: Ownership.LivenessCheck | undefined
}

const ParkedOwner = Schema.Struct({ parkedBy: Schema.String, updatedAt: Schema.Number })
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(RunState))
const decodePark = Schema.decodeUnknownEffect(Schema.fromJsonString(ParkedOwner))
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Ownership.OwnerId))

/**
 * A released engine row does not release its separate control claim.
 * Read that claim before engine recovery; the control runtime still performs
 * the authoritative fenced takeover when the handler enters.
 * @since 1.0.0
 * @private
 */
export const make =
  ({ runs, engineRuns, claimant, isAlive = Ownership.sameHostPidProbe }: Options) =>
  (runId: string): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const readControl = (id: string) =>
        runs.get(id).pipe(
          Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.fail(error))
        )
      const sameProcess = (owner: Ownership.OwnerId) => owner.hostId === claimant.hostId && owner.pid === claimant.pid
      const nowMs = yield* Clock.currentTimeMillis
      const stale = (at: number | null) => at !== null && at < nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)
      const admitsRunning = (row: RunStore.RunRow) =>
        Effect.gen(function*() {
          if (row.status !== "running") return true
          if (row.owner === null) return false
          if (sameProcess(row.owner)) return true
          if (!stale(row.heartbeatAtMs)) return false
          return !(yield* isAlive(row.owner, { claimant, heartbeatAtMs: row.heartbeatAtMs, nowMs }))
        })
      const exact = yield* readControl(runId)
      // Root admission keeps the control session's existing resume policy.
      if (exact !== undefined) return yield* admitsRunning(exact)
      if (engineRuns === undefined) return true
      let native = yield* engineRuns.get(runId)
      if (native.cancelRequestedAtMs !== null) return true
      let state = yield* decodeState(native.stateJson)
      if (state.cancellation !== undefined) return true
      const released = native.status === "suspended" && state.result === undefined
      const seen = new Set([runId])
      for (;;) {
        const parent = state.parentExecutionId ?? native.parentRunId
        if (parent === undefined || parent === null) return true
        if (seen.has(parent)) return false
        seen.add(parent)
        const control = yield* readControl(parent)
        if (control !== undefined) {
          if (control.status !== "suspended") return yield* admitsRunning(control)
          const park = yield* decodePark(control.stateJson)
          const owner = yield* decodeOwner(park.parkedBy)
          // A lease interruption releases the child, not its external effect.
          // A live parked parent must explicitly resume before that effect retries.
          if (sameProcess(owner)) return !released
          if (!stale(park.updatedAt)) return false
          return !(yield* isAlive(owner, { claimant, heartbeatAtMs: park.updatedAt, nowMs }))
        }
        native = yield* engineRuns.get(parent)
        state = yield* decodeState(native.stateJson)
      }
    }).pipe(Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Control ownership admission failed; leaving the execution parked", { runId }).pipe(
          Effect.as(false)
        )
    ))
