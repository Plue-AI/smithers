import { describe, expect, it } from "@effect/vitest"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Cause, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { EventEmitter, once } from "node:events"
import * as Fs from "node:fs"
import * as Net from "node:net"
import { tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import * as Tls from "node:tls"
import { vi } from "vitest"
import * as Cleanup from "../src/internal/ProcessCleanup.ts"
import * as Supervisor from "../src/internal/ProcessSupervisor.ts"
import { resolveJobExecutable, WindowsProcessJob } from "../src/internal/WindowsProcessJob.ts"

vi.mock(
  "../src/internal/WindowsProcessJob.ts",
  () => ({ WindowsProcessJob: vi.fn(), resolveJobExecutable: vi.fn(() => "/trusted/job-helper") })
)

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>()
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    chmodSync: vi.fn(actual.chmodSync),
    rmSync: vi.fn(actual.rmSync)
  }
})
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>()
  return { ...actual, createServer: vi.fn(actual.createServer), createConnection: vi.fn(actual.createConnection) }
})

vi.mock("node:tls", async (original) => {
  const actual = await original<typeof import("node:tls")>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})
const serverFactory = (process.platform === "win32" ? Tls.createServer : Net.createServer) as typeof Net.createServer

const promise = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const bounded = async <A>(value: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The test peer did not settle")), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface Settings {
  readonly platform?: "darwin" | "win32"
  readonly job?: "held-ready" | "held-settlement" | "attach-failure" | "cleanup-failure"
  readonly readiness?: "valid" | "malformed" | "wrong" | "silent" | "absent"
  readonly stop?: "exit" | "ignore" | "open-channel" | "cleanup-error"
  readonly snapshot?: "empty" | "survivor" | "own-group" | "owner" | "unavailable"
  readonly endOnDisconnect?: boolean
  readonly snapshotUnavailableAfterExitMs?: number
}

/**
 * The real lifecycle talks to a native peer, but no operating-system process
 * owns this handle. The only cleanup effects are observations and recorded
 * calls. In particular, none of these failure cases can signal a numeric pid.
 */
