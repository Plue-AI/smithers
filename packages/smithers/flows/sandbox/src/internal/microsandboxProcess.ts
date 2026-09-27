/**
 * Runs Microsandbox guest commands through the SDK's streaming handle.
 *
 * @since 0.1.0
 */

import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { Signal } from "effect/unstable/process/ChildProcess"
import type { Sdk } from "../MicrosandboxSandbox/Sdk.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { concat } from "./concat.ts"
import { elapsed } from "./deadline.ts"
import { execHandles } from "./execHandles.ts"
import { finalizeWithin } from "./finalizeWithin.ts"
import { hostKillScript } from "./killScript.ts"
import { linuxSignalNumber } from "./linuxSignals.ts"
import { warnTeardown } from "./teardownWarning.ts"

type VendorSandbox = Awaited<ReturnType<ReturnType<Sdk["Sandbox"]["builder"]>["create"]>>
type ExecHandle = Awaited<ReturnType<VendorSandbox["execStreamWith"]>>

/**
 * How long a command whose scope closed has to end after `SIGTERM` before the
 * tree is sent `SIGKILL`. It sits inside `finalizeWithin`'s five seconds, so
 * both signals fit under the teardown bound.
 */
const terminationGraceMs = 2_000

/**
 * One guest command line, where it runs, and what it is handed.
 *
 * @category models
 * @since 0.1.0
 */
export interface GuestRequest {
  readonly program: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Record<string, string>
  readonly stdin: Uint8Array | undefined
}

/**
 * A started guest command as the provider tracks it: the vendor handle, the
 * guest pid once the `started` event names it, and whether its exit has been
 * observed. A command seen to exit is never signalled again, because its pid
 * may belong to someone else by then.
 *
 * @category models
 * @since 0.1.0
 */
export interface GuestCommand {
  readonly sandbox: VendorSandbox
  readonly handle: ExecHandle
  readonly exit: Deferred.Deferred<number, ProviderError>
  pid: number | undefined
  ended: boolean
}

const microsandboxFailure = (code: ProviderError["code"], message: string) => (cause: unknown): ProviderError =>
  new ProviderError({ code, message: `microsandbox: ${message}`, cause })

/**
 * Starts one command and hands back its streaming handle.
 *
 * Starting is interruptible. An interrupt that lands while the SDK is still
 * starting the command cannot take the start back, so the handle that arrives
 * afterwards is killed on arrival instead of being left to run unobserved.
 */
const start = (
  sandbox: VendorSandbox,
  request: GuestRequest,
  failed: (cause: unknown) => ProviderError
): Effect.Effect<ExecHandle, ProviderError> =>
  Effect.callback<ExecHandle, ProviderError>((resume) => {
    let abandoned = false
    execHandles.started()
    sandbox.execStreamWith(request.program, (builder) => {
      const configured = builder.args([...request.args]).cwd(request.cwd).envs(request.env)
      return request.stdin === undefined ? configured : configured.stdinBytes(request.stdin)
    }).then(
      (handle) => {
        if (!abandoned) return resume(Effect.succeed(handle))
        // Nobody is left to observe this command: its only owner was the
        // interrupted start. Killing it is the whole of the cleanup, and a
        // kill that fails leaves nothing further this side could do.
        handle.kill().catch(() => undefined)
      },
      (cause: unknown) => resume(Effect.fail(failed(cause)))
    )
    return Effect.sync(() => {
      abandoned = true
    })
  })

