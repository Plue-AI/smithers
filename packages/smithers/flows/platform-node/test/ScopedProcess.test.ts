import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import { targetPidOf } from "../src/internal/ProcessSupervisor.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"

vi.mock("../src/ProcessReaper.ts", async (original) => {
  const actual = await original<typeof import("../src/ProcessReaper.ts")>()
  return { ...actual, processLifecycle: vi.fn(actual.processLifecycle) }
})
vi.mock("../src/internal/PipedProcess.ts", async (original) => {
  const actual = await original<typeof import("../src/internal/PipedProcess.ts")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
vi.mock("../src/internal/ProcessSupervisor.ts", async (original) => {
  const actual = await original<typeof import("../src/internal/ProcessSupervisor.ts")>()
  return { ...actual, targetPidOf: vi.fn(actual.targetPidOf) }
})

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

const identity = (pid: number): string => {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
    }).trim()
  } catch {
    return "gone"
  }
}
const gone = (value: string): boolean => value === "gone" || /^\d+\s+\d+\s+\d+\s+Z/.test(value)
const beat = (path: string): { token: string; pid: number; tick: number } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const fakeHandle = (exitCode: Effect.Effect<ExitCode, PlatformError.PlatformError> = Effect.succeed(ExitCode(0))) =>
  makeHandle({
    pid: ProcessId(900_101),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty
  })

