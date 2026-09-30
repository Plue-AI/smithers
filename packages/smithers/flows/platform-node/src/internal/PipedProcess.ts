/**
 * Native I/O ownership for transient commands and prepared process owners.
 * @since 1.0.0
 */

import * as NodeSink from "@effect/platform-node/NodeSink"
import * as NodeStream from "@effect/platform-node/NodeStream"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import * as Native from "node:child_process"
import { NativeProcessError } from "./ProcessFault.ts"

const ownerDescriptors = new WeakMap<ChildProcessHandle, ReadonlyArray<number | "ignore">>()

/**
 * Windows owners receive caller streams above the reserved CRT standard slots.
 * @private
 * @since 1.0.0
 */
export const standardFdsOf = (handle: ChildProcessHandle): ReadonlyArray<number | "ignore"> | undefined =>
  ownerDescriptors.get(handle)

const promise = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((onSuccess, onFailure) => {
    resolve = onSuccess
    reject = onFailure
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Converts native errors without losing their errno or signal.
 * @private
 * @since 1.0.0
 */
export const failure = (method: string, cause: unknown): PlatformError.PlatformError => {
  const error = cause instanceof Error ? cause : new NativeProcessError({ message: String(cause) })
  const code = (error as NodeJS.ErrnoException).code
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : code === "EACCES" || code === "EPERM" ? "PermissionDenied" : "Unknown",
    module: "ChildProcess",
    method,
    description: error.message,
    cause: error
  })
}

const inputConfig = (value: ChildProcess.CommandOptions["stdin"]): ChildProcess.StdinConfig =>
  value === undefined || typeof value === "string" || Stream.isStream(value)
    ? { stream: value ?? "pipe" }
    : value

const outputConfig = (
  value: ChildProcess.CommandOptions["stdout"]
): ChildProcess.CommandOutput =>
  value === undefined || typeof value === "string" || Sink.isSink(value)
    ? value ?? "pipe"
    : value.stream ?? "pipe"

const descriptorConfig = (options: ChildProcess.CommandOptions) => {
  const stdin = inputConfig(options.stdin)
  const stdout = outputConfig(options.stdout)
  const stderr = outputConfig(options.stderr)
  const additional: Array<{ readonly fd: number; readonly config: ChildProcess.AdditionalFdConfig }> = []
  for (const [name, config] of Object.entries(options.additionalFds ?? {})) {
    const fd = ChildProcess.parseFdName(name)
    if (fd === undefined) continue
    // A sparse descriptor declaration must not allocate an unbounded stdio
    // table. The OS may impose a smaller limit when opening the actual pipes.
    if (!Number.isSafeInteger(fd) || fd > 65_535) {
      throw new RangeError("Additional file descriptors must be below 65536")
    }
    additional.push({ fd, config })
  }
  additional.sort((left, right) => left.fd - right.fd)
  const stdio: Array<Native.IOType> = Array.from(
    { length: Math.max(2, ...additional.map(({ fd }) => fd)) + 1 },
    () => "ignore"
  )
  stdio[0] = typeof stdin.stream === "string" ? stdin.stream : "pipe"
  stdio[1] = typeof stdout === "string" ? stdout : "pipe"
  stdio[2] = typeof stderr === "string" ? stderr : "pipe"
  for (const { fd } of additional) stdio[fd] = "pipe"
  return { stdin, stdout, stderr, additional, stdio }
}

/**
 * Native standard-command I/O, including configured streams and custom pipes.
 * Lifetime error listeners remain on every owned pipe after any consumer is
 * interrupted, so a pending native write cannot raise an unhandled late EPIPE.
 * Consumers still receive the original error through NodeStream/NodeSink.
 * This adapter also preserves native Windows verbatim arguments.
 *
 * It never sends a negative-pid signal. POSIX tree cleanup belongs to the
 * prepared supervisor, which remains alive while it signals its own group.
 * @private
 * @since 1.0.0
 */