const fixture = (settings: Settings = {}) => {
  const owner = promise<ExitCode>()
  const jobAttached = promise<void>()
  const jobReady = promise<void>()
  const jobSettled = promise<void>()
  let jobCreated = false
  const jobReferences: Array<boolean> = []
  let jobStops = 0
  const accepted = promise<void>()
  let peer: Net.Socket | undefined
  let requestPeer: Net.Socket | undefined
  let ownerDone = false
  let ownerEndedAt = 0
  let referenced = true
  let unrefs = 0
  let rawKills = 0
  let rawFinalizerReferenced: boolean | undefined
  const requests: Array<Record<string, unknown>> = []
  const commands: Array<ChildProcess.StandardCommand> = []
  const paths: Array<string> = []
  const endOwner = () => {
    ownerDone = true
    ownerEndedAt = Date.now()
    owner.resolve(ExitCode(0))
    if (jobCreated && settings.job !== "held-settlement") jobSettled.resolve()
  }
  if (settings.platform === "win32") {
    vi.mocked(WindowsProcessJob).mockImplementation(function(pid, created, executable) {
      expect(pid).toBe(900_001)
      expect(created).toBe("123456789012345678")
      expect(executable).toBe("/trusted/job-helper")
      if (settings.job === "attach-failure") throw new Error("job attachment refused")
      jobCreated = true
      jobAttached.resolve()
      if (settings.job !== "held-ready") jobReady.resolve()
      return {
        ready: jobReady,
        settled: {
          promise: jobSettled.promise.then(() => {
            if (settings.job === "cleanup-failure") throw new Error("job settlement unavailable")
          })
        },
        stop: () => {
          jobStops++
          endOwner()
          peer?.end()
        },
        reference: (value: boolean) => jobReferences.push(value)
      } as unknown as WindowsProcessJob
    })
  }
  const send = (message: unknown) => peer?.write(JSON.stringify(message) + "\n")
  const system: Cleanup.System = {
    platform: settings.platform ?? "darwin",
    snapshot: () =>
      settings.snapshot === "unavailable" ||
        ownerDone && Date.now() - ownerEndedAt < (settings.snapshotUnavailableAfterExitMs ?? 0) ?
        undefined :
        ({
          ownGroup: settings.snapshot === "own-group" ? 900_001 : 900_002,
          members: settings.snapshot === "survivor"
            ? [{ pid: 900_003, startedAtMs: 1, zombie: false }]
            : settings.snapshot === "owner" && !ownerDone
            ? [{ pid: 900_001, startedAtMs: 1, zombie: false }]
            : []
        }),
    // Fixture identities are fabricated, so the kernel can prove nothing about them.
    vacant: () => false
  }
  const spawn = (command: ChildProcess.StandardCommand) =>
    Effect.gen(function*() {
      commands.push(command)
      const path = resolve(command.options.cwd ?? process.cwd(), command.args.at(-2)!)
      paths.push(path)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          rawFinalizerReferenced = referenced
          peer?.destroy()
          requestPeer?.destroy()
          endOwner()
        })
      )
      if (settings.readiness === "absent") endOwner()
      else {
        yield* Effect.tryPromise({
          try: async () => {
            peer = Supervisor.connectOwner(path, command.options.env ?? {})
            peer.on("error", () => {})
            requestPeer = Supervisor.connectOwner(path.replace(/\/s$/, "/r"), command.options.env ?? {})
            requestPeer.on("error", () => {})
            requestPeer.once("close", () => {
              if (settings.endOnDisconnect !== false) {
                endOwner()
                peer?.end()
              }
            })
            let buffer = ""
            requestPeer.on("data", (data) => {
              buffer += String(data)
              for (;;) {
                const end = buffer.indexOf("\n")
                if (end < 0) break
                const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>
                buffer = buffer.slice(end + 1)
                requests.push(frame)
                if (frame.type === "start") send({ type: "spawned", pid: 900_004 })
                if (frame.type === "stop" && settings.stop !== "ignore") {
                  if (settings.stop === "cleanup-error") {
                    send({ type: "cleanup_error", message: "test escaped child could not be verified" })
                  }
                  send({ type: "cleanup" })
                  endOwner()
                  if (settings.stop !== "open-channel") peer?.end()
                }
              }
            })
            peer.once("close", () => {
              if (settings.endOnDisconnect !== false) endOwner()
            })
            await bounded(Promise.all([once(peer, "connect"), once(requestPeer, "connect")]))
            if (settings.readiness === "malformed") peer.write("{invalid}\n")
            else if (settings.readiness !== "silent") {
              send({
                type: "ready",
                version: 1,
                pid: settings.readiness === "wrong" ? 900_005 : 900_001,
                created: "123456789012345678"
              })
            }
            accepted.resolve()
          },
          catch: (cause) => Supervisor.failure("spawn", "test peer", cause)
        })
      }
      return makeHandle({
        pid: ProcessId(900_001),
        exitCode: Effect.promise(() => owner.promise),
        isRunning: Effect.sync(() => !ownerDone),
        kill: () =>
          Effect.sync(() => {
            rawKills++
            endOwner()
          }),
        unref: Effect.sync(() => {
          unrefs++
          referenced = false
          return Effect.sync(() => {
            referenced = true
          })
        }),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty
      })
    })
  return {
    jobAttached: jobAttached.promise,
    releaseJob: () => jobReady.resolve(),
    releaseSettlement: () => jobSettled.resolve(),
    jobReferences,
    get jobStops() {
      return jobStops
    },
    system,
    spawn,
    paths,
    requests,
    commands,
    exitTarget: () => send({ type: "exit", code: 0, signal: null }),
    announceCleanup: () => send({ type: "cleanup" }),
    get unrefs() {
      return unrefs
    },
    get rawKills() {
      return rawKills
    },
    get rawFinalizerReferenced() {
      return rawFinalizerReferenced
    },
    disconnect: async () => {
      await bounded(accepted.promise)
      const closed = once(peer!, "close")
      peer!.destroy()
      requestPeer?.destroy()
      await bounded(closed)
    },
    dispose: () => {
      peer?.destroy()
      requestPeer?.destroy()
      endOwner()
    }
  }
}

