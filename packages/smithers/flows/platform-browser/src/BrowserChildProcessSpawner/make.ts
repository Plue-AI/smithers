/**
 * The just-bash-backed `ChildProcessSpawner` adapter.
 *
 * @since 1.0.0-rc.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { ExitCode, make as makeSpawner, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { captured } from "./captured.ts"
import type { JustBashLike } from "./JustBashLike.ts"

/**
 * A capability the adapter does not provide, reported as a system failure.
 *
 * @private
 */
const unsupported = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, description })

/**
 * Caller input this backend cannot honour, rejected before anything runs.
 *
 * @private
 */
const rejected = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: "ChildProcess", method, description })

/**
 * The reason `exitCode`, `stdout`, `stderr`, and `all` report after a `kill`
 * or a scope closure that aborted the run.
 *
 * The handle's observables are typed `Effect<_, PlatformError>`. Replaying the
 * worker's interrupt through them instead would cancel the caller's own fiber,
 * which is indistinguishable from the whole run being cancelled by someone
 * else, so an abort is reported as a value in the error channel.
 *
 * @private
 */
const aborted = (line: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method: "kill",
    description: "the interpreter run was aborted",
    pathOrDescriptor: line
  })

/**
 * `true` when the caller wired a `Stream` into stdin, in any of its shapes.
 *
 * @private
 */
const suppliesStdin = (options: ChildProcess.CommandOptions): boolean => {
  const stdin = options.stdin
  if (stdin === undefined || typeof stdin === "string") return false
  return Stream.isStream(stdin) || Stream.isStream(stdin.stream)
}

/**
 * The reason a supplied stdin is refused. just-bash itself accepts a string
 * `stdin` — `@smthrs/sandbox`'s provider passes one — so the limitation is
 * this adapter's run-to-completion capture, not the interpreter's.
 *
 * @private
 */
const noStdin = "this adapter runs the interpreter once with captured output and cannot stream stdin into it"

/**
 * `env` without the `undefined` values just-bash has no way to represent.
 *
 * @private
 */
