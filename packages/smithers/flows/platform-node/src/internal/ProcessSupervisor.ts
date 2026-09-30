/**
 * Private parent connection for a POSIX process owner. Effect retains ownership
 * of the caller's streams; separate sockets carry requests and lifetime status.
 * @since 1.0.0
 */

import type { Lifecycle } from "@smthrs/kernel/ContainedSpawner"
import * as Channel from "effect/Channel"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ExitCode, makeHandle } from "effect/unstable/process/ChildProcessSpawner"
import { randomBytes } from "node:crypto"
import { chmodSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { createConnection, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import * as Tls from "node:tls"
import { standardFdsOf } from "./PipedProcess.ts"
import type { Policy, Snapshot, System } from "./ProcessCleanup.ts"
import { source } from "./SupervisorProgram.ts"
import { resolveJobExecutable, WindowsProcessJob } from "./WindowsProcessJob.ts"

const startupMs = 5000
const deliveryMs = 500
const exitAllowanceMs = 2500
// Host-wide process observations can exceed a socket-delivery deadline on a
// loaded machine. Keep verification bounded without mistaking that delay for
// an unclean exit; an unknown observation still never counts as success.
const verificationMs = 2500
const targets = new WeakMap<ChildProcessHandle, Control>()
// Native owners and sockets keep running when the caller freezes its Clock.
// Their delivery bounds and cleanup retries must keep running with them.
const processClock = Clock.Clock.defaultValue()

/**
 * Actual service pid, distinct from the owner recorded by the host.
 * @private
 * @since 1.0.0
 */
export const targetPidOf = (handle: ChildProcessHandle): number | undefined => targets.get(handle)?.targetPid

/** Native error fields remain data on the public PlatformError cause. */
const nativeError = (cause: unknown): Error & { code?: string; syscall?: string } => {
  if (cause instanceof Error) return cause
  const value = cause as { message?: string } | null
  return Object.assign(new Error(value?.message ?? "The process supervisor failed"), cause)
}

/**
 * Preserve the platform's errno and signal vocabulary across the private wire.
 * @private
 * @since 1.0.0
 */
export const failure = (method: string, command: string, cause: unknown): PlatformError.PlatformError => {
  const error = nativeError(cause)
  const tags: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
    ENOENT: "NotFound",
    EACCES: "PermissionDenied",
    EEXIST: "AlreadyExists",
    EISDIR: "BadResource",
    ENOTDIR: "BadResource",
    ELOOP: "BadResource",
    EBUSY: "Busy"
  }
  return PlatformError.systemError({
    _tag: tags[error.code ?? ""] ?? "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    syscall: error.syscall,
    description: error.message,
    cause: error
  })
}

/**
 * The observation behind an unverified cleanup, in the message itself: a
 * failure report usually shows only the message, and whether the receipt, the
 * kernel or the snapshot was missing decides host load versus a live survivor.
 * @private
 * @since 1.0.0
 */
export const unverifiedCleanup = (
  control: {
    readonly fault: unknown
    readonly cleanupFailed: boolean
    readonly cleanupAcknowledged: boolean
    readonly targetDone: boolean
  },
  cleanupRequired: boolean,
  vacant: boolean,
  observed: Snapshot | undefined
): string =>
  [
    `target exited: ${control.targetDone}`,
    `cleanup receipt: ${
      control.cleanupFailed
        ? "failed"
        : !cleanupRequired
        ? "not required"
        : control.cleanupAcknowledged
        ? "acknowledged"
        : "missing"
    }`,
    `group vacant: ${vacant}`,
    observed === undefined
      ? "group snapshot: unavailable"
      : `group members: ${
        observed.members.length === 0
          ? "none"
          : observed.members.map((member) => `${member.pid} ${member.zombie ? "zombie" : "live"}`).join(", ")
      }; host group ${observed.ownGroup}`,
    ...(control.fault === undefined
      ? []
      : [`fault: ${String((control.fault as { message?: unknown })?.message ?? control.fault)}`])
  ].join("; ")

const promise = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A status may arrive before its Effect consumer starts waiting.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

const wait = <A>(value: Promise<A>, method: string, command: string) =>
  Effect.tryPromise({ try: () => value, catch: (cause) => failure(method, command, cause) })

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, millis: number, method: string, command: string) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: millis,
      orElse: () => Effect.fail(failure(method, command, new Error(`Process supervisor ${method} timed out`)))
    }),
    Effect.provideService(Clock.Clock, processClock)
  )

