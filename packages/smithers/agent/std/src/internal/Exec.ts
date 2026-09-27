/**
 * Buffered shell execution over the permission-aware process spawner.
 *
 * `@smthrs/kernel` used to expose a `Shell` service whose `exec` returned a
 * buffered `{ stdout, stderr, exitCode }`. The kernel replaced it with
 * `ChildProcessSpawner`, Effect's own process boundary, which streams and has
 * no buffered form. This module is the buffered form the shell flows still
 * want, expressed in terms of the spawner so the `proc:spawn` capability check
 * and the command-line resource stay exactly where the kernel put them.
 *
 * Commands run through the platform shell (`shell: true`), matching the old
 * service: the flows take a command *line*, not an argv.
 *
 * @since 1.0.0
 */

import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as StdError from "../StdError.ts"

/**
 * Failure codes a buffered execution can report, matching the codes the
 * removed kernel `Shell` used so handler-level mapping is unchanged.
 *
 * @category models
 * @since 1.0.0
 */
export const ExecErrorCode = Schema.Literals(["timeout", "spawn_error", "capture_overflow"])

/**
 * Failure codes a buffered execution can report.
 *
 * @category models
 * @since 1.0.0
 */
export type ExecErrorCode = typeof ExecErrorCode.Type

/**
 * A command that never produced an exit code.
 *
 * A non-zero exit is a successful {@link ExecResult}, not a failure; this
 * error is reserved for a command that could not start or was cut off by its
 * timeout, or whose captured output exceeded a refusing capture bound.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExecError extends Schema.TaggedError<ExecError>()("@smthrs/std/ExecError", {
  code: ExecErrorCode,
  message: Schema.String
}) {}

/**
 * The buffered result of one command.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /** UTF-8 bytes dropped from the head of stdout to stay inside the capture bound. */
  readonly stdoutDroppedBytes: number
  /** UTF-8 bytes dropped from the head of stderr to stay inside the capture bound. */
  readonly stderrDroppedBytes: number
}

/**
 * Options accepted by {@link exec}.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecOptions {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
  /**
   * The program's arguments. Present means an argv, absent means a command
   * line for the platform shell. An argv is how a payload reaches a program
   * without being quoted into a string: nothing between here and `execve`
   * re-parses it.
   */
  readonly args?: ReadonlyArray<string> | undefined
  /**
   * Text written to the program's standard input, as data. A script delivered
   * this way is never quoted, escaped, or heredoc-terminated, which is the
   * whole point: quoting corruption cost the measured SWE-bench program twelve
   * probe failures and one instance's most expensive frame.
   */
  readonly stdin?: string | undefined
  /**
   * Bytes retained per captured stream. A stream that prints more keeps its
   * tail and reports what it dropped, so a command printing gigabytes costs a
   * bounded amount of memory rather than the whole of what it printed.
   *
   * Absent means unbounded, which is what a caller wants when it needs every
   * byte a tool produced (`rg --files`, `git worktree list`).
   */
  readonly maxCaptureBytes?: number | undefined
  /** Defaults to `tail`; `refuse` fails if either stream exceeds the bound. */
  readonly overflow?: "tail" | "refuse" | undefined
}

/** One captured stream: the text kept, and the bytes dropped to keep it bounded. */
interface Capture {
  readonly text: string
  readonly droppedBytes: number
}

interface Tail {
  chunks: Array<Uint8Array>
  bytes: number
  dropped: number
}

const decoder = new TextDecoder("utf-8")

/**
 * Joins the retained chunks and decodes them, skipping the partial code point a
 * dropped head can leave behind.
 *
 * A UTF-8 continuation byte is `10xxxxxx`, and a code point is at most four
 * bytes, so at most three leading continuation bytes can precede the first
 * whole character. Skipping them is counted as dropped rather than decoded to a
 * replacement character the process never printed.
 */
const decodeTail = (state: Tail): Capture => {
  const bytes = new Uint8Array(state.bytes)
  let offset = 0
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (state.dropped === 0) return { text: decoder.decode(bytes), droppedBytes: 0 }
  let start = 0
  while (start < bytes.byteLength && start < 3 && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start++
  return { text: decoder.decode(bytes.subarray(start)), droppedBytes: state.dropped + start }
}

const boundedTail = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
  overflow: "tail" | "refuse" | undefined
): Effect.Effect<Capture, E> =>
  Stream.runFold(
    stream,
    (): Tail => ({ chunks: [], bytes: 0, dropped: 0 }),
    (state, chunk) => {
      if (chunk.byteLength === 0) return state
      state.chunks.push(chunk)
      state.bytes += chunk.byteLength
      while (state.bytes > maxBytes && state.chunks.length > 0) {
        const excess = state.bytes - maxBytes
        const first = state.chunks[0]!
        if (first.byteLength <= excess) {
          state.chunks.shift()
          state.bytes -= first.byteLength
          state.dropped += first.byteLength
        } else {
          state.chunks[0] = first.subarray(excess)
          state.bytes -= excess
          state.dropped += excess
        }
      }
      return state
    }
  ).pipe(Effect.map((state) =>
    overflow === "refuse" && state.dropped > 0
      ? { text: "", droppedBytes: state.dropped }
      : decodeTail(state)
  ))

