/**
 * Backend command processes, started through the contained host spawner.
 *
 * `ProcessReaper.layerSpawner` gives each child a supervisor that owns its
 * process group, so a cancelled or timed-out `ssh`, `jj`, `git` or keyring
 * helper takes its descendants with it. The ledger is in memory: these
 * commands live and die with one CLI invocation.
 * @since 1.0.0
 */

import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { once } from "node:events"
import { hostname } from "node:os"
import { PassThrough } from "node:stream"

type Environment = Readonly<Record<string, string | undefined>>

const spawner = ProcessReaper.layerSpawner().pipe(
  Layer.provide(ProcessLedger.layerMemory({ hostId: hostname(), ownerPid: process.pid }))
)

const environment = (env: Environment): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))

/**
 * A spawn the operating system refused because the program does not exist.
 * @private
 * @since 1.0.0
 */
export class NotFound extends Error {}

// Our own timeout and overflow errors pass through; a platform error carries
// a `reason`, and `NotFound` is the one callers branch on.
const settle = <A>(command: string, exit: Exit.Exit<A, unknown>, interrupted: string): A => {
  if (Exit.isSuccess(exit)) return exit.value
  const cause = exit.cause
  const failure = cause.reasons.find((reason) => reason._tag === "Fail")
  const error: unknown = failure?._tag === "Fail" ? failure.error : undefined
  if (error instanceof Error && !("reason" in error)) throw error
  if (error === undefined && cause.reasons.some((reason) => reason._tag === "Interrupt")) {
    throw new Error(`${command} was ${interrupted}`)
  }
  const reason = (error as { reason?: { _tag?: string } } | undefined)?.reason
  if (reason?._tag === "NotFound") throw new NotFound(`${command} not found`)
  throw new Error(`${command} failed: ${error instanceof Error ? error.message : String(error ?? cause)}`)
}

/**
 * @private
 * @since 1.0.0
 */
export interface Result {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs one command to completion and buffers its output.
 *
 * Rejects with {@link NotFound} when the program is missing, and with a plain
 * error on timeout, cancellation, or output past `maxBytes`. The child's
 * environment is exactly `env`.
 * @private
 * @since 1.0.0
 */
export const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: Environment
    readonly input?: string | undefined
    readonly timeoutMs: number
    readonly maxBytes?: number | undefined
    readonly signal?: AbortSignal | undefined
  }
): Promise<Result> => {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
    Stream.runFold(stream, () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }), (state, chunk) => {
      state.bytes += chunk.byteLength
      if (state.bytes <= maxBytes) state.chunks.push(chunk)
      return state
    }).pipe(Effect.flatMap(({ bytes, chunks }) =>
      bytes > maxBytes
        ? Effect.fail(new Error(`${command} output exceeded ${maxBytes} bytes`))
        : Effect.succeed(Buffer.concat(chunks).toString("utf8"))
    ))
  const program = Effect.gen(function*() {
    const handle = yield* (yield* ChildProcessSpawner).spawn(ChildProcess.make(command, [...args], {
      env: environment(options.env),
      extendEnv: false,
      stdin: options.input === undefined ? "ignore" : Stream.make(new TextEncoder().encode(options.input))
    }))
    const [stdout, stderr, code] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      {
        concurrency: "unbounded"
      }
    )
    return { code: Number(code), stdout, stderr }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () => Effect.fail(new Error(`${command} timed out`))
    }),
    Effect.provide(spawner)
  )
  return Effect.runPromiseExit(program, { signal: options.signal }).then((exit) => settle(command, exit, "cancelled"))
}

/**
 * A running command with Node streams, for callers that stream archives or
 * relay output as it arrives.
 * @private
 * @since 1.0.0
 */
export interface Child {
  /** Absent when stdio is inherited. Ending it closes the child's stdin. */
  readonly stdin: PassThrough | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  /** The exit code; rejects when the spawn fails or {@link kill} stopped it. */
  readonly exited: Promise<number>
  /** Stops the child and its process group. Safe to call after exit. */
  readonly kill: () => void
}

// Waits while the reader is behind, so a slow consumer bounds the buffer.
const relay = (source: Stream.Stream<Uint8Array, unknown>, sink: PassThrough) =>
  Stream.runForEach(source, (chunk) =>
    Effect.promise(() =>
      sink.write(chunk) || sink.destroyed
        ? Promise.resolve()
        : Promise.race([once(sink, "drain"), once(sink, "close")]).then(() => undefined)
    )).pipe(Effect.ensuring(Effect.sync(() => sink.end())))

/**
 * Starts a command whose streams the caller drives.
 * @private
 * @since 1.0.0
 */
export const spawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: Environment
    readonly stdio: "pipe" | "inherit"
    readonly signal?: AbortSignal | undefined
  }
): Child => {
  const piped = options.stdio === "pipe"
  const stdin = piped ? new PassThrough() : undefined
  const stdout = piped ? new PassThrough() : undefined
  const stderr = piped ? new PassThrough() : undefined
  // Stopping the child destroys stdin; a writer still piping into it fails
  // there, and the exit status reports the outcome.
  stdin?.on("error", () => {})
  const program = Effect.gen(function*() {
    const handle = yield* (yield* ChildProcessSpawner).spawn(ChildProcess.make(command, [...args], {
      env: environment(options.env),
      extendEnv: false,
      stdin: stdin === undefined
        ? "inherit"
        : Stream.fromAsyncIterable(stdin as AsyncIterable<Uint8Array>, (cause) => cause as never),
      stdout: piped ? "pipe" : "inherit",
      stderr: piped ? "pipe" : "inherit"
    }))
    const [code] = yield* Effect.all([
      handle.exitCode,
      ...(stdout === undefined ? [] : [relay(handle.stdout, stdout)]),
      ...(stderr === undefined ? [] : [relay(handle.stderr, stderr)])
    ], { concurrency: "unbounded" })
    return Number(code)
  }).pipe(Effect.scoped, Effect.provide(spawner))
  const fiber = Effect.runFork(program)
  // A pending read of an unended stdin holds the fiber, so release it first.
  const abort = () => {
    stdin?.destroy()
    Effect.runFork(Fiber.interrupt(fiber))
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  const exited = Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
    options.signal?.removeEventListener("abort", abort)
    stdout?.end()
    stderr?.end()
    return settle(command, exit, "stopped")
  })
  return { stdin, stdout, stderr, exited, kill: abort }
}
