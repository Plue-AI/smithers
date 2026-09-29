import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Deferred, Effect, Fiber, PlatformError, Sink, Stream } from "effect"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { afterEach, expect, it, vi } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

afterEach(() => vi.restoreAllMocks())

const fixture = (
  kill: ScopedProcess.Handle["kill"],
  exitCode: ScopedProcess.Handle["exitCode"] = Effect.succeed(ExitCode(0))
) => {
  const handle = Object.assign(
    makeHandle({
      pid: ProcessId(12345),
      exitCode,
      // A completed target still requires its owner's tree cleanup.
      isRunning: Effect.succeed(false),
      kill,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    }),
    { targetPid: 12346 }
  )
  vi.spyOn(ScopedProcess, "spawn").mockReturnValue(Effect.succeed(handle))
  return {
    command: "fixture",
    args: ["literal argument"],
    cwd: "/fixture",
    stdout: () => {},
    stderr: () => {}
  }
}

it.skipIf(process.platform === "win32")(
  "joins process cleanup on native fiber interruption",
  () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const killing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const options = fixture(() =>
        Deferred.succeed(killing, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        ), Effect.never)
      const process = yield* ContainedProcess.runEffect(options).pipe(Effect.forkScoped({ startImmediately: true }))
      let closed = false
      const closing = yield* Fiber.interrupt(process).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Deferred.await(killing)
      expect(closed).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(closed).toBe(true)
    })))
)

it.skipIf(process.platform === "win32")(
  "awaits the owner's declared stop contract even after the target exits",
  async () => {
    let release!: () => void
    let stopped = false
    const killed = new Promise<void>((resolve) => {
      release = resolve
    })
    const kill = vi.fn(() => Effect.promise(() => killed))
    const options = fixture(kill)
    const pending = ContainedProcess.run(options).then((code) => {
      stopped = true
      return code
    })
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith({ killSignal: "SIGTERM", forceKillAfter: 5000 }))
    expect(stopped).toBe(false)
    expect(ScopedProcess.spawn).toHaveBeenCalledWith({
      command: "fixture",
      args: ["literal argument"],
      cwd: "/fixture",
      env: undefined,
      stdin: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: 5000
    })
    release()
    expect(await pending).toBe(0)
    expect(stopped).toBe(true)
  }
)

it.skipIf(process.platform === "win32")(
  "preserves refused cleanup instead of reporting an exited command as successful",
  async () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "kill",
      cause: Object.assign(new Error("cleanup observation denied"), { code: "EPERM" })
    })
    const options = fixture(() => Effect.fail(denied))
    await expect(ContainedProcess.run(options)).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "cleanup_failed",
      cause: denied
    })
  }
)

it.skipIf(process.platform === "win32")(
  "retains a supervisor failure rather than inventing a nonzero target exit",
  async () => {
    const failure = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "exitCode",
      cause: new Error("owner lost before target status")
    })
    const kill = vi.fn(() => Effect.void)
    const options = fixture(kill, Effect.fail(failure))
    await expect(ContainedProcess.run(options)).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "process_failed",
      cause: failure
    })
    expect(kill).toHaveBeenCalledOnce()
  }
)
