/**
 * Adapts a remote provider to Effect's `ChildProcessSpawner`.
 *
 * Provider packages adapt their SDK sessions to `Provider`; this module owns
 * the conversion to Effect's `ChildProcessSpawner` contract and its
 * `PlatformError` surface, so a remote session is the same service a local
 * process spawner is. Opening a provider is scoped, so interruption closes the
 * layer scope and runs the provider's cancellation finalizer. No `AbortSignal`
 * crosses this seam.
 *
 * @since 0.1.0
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { concat } from "../internal/concat.ts"
import { elapsed } from "../internal/deadline.ts"
import { platformFailure } from "../internal/platformReason.ts"
import type { Provider, RemoteProcess } from "./Provider.ts"
import type { ProviderError } from "./ProviderError.ts"

const MODULE = "ChildProcess"

/**
 * How long the signal a closing scope sends is given before the close moves
 * on without it.
 *
 * A finalizer runs uninterruptibly, so a provider whose `kill` never settles
 * wedges the fiber closing the scope, and cancellation, layer teardown, and
 * process shutdown with it. The signal is a courtesy the provider's own
 * release finalizer repeats when it tears the session down, so it is bounded
 * rather than waited on: `SandboxSupervision` bounds a caller-supplied
 * reporter for the same reason. The bound runs on the platform timer, not the
 * ambient `Clock`, because a caller's test clock can freeze that one and a
 * frozen clock would restore the hang this exists to prevent.
 */
const signalWithin = Duration.seconds(5)

const platformError = platformFailure

const ambient = new Set(ChildProcessEnvironment.inheritedNames)

/**
 * A command's environment as a remote guest receives it.
 *
 * A caller that builds a least-authority environment for a local child
 * (`ChildProcessEnvironment.make`) carries this process's own `PATH`, `HOME`,
 * `TMPDIR`, `USER`, `SHELL`, `LANG`, `TERM` and locale. Those name places and
 * identities on this machine, not in the guest: a guest handed the host's
 * `HOME` looks for its caches under a directory it does not have, and one
 * handed the host's `TMPDIR` writes temporary files where it cannot. An entry
 * that only repeats this process's ambient value is dropped, so the guest
 * keeps its own; a value set on purpose (one that differs), a removal, and
 * every other name cross unchanged.
 */
const guestEnvironment = (
  env: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string | undefined> | undefined => {
  if (env === undefined) return undefined
  const host = globalThis.process.env
  const guest: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase()
    const hostAmbient = (ambient.has(upper) || upper.startsWith("LC_")) && value !== undefined && host[name] === value
    if (!hostAmbient) guest[name] = value
  }
  return guest
}

const noStdin = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "spawn",
    description: `remote sessions do not pipe stdin to \`${command}\``
  })

const noKill = (command: string): PlatformError.PlatformError =>
  PlatformError.badArgument({
    module: MODULE,
    method: "kill",
    description: `remote sessions end \`${command}\` by closing its scope, not by signal`
  })

/** The signal a kill delivers when neither the caller nor the command named one. */
const defaultSignal: ChildProcess.Signal = "SIGTERM"

const rejected = (description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: MODULE, method: "spawn", description })

/** The stream a command supplies as its standard input, if it supplies one. */
const stdinStream = (
  options: ChildProcess.CommandOptions
): Stream.Stream<Uint8Array, unknown> | undefined => {
  const stdin = options.stdin
  if (stdin === undefined || typeof stdin === "string") return undefined
  if (Stream.isStream(stdin)) return stdin
  return Stream.isStream(stdin.stream) ? stdin.stream : undefined
}

/**
 * The most a command may feed a remote session on standard input.
 *
 * The seam carries input as one complete blob, because the transports beneath
 * the providers take an input blob up front or take none at all, so the whole
 * stream has to be held in memory before the command starts. The bound keeps
 * a runaway producer from turning that into an unbounded allocation; anything
 * larger belongs in a file the command reads itself.
 */
