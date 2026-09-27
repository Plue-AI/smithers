/**
 * Scoped transient commands with the host's process-tree cleanup policy.
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as PlatformError from "effect/PlatformError"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import * as PipedProcess from "./internal/PipedProcess.ts"
import { targetPidOf } from "./internal/ProcessSupervisor.ts"
import * as ProcessReaper from "./ProcessReaper.ts"

/**
 * One command's literal argv, environment, pipes and termination policy.
 * @category models
 * @since 1.0.0
 */
export interface Options extends ChildProcess.KillOptions {
  readonly command: string
  readonly args?: ReadonlyArray<string> | undefined
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly stdin?: "ignore" | "pipe" | undefined
  readonly windowsVerbatimArguments?: boolean | undefined
  readonly windowsHide?: boolean | undefined
}

/**
 * The managed owner identity and the actual target identity are distinct.
 * @category models
 * @since 1.0.0
 */
export interface Handle extends ChildProcessHandle {
  /** The native target's pid, for diagnostics and service liveness. */
  readonly targetPid: number
}

/**
 * Starts a pipe-based command and contains its lifetime inside the caller's
 * scope. The returned pid names the live supervisor; exitCode reports
 * the actual target. The private parent connection stops the tree on host loss.
 * Transient commands have no durable ledger; durable hosts use NodeHost instead.
 *
 * Unconsumed output stays in bounded native buffers until it is read or the
 * scope closes. Consume stdout and stderr alongside exitCode: a command can
 * block when an unread pipe is full.
 *
 * Failed startup closes its child scope before returning an error, even when
 * the caller catches that error and retains the surrounding scope.
 * @category constructors
 * @since 1.0.0
 */
export const spawn = (
  options: Options
): Effect.Effect<Handle, PlatformError.PlatformError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const command = ChildProcess.make(options.command, [...options.args ?? []], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: false,
        stdin: options.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
        killSignal: options.killSignal ?? "SIGTERM",
        forceKillAfter: options.forceKillAfter ?? 2000,
        windowsHide: options.windowsHide ?? true,
        // Preserve the target's native option through the private protocol.
        ...{ windowsVerbatimArguments: options.windowsVerbatimArguments }
      })
      return yield* restore(
        Effect.gen(function*() {
          const prepared = yield* ProcessReaper.processLifecycle(
            command,
            (command) => PipedProcess.spawn(command, false, true)
          )
          yield* prepared.activate
          const targetPid = targetPidOf(prepared.handle)
          if (targetPid === undefined) {
            return yield* Effect.fail(
              PipedProcess.failure("spawn", new Error("The supervisor did not identify its target"))
            )
          }
          return Object.defineProperty(prepared.handle, "targetPid", { value: targetPid, enumerable: true }) as Handle
        }).pipe(Scope.provide(scope))
      ).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
      )
    })
  )

/**
 * The native command's result, preserving a signal instead of inventing a code.
 * @category models
 * @since 1.0.0
 */
export interface Status {
  readonly code: number | null
  readonly signal: ChildProcess.Signal | null
}

/**
 * Reads the target's result. Failures without an actual target signal remain
 * platform failures, including loss of the supervisor before a result arrives.
 * @category execution
 * @since 1.0.0
 */
export const status = (handle: ChildProcessHandle): Effect.Effect<Status, PlatformError.PlatformError> =>
  handle.exitCode.pipe(
    Effect.map((code): Status => ({ code, signal: null })),
    Effect.catch((error) => {
      const cause = "cause" in error.reason ? error.reason.cause : undefined
      const signal = typeof cause === "object" && cause !== null && "signal" in cause ? cause.signal : undefined
      return typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal)
        ? Effect.succeed({ code: null, signal: signal as ChildProcess.Signal })
        : Effect.fail(error)
    })
  )