const resolveEnvironment = (
  options: ChildProcess.CommandOptions
): Record<string, string> | undefined => {
  if (options.env === undefined) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * The interpreter call as a promise that always settles with an outcome,
 * never by rejecting, so the permit can be held until it is over.
 *
 * @private
 */
type Settled = { readonly ok: true; readonly value: Awaited<ReturnType<JustBashLike["exec"]>> } | {
  readonly ok: false
  readonly error: unknown
}

/**
 * Builds the `ChildProcessSpawner` service over a just-bash interpreter.
 *
 * Public for the same reason `BrowserFileSystem.make` is: a caller that
 * already holds `FileSystem` and `Path` can construct the service without
 * going through a `Layer`. `layer` is the ordinary route.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (bash: JustBashLike) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    /** Runs are serialized so two interpreters never mutate the mount at once. */
    const gate = Semaphore.makeUnsafe(1)
    let pid = 0

    const resolveWorkingDirectory = Effect.fnUntraced(
      function*(options: ChildProcess.CommandOptions) {
        if (options.cwd === undefined) return undefined
        const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(options.cwd) || /^\\\\/.test(options.cwd)
        const cwd = windowsAbsolute
          ? options.cwd
          : path.isAbsolute(options.cwd)
          ? path.normalize(options.cwd)
          : path.resolve("/", options.cwd)
        // A regular file passes a bare existence check and is then handed to
        // the interpreter as a working directory, where Node fails ENOTDIR.
        const info = yield* fs.stat(cwd)
        if (info.type !== "Directory") {
          return yield* Effect.fail(rejected("spawn", `the working directory ${options.cwd} is not a directory`))
        }
        return cwd
      }
    )

    const spawnCommand: (
      command: ChildProcess.Command
    ) => Effect.Effect<
      ChildProcessHandle,
      PlatformError.PlatformError,
      Scope.Scope
    > = Effect.fnUntraced(function*(cmd) {
      if (cmd._tag === "PipedCommand") {
        return yield* Effect.fail(rejected(
          "spawn",
          "just-bash has no process table to pipe between; express the pipeline as a single command line"
        ))
      }
      if (suppliesStdin(cmd.options)) {
        return yield* Effect.fail(rejected("spawn", noStdin))
      }
      if (cmd.options.additionalFds !== undefined && Object.keys(cmd.options.additionalFds).length > 0) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot configure additional file descriptors"))
      }
      if (typeof cmd.options.shell === "string") {
        return yield* Effect.fail(rejected(
          "spawn",
          `just-bash cannot select the requested shell ${cmd.options.shell}`
        ))
      }
      if (cmd.options.detached === true) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot detach a command from the browser tab"))
      }
      if (cmd.options.forceKillAfter !== undefined) {
        return yield* Effect.fail(rejected(
          "spawn",
          "just-bash has no force-stop after the abort, so forceKillAfter cannot be honoured"
        ))
      }

      const cwd = yield* resolveWorkingDirectory(cmd.options)
      const env = resolveEnvironment(cmd.options)
      const line = CommandLine.render(cmd)

      const completed = yield* Deferred.make<
        Awaited<ReturnType<JustBashLike["exec"]>>,
        PlatformError.PlatformError
      >()
      let running = true
      /**
       * The permit is held until the interpreter promise itself settles, not
       * until the calling fiber stops waiting for it. `Effect.tryPromise`
       * aborts and resumes in the same turn, which would release the permit
       * with the call still in flight and let a second interpreter mutate the
       * mount concurrently — the exact overlap the semaphore exists to
       * prevent.
       */
      const execute = gate.withPermit(
        Effect.flatMap(
          Effect.suspend(() => {
            const controller = new AbortController()
            let settled: Promise<Settled>
            try {
              settled = bash.exec(line, {
                ...(cwd === undefined ? {} : { cwd }),
                ...(env === undefined ? {} : { env }),
                // Effect's default is replacement; `extendEnv: true` is the
                // merge. just-bash merges unless it is asked for `replaceEnv`,
                // so the request has to be made rather than assumed.
                ...(env === undefined || cmd.options.extendEnv === true ? {} : { replaceEnv: true }),
                signal: controller.signal
              }).then(
                (value): Settled => ({ ok: true, value }),
                (error): Settled => ({ ok: false, error })
              )
            } catch (error) {
              // An interpreter that throws synchronously never produced a
              // promise to wait on, and it is still a failed run rather than a
              // defect in this adapter.
              return Effect.succeed<Settled>({ ok: false, error })
            }
            return Effect.onInterrupt(
              Effect.promise(() => settled),
              () => Effect.andThen(Effect.sync(() => controller.abort()), Effect.promise(() => settled))
            )
          }),
          (outcome) =>
            outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
                description: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
                cause: outcome.error
              })
            )
        )
      )
      const worker = yield* execute.pipe(
        /**
         * A cause carrying both a failure and an interrupt would report the
         * abort and drop the failure. Nothing in `execute` can produce one:
         * `Effect.promise` cannot fail, and neither the abort finalizer nor
         * the permit release can, so the only reasons reachable here are one
         * `Fail` or one `Interrupt`.
         */
        Effect.onExit((exit) => {
          const reported: Exit.Exit<
            Awaited<ReturnType<JustBashLike["exec"]>>,
            PlatformError.PlatformError
          > = Exit.hasInterrupts(exit) ? Exit.fail(aborted(line)) : exit
          return Effect.sync(() => {
            running = false
          }).pipe(Effect.andThen(Deferred.done(completed, reported)))
        }),
        Effect.forkScoped({ startImmediately: true })
      )
      const result = Deferred.await(completed)
      const stdout = Stream.unwrap(Effect.map(result, (value) => captured(value.stdout, cmd.options.stdout)))
      const stderr = Stream.unwrap(Effect.map(result, (value) => captured(value.stderr, cmd.options.stderr)))

      return makeHandle({
        pid: ProcessId(++pid),
        exitCode: Effect.map(result, (value) => ExitCode(value.exitCode)),
        isRunning: Effect.sync(() => running),
        /**
         * `killSignal` is meaningless for an interpreter that has no process
         * to signal, so it is accepted and ignored. `forceKillAfter` is a
         * request this backend cannot honour at all: there is no second, harder
         * stop after the abort, so it is refused rather than dropped.
         */
        kill: (options) =>
          options?.forceKillAfter === undefined
            ? Fiber.interrupt(worker).pipe(Effect.asVoid)
            : Effect.fail(rejected(
              "kill",
              "just-bash has no force-stop after the abort, so forceKillAfter cannot be honoured"
            )),
        stdin: Sink.fail(unsupported("stdin", noStdin)),
        stdout,
        stderr,
        all: Stream.concat(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })

    return makeSpawner(spawnCommand)
  })