const maxStdinBytes = 16 * 1024 * 1024

/**
 * Reads a command's whole standard input, refusing it the moment it crosses
 * the bound rather than once the producer is done.
 *
 * The order matters twice over. Folding the stream into a growing
 * `Uint8Array` and comparing the length afterwards let an unbounded producer
 * allocate without limit before the bound was ever evaluated — and never
 * evaluated it at all for a stream that does not end — while copying the
 * accumulator per chunk cost O(n^2) bytes moved, roughly 32 GiB for a 16 MiB
 * input arriving in 4 KiB pieces. Counting as the chunks arrive fails the
 * spawn on the first chunk that would cross the bound, which interrupts the
 * producer.
 *
 * Each accepted chunk is copied when it arrives rather than retained. A
 * producer with a fixed read buffer — the ordinary shape for anything reading
 * a file or a socket into scratch space — emits the same `Uint8Array` again
 * with new contents, so retaining the references and copying them at the end
 * delivered the last chunk's bytes in every earlier chunk's place: an input
 * of `[1, 2]` reached the provider as `[2, 2]`. The copy is the only moment
 * the bytes are demonstrably the caller's, and two linear passes over an
 * input this seam already holds whole cost nothing next to that.
 */
const collectStdin = (
  command: string,
  stream: Stream.Stream<Uint8Array, unknown>
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = []
    let length = 0
    return Stream.runForEach(
      Stream.mapError(stream, (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: MODULE,
          method: "spawn",
          description: `the standard input for \`${command}\` could not be read`,
          cause
        })),
      (part) =>
        Effect.suspend(() => {
          if (length + part.length > maxStdinBytes) {
            return Effect.fail(
              rejected(
                `the standard input for \`${command}\` exceeds ${maxStdinBytes} bytes; have the command read a file instead`
              )
            )
          }
          chunks.push(new Uint8Array(part))
          length += part.length
          return Effect.void
        })
    ).pipe(Effect.map(() => concat(chunks)))
  })

/** The literal handling a command names for its standard input, if it names one. */
const stdinHandling = (
  options: ChildProcess.CommandOptions
): ChildProcess.CommandInput | undefined => {
  const stdin = options.stdin
  if (stdin === undefined) return undefined
  if (typeof stdin === "string") return stdin
  if (Stream.isStream(stdin)) return undefined
  return typeof stdin.stream === "string" ? stdin.stream : undefined
}

/** The leftmost stage's options: a pipeline reads its input where it starts. */
const leftmostOptions = (command: ChildProcess.Command): ChildProcess.CommandOptions =>
  command._tag === "StandardCommand" ? command.options : leftmostOptions(command.left)

const validateCommand = (
  command: ChildProcess.Command,
  acceptsStdin: boolean,
  leftmost = true
): Effect.Effect<void, PlatformError.PlatformError> => {
  if (command._tag === "PipedCommand") {
    if (command.options.from !== undefined && command.options.from !== "stdout") {
      return Effect.fail(rejected(`a remote session cannot pipe from ${command.options.from}`))
    }
    if (command.options.to !== undefined && command.options.to !== "stdin") {
      return Effect.fail(rejected(`a remote session cannot pipe to ${command.options.to}`))
    }
    return Effect.andThen(
      validateCommand(command.left, acceptsStdin, leftmost),
      validateCommand(command.right, acceptsStdin, false)
    )
  }
  // `"inherit"` is the one input option the seam can neither honor nor
  // report through the handle. `"pipe"` and `"ignore"` are honest here — the
  // handle's `stdin` sink fails, and ignore genuinely means EOF — but a local
  // spawner hands an inheriting child this process's own standard input, and
  // a remote command would silently read EOF instead. The module's rule is
  // that a divergence it cannot preserve is refused, not hidden.
  if (stdinHandling(command.options) === "inherit" && leftmost) {
    return Effect.fail(rejected("a remote session cannot inherit this process's standard input"))
  }
  if (stdinStream(command.options) !== undefined && !(acceptsStdin && leftmost)) {
    return Effect.fail(
      rejected(
        acceptsStdin
          ? "a remote session feeds standard input to the first command of a pipeline only"
          : "this remote session cannot supply stdin to a command"
      )
    )
  }
  if (command.options.additionalFds !== undefined && Object.keys(command.options.additionalFds).length > 0) {
    return Effect.fail(rejected("a remote session cannot configure additional file descriptors"))
  }
  if (typeof command.options.shell === "string") {
    return Effect.fail(rejected(`a remote session cannot select the requested shell ${command.options.shell}`))
  }
  if (command.options.detached === true) {
    return Effect.fail(rejected("a remote session cannot detach a command from its session"))
  }
  return Effect.void
}

