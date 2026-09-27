/**
 * Process containment: prepared ownership, bounded cleanup and durable records.
 *
 * A host supplies a {@link Lifecycle} that owns launch and cleanup independently
 * of the command's exit status. The lifecycle first prepares a process identity;
 * this decorator commits that identity to {@link ProcessLedger.ProcessLedger}
 * before activating the caller's command. Failed or interrupted startup closes
 * its child scope immediately, including any earlier legs of a partial pipeline.
 *
 * Each command receives default termination and escalation options. The host
 * lifecycle validates that policy and verifies cleanup before the decorator
 * retires its record. Unverifiable cleanup retains the record for recovery;
 * a host that dies also leaves its committed records discoverable by the next
 * incarnation's reaper (`ProcessReaper` in `@smthrs/platform-node`).
 *
 * Every pipeline leg is prepared and recorded separately, including legs whose
 * pid the aggregate handle does not expose. The module remains platform-neutral.
 * A layer without a lifecycle provides only deadline defaults and bookkeeping;
 * it does not declare the verified-cleanup contract read by {@link isContained}.
 *
 * Governing design:
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  type ChildProcessHandle,
  ChildProcessSpawner,
  make as makeSpawner
} from "effect/unstable/process/ChildProcessSpawner"
import * as CommandLine from "./CommandLine.ts"
import * as Containment from "./internal/Containment.ts"
import * as Pipeline from "./internal/Pipeline.ts"
import * as ProcessLedger from "./ProcessLedger.ts"

/**
 * How long a contained child may take to honour `SIGTERM`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const defaultGraceMs = 2000

/**
 * Containment configuration.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /**
   * Milliseconds between the `SIGTERM` that asks a child to stop and the
   * `SIGKILL` that makes it. Default {@link defaultGraceMs}.
   */
  readonly graceMs?: number | undefined
  /**
   * The platform the host spawner runs on, as `process.platform` spells it.
   * Windows records no POSIX process group, including for detached children.
   * On POSIX, detachment determines whether the child leads its own group.
   * Default `"linux"`; host bundles pass their actual platform.
   */
  readonly platform?: string | undefined
}

/**
 * A platform's preparation, activation, and cleanup of a contained process.
 *
 * Preparation receives the underlying spawner and must own cleanup before it
 * can fail or be interrupted. It returns the process identity to record and an
 * idempotent `activate` effect. The decorator runs activation only after that
 * identity commits to the ledger. A platform can therefore prepare an owner
 * without executing the caller's command before it is durably discoverable.
 *
 * Failed startup closes its own scope immediately. A successful startup keeps
 * that scope attached to the caller's scope. `settled` must stay false on failed
 * or unverifiable cleanup; only verified cleanup permits ledger retirement.
 * The wrapped handle applies the same policy to an explicit `kill`.
 *
 * @category models
 * @since 1.0.0
 */