const capture = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number | undefined,
  overflow: "tail" | "refuse" | undefined
): Effect.Effect<Capture, E> =>
  maxBytes === undefined
    ? Effect.map(Stream.mkString(Stream.decodeText(stream)), (text) => ({ text, droppedBytes: 0 }))
    : boundedTail(stream, maxBytes, overflow)

const unbounded = (
  command: string,
  options: ExecOptions
): Effect.Effect<ExecResult, ExecError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const settings: ChildProcess.CommandOptions = {
      ...(options.args === undefined ? { shell: true } : {}),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: ChildProcessEnvironment.make(process.env, options.env),
      extendEnv: false,
      ...(options.stdin === undefined
        ? {}
        : { stdin: Stream.make(new TextEncoder().encode(options.stdin)) })
    }
    const handle = yield* spawner.spawn(
      options.args === undefined
        ? ChildProcess.make(command, settings)
        : ChildProcess.make(command, [...options.args], settings)
    )
    // stdout, stderr, and the exit code have to be consumed concurrently: a
    // command that fills a pipe blocks until the pipe is drained, so waiting
    // for exit first would deadlock on any output larger than the buffer.
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        capture(handle.stdout, options.maxCaptureBytes, options.overflow),
        capture(handle.stderr, options.maxCaptureBytes, options.overflow),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (options.overflow === "refuse") {
      const overflowed = [
        stdout.droppedBytes > 0 ? "stdout" : undefined,
        stderr.droppedBytes > 0 ? "stderr" : undefined
      ]
        .filter((stream): stream is string => stream !== undefined)
      if (overflowed.length > 0) {
        return yield* Effect.fail(
          new ExecError({
            code: "capture_overflow",
            message: `${command} ${
              overflowed.join(" and ")
            } exceeded the ${options.maxCaptureBytes}-byte capture cap; refusing partial output`
          })
        )
      }
    }
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      stdoutDroppedBytes: stdout.droppedBytes,
      stderrDroppedBytes: stderr.droppedBytes
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ExecError ? error : new ExecError({
        code: "spawn_error",
        message: `exec: ${command}: ${error.message}`
      })
    )
  )

/**
 * Runs a command line through the platform shell and buffers its output.
 *
 * Cancellation is scope closure: the spawn is scoped, so an interrupted fiber
 * — including the one a `timeoutMs` interrupts — terminates the process rather
 * than leaking it.
 *
 * @category execution
 * @since 1.0.0
 */
export const exec = (
  command: string,
  options: ExecOptions = {}
): Effect.Effect<ExecResult, ExecError, ChildProcessSpawner.ChildProcessSpawner> =>
  options.timeoutMs === undefined
    ? unbounded(command, options)
    : Effect.timeoutOrElse(unbounded(command, options), {
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new ExecError({
            code: "timeout",
            message: `exec: \`${command}\` exceeded ${options.timeoutMs}ms`
          })
        )
    })

/**
 * The model-facing failure code a command that never produced an exit code
 * carries.
 *
 * A timeout keeps its own code, because "the command never finished" and "the
 * command never started" are different things to a caller deciding whether to
 * retry. Every other way of producing no exit code is a host failure.
 *
 * @category errors
 * @since 1.0.0
 */
export const toStdErrorCode = (error: ExecError): StdError.Code =>
  error.code === "timeout" ? "timeout" : "command_failed"

/**
 * The model-facing failure one execution error becomes.
 *
 * A timeout names the command, which is what the caller asked for and all a
 * timeout has to say. Any other failure carries the message the execution
 * produced, which already names the command.
 *
 * @category errors
 * @since 1.0.0
 */
export const toStdError = (command: string, error: ExecError): StdError.StdError =>
  new StdError.StdError({
    code: toStdErrorCode(error),
    message: error.code === "timeout"
      ? `Command timed out: ${command}`
      : `Command failed to start: ${error.message}`
  })