/**
 * Runs one command to completion, gathering its output. Used for the
 * provider's own plumbing — warming a Nix environment, delivering a signal —
 * where the caller needs the status and nothing streams back to anyone.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runGuest = (
  sandbox: VendorSandbox,
  request: GuestRequest,
  message: string
): Effect.Effect<{ readonly code: number; readonly stdout: Uint8Array; readonly stderr: string }, ProviderError> =>
  Effect.flatMap(
    start(sandbox, request, microsandboxFailure("unavailable", message)),
    (handle) =>
      Effect.gen(function*() {
        const stdout: Array<Uint8Array> = []
        const stderr: Array<Uint8Array> = []
        for (;;) {
          const event = yield* Effect.tryPromise({
            try: () => handle.recv(),
            catch: microsandboxFailure("unavailable", message)
          })
          if (event === null) {
            return yield* Effect.fail(
              microsandboxFailure("unavailable", `${message}: the command ended without reporting its status`)(
                undefined
              )
            )
          }
          if (event === undefined) {
            return yield* Effect.fail(
              microsandboxFailure("unavailable", `${message}: the guest could not start ${request.program}`)(undefined)
            )
          }
          if (event.kind === "stdout") stdout.push(event.data)
          else if (event.kind === "stderr") stderr.push(event.data)
          else if (event.kind === "exited") {
            return { code: event.code, stdout: concat(stdout), stderr: new TextDecoder().decode(concat(stderr)) }
          }
        }
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.ignore(
            Effect.tryPromise({
              try: () => handle.kill(),
              catch: microsandboxFailure("unknown", `${message}: the interrupted command could not be killed`)
            }).pipe(Effect.tapError((error) => warnTeardown("microsandbox", "kill", error)))
          )
        )
      )
  )

/**
 * Signals a started command and every process it started.
 *
 * Two deliveries, in this order. A second guest command walks the process
 * tree below the recorded pid and signals the whole collected set at once,
 * which reaches descendants that left the command's process group with
 * `setsid`, as long as their parent is still alive to be walked from. Then the
 * SDK's own signal reaches the command's process group, which covers a guest
 * that lacks the walk's tools (`awk` or `pgrep`) and a command whose pid the
 * stream has not named yet. The walk goes first because the group signal ends
 * the parent a later walk would start from. Delivery succeeds when either
 * delivery did.
 *
 * @category constructors
 * @since 0.1.0
 */
export const signalGuest = (
  command: GuestCommand,
  signal: Signal,
  machine: string
): Effect.Effect<void, ProviderError> =>
  Effect.suspend(() => {
    if (command.ended) return Effect.void
    const pid = command.pid
    const walk = pid === undefined
      ? Effect.fail(
        new ProviderError({ code: "unknown", message: "microsandbox: the command has not reported its pid yet" })
      )
      : Effect.flatMap(
        runGuest(
          command.sandbox,
          {
            program: "/bin/sh",
            args: ["-c", hostKillScript(pid, signal.replace(/^SIG/, ""))],
            cwd: "/",
            env: {},
            stdin: undefined
          },
          `the signal ${signal} could not be delivered in ${machine}`
        ),
        (result) =>
          result.code === 0 ? Effect.void : Effect.fail(
            new ProviderError({
              code: "unknown",
              message:
                `microsandbox: the signal ${signal} could not be delivered in ${machine}: ${result.stderr.trim()}`
            })
          )
      )
    const number = linuxSignalNumber(signal)
    const group = number === undefined
      ? Effect.fail(new ProviderError({ code: "unknown", message: `microsandbox: Linux has no signal ${signal}` }))
      : Effect.tryPromise({
        try: () => command.handle.signal(number),
        catch: microsandboxFailure("unknown", `the signal ${signal} could not be delivered in ${machine}`)
      })
    return Effect.gen(function*() {
      const walked = yield* Effect.exit(walk)
      if (command.ended) return
      const grouped = yield* Effect.exit(group)
      if (Exit.isSuccess(walked) || Exit.isSuccess(grouped)) return
      return yield* walked
    })
  })

/**
 * Ends a command whose scope closed while it was running: `SIGTERM` to the
 * tree, a bounded wait for the exit, then `SIGKILL` to whatever ignored it.
 * Failures are logged by provider, operation, and code only.
 */
