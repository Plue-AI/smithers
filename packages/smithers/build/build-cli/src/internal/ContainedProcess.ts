/** Scoped process execution for build-cli discovery and watch cycles.
 * @since 1.0.0-rc.0
 */

import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Cause, Data, Effect, Exit, Layer, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ChildProcessSpawner, makeHandle } from "effect/unstable/process/ChildProcessSpawner"

/** A bounded process operation failed, with its original cause retained.
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ProcessError extends Data.TaggedError("smithers-build/ProcessError")<{
  readonly code: "timed_out" | "cancelled" | "process_failed" | "output_limit" | "cleanup_failed"
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(code: ProcessError["code"], message: string, cause?: unknown) {
    super({ code, message, ...(cause === undefined ? {} : { cause }) })
  }
}

const graceMs = 5000

const windowsLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

// Windows discovery/watch already used Effect's taskkill /T implementation.
// Preserve that native path; the POSIX owner protocol requires UNIX sockets.
const spawn = (options: ScopedProcess.Options) => {
  if (process.platform !== "win32") return ScopedProcess.spawn(options)
  return Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      extendEnv: options.env === undefined,
      detached: false,
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: graceMs
    }))
    const kill: ChildProcessHandle["kill"] = (options) =>
      Effect.flatMap(handle.isRunning, (running) => running ? handle.kill(options) : Effect.void).pipe(
        Effect.timeoutOrElse({
          duration: graceMs * 2,
          orElse: () => Effect.fail(new ProcessError("cleanup_failed", `could not stop process ${handle.pid}`))
        }),
        Effect.orDie
      )
    return makeHandle({ ...handle, kill })
  }).pipe(Effect.provide(windowsLayer))
}

/** One bounded process invocation.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
  readonly fatalUtf8?: boolean | undefined
  /** Written to the command's stdin, which is then closed; without it stdin is ignored. */
  readonly stdin?: string | undefined
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const processError = (cause: unknown): ProcessError =>
  cause instanceof ProcessError ? cause : new ProcessError("process_failed", "process execution failed", cause)

/** Executes a command and joins its owned process tree before releasing its scope.
 * @category execution
 * @since 1.0.0-rc.0
 */
export const runEffect = (options: Omit<Options, "signal">): Effect.Effect<number, ProcessError> =>
  Effect.suspend(() => {
    let cleanupFailure: unknown
    const program = Effect.gen(function*() {
      const handle = yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function*() {
          const handle = yield* spawn({
            command: options.command,
            args: options.args,
            cwd: options.cwd,
            env: options.environment,
            stdin: options.stdin === undefined ? "ignore" : "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: graceMs
          })
          // Registered after spawn: this runs BEFORE the service releases its handle.
          // Leader exit is insufficient: descendants may have closed all inherited pipes.
          yield* Effect.addFinalizer(() =>
            handle.kill({ killSignal: "SIGTERM", forceKillAfter: graceMs }).pipe(
              Effect.tapCause((cause) =>
                Effect.sync(() => {
                  cleanupFailure = Cause.squash(cause)
                })
              ),
              Effect.orDie
            )
          )
          return handle
        })
      )
      const consume = (stream: typeof handle.stdout, write: (text: string) => void) => {
        let size = 0
        const decoder = new TextDecoder("utf-8", { fatal: options.fatalUtf8 ?? false })
        return Stream.runForEach(stream, (chunk) =>
          Effect.try({
            try: () => {
              size += chunk.byteLength
              if (options.maxOutputBytes !== undefined && size > options.maxOutputBytes) {
                throw new ProcessError("output_limit", `process output exceeds ${options.maxOutputBytes} bytes`)
              }
              write(decoder.decode(chunk, { stream: true }))
            },
            catch: (cause) => cause
          })).pipe(Effect.andThen(Effect.try({
            try: () => {
              const tail = decoder.decode()
              if (tail !== "") write(tail)
            },
            catch: (cause) => cause
          })))
      }
      const [code] = yield* Effect.all([
        process.platform === "win32"
          ? handle.exitCode.pipe(Effect.catch(() => Effect.succeed(1)))
          : ScopedProcess.status(handle).pipe(Effect.map((status) => status.code ?? 1)),
        consume(handle.stdout, options.stdout),
        consume(handle.stderr, options.stderr),
        // A command may exit without reading its input; its exit status, not the broken pipe, is the result.
        options.stdin === undefined ? Effect.void : Stream.make(new TextEncoder().encode(options.stdin)).pipe(
          Stream.run(handle.stdin),
          Effect.catchIf(
            (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "EPIPE",
            () => Effect.void
          )
        )
      ], { concurrency: "unbounded" })
      return code
    })
    const bounded = options.timeoutMs === undefined ? program : program.pipe(Effect.timeoutOrElse({
      duration: options.timeoutMs,
      orElse: () => Effect.fail(new ProcessError("timed_out", `process timed out after ${options.timeoutMs}ms`))
    }))
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(restore(Effect.scoped(bounded)))
        if (cleanupFailure !== undefined) {
          return yield* Effect.fail(new ProcessError("cleanup_failed", "process cleanup failed", cleanupFailure))
        }
        if (Exit.isSuccess(result)) return result.value
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(Cause.map(result.cause, processError))
        return yield* Effect.fail(processError(Cause.squash(result.cause)))
      })
    )
  })

/** Promise boundary for command APIs that accept an AbortSignal.
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = async (options: Options): Promise<number> => {
  const result = await Effect.runPromiseExit(runEffect(options), { signal: options.signal })
  if (Exit.isSuccess(result)) return result.value
  const cause = processError(Cause.squash(result.cause))
  if (cause.code === "cleanup_failed") throw cause
  if (options.signal?.aborted) throw new ProcessError("cancelled", "process cancelled", options.signal.reason)
  throw cause
}