/**
 * Standalone application executables do not implement the runtime's eval CLI.
 * Refuse them before spawning rather than recursively launching the application.
 * @private
 * @since 1.0.0
 */
export const bootstrapArguments = (runtime: { readonly bun: boolean; readonly main: string; readonly sea: boolean }) =>
  runtime.sea || runtime.main.startsWith("/$bunfs/")
    ? Effect.fail(
      failure(
        "spawn",
        process.execPath,
        new Error("Process supervision requires a Node or Bun runtime executable, not a compiled application")
      )
    )
    : Effect.succeed(runtime.bun ? ["--no-env-file", "--config=/dev/null"] : [])

const channelEnvironment = "SMITHERS_PROCESS_CHANNEL"
const tlsOptions = { minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphers: "TLS_AES_128_GCM_SHA256" } as const

/**
 * Connect an owner to its authenticated private channel.
 * @private
 * @since 1.0.0
 */
export const connectOwner = (path: string, environment: Readonly<Record<string, string | undefined>>): Socket => {
  const encoded = environment[channelEnvironment]
  if (encoded === undefined) return createConnection(path)
  const channel = JSON.parse(encoded) as { key: string; status: number; requests: number }
  return Tls.connect({
    ...tlsOptions,
    host: "127.0.0.1",
    port: path.endsWith("/r") ? channel.requests : channel.status,
    pskCallback: () => ({ identity: "smithers-owner", psk: Buffer.from(channel.key, "hex") })
  })
}

/**
 * Kept separate from Effect scopes so native socket callbacks only settle
 * promises; none can start an unowned fiber or signal an observed process id.
 * @private
 * @since 1.0.0
 */
export class Control {
  readonly ready = promise<number>()
  readonly started = promise<void>()
  readonly exited = promise<ExitCode>()
  readonly lost = promise<never>()
  readonly ended = promise<void>()
  readonly requestsReady = promise<void>()
  readonly directory: string
  readonly path: string
  readonly requestPath: string
  readonly server
  readonly requestServer
  readonly listening: Promise<void>
  private readonly key: Buffer | undefined
  private readonly connections = new Set<Socket>()
  socket: Socket | undefined
  requestSocket: Socket | undefined
  targetDone = false
  ownerCreation: unknown
  targetPid: number | undefined
  ownerDone = false
  spawnFailed = false
  cleanupFailed = false
  cleanupAcknowledged = false
  activationSent = false
  closeSent = false
  fault: unknown
  onTargetExit: () => void = () => {}
  onCleanup: () => void = () => {}
  private receivedReady = false
  private receivedStarted = false
  private withdrawn = false

  constructor(transport: "native" | "tls" = "native") {
    this.key = transport === "tls" || process.platform === "win32" ? randomBytes(32) : undefined
    this.directory = mkdtempSync(this.key === undefined ? "/tmp/sm-p-" : join(tmpdir(), "sm-p-"))
    this.path = `${this.directory}/s`
    this.requestPath = `${this.directory}/r`
    const servers: Array<ReturnType<typeof createServer>> = []
    try {
      chmodSync(this.directory, 0o700)
      this.server = this.makeServer((socket) => this.accept(socket))
      servers.push(this.server)
      this.requestServer = this.makeServer((socket) => this.acceptRequests(socket))
      servers.push(this.requestServer)
      this.listening = Promise.all([
        new Promise<void>((resolve, reject) => {
          this.server.once("error", reject)
          if (this.key === undefined) this.server.listen(this.path, resolve)
          else this.server.listen(0, "127.0.0.1", resolve)
        }),
        new Promise<void>((resolve, reject) => {
          this.requestServer.once("error", reject)
          if (this.key === undefined) this.requestServer.listen(this.requestPath, resolve)
          else this.requestServer.listen(0, "127.0.0.1", resolve)
        })
      ]).then(() => {})
    } catch (cause) {
      for (const server of servers) server.close()
      rmSync(this.directory, { recursive: true, force: true })
      throw cause
    }
  }