const run = async (
  host: ReturnType<typeof fixture>,
  use: (handle: ReturnType<typeof makeHandle>) => Effect.Effect<unknown, unknown> = () => Effect.void,
  options: ChildProcess.CommandOptions = {}
) => {
  const ledger = await Effect.runPromise(
    ProcessLedger.makeMemory({ hostId: "failed-supervisor", ownerPid: process.pid })
  )
  const outcome = await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("literal", ["original argument"], {
        forceKillAfter: 0,
        ...options
      }))
      return yield* use(handle)
    }).pipe(
      Effect.provide(ContainedSpawner.layer({ platform: host.system.platform }, Cleanup.lifecycle(host.system))),
      Effect.provide(
        Layer.succeed(ChildProcessSpawner)(make((command) =>
          command._tag === "StandardCommand"
            ? host.spawn(command)
            : Effect.die("the lifecycle must prepare one standard owner")
        ))
      ),
      Effect.provideService(ProcessLedger.ProcessLedger, ledger),
      Effect.scoped,
      Effect.exit
    )
  )
  return { outcome, live: await Effect.runPromise(ledger.live) }
}

describe("failed process preparation", () => {
  it("uses private filesystem sockets on POSIX and preserves request write failures", async () => {
    // No OS resources are allocated: exercise the POSIX transport contract on
    // every host, including Windows, whose real transport is authenticated TLS.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const servers = Array.from({ length: 2 }, () => {
      const server = new EventEmitter()
      return Object.assign(server, {
        listen: vi.fn((_path: string, ready: () => void) => ready()),
        close: vi.fn(),
        unref: vi.fn()
      })
    })
    const socket = new Net.Socket()
    const cause = new Error("request write refused")
    const write = vi.spyOn(socket, "write").mockImplementation((_data, callback: unknown) => {
      if (typeof callback !== "function") throw new Error("Missing write callback")
      callback(cause)
      return false
    })
    vi.mocked(Fs.mkdtempSync).mockReturnValueOnce("/tmp/sm-p-contract")
    vi.mocked(Fs.chmodSync).mockImplementationOnce(() => {})
    vi.mocked(Fs.rmSync).mockImplementationOnce(() => {})
    for (const server of servers) {
      vi.mocked(Net.createServer).mockReturnValueOnce(server as unknown as Net.Server)
    }
    vi.mocked(Net.createConnection).mockReturnValueOnce(socket).mockReturnValueOnce(socket)
    let control: Supervisor.Control | undefined
    try {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
      control = new Supervisor.Control()
      await control.listening
      expect(Fs.mkdtempSync).toHaveBeenLastCalledWith(join(tmpdir(), "sm-p-"))
      expect(Fs.chmodSync).toHaveBeenLastCalledWith(control.directory, 0o700)
      expect(servers[0]!.listen).toHaveBeenCalledWith(control.path, expect.any(Function))
      expect(servers[1]!.listen).toHaveBeenCalledWith(control.requestPath, expect.any(Function))
      expect(control.environment()).toEqual({})
      expect(control.connect()).toBe(socket)
      expect(Net.createConnection).toHaveBeenLastCalledWith(control.path)
      expect(control.connect(true)).toBe(socket)
      expect(Net.createConnection).toHaveBeenLastCalledWith(control.requestPath)
      control.requestSocket = socket
      await expect(control.write({ type: "stop" })).rejects.toBe(cause)
      expect(write).toHaveBeenCalledWith("{\"type\":\"stop\"}\n", expect.any(Function))
    } finally {
      Object.defineProperty(process, "platform", platform)
      control?.dispose()
      socket.destroy()
      write.mockRestore()
    }
    expect(servers.every((server) => server.close.mock.calls.length === 1)).toBe(true)
    expect(Fs.rmSync).toHaveBeenLastCalledWith("/tmp/sm-p-contract", { recursive: true, force: true })
  })

  it.each([false, true])("preserves explicit environment values with extendEnv=%s", async (extendEnv) => {
    const host = fixture()
    const name = "SMITHERS_SUPERVISOR_TEST_INHERITED"
    const previous = process.env[name]
    process.env[name] = "from-host"
    try {
      const result = await run(host, undefined, { extendEnv, env: { EXPLICIT: "from-command" } })
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      const env = host.requests.find((request) => request.type === "configure")!.env as Record<string, string>
      expect(env.EXPLICIT).toBe("from-command")
      expect(env[name]).toBe(extendEnv ? "from-host" : undefined)
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
      host.dispose()
    }
  })

  it.each(["empty", "survivor", "own-group", "unavailable"] as const)(
    "does not fast-stop a natural exit without an owner-only snapshot (%s)",
    async (snapshot) => {
      const host = fixture({ snapshot })
      try {
        const result = await run(host, (handle) =>
          Effect.gen(function*() {
            host.exitTarget()
            expect(yield* handle.exitCode).toBe(0)
          }))
        expect(host.requests.filter((request) => request.fast === true)).toEqual([])
        expect(Exit.isSuccess(result.outcome)).toBe(snapshot === "empty")
        expect(result.live).toHaveLength(snapshot === "empty" ? 0 : 1)
        expect(host.rawKills).toBe(0)
      } finally {
        host.dispose()
      }
    }
  )

  it("exposes running state and additional pipes while preserving window visibility", async () => {
    const host = fixture()
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          expect(yield* handle.isRunning).toBe(true)
          yield* Stream.make(new Uint8Array([1])).pipe(Stream.run(handle.getInputFd(3)))
          expect(yield* handle.getOutputFd(4).pipe(Stream.runCollect)).toEqual([])
          host.exitTarget()
          expect(yield* handle.exitCode).toBe(0)
          expect(yield* handle.isRunning).toBe(false)
        }), { windowsHide: false, additionalFds: { fd3: { type: "input" }, fd4: { type: "output" } } })
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.requests.find((request) => request.type === "configure")).toMatchObject({
        windowsHide: false,
        userFds: [3, 4]
      })
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  })

  it("refuses an unavailable Node SEA module before allocating or spawning an owner", async () => {
    const cause = new Error("the Node SEA module could not load")
    const bun = Object.getOwnPropertyDescriptor(process.versions, "bun")
    Object.defineProperty(process.versions, "bun", { value: undefined, configurable: true })
    vi.doMock("node:sea", () => {
      throw cause
    })
    const host = fixture()
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        const error = Cause.squash(result.outcome.cause)
        expect(error).toMatchObject({ _tag: "PlatformError", reason: { method: "spawn" } })
        // Vitest wraps a rejected module factory in its import error. That
        // exact rejection stays attached to the typed preparation failure.
        expect(error).toHaveProperty("cause.cause", cause)
      }
      expect(host.commands).toEqual([])
      expect(host.paths).toEqual([])
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
      vi.doUnmock("node:sea")
      if (bun === undefined) Reflect.deleteProperty(process.versions, "bun")
      else Object.defineProperty(process.versions, "bun", bun)
    }
  })

  it("selects Bun bootstrap flags without importing Node SEA or changing the target configuration", async () => {
    const bun = Object.getOwnPropertyDescriptor(process.versions, "bun")
    Object.defineProperty(process.versions, "bun", { value: "1.4.1-test-seam", configurable: true })
    vi.doMock("node:sea", () => {
      throw new Error("the Bun bootstrap must not import Node SEA")
    })
    const host = fixture()
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.commands).toHaveLength(1)
      expect(host.commands[0]!.args.slice(0, 3)).toEqual(["--no-env-file", "--config=/dev/null", "-e"])
      expect(host.commands[0]!.options).toMatchObject({
        cwd: process.platform === "win32" ? parse(process.execPath).root : expect.stringContaining("sm-p-"),
        extendEnv: false,
        shell: false
      })
      expect(host.requests.find((frame) => frame.type === "configure")).toMatchObject({
        command: "literal",
        args: ["original argument"]
      })
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
      vi.doUnmock("node:sea")
      if (bun === undefined) Reflect.deleteProperty(process.versions, "bun")
      else Object.defineProperty(process.versions, "bun", bun)
    }
  })

  for (const readiness of ["absent", "malformed", "wrong"] as const) {
    it(`refuses ${readiness} owner readiness without activating or leaving a record`, async () => {
      const host = fixture({ readiness })
      try {
        const result = await run(host)
        expect(Exit.isFailure(result.outcome)).toBe(true)
        if (Exit.isFailure(result.outcome)) expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(host.requests.some((frame) => frame.type === "start")).toBe(false)
        expect(result.live).toEqual([])
        expect(host.rawKills).toBe(0)
        for (const path of host.paths) expect(Fs.existsSync(path)).toBe(false)
      } finally {
        host.dispose()
      }
    })
  }

  it("bounds a live owner that never announces readiness and still cleans its preparation", async () => {
    const host = fixture({ readiness: "silent" })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(String(result.outcome.cause)).toContain("spawn timed out")
      }
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
      expect(Date.now() - started).toBeLessThan(8000)
      expect(host.requests.map((frame) => frame.type)).toEqual(["stop"])
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  }, 10_000)

  it("refuses excessive private configuration before recording or activating a target", async () => {
    const host = fixture()
    try {
      const result = await run(host, undefined, { env: { LARGE: "x".repeat(4 * 1024 * 1024) } })
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) {
        expect(Cause.hasDies(result.outcome.cause)).toBe(false)
        expect(String(result.outcome.cause)).toContain("configuration exceeds")
      }
      expect(host.requests.map((frame) => frame.type)).toEqual(["stop"])
      expect(result.live).toEqual([])
    } finally {
      host.dispose()
    }
  })

  for (const step of ["directory", "permissions", "server", "request-server", "listening"] as const) {
    it(`maps a ${step} failure into the typed channel and removes any owned directory`, async () => {
      const cause = Object.assign(new Error(`${step} denied`), { code: "EACCES" })
      if (step === "directory") {
        vi.mocked(Fs.mkdtempSync).mockImplementationOnce(() => {
          throw cause
        })
      }
      if (step === "permissions") {
        vi.mocked(Fs.chmodSync).mockImplementationOnce(() => {
          throw cause
        })
      }
      if (step === "request-server") {
        vi.mocked(serverFactory).mockImplementationOnce(vi.mocked(serverFactory).getMockImplementation()!)
      }
      if (step === "server" || step === "request-server") {
        vi.mocked(serverFactory).mockImplementationOnce(() => {
          throw cause
        })
      }
      if (step === "listening") {
        const server = serverFactory()
        vi.spyOn(server, "listen").mockImplementation(() => {
          queueMicrotask(() => server.emit("error", cause))
          return server
        })
        vi.mocked(serverFactory).mockReturnValueOnce(server)
      }
      const spawn = vi.fn(() => Effect.die("raw spawn must not run"))
      const outcome = await Effect.runPromise(
        Supervisor.prepare({ platform: "darwin", snapshot: () => undefined, vacant: () => false }, Cleanup.policy)(
          ChildProcess.make("literal"),
          spawn
        ).pipe(Effect.scoped, Effect.exit)
      )
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) {
        expect(Cause.hasDies(outcome.cause)).toBe(false)
        expect(String(outcome.cause)).toContain("PermissionDenied")
      }
      expect(spawn).not.toHaveBeenCalled()
      const directory = vi.mocked(Fs.mkdtempSync).mock.results.at(-1)
      if (directory?.type === "return") expect(Fs.existsSync(directory.value)).toBe(false)
    })
  }
})