const outputStream = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  option: ChildProcess.CommandOutput | { readonly stream?: ChildProcess.CommandOutput | undefined } | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const handling = option === undefined || typeof option === "string" || Sink.isSink(option)
    ? option
    : option.stream
  if (handling === undefined || handling === "pipe" || handling === "overlapped") return stream
  if (Sink.isSink(handling)) return Stream.transduce(stream, handling)
  return Stream.empty
}

const rightmostOptions = (command: ChildProcess.Command): ChildProcess.CommandOptions =>
  command._tag === "StandardCommand" ? command.options : rightmostOptions(command.right)

/**
 * Allocates the `ProcessId` a handle reports.
 *
 * Scoped to one spawner, not to the module. A remote session has no local pid
 * to report, so the number is only ever an intra-spawner handle
 * discriminator — and a module-level `let nextPid = 1` made it process-global
 * state in a repository whose rule is that host access goes through a Layer.
 * Two spawner layers in one process shared a counter, so a handle's id
 * depended on how many processes an unrelated spawner had started.
 */
const pidAllocator = (): () => ProcessId => {
  let nextPid = 1
  return () => ProcessId(nextPid++)
}

const handleOf = (
  command: string,
  child: ChildProcess.Command,
  process: RemoteProcess,
  allocatePid: () => ProcessId,
  provider: Provider
): Effect.Effect<ChildProcessHandle, never, Scope.Scope> =>
  Effect.gen(function*() {
    let running = true
    const rawStdout = Stream.mapError(process.stdout, platformError("stdout", command))
    const rawStderr = Stream.mapError(process.stderr, platformError("stderr", command))
    const options = rightmostOptions(child)
    const stdout = outputStream(rawStdout, options.stdout)
    const stderr = outputStream(rawStderr, options.stderr)
    const completed = yield* Deferred.make<ExitCode, PlatformError.PlatformError>()
    // Either settlement of the provider's exit observation — a code or a
    // failure — means the remote process is gone, so both clear `running`:
    // a handle whose exit could not be read must not keep reporting itself
    // as a live process.
    const observeExit = process.exitCode.pipe(
      Effect.mapError((error) => {
        running = false
        return platformError("exitCode", command)(error)
      }),
      Effect.map((code) => {
        running = false
        return ExitCode(code)
      })
    )
    // Observe completion independently of whether a caller awaits `exitCode`.
    // The Deferred memoizes the one provider observation for every waiter, and
    // the scoped fiber cannot outlive the remote session that owns it.
    yield* Effect.forkScoped(Deferred.into(observeExit, completed))
    const kill = provider.kill
    const signalled: (signal: ChildProcess.Signal) => Effect.Effect<void, PlatformError.PlatformError> =
      kill === undefined
        ? () => Effect.fail(noKill(command))
        : (signal) => Effect.mapError(kill(process, signal), platformError("kill", command))
    if (kill !== undefined) {
      // Closing a process scope asks the provider to stop THAT command before
      // the provider's own release finalizer tears down whatever it owns. A
      // process this side has already seen exit is left alone: the pid it
      // named may belong to someone else by now.
      //
      // `running` is what this side has SEEN, and it lags what happened.
      // `ChildProcessSpawner.string` and `lines` are `Stream.mkString` and
      // `Stream.runCollect` over stdout alone: they close the process scope
      // the moment the output ends, which is before the forked observation of
      // the exit has landed, so a command that finished cleanly is signalled
      // anyway. That signal is harmless, but waiting on it is not — a provider
      // whose `kill` is slow charged every `string` caller the full
      // `signalWithin` bound after its command had already exited. So the wait
      // also ends the moment the exit observation arrives: the signal is still
      // sent for a process that may still be alive, and a process that turns
      // out to have finished stops costing anybody time.
      yield* Effect.addFinalizer(() =>
        running
          ? Effect.ignore(
            Effect.raceFirst(
              kill(process, rightmostOptions(child).killSignal ?? defaultSignal),
              Effect.raceFirst(Effect.ignore(Deferred.await(completed)), elapsed(signalWithin))
            )
          )
          : Effect.void
      )
    }
    return makeHandle({
      pid: allocatePid(),
      exitCode: Deferred.await(completed),
      isRunning: Effect.sync(() => running),
      kill: (options) => signalled(options?.killSignal ?? rightmostOptions(child).killSignal ?? defaultSignal),
      stdin: Sink.fail(noStdin(command)),
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  })

/**
 * Opens one provider session and adapts it, reporting whether the open
 * succeeded.
 *
 * The session is acquired in the caller's scope, so closing that scope runs
 * the finalizer `Provider.open` installed. This is the constructor for a
 * caller that has to TELL a session that opened from one that did not:
 * {@link make} deliberately cannot, and a supervisor that cached its result
 * as a live generation would replay one open failure for the life of the
 * layer without ever calling `open` again.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeOpened = (
  provider: Provider
): Effect.Effect<ChildProcessSpawner["Service"], ProviderError, Scope.Scope> =>
  Effect.map(provider.open(provider.session), () => {
    const allocatePid = pidAllocator()
    return makeSpawner(
      Effect.fnUntraced(function*(command: ChildProcess.Command) {
        yield* validateCommand(command, provider.stdin === true)
        const rendered = CommandLine.render(command)
        const input = stdinStream(leftmostOptions(command))
        const stdin = input === undefined ? undefined : yield* collectStdin(rendered, input)
        const started = yield* provider.spawn(rendered, {
          cwd: CommandLine.cwd(command),
          env: guestEnvironment(CommandLine.env(command)),
          ...stdin === undefined ? {} : { stdin }
        }).pipe(Effect.mapError(platformError("spawn", rendered)))
        return yield* handleOf(rendered, command, started, allocatePid, provider)
      })
    )
  })

/**
 * Opens one provider session and adapts it to Effect's `ChildProcessSpawner`.
 *
 * The session is acquired in the caller's scope, so closing that scope runs
 * the finalizer `Provider.open` installed. A session that could not be opened
 * still yields a service: every command it is given fails with the open error,
 * which keeps the failure on the action that tried to run something rather
 * than on whatever was building the layer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  provider: Provider
): Effect.Effect<ChildProcessSpawner["Service"], never, Scope.Scope> =>
  Effect.catch(
    makeOpened(provider),
    (error) =>
      Effect.succeed(
        makeSpawner((command: ChildProcess.Command) =>
          Effect.fail(platformError("open", CommandLine.render(command))(error))
        )
      )
  )

/**
 * Adapts a configured provider to Effect's `ChildProcessSpawner`.
 *
 * Provider acquisition is tied to the layer scope. Interrupting an execution
 * or stream consumer closes that scope and therefore runs the finalizer
 * installed by `Provider.open`.
 *
 * The command reaches the provider as the same rendered line
 * `@smthrs/kernel/ChildProcessSpawner` writes as the `proc:spawn` capability
 * resource, so a grant and the thing it authorizes read the same.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (provider: Provider): Layer.Layer<ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner, make(provider))