  private makeServer(accept: (socket: Socket) => void): ReturnType<typeof createServer> {
    if (this.key === undefined) return createServer(accept)
    const server = Tls.createServer({
      ...tlsOptions,
      handshakeTimeout: startupMs,
      pskCallback: (_socket, identity) => identity === "smithers-owner" ? this.key! : null
    }, accept)
    server.on("connection", (socket) => {
      this.connections.add(socket)
      socket.once("close", () => this.connections.delete(socket))
    })
    server.on("tlsClientError", (_error, socket) => socket.destroy())
    return server
  }

  /** Only the trusted owner receives this environment; target configuration replaces it. */
  environment(): Readonly<Record<string, string>> {
    if (this.key === undefined) return {}
    const status = this.server.address() as { port: number }
    const requests = this.requestServer.address() as { port: number }
    return {
      [channelEnvironment]: JSON.stringify({
        key: this.key.toString("hex"),
        status: status.port,
        requests: requests.port
      })
    }
  }

  /** The test peer uses the same authenticated transport as the isolated owner. */
  connect(requests = false): Socket {
    return connectOwner(requests ? this.requestPath : this.path, this.environment())
  }

  /** Validate the stored READY after the raw spawn effect has returned its pid. */
  withdraw(pid: number, actual: number): void {
    if (pid !== actual) throw new Error("Wrong supervisor identity")
    this.server.close()
    this.server.unref()
    this.requestServer.close()
    this.requestServer.unref()
    // Node may unlink the owned socket synchronously inside server.close().
    rmSync(this.path, { force: true })
    rmSync(this.requestPath, { force: true })
    rmdirSync(this.directory)
    this.withdrawn = true
  }

  /** Request EOF asks for cleanup; leave its independent status reader intact. */
  disconnect(): void {
    this.requestSocket?.destroy()
  }

  dispose(): void {
    for (const socket of this.connections) socket.destroy()
    this.disconnect()
    this.socket?.destroy()
    this.server.close()
    this.requestServer.close()
    if (!this.withdrawn) rmSync(this.directory, { recursive: true, force: true })
  }

  rawEnded(): void {
    this.ownerDone = true
    // An accepted socket may still have buffered status frames. Its close event
    // rejects missing outcomes only after Node has delivered those frames.
    if (this.socket === undefined) this.closed()
  }

  write(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.requestSocket
      if (socket === undefined || socket.destroyed || !socket.writable) {
        reject(new Error("Private process control channel closed"))
        return
      }
      const data = `${JSON.stringify(message)}\n`
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) {
        reject(new Error("Process configuration exceeds the private frame limit"))
        return
      }
      socket.write(data, (error) => error ? reject(error) : resolve())
    })
  }

  private closed(): void {
    this.disconnect()
    const cause = this.fault ?? new Error("Process supervisor closed before reporting its outcome")
    if (this.activationSent && !this.targetDone && !this.spawnFailed) this.lost.reject(cause)
    this.ready.reject(cause)
    this.requestsReady.reject(cause)
    this.started.reject(cause)
    this.exited.reject(cause)
    this.ended.resolve()
  }

  private acceptRequests(socket: Socket): void {
    if (this.requestSocket !== undefined) {
      socket.destroy()
      return
    }
    this.requestSocket = socket
    // A late write may fail after the owner has sent its last status frames.
    // Destroying this socket must never discard those frames on the reader.
    socket.on("error", (cause) => {
      this.fault = cause
    })
    this.requestsReady.resolve()
  }

  private accept(socket: Socket): void {
    if (this.socket !== undefined) {
      socket.destroy()
      return
    }
    this.socket = socket
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      try {
        buffer += data
        if (Buffer.byteLength(buffer) > 16 * 1024) throw new Error("Process status frame exceeds its limit")
        for (;;) {
          const end = buffer.indexOf("\n")
          if (end < 0) break
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          this.receive(JSON.parse(line))
        }
      } catch (cause) {
        this.fault = cause
        socket.destroy()
      }
    })
    socket.on("error", (cause) => {
      this.fault = cause
    })
    socket.once("close", () => this.closed())
  }

  private receive(value: unknown): void {
    if (typeof value !== "object" || value === null) throw new Error("Invalid process status")
    const message = value as Record<string, unknown>
    switch (message.type) {
      case "ready":
        if (
          this.receivedReady || message.version !== 1 || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 1
        ) {
          throw new Error("Invalid process readiness")
        }
        this.receivedReady = true
        this.ownerCreation = message.created
        this.ready.resolve(Number(message.pid))
        return
      case "spawned":
        if (
          !this.activationSent || this.receivedStarted || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 1
        ) {
          throw new Error("Invalid target startup")
        }
        this.receivedStarted = true
        this.targetPid = Number(message.pid)
        this.started.resolve()
        return
      case "spawn_error":
        if (!this.activationSent || this.receivedStarted) throw new Error("Invalid target spawn failure")
        this.spawnFailed = true
        this.fault = message
        this.started.reject(message)
        this.exited.reject(message)
        return
      case "fault":
        this.fault = message
        this.started.reject(message)
        this.exited.reject(message)
        return
      case "exit":
        if (
          !this.receivedStarted || this.targetDone ||
          !(Number.isInteger(message.code) && Number(message.code) >= 0 && message.signal === null ||
            message.code === null && typeof message.signal === "string" && /^SIG[A-Z0-9]+$/.test(message.signal))
        ) {
          throw new Error("Invalid target exit status")
        }
        this.targetDone = true
        if (message.code === null) {
          this.exited.reject({
            message: `Process interrupted due to receipt of signal: '${message.signal}'`,
            signal: message.signal
          })
        } else this.exited.resolve(ExitCode(Number(message.code)))
        this.onTargetExit()
        return
      case "cleanup_error":
        this.cleanupFailed = true
        this.fault = message
        return
      case "cleanup":
        this.cleanupAcknowledged = true
        this.onCleanup()
        return
      default:
        throw new Error("Unknown process status")
    }
  }
}