describe("unverified cleanup report", () => {
  const control = { fault: undefined, cleanupFailed: false, cleanupAcknowledged: false, targetDone: true }
  it("names the receipt state, the kernel answer and each observed member", () => {
    const snapshot = {
      ownGroup: 700,
      members: [{ pid: 901, startedAtMs: 1, zombie: true }, { pid: 902, startedAtMs: 2, zombie: false }]
    }
    expect(Supervisor.unverifiedCleanup(control, true, false, snapshot)).toBe(
      "target exited: true; cleanup receipt: missing; group vacant: false; group members: 901 zombie, 902 live; host group 700"
    )
    expect(Supervisor.unverifiedCleanup({ ...control, cleanupAcknowledged: true }, true, false, undefined)).toBe(
      "target exited: true; cleanup receipt: acknowledged; group vacant: false; group snapshot: unavailable"
    )
    expect(Supervisor.unverifiedCleanup({ ...control, targetDone: false }, false, true, { ownGroup: 700, members: [] }))
      .toBe(
        "target exited: false; cleanup receipt: not required; group vacant: true; group members: none; host group 700"
      )
  })

  it("reports a failed receipt with its fault, whether an Error, a frame or a string", () => {
    const failed = { ...control, cleanupFailed: true }
    expect(Supervisor.unverifiedCleanup({ ...failed, fault: new Error("escaped child") }, true, false, undefined))
      .toBe(
        "target exited: true; cleanup receipt: failed; group vacant: false; group snapshot: unavailable; fault: escaped child"
      )
    expect(
      Supervisor.unverifiedCleanup({ ...failed, fault: { type: "fault", message: "frame" } }, true, false, undefined)
    )
      .toMatch(/; fault: frame$/)
    expect(Supervisor.unverifiedCleanup({ ...failed, fault: "closed" }, true, false, undefined)).toMatch(
      /; fault: closed$/
    )
  })
})

