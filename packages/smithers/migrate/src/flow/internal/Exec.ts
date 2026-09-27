/**
 * Buffered command execution over the permission-aware process spawner.
 *
 * Every command this package runs — `jj`, `git`, an install, a typecheck, a
 * test suite — goes through here, so the `proc:spawn` capability check and the
 * command-line resource stay exactly where the kernel put them. The buffered
 * shape is what a report wants: an exit code and two bounded tails, not a
 * stream nobody kept.
 *
 * Bounded while the command runs, not after it exits. Each stream is drained
 * through a rolling window that keeps the last {@link tailBytes} bytes and
 * counts what it dropped, so a test suite that prints a gigabyte costs this
 * process twelve kilobytes per stream, and a command that never stops
 * printing is stopped by its timeout rather than by the heap.
 *
 * @since 1.0.0-rc.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import type { PlatformError } from "effect/PlatformError"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * The buffered result of one command. A non-zero exit is a result, not a
 * failure: verification reports what a command said, and a failed typecheck is
 * the answer rather than an error.
 *
 * `stdout` and `stderr` are each the last {@link tailBytes} bytes of the
 * stream, decoded at a character boundary, with a marker line naming how many
 * earlier bytes were dropped when any were.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly durationMs: number
}

/**
 * Options for {@link run}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly timeoutMs?: number | undefined
  /** Present means an argv; absent means a command line for the platform shell. */
  readonly args?: ReadonlyArray<string> | undefined
}

/**
 * A command that never produced an exit code: it could not start, or its
 * timeout cut it off.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ExecFailure {
  readonly _tag = "ExecFailure"
  readonly command: string
  readonly reason: string
  constructor(command: string, reason: string) {
    this.command = command
    this.reason = reason
  }
}

/**
 * The number of bytes of a command's output the report keeps at each end.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const tailBytes = 12 * 1024

const omittedMarker = /^\[(\d+) earlier bytes omitted\]\n/

/** The last `limit` bytes of a byte sequence, and how many came before them. */
interface Window {
  readonly chunks: ReadonlyArray<Uint8Array>
  readonly kept: number
  readonly omitted: number
}

const emptyWindow: Window = { chunks: [], kept: 0, omitted: 0 }

/** Slides the window forward over one more chunk. */
const slide = (window: Window, chunk: Uint8Array, limit: number): Window => {
  const chunks = [...window.chunks, chunk]
  let kept = window.kept + chunk.length
  let omitted = window.omitted
  while (kept > limit && chunks.length > 0) {
    const excess = kept - limit
    const head = chunks[0]!
    if (head.length <= excess) {
      chunks.shift()
      kept -= head.length
      omitted += head.length
    } else {
      chunks[0] = head.subarray(excess)
      kept -= excess
      omitted += excess
    }
  }
  return { chunks, kept, omitted }
}

/**
 * Decodes a window as text: a marker line for what was dropped, then the kept
 * bytes from the first character boundary. A window cut inside a multi-byte
 * sequence starts with continuation bytes, and they are dropped too rather
 * than decoded to replacement characters.
 */
const decodeWindow = (window: Window): string => {
  const bytes = new Uint8Array(window.kept)
  let offset = 0
  for (const chunk of window.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  let start = 0
  if (window.omitted > 0) {
    while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start += 1
  }
  const omitted = window.omitted + start
  const text = new TextDecoder().decode(bytes.subarray(start))
  return omitted === 0 ? text : `[${omitted} earlier bytes omitted]\n${text}`
}

const drain = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  limit: number
): Effect.Effect<string, PlatformError> =>
  Stream.runFold(stream, () => emptyWindow, (window, chunk) => slide(window, chunk, limit)).pipe(
    Effect.map(decodeWindow)
  )

const gather = (
  handle: ChildProcessHandle,
  limit: number
): Effect.Effect<readonly [string, string, number], PlatformError> =>
  // stdout, stderr, and the exit code have to be consumed concurrently: a
  // command that fills a pipe blocks until the pipe is drained, so waiting for
  // exit first would deadlock on any output larger than the buffer.
  Effect.all(
    [drain(handle.stdout, limit), drain(handle.stderr, limit), handle.exitCode],
    { concurrency: "unbounded" }
  )

const spawn = (
  command: string,
  options: Options
): Effect.Effect<Result, ExecFailure, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    // The Clock service, not the wall clock: a duration a report prints is a
    // measurement, and a measurement takes its time from the runtime that ran it.
    const started = yield* Clock.currentTimeMillis
    const settings: ChildProcess.CommandOptions = {
      ...(options.args === undefined ? { shell: true } : {}),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env })
    }
    const handle = yield* spawner.spawn(
      options.args === undefined
        ? ChildProcess.make(command, settings)
        : ChildProcess.make(command, [...options.args], settings)
    )
    // Draining runs in its own fiber so the budget can be enforced by joining
    // it: a fiber join is interruptible, where a drain blocked on a pipe the
    // child never closes is not. A command over budget is abandoned rather
    // than asked politely, and the streams are dropped with it.
    const fiber = yield* Effect.forkChild(gather(handle, tailBytes))
    const settled = options.timeoutMs === undefined
      ? Option.some(yield* Fiber.join(fiber))
      : yield* Effect.timeoutOption(Fiber.join(fiber), options.timeoutMs)
    if (Option.isNone(settled)) {
      yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      return yield* Effect.fail(new ExecFailure(command, `exceeded ${options.timeoutMs}ms`))
    }
    const [stdout, stderr, exitCode] = settled.value
    return { stdout, stderr, exitCode, durationMs: (yield* Clock.currentTimeMillis) - started }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ExecFailure ? error : new ExecFailure(command, String((error as Error).message ?? error))
    )
  )

/**
 * Runs one command and buffers its output, bounded to {@link tailBytes} per
 * stream while it runs.
 *
 * Cancellation is scope closure: the spawn is scoped, so an interrupted fiber
 * — including the one a `timeoutMs` interrupts — terminates the process rather
 * than leaking it.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (
  command: string,
  options: Options = {}
): Effect.Effect<Result, ExecFailure, ChildProcessSpawner> => spawn(command, options)

/**
 * The last `limit` bytes of a text, with a marker naming what was dropped so a
 * reader knows the tail is a tail.
 *
 * Idempotent over its own output: a text that already carries a marker keeps
 * one marker, with the dropped counts added, rather than growing a marker per
 * pass.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const tail = (text: string, limit: number = tailBytes): string => {
  const marked = omittedMarker.exec(text)
  const already = marked === null ? 0 : Number(marked[1])
  const body = marked === null ? text : text.slice(marked[0].length)
  const bytes = new TextEncoder().encode(body)
  if (bytes.length <= limit) return already === 0 ? body : `[${already} earlier bytes omitted]\n${body}`
  const window = slide(emptyWindow, bytes, limit)
  return decodeWindow({ ...window, omitted: window.omitted + already })
}