/**
 * Prepare a private, independently bounded process owner before target launch.
 * @private
 * @since 1.0.0
 */
export const prepare = (
  system: System,
  policy: (
    options: ChildProcess.KillOptions,
    defaults?: ChildProcess.KillOptions
  ) => Effect.Effect<Policy, PlatformError.PlatformError>,
  transport: "native" | "tls" = "native"
): Lifecycle =>
(command, spawn) =>
  Effect.gen(function*() {
    const initial = yield* policy(command.options)
    const bun = process.versions.bun !== undefined
    const sea = bun ? false : (yield* Effect.tryPromise({
      try: () => import("node:sea"),
      catch: (cause) => failure("spawn", process.execPath, cause)
    })).isSea()
    const bootstrap = yield* bootstrapArguments({
      bun,
      sea,
      main: (globalThis as { readonly Bun?: { readonly main?: string } }).Bun?.main ?? ""
    })
    const windows = system.platform === "win32"
    const grouped = !windows && (command.options.detached ?? true)
    const jobExecutable = windows ?
      yield* Effect.try({
        try: resolveJobExecutable,
        catch: (cause) => failure("spawn", command.command, cause)
      }) :
      undefined
    const control = yield* Effect.acquireRelease(
      Effect.try({ try: () => new Control(transport), catch: (cause) => failure("spawn", command.command, cause) }),
      (control) => Effect.sync(() => control.dispose())
    )
    yield* bounded(wait(control.listening, "spawn", command.command), startupMs, "spawn", command.command)
    const raw = yield* spawn(ChildProcess.make(process.execPath, [
      ...bootstrap,
      "-e",
      source,
      control.path,
      grouped ? "group" : "direct"
    ], {
      ...command.options,
      cwd: parse(process.execPath).root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/",
        XDG_CONFIG_HOME: "/",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...control.environment(),
        ...(jobExecutable === undefined ? {} : { SMITHERS_PROCESS_JOB_HELPER: jobExecutable })
      },
      extendEnv: false,
      shell: false,
      detached: grouped,
      killSignal: "SIGTERM",
      forceKillAfter: initial.graceMs
    }))
    yield* Effect.exit(raw.exitCode).pipe(Effect.andThen(Effect.sync(() => control.rawEnded())), Effect.forkScoped)
    let job: WindowsProcessJob | undefined
    let settled = false
    let referenced = true
    let reref: Effect.Effect<void, PlatformError.PlatformError> = Effect.void
    let selected = initial
    let requireCleanupReceipt = false
    const snapshot = () => system.snapshot(raw.pid)
    const alone = () => {
      if (!grouped) return control.targetDone
      const observed = snapshot()
      if (observed === undefined || observed.ownGroup === raw.pid) return false
      const running = observed.members.filter((member) => !member.zombie)
      return running.length === 1 && running[0]!.pid === raw.pid
    }
    // This observation only shortens the owner's deadline. The live owner makes
    // the signal, so neither a stale observation nor a reused pid grants a kill.
    control.onTargetExit = () => {
      // An explicit stop already owns its deadline and escaped-child sweep.
      // Natural exit must not replace that policy with a second fast stop.
      if (control.closeSent) return
      if (!alone()) return
      control.closeSent = true
      void control.write({ type: "stop", killSignal: "SIGKILL", fast: true }).catch(() => control.disconnect())
    }
    const finish = yield* Effect.cached(Effect.gen(function*() {
      yield* bounded(Effect.exit(raw.exitCode), selected.graceMs + exitAllowanceMs, "kill", command.command).pipe(
        Effect.catch((cause) =>
          job === undefined ? Effect.fail(cause) : Effect.gen(function*() {
            // The native guardian can terminate a stalled owner independently.
            job!.stop()
            yield* bounded(Effect.exit(raw.exitCode), exitAllowanceMs, "kill", command.command)
          })
        )
      )
      if (job !== undefined) {
        yield* bounded(wait(job.settled.promise, "kill", command.command), 5500, "kill", command.command)
        settled = true
        return
      }
      yield* bounded(wait(control.ended.promise, "kill", command.command), deliveryMs, "kill", command.command).pipe(
        Effect.ignore
      )
      const deadline = Date.now() + verificationMs
      for (;;) {
        // The kernel's ESRCH proves the group empty with no fork. A `ps`
        // snapshot can go unanswered on a loaded host, so it only decides what
        // the kernel cannot: a group still holding zombies, or an unknown one.
        // A live member keeps both answers false. This host is alive, so a
        // vacant group is never this host's own group.
        const vacant = grouped && system.vacant(raw.pid)
        const observed = grouped && !vacant ? snapshot() : undefined
        settled = !control.cleanupFailed && (!requireCleanupReceipt || control.cleanupAcknowledged) && (grouped
          ? vacant ||
            observed !== undefined && observed.ownGroup !== raw.pid && observed.members.every((member) => member.zombie)
          : control.targetDone || control.spawnFailed || !control.activationSent)
        if (settled) return
        if (Date.now() >= deadline) {
          return yield* Effect.fail(
            failure(
              "kill",
              command.command,
              new Error(
                "Process cleanup could not be verified; its ledger record is retained " +
                  `(${unverifiedCleanup(control, requireCleanupReceipt, vacant, observed)})`,
                {
                  cause: {
                    fault: control.fault,
                    cleanupFailed: control.cleanupFailed,
                    cleanupRequired: requireCleanupReceipt,
                    cleanupAcknowledged: control.cleanupAcknowledged,
                    targetDone: control.targetDone,
                    groupVacant: vacant,
                    ownerObserved: observed !== undefined,
                    members: observed?.members
                  }
                }
              )
            )
          )
        }
        yield* Effect.sleep(10).pipe(Effect.provideService(Clock.Clock, processClock))
      }
    }))
    const kill = (options: ChildProcess.KillOptions = {}) =>
      Effect.gen(function*() {
        const requested = yield* policy(options, command.options)
        if (!referenced) {
          job?.reference(true)
          control.socket?.ref()
          control.requestSocket?.ref()
          yield* reref
          referenced = true
        }
        if (!control.closeSent) {
          control.closeSent = true
          selected = requested
          // An empty original group cannot prove an explicit escaped-descendant
          // sweep succeeded if its status frames were lost. Startup and natural
          // completion have no such additional contract.
          requireCleanupReceipt = grouped && control.activationSent && !control.spawnFailed && !control.targetDone
          yield* bounded(
            wait(
              control.write({
                type: "stop",
                explicit: true,
                ...requested,
                // A live target can move out of this group with setsid().
                // Only an owner whose target was never activated can replace
                // the requested signal; natural exit has its own fast path.
                killSignal: !control.activationSent && alone() ? "SIGKILL" : requested.killSignal
              }),
              "kill",
              command.command
            ),
            deliveryMs,
            "kill",
            command.command
          )
            .pipe(Effect.catch(() => Effect.sync(() => control.disconnect())))
        }
        yield* finish
      }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() =>
      kill().pipe(
        // A stuck owner keeps its ledger entry. Disable the underlying spawner's
        // unconditional group-kill finalizer rather than signal a stale identity.
        Effect.ensuring(
          Effect.suspend(() =>
            settled ? Effect.void : Effect.andThen(
              raw.unref,
              Effect.sync(() => {
                job?.stop()
                job?.reference(false)
                control.disconnect()
              })
            )
          ).pipe(Effect.orDie)
        ),
        Effect.orDie
      )
    )
    const ready = yield* bounded(
      wait(control.ready.promise, "spawn", command.command),
      startupMs,
      "spawn",
      command.command
    )
    yield* bounded(wait(control.requestsReady.promise, "spawn", command.command), startupMs, "spawn", command.command)
    yield* Effect.try({
      try: () => control.withdraw(ready, raw.pid),
      catch: (cause) => failure("spawn", command.command, cause)
    })
    if (windows) {
      job = yield* Effect.try({
        try: () => new WindowsProcessJob(raw.pid, control.ownerCreation, jobExecutable!),
        catch: (cause) => failure("spawn", command.command, cause)
      })
      yield* bounded(wait(job.ready.promise, "spawn", command.command), startupMs, "spawn", command.command)
    }
    const acknowledgeCleanup = windows || transport === "tls"
    if (acknowledgeCleanup) {
      control.onCleanup = () => {
        if (!control.ownerDone) {
          void control.write({ type: "cleanup_ack" }).catch(() => control.disconnect())
        }
      }
    }
    const options = command.options
    // Match Effect/Node's undefined-vs-empty environment semantics in the host,
    // before replacing the helper's environment with its isolated bootstrap.
    const env = options.extendEnv ? { ...process.env, ...options.env } : options.env ?? { ...process.env }
    yield* bounded(
      wait(
        control.write({
          type: "configure",
          acknowledgeCleanup,
          command: command.command,
          args: command.args,
          cwd: resolve(options.cwd ?? process.cwd()),
          env,
          shell: options.shell,
          windowsHide: options.windowsHide ?? true,
          windowsVerbatimArguments:
            (options as ChildProcess.CommandOptions & { readonly windowsVerbatimArguments?: boolean })
              .windowsVerbatimArguments,
          standardFds: standardFdsOf(raw),
          userFds: [
            ...new Set(
              Object.keys(options.additionalFds ?? {}).map(ChildProcess.parseFdName)
                .filter((fd): fd is number => fd !== undefined)
            )
          ],
          ...initial
        }),
        "spawn",
        command.command
      ),
      deliveryMs,
      "spawn",
      command.command
    )
    const activate = yield* Effect.cached(Effect.gen(function*() {
      control.activationSent = true
      yield* bounded(
        wait(control.write({ type: "start" }), "spawn", command.command),
        deliveryMs,
        "spawn",
        command.command
      )
      yield* bounded(wait(control.started.promise, "spawn", command.command), startupMs, "spawn", command.command)
    }))
    const unref = Effect.gen(function*() {
      if (referenced) {
        reref = yield* raw.unref
        job?.reference(false)
        control.socket?.unref()
        control.requestSocket?.unref()
        referenced = false
      }
      return Effect.gen(function*() {
        if (!referenced) {
          job?.reference(true)
          control.socket?.ref()
          control.requestSocket?.ref()
          yield* reref
          referenced = true
        }
      })
    })
    const output = <A>(stream: Stream.Stream<A, PlatformError.PlatformError>) =>
      stream.pipe(
        Stream.interruptWhen(wait(control.lost.promise, "read", command.command))
      )
    const input = <A>(sink: Sink.Sink<A, Uint8Array, never, PlatformError.PlatformError>) =>
      Sink.fromChannel(
        Sink.toChannel(sink).pipe(Channel.interruptWhen(wait(control.lost.promise, "write", command.command)))
      )
    const handle = makeHandle({
      ...raw,
      exitCode: wait(control.exited.promise, "exitCode", command.command),
      isRunning: Effect.sync(() => !control.targetDone && !control.ownerDone),
      stdin: input(raw.stdin),
      getInputFd: (fd) => input(raw.getInputFd(fd)),
      stdout: output(raw.stdout),
      stderr: output(raw.stderr),
      all: output(raw.all),
      getOutputFd: (fd) => output(raw.getOutputFd(fd)),
      kill,
      unref
    })
    targets.set(handle, control)
    return {
      handle,
      activate,
      settled: Effect.sync(() => settled)
    }
  })