export const spawn = (
  command: ChildProcess.StandardCommand,
  windowsVerbatimArguments: boolean | undefined,
  owner = false
): Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> =>
  Effect.gen(function*() {
    const descriptors = yield* Effect.try({
      try: () => descriptorConfig(command.options),
      catch: (cause) => failure("spawn", cause)
    })
    const standardFds: Array<number | "ignore"> = [0, 1, 2]
    const physicalFds = [0, 1, 2]
    const stdio: Array<Native.IOType | number> = [...descriptors.stdio]
    if (owner && process.platform === "win32") {
      const first = stdio.length
      for (const fd of [0, 1, 2]) {
        const mode = stdio[fd]!
        physicalFds[fd] = first + fd
        standardFds[fd] = mode === "ignore" ? "ignore" : first + fd
        stdio.push(mode === "inherit" ? fd : mode)
        stdio[fd] = "ignore"
      }
    }
    const state = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const ready = promise<void>()
          // Startup errors reject ready before any handle is exposed. Once
          // started, the native exit event or retained native status supplies
          // this result.
          let recordExit!: (result: readonly [number | null, NodeJS.Signals | null]) => void
          const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
            recordExit = resolve
          })
          const options = command.options
          const child = Native.spawn(command.command, [...command.args], {
            cwd: options.cwd,
            env: options.extendEnv ? { ...process.env, ...options.env } : options.env,
            shell: options.shell,
            detached: options.detached ?? process.platform !== "win32",
            windowsHide: options.windowsHide ?? true,
            windowsVerbatimArguments,
            stdio
          })
          const state = {
            child,
            ready: ready.promise,
            exited,
            ended: false,
            started: false,
            referenced: true,
            pipeErrors: new WeakMap<object, Error>(),
            error: undefined as Error | undefined
          }
          child.once("spawn", () => {
            state.started = true
            ready.resolve()
          })
          child.on("error", (error) => {
            state.error = error
            if (!state.started) {
              state.ended = true
              ready.reject(error)
            }
          })
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            state.ended = true
            recordExit([code, signal])
          }
          child.once("exit", onExit)
          // Bun can emit spawn before Native.spawn returns on a cold start.
          // A returned pid proves that the native child was created; failed
          // native spawns have no pid and still reject through the error event.
          if (child.pid !== undefined) {
            state.started = true
            ready.resolve()
          }
          // Likewise retain an exit already reflected by the native handle
          // before listeners could attach. Later events settle the same result.
          if (child.exitCode != null || child.signalCode != null) {
            onExit(child.exitCode ?? null, child.signalCode ?? null)
          }
          // A pipe can fail before a consumer has started reading or writing.
          // Preserve the cause for consumers that attach after its error event.
          for (const pipe of child.stdio) {
            pipe?.on("error", (error: Error) => {
              state.pipeErrors.set(pipe, error)
            })
          }
          // Node resumes unread stdio after exit to deliver its close event.
          // A fast target can exit before activation returns the public handle;
          // flowing at that point discards bytes before any consumer subscribes.
          // Keep declared outputs in readable mode for their entire lifetime.
          // This listener does not drain or copy data: the native high-water
          // mark still applies backpressure until NodeStream pulls the bytes.
          for (
            const fd of [
              physicalFds[1]!,
              physicalFds[2]!,
              ...descriptors.additional.filter(({ config }) => config.type === "output").map(({ fd }) => fd)
            ]
          ) {
            const pipe = child.stdio[fd]
            pipe?.on("readable", () => {})
            // POSIX sockets can close the unused writer independently. Bun
            // needs this to retain buffered output after child exit. Windows
            // named-pipe shutdown instead starts libuv's EOF timer, which can
            // close both directions before the child writes. Leave it open.
            if (process.platform !== "win32" && fd > 2 && pipe !== null && pipe !== undefined && "end" in pipe) {
              pipe.end()
            }
          }
          return state
        },
        catch: (cause) => failure("spawn", cause)
      }),
      (state) =>
        Effect.gen(function*() {
          if (state.referenced && !state.ended) {
            yield* Effect.try({
              try: () => {
                // Native kill returns false for an exit whose event is still
                // queued. Require that event below; never infer a live failure
                // or successful cleanup from the boolean alone.
                if (!state.child.kill("SIGKILL") && state.error !== undefined) throw state.error
              },
              catch: (cause) => failure("kill", cause)
            })
            yield* Effect.promise(() => state.exited).pipe(
              Effect.timeout("2 seconds")
            )
          }
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            for (const pipe of state.child.stdio) {
              if (pipe !== null && pipe !== undefined && "destroy" in pipe && typeof pipe.destroy === "function") {
                pipe.destroy()
              }
            }
          })),
          Effect.orDie
        )
    )
    yield* Effect.tryPromise({ try: () => state.ready, catch: (cause) => failure("spawn", cause) })
    const wait = Effect.promise(() => state.exited)
    const kill: ChildProcessHandle["kill"] = (options) =>
      Effect.suspend(() => {
        if (state.ended) return Effect.void
        const signal = options?.killSignal ?? command.options.killSignal ?? "SIGTERM"
        const send = (signal: ChildProcess.Signal) =>
          Effect.try({
            try: () => {
              if (!state.child.kill(signal) && state.error !== undefined) throw state.error
            },
            catch: (cause) => failure("kill", cause)
          })
        return send(signal).pipe(
          Effect.andThen(wait.pipe(Effect.timeoutOrElse({
            duration: options?.forceKillAfter ?? command.options.forceKillAfter ?? 2000,
            orElse: () => send("SIGKILL").pipe(Effect.andThen(wait), Effect.timeout("2 seconds"))
          }))),
          Effect.mapError((cause) => cause instanceof PlatformError.PlatformError ? cause : failure("kill", cause)),
          Effect.asVoid,
          Effect.uninterruptible
        )
      })
    const input = (fd: number, config?: ChildProcess.StdinConfig): ChildProcessHandle["stdin"] => {
      const pipe = state.child.stdio[fd]
      if (pipe === null || pipe === undefined || !("write" in pipe)) return Sink.drain
      const writable = pipe
      const method = fd === 0 ? "stdin" : `fd${fd}`
      return Sink.suspend(() => {
        const error = state.pipeErrors.get(pipe) ?? writable.errored ?? undefined
        if (error !== undefined) return Sink.fail(failure(method, error))
        if (writable.destroyed || writable.writableEnded) {
          return Sink.fail(failure(method, new NativeProcessError({ message: `${method} is closed`, code: "EPIPE" })))
        }
        return NodeSink.fromWritable({
          evaluate: () => writable,
          onError: (cause) => failure(method, cause),
          encoding: config?.encoding,
          endOnDone: config?.endOnDone
        })
      })
    }
    const output = (fd: number, transform?: ChildProcess.CommandOutput): ChildProcessHandle["stdout"] => {
      const pipe = state.child.stdio[fd]
      const stream = pipe !== null && pipe !== undefined && "read" in pipe
        ? Stream.suspend(() => {
          const method = fd === 1 ? "stdout" : fd === 2 ? "stderr" : `fd${fd}`
          const error = state.pipeErrors.get(pipe) ?? pipe.errored ?? undefined
          return error !== undefined ?
            Stream.fail(failure(method, error)) :
            NodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
              evaluate: () => pipe,
              onError: (cause) => failure(method, cause)
            })
        })
        : Stream.empty
      return Sink.isSink(transform) ? Stream.transduce(stream, transform) : stream
    }
    const stdin = input(physicalFds[0]!, descriptors.stdin)
    const stdout = output(physicalFds[1]!, descriptors.stdout)
    const stderr = output(physicalFds[2]!, descriptors.stderr)
    if (Stream.isStream(descriptors.stdin.stream)) {
      yield* Stream.run(descriptors.stdin.stream, stdin).pipe(Effect.forkScoped)
    }
    const inputs = new Map<number, ChildProcessHandle["stdin"]>()
    const outputs = new Map<number, ChildProcessHandle["stdout"]>()
    for (const { fd, config } of descriptors.additional) {
      if (config.type === "input") {
        const sink = input(fd)
        inputs.set(fd, sink)
        if (config.stream !== undefined) yield* Stream.run(config.stream, sink).pipe(Effect.forkScoped)
      } else outputs.set(fd, output(fd, config.sink))
    }
    const handle = makeHandle({
      pid: ProcessId(state.child.pid!),
      exitCode: wait.pipe(Effect.flatMap(([code, signal]) =>
        code === null
          ? Effect.fail(
            failure(
              "exitCode",
              new NativeProcessError({
                message: `Process interrupted due to receipt of signal: '${signal}'`,
                signal: String(signal)
              })
            )
          )
          : Effect.succeed(ExitCode(code))
      )),
      isRunning: Effect.sync(() => !state.ended),
      kill,
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: (fd) => inputs.get(fd) ?? Sink.drain,
      getOutputFd: (fd) => outputs.get(fd) ?? Stream.empty,
      unref: Effect.sync(() => {
        state.referenced = false
        state.child.unref()
        return Effect.sync(() => {
          state.referenced = true
          state.child.ref()
        })
      })
    })
    if (owner && process.platform === "win32") ownerDescriptors.set(handle, standardFds)
    return handle
  })