describe("failed process shutdown", () => {
  it("waits for a real empty-group observation after a transient host probe outage", async () => {
    const host = fixture({ snapshotUnavailableAfterExitMs: 800 })
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it("releases an unactivated owner immediately without launching its target or signalling a raw pid", async () => {
    const host = fixture({ snapshot: "owner" })
    try {
      const outcome = await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const prepared = yield* Supervisor.prepare(host.system, Cleanup.policy)(
            ChildProcess.make("literal", { killSignal: "SIGTERM", forceKillAfter: 500 }),
            host.spawn
          )
          // Preparation can be withdrawn before the ledger accepts the owner.
          // Observe only that owner and request cleanup through its live channel.
          yield* prepared.handle.kill()
          expect(yield* prepared.settled).toBe(true)
        })).pipe(Effect.exit)
      )
      expect(Exit.isSuccess(outcome)).toBe(true)
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "stop"])
      expect(host.requests[1]).toMatchObject({ type: "stop", explicit: true, killSignal: "SIGKILL", graceMs: 500 })
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
      expect(host.rawFinalizerReferenced).toBe(true)
    } finally {
      host.dispose()
    }
  })

  it("disconnects a failed cleanup receipt write and waits for native job settlement", async () => {
    const host = fixture({ platform: "win32" })
    const original = Supervisor.Control.prototype.write
    const refused = promise<void>()
    const write = vi.spyOn(Supervisor.Control.prototype, "write").mockImplementation(
      function(this: Supervisor.Control, message) {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "cleanup_ack") {
          refused.resolve()
          return Promise.reject(new Error("the cleanup receipt write failed"))
        }
        return original.call(this, message)
      }
    )
    try {
      const result = await run(host, () =>
        Effect.promise(async () => {
          host.announceCleanup()
          await bounded(refused.promise)
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
    } finally {
      write.mockRestore()
      host.dispose()
    }
  })

  it("disconnects after an owner-only natural-exit fast-stop write fails and verifies cleanup", async () => {
    const host = fixture({ snapshot: "owner" })
    const original = Supervisor.Control.prototype.write
    const rejected: Array<unknown> = []
    const write = vi.spyOn(Supervisor.Control.prototype, "write").mockImplementation(
      function(this: Supervisor.Control, message) {
        if (typeof message === "object" && message !== null && "fast" in message && message.fast === true) {
          rejected.push(message)
          return Promise.reject(new Error("the fast-stop write failed"))
        }
        return original.call(this, message)
      }
    )
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          host.exitTarget()
          expect(yield* handle.exitCode).toBe(0)
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(rejected).toEqual([{ type: "stop", killSignal: "SIGKILL", fast: true }])
      // The real peer only exits on connection close in this schedule. There
      // was no accepted stop frame and no raw numerical-pid kill fallback.
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "start"])
      expect(result.live).toEqual([])
      expect(host.rawKills).toBe(0)
      expect(host.unrefs).toBe(0)
    } finally {
      write.mockRestore()
      host.dispose()
    }
  })

  it("uses EOF after a failed stop write and retains an unacknowledged explicit cleanup", async () => {
    const host = fixture()
    try {
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => host.disconnect())
          yield* handle.kill()
        }))
      expect(Exit.isFailure(result.outcome)).toBe(true)
      expect(host.requests.map((frame) => frame.type)).toEqual(["configure", "start"])
      expect(host.rawKills).toBe(0)
      expect(result.live).toHaveLength(1)
      expect(host.unrefs).toBe(1)
    } finally {
      host.dispose()
    }
  })

  it("bounds an unresponsive owner, retains its record, and disables blind raw cleanup", async () => {
    const host = fixture({ stop: "ignore", endOnDisconnect: false })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      if (Exit.isFailure(result.outcome)) expect(String(result.outcome.cause)).toContain("kill timed out")
      expect(Date.now() - started).toBeLessThan(5000)
      expect(result.live).toHaveLength(1)
      expect(result.live[0]).toMatchObject({
        pid: 900_001,
        pgid: 900_001,
        commandDigest: "literal"
      })
      expect(host.unrefs).toBe(1)
      expect(host.rawFinalizerReferenced).toBe(false)
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  }, 7000)

  for (const snapshot of ["survivor", "own-group"] as const) {
    it(`retains the record when the owner exits but the observation reports ${snapshot}`, async () => {
      const host = fixture({ snapshot })
      try {
        const result = await run(host)
        expect(Exit.isFailure(result.outcome)).toBe(true)
        if (Exit.isFailure(result.outcome)) {
          expect(String(result.outcome.cause)).toContain("cleanup could not be verified")
          expect(String(result.outcome.cause)).toMatch(/group vacant: false; group members: .*; host group \d+/)
        }
        expect(result.live).toHaveLength(1)
        expect(host.unrefs).toBe(1)
        expect(host.rawFinalizerReferenced).toBe(false)
        expect(host.rawKills).toBe(0)
      } finally {
        host.dispose()
      }
    })
  }

  it("retains a reported escaped-child cleanup failure despite an empty original group", async () => {
    const host = fixture({ stop: "cleanup-error" })
    try {
      const result = await run(host)
      expect(Exit.isFailure(result.outcome)).toBe(true)
      expect(result.live).toHaveLength(1)
      expect(host.unrefs).toBe(1)
      expect(host.rawFinalizerReferenced).toBe(false)
    } finally {
      host.dispose()
    }
  })

  it("bounds a status channel left open after verified raw-owner exit", async () => {
    const host = fixture({ stop: "open-channel" })
    const started = Date.now()
    try {
      const result = await run(host)
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(result.live).toEqual([])
      expect(host.unrefs).toBe(0)
      expect(host.rawKills).toBe(0)
    } finally {
      host.dispose()
    }
  })
})