export type Lifecycle = (
  command: ChildProcess.StandardCommand,
  spawn: (
    command: ChildProcess.StandardCommand
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>
) => Effect.Effect<
  {
    readonly handle: ChildProcessHandle
    readonly activate: Effect.Effect<void, PlatformError.PlatformError, Scope.Scope>
    readonly settled: Effect.Effect<boolean>
  },
  PlatformError.PlatformError,
  Scope.Scope
>

/**
 * Whether a spawner declares the platform lifecycle required for containment.
 *
 * Only a layer with a {@link Lifecycle} declares this contract. A kill deadline
 * alone does not verify cleanup. The permission decorator preserves the
 * declaration when it wraps a contained service. The marker interoperates
 * across the package's ESM and CommonJS projections.
 *
 * This is a trusted composition check: a caller-supplied lifecycle remains
 * responsible for implementing its contract.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isContained = (spawner: ChildProcessSpawner["Service"]): boolean => Containment.isContained(spawner)

/**
 * Supplies a command's default termination signal and escalation deadline.
 *
 * Both legs of a pipeline get the same policy — a pipeline is one action's
 * process tree and a surviving leg is as much of a leak as a surviving
 * child. Explicit `killSignal` and `forceKillAfter` values are preserved for
 * the host lifecycle to validate.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const withContainment = (
  command: ChildProcess.Command,
  options?: Options
): ChildProcess.Command => {
  const graceMs = options?.graceMs ?? defaultGraceMs
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      withContainment(command.left, options),
      withContainment(command.right, options),
      command.options
    )
  }
  return ChildProcess.make(command.command, [...command.args], {
    ...command.options,
    killSignal: command.options.killSignal ?? "SIGTERM",
    forceKillAfter: command.options.forceKillAfter ?? graceMs
  })
}

/**
 * The process group a started child leads, or `null` when it shares the
 * host's or the platform has no POSIX process groups.
 *
 * A detached POSIX child leads a group whose id is its own pid. A child in
 * the host's group must not record that group as its own cleanup target.
 * Windows detachment creates an independent console, not a POSIX group;
 * Windows records therefore always carry `null`.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const groupOf = (command: ChildProcess.Command, pid: number, platform?: string): number | null => {
  if (platform === "win32") return null
  const options = command._tag === "PipedCommand" ? rightmost(command).options : command.options
  return (options.detached ?? true) ? pid : null
}

const rightmost = (command: ChildProcess.Command): ChildProcess.StandardCommand =>
  command._tag === "StandardCommand" ? command : rightmost(command.right)

/**
 * Decorates the process spawner in place with containment and bookkeeping.
 *
 * Compose it over a host spawner layer with `Layer.provide`. It provides the
 * tag it also requires. Compose the permission decorator over this layer to
 * authorize the caller's whole pipeline before its per-process expansion. A
 * lifecycle may use different commands during preparation; a decorator below
 * containment sees those platform commands instead of the caller's command.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  options?: Options,
  lifecycle?: Lifecycle
): Layer.Layer<ChildProcessSpawner, never, ChildProcessSpawner | ProcessLedger.ProcessLedger> =>
  Layer.effect(
    ChildProcessSpawner,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const ledger = yield* ProcessLedger.ProcessLedger
      const service = makeSpawner(
        (command) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function*() {
              // A failed startup must clean up even when its caller catches the
              // error and keeps the outer scope open. One child scope contains
              // the entire pipeline, so failure of a later leg also closes all
              // earlier legs. Successful spawns retain it until their caller closes.
              const processScope = yield* Scope.fork(yield* Scope.Scope)
              return yield* restore(
                Pipeline.spawn(
                  command,
                  Effect.fn("ContainedSpawner.spawn")(function*(command) {
                    // The release finalizer is registered BEFORE the spawn, so scope
                    // closure runs it AFTER the spawn's own kill finalizer: finalizers
                    // run last-registered-first, and a ledger that announced an exit
                    // while the process was still being signalled would be telling the
                    // next incarnation to stop looking for something still alive. The
                    // slot is empty until the record exists, which is also what makes a
                    // spawn that never got recorded a no-op to release.
                    const slot: { current?: ProcessLedger.ProcessRecord; settled: Effect.Effect<boolean> } = {
                      settled: Effect.succeed(true)
                    }
                    yield* Effect.addFinalizer(() =>
                      Effect.gen(function*() {
                        if (slot.current === undefined) return
                        if (yield* slot.settled) return yield* releaseQuietly(ledger, slot.current)
                        yield* Effect.logWarning(
                          `process cleanup could not verify ${slot.current.pid}; retaining its ledger record`
                        )
                      })
                    )
                    const contained = withContainment(command, options) as ChildProcess.StandardCommand
                    const watched = lifecycle === undefined ? undefined : yield* lifecycle(contained, spawner.spawn)
                    const handle = watched?.handle ?? (yield* spawner.spawn(contained))
                    slot.settled = watched?.settled ?? slot.settled
                    const pid = handle.pid as number
                    slot.current = yield* ledger.record({
                      pid,
                      pgid: groupOf(command, pid, options?.platform),
                      commandDigest: CommandLine.executable(command)
                    }).pipe(
                      // A spawn whose record did not commit is precisely the child this
                      // module exists to make discoverable, so it is not started: the
                      // process is signalled and the caller is told, rather than left
                      // running with nothing durable naming it.
                      Effect.tapCause(() => Effect.ignore(handle.kill())),
                      Effect.mapError(unrecorded)
                    )
                    if (watched !== undefined) yield* watched.activate
                    return handle
                  })
                ).pipe(Scope.provide(processScope))
              ).pipe(
                Effect.onError((cause) => Scope.close(processScope, Exit.failCause(cause)))
              )
            })
          )
      )
      return lifecycle === undefined ? service : Containment.mark(service)
    })
  )

/** The spawn failure a caller sees when the ledger could not record a child. */
const unrecorded = (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "spawn",
    description: "the process ledger could not record this spawn durably",
    cause
  })

/**
 * Retires a record on scope close, retrying the durable write.
 *
 * A finalizer has nowhere to report a failure, so the retry is the report: an
 * exit that never commits leaves the record inherited, and the next
 * incarnation's reaper finds a pid that is already gone and retires it then.
 * That is the safe direction, and the reason this is the ONE place a ledger
 * failure is logged rather than propagated.
 */
const releaseQuietly = (
  ledger: ProcessLedger.Service,
  record: ProcessLedger.ProcessRecord
): Effect.Effect<void> =>
  ledger.release(record).pipe(
    Effect.retry(Schedule.recurs(2)),
    Effect.catch((error) =>
      Effect.logWarning(`process ledger could not retire ${record.pid}; leaving it for the reaper`, error)
    )
  )
