/**
 * Answers whether a recorded run owner is still alive on this host.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"

/**
 * The owner identity fields liveness is decided from.
 *
 * Structural on purpose: `@smthrs/journal`'s `OwnerId` is exactly this shape
 * plus a nonce, so an `OwnerId` is accepted here without this package taking a
 * dependency on the journal to name a type.
 *
 * @category models
 * @since 0.1.0
 */
export interface Owner {
  /** The host the owner ran on. */
  readonly hostId: string
  /** The operating-system process id that held the run. */
  readonly pid: number
}

/**
 * Liveness configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The host id this process answers for. */
  readonly hostId: string
  /**
   * How the probe asks the operating system. Default `process.kill`, which
   * delivers nothing for signal 0 and only reports whether the pid is
   * signalable.
   */
  readonly signal?: ((pid: number, signal: 0) => void) | undefined
}

const signalable = (send: (pid: number, signal: 0) => void, pid: number): boolean => {
  try {
    send(pid, 0)
    return true
  } catch (cause) {
    // ESRCH means the process is gone. EPERM means it exists and belongs to
    // another user, which is still a live owner this host must not rob. A throw
    // that is not an object at all carries no code, and reading through it
    // rather than off it is what stops that crashing the probe: a thrown string
    // or `null` is an answer nobody gave, which is a live owner.
    return (cause as { readonly code?: string } | null | undefined)?.code !== "ESRCH"
  }
}

/**
 * Builds the liveness probe `EngineStore` consults before it steals a run.
 *
 * The engine asks this before taking a run whose recorded owner it is not, so
 * a wrong `true` strands a run and a wrong `false` runs it twice. The rule is
 * therefore asymmetric on purpose:
 *
 * - An owner from a **different host** is alive. A pid means nothing across
 *   machines, and the process table this probe reads is only this machine's.
 * - An owner from **this host** is dead only when the signal-0 probe reports
 *   `ESRCH`. Every other result preserves liveness.
 *
 * The residual risk is pid reuse. An owner whose pid was recycled by an
 * unrelated program reads as alive and its run waits for an operator, which is
 * the safe direction: nothing about a recycled pid can tell this process
 * whether the run is still being driven, and the cost of guessing wrong the
 * other way is two hosts executing one run.
 *
 * A multi-process deployment with a supervisor or a lease system knows better
 * than any pid probe and should answer from that instead.
 *
 * `@smthrs/run-store`'s `Ownership.sameHostPidProbe` fills the same
 * `LivenessCheck`. Both probes use the same `ESRCH`-only death rule.
 * `EPERM`, `EINVAL`, and unknown signal errors preserve liveness.
 *
 * The cross-host policy differs. `sameHostPidProbe` compares the owner's
 * `hostId` with `context.claimant.hostId` and returns `false` for a foreign
 * host, leaving the expired lease to govern reclaiming the run. This probe
 * compares with the configured `hostId` and returns `true` for a foreign
 * host, so a permanently dead foreign host's runs wait for an operator.
 *
 * Which answer a deployment gets depends on the entry point it used:
 * `@smthrs/flows`' `NodeRuntime` defaults to this function, while
 * `@smthrs/cli`'s `NodeControl` passes `sameHostPidProbe`. This function
 * returns a one-argument function, which is structurally accepted as an
 * `Ownership.LivenessCheck` and ignores its `context` argument. Pick the
 * probe for its cross-host policy and source of host identity.
 *
 * @category constructors
 * @since 0.1.0
 */
export const isAlive = (options: Options): (owner: Owner) => Effect.Effect<boolean> => {
  const send = options.signal ?? ((pid, signal) => {
    process.kill(pid, signal)
  })
  return (owner) => Effect.sync(() => owner.hostId !== options.hostId || signalable(send, owner.pid))
}