const terminate = (command: GuestCommand, machine: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const deliver = (signal: Signal) =>
      Effect.ignore(
        signalGuest(command, signal, machine).pipe(
          Effect.tapError((error) => warnTeardown("microsandbox", "kill", error))
        )
      )
    yield* deliver("SIGTERM")
    yield* Effect.raceFirst(Effect.asVoid(Effect.exit(Deferred.await(command.exit))), elapsed(terminationGraceMs))
    if (!command.ended) yield* deliver("SIGKILL")
  })

/**
 * Starts one command whose scope is its lifetime and streams its output.
 *
 * `spawn` returns as soon as the command has started. One fiber, scoped to the
 * spawn, drains the handle's events: output chunks land on the stdout and
 * stderr streams as the guest writes them, `started` records the guest pid,
 * and `exited` ends both streams and settles `exitCode`. A handle whose stream
 * ends without an `exited` event means the machine went away mid-command, so
 * both streams and `exitCode` fail with `unavailable` instead of waiting for an
 * exit that will never be reported. A guest that could not start the command
 * at all — a missing program or working directory — fails them with
 * `spawn_error`.
 *
 * Closing the spawn's scope before the exit was observed terminates the command
 * and everything it started, under `finalizeWithin`'s bound: an interrupted
 * caller does not leave guest work running behind it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const spawnGuest = (
  sandbox: VendorSandbox,
  request: GuestRequest,
  names: { readonly machine: string; readonly command: string }
): Effect.Effect<
  { readonly process: RemoteProcess; readonly command: GuestCommand },
  ProviderError,
  Scope.Scope
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const handle = yield* restore(
        start(
          sandbox,
          request,
          microsandboxFailure("spawn_error", `\`${names.command}\` could not run in ${names.machine}`)
        )
      )
      const stdout = yield* Queue.unbounded<Uint8Array, ProviderError | Cause.Done>()
      const stderr = yield* Queue.unbounded<Uint8Array, ProviderError | Cause.Done>()
      const command: GuestCommand = {
        sandbox,
        handle,
        exit: yield* Deferred.make<number, ProviderError>(),
        pid: undefined,
        ended: false
      }
      const lost = microsandboxFailure(
        "unavailable",
        `the microVM ${names.machine} ended before \`${names.command}\` reported its status`
      )
      const unstarted = microsandboxFailure(
        "spawn_error",
        `the guest could not start \`${names.command}\` in ${names.machine}`
      )
      const drain = Effect.gen(function*() {
        for (;;) {
          const event = yield* Effect.tryPromise({ try: () => handle.recv(), catch: lost })
          if (event === null) return yield* Effect.fail(lost(undefined))
          if (event === undefined) {
            // The guest refused to start the command, so there is no process
            // to signal and never will be an exit.
            command.ended = true
            return yield* Effect.fail(unstarted(undefined))
          }
          switch (event.kind) {
            case "started":
              command.pid = event.pid
              break
            case "stdout":
              yield* Queue.offer(stdout, event.data)
              break
            case "stderr":
              yield* Queue.offer(stderr, event.data)
              break
            case "exited":
              command.ended = true
              yield* Queue.end(stdout)
              yield* Queue.end(stderr)
              yield* Deferred.succeed(command.exit, event.code)
              return
          }
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.all([Queue.fail(stdout, error), Queue.fail(stderr, error), Deferred.fail(command.exit, error)])
        )
      )
      // Registered before the termination finalizer so it closes after it:
      // finalizers run in reverse, and termination waits on the exit this
      // fiber observes.
      yield* Effect.forkScoped(drain)
      yield* Effect.addFinalizer(() =>
        command.ended
          ? Effect.void
          : finalizeWithin(terminate(command, names.machine), `microsandbox ${names.machine} command`)
      )
      const process: RemoteProcess = {
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        exitCode: Deferred.await(command.exit)
      }
      return { process, command }
    })
  )