describe("scoped transient processes", () => {
  it.live.skipIf(process.platform === "win32")(
    "preserves default group ownership",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const handle = yield* ScopedProcess.spawn({
          command: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          forceKillAfter: 80
        })
        const group = (pid: number) =>
          Number(
            execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
              encoding: "utf8",
              timeout: 1000,
              env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
            }).trim()
          )
        const ownerGroup = group(handle.pid)
        expect(group(handle.targetPid)).toBe(ownerGroup)
        expect(ownerGroup).toBe(handle.pid)
        yield* handle.kill({ forceKillAfter: 80 })
        expect(gone(identity(handle.targetPid))).toBe(true)
      }))
  )

  it.live("preserves the caller's default target cwd and an explicitly configured cwd", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "scoped-cwd-"))
      try {
        for (const cwd of [undefined, directory]) {
          const actual = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* ScopedProcess.spawn({
              command: process.execPath,
              args: ["-e", "process.stdout.write(process.cwd())"],
              cwd
            })
            return yield* text(handle.stdout)
          }))
          expect(actual).toBe(realpathSync(cwd ?? process.cwd()))
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.live("applies verbatim argument quoting to the target without corrupting the owner program", () =>
    Effect.gen(function*() {
      const script = "process.stdout.write(process.argv[1])"
      const argument = "literal argument é🙂"
      const args = [script, argument].map((value) => process.platform === "win32" ? JSON.stringify(value) : value)
      const result = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* ScopedProcess.spawn({
          command: process.execPath,
          args: ["-e", ...args],
          windowsVerbatimArguments: true
        })
        return yield* Effect.all([text(handle.stdout), ScopedProcess.status(handle)], { concurrency: "unbounded" })
      }))
      expect(result).toEqual([argument, { code: 0, signal: null }])
    }))

  it.live("preserves target identity, literal arguments, input and a nonzero status", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "scoped-command-"))
      try {
        const result = yield* Effect.scoped(Effect.gen(function*() {
          const handle = yield* ScopedProcess.spawn({
            command: process.execPath,
            args: [
              "-e",
              "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({input,args:process.argv.slice(1),pid:process.pid,cwd:process.cwd(),only:process.env.ONLY,path:typeof process.env.PATH}));process.stderr.write('diagnostic');process.exitCode=23})",
              "a b",
              "literal;$value",
              "é🙂"
            ],
            cwd: directory,
            env: { ONLY: "scoped-fixture" },
            stdin: "pipe",
            forceKillAfter: 80,
            windowsHide: false,
            windowsVerbatimArguments: false
          })
          const [stdout, stderr, status] = yield* Effect.all([
            text(handle.stdout),
            text(handle.stderr),
            ScopedProcess.status(handle),
            Stream.make(new TextEncoder().encode("input é🙂\n")).pipe(Stream.run(handle.stdin))
          ], { concurrency: "unbounded" })
          return { stdout, stderr, status, targetPid: handle.targetPid, ownerPid: handle.pid }
        }))
        const report = JSON.parse(result.stdout)
        const native = JSON.parse(execFileSync(process.execPath, [
          "-p",
          "JSON.stringify({cwd:process.cwd(),path:typeof process.env.PATH})"
        ], { cwd: directory, env: { ONLY: "scoped-fixture" }, encoding: "utf8" }))
        expect(report).toMatchObject({
          input: "input é🙂\n",
          args: ["a b", "literal;$value", "é🙂"],
          pid: result.targetPid,
          only: "scoped-fixture",
          path: native.path,
          cwd: native.cwd
        })
        expect(result.stderr).toBe("diagnostic")
        expect(result.status).toEqual({ code: 23, signal: null })
        expect(result.targetPid).toBeGreaterThan(1)
        expect(result.ownerPid).not.toBe(result.targetPid)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.live("completes a default command with ignored input and natural exit", () =>
    Effect.gen(function*() {
      // With ignored stdin, Node without argv receives EOF and exits normally.
      const result = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* ScopedProcess.spawn({ command: process.execPath })
        return yield* ScopedProcess.status(handle)
      }))
      expect(result).toEqual({ code: 0, signal: null })
    }))

  it.live.skipIf(process.platform === "win32")(
    "reports a real target signal without converting it into a successful code",
    () =>
      Effect.gen(function*() {
        const result = yield* Effect.scoped(Effect.gen(function*() {
          const handle = yield* ScopedProcess.spawn({
            command: process.execPath,
            args: ["-e", "process.kill(process.pid,'SIGTERM');setInterval(()=>{},1000)"],
            forceKillAfter: 80
          })
          return yield* ScopedProcess.status(handle)
        }))
        expect(result).toEqual({ code: null, signal: "SIGTERM" })
      })
  )

  it.live.skipIf(process.platform === "win32")(
    "finishes inherited output after natural target exit and stops its unique child",
    () =>
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "scoped-inherited-output-"))
        const token = randomUUID()
        const heartbeat = join(directory, "heartbeat.json")
        const child = `const fs=require('node:fs');const token=${JSON.stringify(token)};const path=${
          JSON.stringify(heartbeat)
        };let tick=0;process.on('SIGTERM',()=>{});const beat=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify({token,pid:process.pid,tick:tick++}));fs.renameSync(path+'.tmp',path)};beat();setInterval(beat,25)`
        const leader = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${
          JSON.stringify(child)
        }],{stdio:['ignore','inherit','inherit']}).unref();const timer=setInterval(()=>{if(fs.existsSync(${
          JSON.stringify(heartbeat)
        })){clearInterval(timer);process.stdout.write('complete\\n',()=>process.exit(0))}},5)`
        try {
          const output = yield* Effect.scoped(Effect.gen(function*() {
            const handle = yield* ScopedProcess.spawn({
              command: process.execPath,
              args: ["-e", leader],
              forceKillAfter: 80
            })
            // Output EOF must not depend on a caller already awaiting status or
            // closing the scope that owns the inherited pipe.
            return yield* text(handle.stdout).pipe(Effect.timeout("3 seconds"))
          }))
          expect(output).toBe("complete\n")
          const stopped = beat(heartbeat)!
          expect(stopped.token).toBe(token)
          yield* Effect.sleep(150)
          expect(beat(heartbeat)?.tick).toBe(stopped.tick)
          expect(gone(identity(stopped.pid)), identity(stopped.pid)).toBe(true)
        } finally {
          const last = beat(heartbeat)
          if (last !== undefined && identity(last.pid).includes(token)) process.kill(last.pid, "SIGKILL")
          rmSync(directory, { recursive: true, force: true })
        }
      })
  )

  it.live("cleans a refused target before returning to an outer scope that remains open", () =>
    Effect.gen(function*() {
      const original = vi.mocked(ProcessReaper.processLifecycle).getMockImplementation()!
      let ownerPid = 0
      let ownerPath = ""
      vi.mocked(ProcessReaper.processLifecycle).mockImplementationOnce((command, spawn) =>
        original(command, (prepared) =>
          spawn(prepared).pipe(Effect.tap((handle) =>
            Effect.sync(() => {
              ownerPid = handle.pid
              ownerPath = prepared.args.at(-2) ?? ""
            })
          )))
      )
      try {
        yield* Effect.scoped(Effect.gen(function*() {
          const refused = yield* Effect.exit(ScopedProcess.spawn({
            command: join(tmpdir(), `missing-scoped-target-${randomUUID()}`),
            forceKillAfter: 80
          }))
          expect(Exit.isFailure(refused)).toBe(true)
          if (Exit.isFailure(refused)) expect(String(refused.cause)).toContain("NotFound")
          if (process.platform !== "win32") {
            expect(ownerPid).toBeGreaterThan(1)
            expect(gone(identity(ownerPid)), identity(ownerPid)).toBe(true)
          }
          // The outer scope is still live. Its eventual finalizer cannot be
          // the operation responsible for cleaning the refused startup.
          yield* Effect.sleep(20)
        }))
      } finally {
        if (ownerPid > 1 && ownerPath !== "" && identity(ownerPid).includes(ownerPath)) {
          process.kill(ownerPid, "SIGKILL")
        }
      }
    }))

  it.effect("refuses an activated POSIX owner that never identifies its target and closes it immediately", () =>
    Effect.gen(function*() {
      let activated = false
      let released = false
      vi.mocked(ProcessReaper.processLifecycle).mockImplementationOnce(() =>
        Effect.gen(function*() {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true
            })
          )
          return {
            handle: fakeHandle(),
            activate: Effect.sync(() => {
              activated = true
            }),
            settled: Effect.succeed(true)
          }
        })
      )
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      Object.defineProperty(process, "platform", { value: "linux" })
      try {
        yield* Effect.scoped(Effect.gen(function*() {
          const result = yield* Effect.exit(ScopedProcess.spawn({ command: "literal" }))
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(String(result.cause)).toContain("did not identify its target")
          expect(activated).toBe(true)
          expect(released).toBe(true)
        }))
      } finally {
        Object.defineProperty(process, "platform", platform)
      }
    }))

  it.effect("keeps Windows verbatim arguments on the target and requests mapped owner pipes", () =>
    Effect.gen(function*() {
      const handle = fakeHandle()
      const raw = vi.mocked(PipedProcess.spawn)
      raw.mockReturnValueOnce(Effect.succeed(handle))
      vi.mocked(targetPidOf).mockReturnValueOnce(900_102)
      vi.mocked(ProcessReaper.processLifecycle).mockImplementationOnce((command, spawn) =>
        Effect.map(spawn(command), (handle) => ({ handle, activate: Effect.void, settled: Effect.succeed(true) }))
      )
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      Object.defineProperty(process, "platform", { value: "win32" })
      try {
        const result = yield* Effect.scoped(ScopedProcess.spawn({
          command: "cmd.exe",
          args: ["/d", "/s", "/c", "\"literal argument\""],
          windowsVerbatimArguments: true
        }))
        expect(result.targetPid).toBe(900_102)
        expect(raw.mock.calls.at(-1)?.[1]).toBe(false)
        expect(raw.mock.calls.at(-1)?.[2]).toBe(true)
        expect(raw.mock.calls.at(-1)?.[0]).toMatchObject({
          command: "cmd.exe",
          args: ["/d", "/s", "/c", "\"literal argument\""],
          options: { detached: false, stdin: "ignore", windowsVerbatimArguments: true }
        })
      } finally {
        Object.defineProperty(process, "platform", platform)
      }
    }))
})

describe("scoped target status", () => {
  for (
    const cause of [undefined, null, 42, new Error("supervisor lost"), { signal: null }, { signal: 9 }, {
      signal: "TERM"
    }]
  ) {
    it.effect(`preserves failures without an actual target signal (${JSON.stringify(cause)})`, () =>
      Effect.gen(function*() {
        const error = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "exitCode", cause })
        expect(yield* Effect.flip(ScopedProcess.status(fakeHandle(Effect.fail(error))))).toBe(error)
      }))
  }
  it.effect("preserves a reason that does not carry a cause field", () =>
    Effect.gen(function*() {
      const error = PlatformError.badArgument({ module: "ChildProcess", method: "exitCode" })
      expect(yield* Effect.flip(ScopedProcess.status(fakeHandle(Effect.fail(error))))).toBe(error)
    }))
  it.effect("preserves the actual target signal from a typed platform failure", () =>
    Effect.gen(function*() {
      const error = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: { signal: "SIGINT" }
      })
      expect(yield* ScopedProcess.status(fakeHandle(Effect.fail(error)))).toEqual({ code: null, signal: "SIGINT" })
    }))
})