describe("Windows job ownership", () => {
  it("completes native settlement after an explicit kill is interrupted", async () => {
    const host = fixture({ platform: "win32", job: "held-settlement" })
    let interruptFinished = false
    const result = await run(host, (handle) =>
      Effect.gen(function*() {
        const killed = yield* handle.kill().pipe(Effect.forkChild({ startImmediately: true }))
        while (!host.requests.some((message) => message.type === "stop")) yield* Effect.sleep(1)
        const interrupted = yield* Fiber.interrupt(killed).pipe(
          Effect.andThen(Effect.sync(() => {
            interruptFinished = true
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.sleep(10)
        expect(interruptFinished).toBe(false)
        host.releaseSettlement()
        yield* Fiber.join(interrupted)
      }))
    expect(interruptFinished).toBe(true)
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(result.live).toEqual([])
    expect(host.requests.filter((message) => message.type === "stop")).toHaveLength(1)
  })

  it("refuses an unavailable native helper before creating an owner", async () => {
    vi.mocked(resolveJobExecutable).mockImplementationOnce(() => {
      throw new Error("missing native helper")
    })
    const host = fixture({ platform: "win32" })
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(host.commands).toEqual([])
    expect(result.live).toEqual([])
  })
  it("waits for native job assignment before configuring or activating the target", async () => {
    const host = fixture({ platform: "win32", job: "held-ready" })
    const running = run(host)
    await host.jobAttached
    expect(host.requests).toEqual([])
    expect(host.commands[0]!.options.detached).toBe(false)
    host.releaseJob()
    const result = await running
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(host.requests.map((message) => message.type)).toEqual(["configure", "start", "stop"])
    expect(result.live).toEqual([])
    expect(host.rawKills).toBe(0)
  })

  it("refuses activation when the native job cannot attach", async () => {
    const host = fixture({ platform: "win32", job: "attach-failure" })
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(host.requests.every((message) => message.type === "stop")).toBe(true)
    expect(result.live).toEqual([])
  })

  it("retains the ledger record when native settlement fails", async () => {
    const host = fixture({ platform: "win32", job: "cleanup-failure" })
    const result = await run(host)
    expect(Exit.isFailure(result.outcome)).toBe(true)
    expect(result.live).toHaveLength(1)
    expect(host.jobStops).toBe(1)
    expect(host.jobReferences).toEqual([false])
    expect(host.rawFinalizerReferenced).toBe(false)
  })

  it("forces the job when its Node owner does not answer a stop", async () => {
    const host = fixture({ platform: "win32", stop: "ignore" })
    const result = await run(host)
    expect(Exit.isSuccess(result.outcome)).toBe(true)
    expect(host.jobStops).toBe(1)
    expect(host.rawKills).toBe(0)
    expect(result.live).toEqual([])
  })

  it.each(["darwin", "win32"] as const)(
    "tracks %s references through repeated unref, reref, and explicit stop",
    async (platform) => {
      const host = fixture({ platform })
      const result = await run(host, (handle) =>
        Effect.gen(function*() {
          const reref = yield* handle.unref
          const second = yield* handle.unref
          yield* reref
          yield* second
          yield* handle.unref
          yield* handle.kill({ killSignal: "SIGINT", forceKillAfter: 0 })
        }))
      expect(Exit.isSuccess(result.outcome)).toBe(true)
      expect(host.jobReferences).toEqual(platform === "win32" ? [false, true, false, true] : [])
      expect(host.requests.at(-1)).toMatchObject({ type: "stop", killSignal: "SIGINT", graceMs: 0 })
      expect(result.live).toEqual([])
    }
  )
})
