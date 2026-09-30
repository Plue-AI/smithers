/**
 * Prepared process ownership and bounded release for Node and Bun hosts.
 * @since 1.0.0
 */

import { defaultGraceMs, type Lifecycle } from "@smthrs/kernel/ContainedSpawner"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { constants } from "node:os"
import { ProcessCleanupPolicyError } from "./ProcessCleanupPolicyError.ts"
import * as Supervisor from "./ProcessSupervisor.ts"

/**
 * An operating-system identity observed in a group.
 * @private
 * @since 1.0.0
 */
export interface Member {
  readonly pid: number
  readonly startedAtMs: number
  readonly zombie: boolean
}

/**
 * One bounded observation, including the host group.
 * @private
 * @since 1.0.0
 */
export interface Snapshot {
  readonly ownGroup: number
  readonly members: ReadonlyArray<Member>
}

/**
 * Observations can shorten or verify cleanup, but never authorize signals.
 * @private
 * @since 1.0.0
 */
export interface System {
  readonly platform: string
  readonly snapshot: (pgid: number) => Snapshot | undefined
  /**
   * True only when the kernel proves the group has no process at all. False
   * means occupied or unknown; `snapshot` still decides those.
   */
  readonly vacant: (pgid: number) => boolean
}

/**
 * A finite termination deadline understood by the private owner.
 * @private
 * @since 1.0.0
 */
export interface Policy {
  readonly killSignal: ChildProcess.Signal
  readonly graceMs: number
}

/**
 * Normalize and validate the deadline before it enters a native timer.
 * @private
 * @since 1.0.0
 */
export const policy = (
  options: ChildProcess.KillOptions,
  defaults: ChildProcess.KillOptions = {}
): Effect.Effect<Policy, PlatformError.PlatformError> =>
  Effect.try({
    try: () => {
      const killSignal = options.killSignal ?? defaults.killSignal ?? "SIGTERM"
      if (killSignal === "SIGSTOP" || constants.signals[killSignal] === undefined) {
        throw new ProcessCleanupPolicyError({
          code: "kill_signal_unsupported",
          message: `Unsupported process termination signal ${killSignal}`
        })
      }
      const graceMs = Duration.toMillis(options.forceKillAfter ?? defaults.forceKillAfter ?? defaultGraceMs)
      // Node/Bun clamp an overflowing timeout to 1 ms. Refuse that policy rather
      // than silently replacing a caller's grace with immediate termination.
      if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 2_147_483_647) {
        throw new ProcessCleanupPolicyError({
          code: "grace_out_of_range",
          message: "Process cleanup grace must fit a finite nonnegative native timer"
        })
      }
      return { killSignal, graceMs }
    },
    catch: (cause) => Supervisor.failure("kill", "process cleanup policy", cause)
  })

/**
 * Prepare a live owner before target activation. Windows attaches that owner
 * to a native job; POSIX uses its independently bounded process supervisor.
 * @private
 * @since 1.0.0
 */
export const lifecycle = (system: System): Lifecycle => Supervisor.prepare(system, policy)
