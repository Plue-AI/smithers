import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Logger, References, Stream } from "effect"
import { type ChildProcess as NodeChild, spawn } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { elapsed } from "../src/internal/deadline.ts"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import type { Sdk } from "../src/MicrosandboxSandbox/Sdk.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../src/Sandbox/Provider.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const encoder = new TextEncoder()

type Builder = ReturnType<Sdk["Sandbox"]["builder"]>
type VendorSandbox = Awaited<ReturnType<Builder["create"]>>
type VendorHandle = Awaited<ReturnType<Sdk["Sandbox"]["get"]>>
type ExecBuilder = Parameters<Parameters<VendorSandbox["execStreamWith"]>[1]>[0]
type ExecHandle = Awaited<ReturnType<VendorSandbox["execStreamWith"]>>
type ExecEvent = NonNullable<Awaited<ReturnType<ExecHandle["recv"]>>>
type ListBuilder = Parameters<Parameters<Sdk["Sandbox"]["listWith"]>[0]>[0]

// -----------------------------------------------------------------------------
// The Microsandbox SDK as a fake: real processes and real files behind the
// vendor's builders, handles, and streaming command events.
// -----------------------------------------------------------------------------

// The fake emulates only the vendor transport: the fluent builders, lifecycle
// handles, label listing, and the streaming command handle record what the SDK
// would carry, and underneath every command is a REAL process running against
// a REAL directory, every guest file a real file. Each command leads its own
// process group, the way the guest agent runs an exec, so the handle's
// `signal` reaches the group and nothing outside it. Guest-fixed absolute
// paths — the default `/workspace`, the image's `/etc/hostname` — live under
// the machine's own directory on this host.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-msb-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

interface LiveExec {
  readonly child: NodeChild
  /** The guest went away: the stream ends without an exit event. */
  readonly lose: () => void
}

interface Machine {
  readonly name: string
  /** The real directory guest-fixed absolute paths live under on this host. */
  readonly root: string
  readonly ephemeral: boolean
  readonly backendKind: "local" | "cloud"
  /**
   * The test-root directory the provider prepared as this machine's
   * workspace. It stands in for the guest's own workspace, so it goes with
   * the machine.
   */
  workspace: string | undefined
  labels: Record<string, string>
  status: "running" | "stopped" | "crashed"
  /** The guest stopped answering while the machine is still recorded as running, until it is stopped or started. */
  wedged?: boolean
  readonly live: Set<LiveExec>
}

interface ExecCall {
  readonly name: string
  readonly shell: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin: Uint8Array | undefined
}

interface Recorded {
  readonly stops: Array<string>
  readonly builds: Array<{ readonly name: string; readonly settings: Record<string, unknown> }>
  readonly execs: Array<ExecCall>
  readonly mkdirs: Array<string>
  readonly destroys: Array<{ readonly name: string; readonly timeoutMs: number; readonly force?: boolean }>
  readonly connects: Array<string>
  readonly starts: Array<{ readonly name: string; readonly detached: boolean }>
  readonly modifies: Array<{ readonly name: string; readonly labels: Record<string, string>; readonly policy: string }>
  readonly signals: Array<{ readonly name: string; readonly signal: number }>
  readonly handleKills: Array<string>
  readonly lists: Array<{ readonly labels: Record<string, string>; readonly cursor: string | undefined }>
  readonly backends: Array<string>
}

interface Controls {
  readonly createFailure?: (() => unknown) | undefined
  /** Rejects a removal; `force` tells the graceful attempt from the forced one. */
  readonly destroyFailure?: ((name: string, force: boolean) => unknown) | undefined
  readonly pingFailure?: Error | undefined
  readonly readFailure?: (() => unknown) | undefined
  readonly defaultBackend?: (() => "local" | "cloud") | undefined
  readonly machineBackend?: "local" | "cloud" | undefined
  readonly modifyApplied?: boolean | undefined
  readonly modifyFailure?: (() => unknown) | undefined
  /** Rejects `execStreamWith` for a matching command line. */
  readonly execFailure?: ((line: string) => unknown) | undefined
  /** Holds `execStreamWith` open until the gate resolves, for a matching command line. */
  readonly startGate?: ((line: string) => Promise<void> | undefined) | undefined
  /** Delays the `started` event of a matching command line. */
  readonly startedDelayMs?: ((line: string) => number | undefined) | undefined
  /** Delays the `exited` event of a matching command line after its process closes. */
  readonly exitedDelayMs?: ((line: string) => number | undefined) | undefined
  /** Ends a matching command's stream right after it starts, without an exit event. */
  readonly loseOn?: ((line: string) => boolean) | undefined
  /** Rejects the handle's `signal` for a matching command line. */
  readonly signalFailure?: ((line: string) => unknown) | undefined
  /** Rejects the handle's `kill` for a matching command line, which then keeps running. */
  readonly killFailure?: ((line: string) => unknown) | undefined
  /** Rejects `recv` right after a matching command starts. */
  readonly recvFailure?: ((line: string) => unknown) | undefined
  readonly listPageSize?: number | undefined
  readonly listFailure?: (() => unknown) | undefined
  readonly refreshFailure?: ((name: string) => unknown) | undefined
  readonly configJson?: ((name: string) => string | undefined) | undefined
  readonly snapshotFailure?: ((name: string) => unknown) | undefined
  readonly snapshotReadFailure?: (() => unknown) | undefined
  readonly startFailure?: (() => unknown) | undefined
  readonly connectFailure?: (() => unknown) | undefined
  readonly stopFailure?: (() => unknown) | undefined
}

/** Every guest filesystem failure arrives as the SDK's one fs error kind. */
const fsFailure = (cause: unknown): Error => {
  const code = Reflect.get(Object(cause), "code")
  return Object.assign(
    new Error(
      code === "ENOENT"
        ? "sandbox fs error: open: No such file or directory (os error 2)"
        : `sandbox fs error: ${cause instanceof Error ? cause.message : String(cause)}`
    ),
    { code: "sandboxFsOps" }
  )
}

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** What the vendor says when a machine's guest agent is gone. */
const agentGone = (name: string): Error =>
  coded(
    "custom",
    `GenericFailure [AgentClient] agent client error: connect /run/agent/${name}.sock: Connection refused (os error 61)`
  )

/**
 * One command's event stream: buffered until received, closed by `null`.
 * `undefined` is what the vendor hands back for the guest's report that the
 * command could not start.
 */
const eventChannel = () => {
  const buffered: Array<ExecEvent | null | undefined> = []
  const waiting: Array<(event: ExecEvent | null | undefined) => void> = []
  let closed = false
  return {
    push: (event: ExecEvent | null | undefined): void => {
      if (closed) return
      if (event === null) closed = true
      const waiter = waiting.shift()
      if (waiter === undefined) buffered.push(event)
      else waiter(event)
    },
    next: (): Promise<ExecEvent | null | undefined> => {
      if (buffered.length > 0) return Promise.resolve(buffered.shift()!)
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => waiting.push(resolve))
    }
  }
}

const signalGroup = (child: NodeChild, signal: number): void => {
  process.kill(-child.pid!, signal)
}

const fakeSdk = (controls: Controls = {}) => {
  const machines = new Map<string, Machine>()
  const snapshots = new Map<
    string,
    { readonly name: string; readonly createdAt: Date; readonly source: string; readonly disk?: string }
  >()
  const recorded: Recorded = {
    stops: [],
    builds: [],
    execs: [],
    mkdirs: [],
    destroys: [],
    connects: [],
    starts: [],
    modifies: [],
    signals: [],
    handleKills: [],
    lists: [],
    backends: []
  }

  const machineAt = (name: string): Machine => {
    const machine = machines.get(name)
    if (machine === undefined) throw coded("sandboxNotFound", `sandbox not found: ${name}`)
    return machine
  }

  // A guest path the test placed under its own root is that real path; any
  // other absolute guest path is a guest-fixed location backed by a real file
  // under the machine's directory.
  const hostPath = (machine: Machine, path: string): string =>
    path === root || path.startsWith(`${root}/`) ? path : join(machine.root, path)

  const realFs = <A>(body: () => A): A => {
    try {
      return body()
    } catch (cause) {
      throw fsFailure(cause)
    }
  }

  const exec = async (machine: Machine, call: ExecCall): Promise<ExecHandle> => {
    const line = [call.shell, ...call.args].join(" ")
    const failed = controls.execFailure?.(line)
    if (failed !== undefined) throw failed
    await controls.startGate?.(line)
    const events = eventChannel()
    const child = spawn(call.shell, [...call.args], {
      cwd: hostPath(machine, call.cwd),
      env: { ...process.env, ...call.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
    child.stdin!.on("error", () => undefined)
    // A program or working directory the guest does not have: the guest agent
    // reports a failed start instead of a started process, and the stream ends.
    child.on("error", () => {
      machine.live.delete(live)
      events.push(undefined)
      events.push(null)
    })
    child.stdin!.end(Buffer.from(call.stdin ?? new Uint8Array()))
    const live: LiveExec = {
      child,
      lose: () => {
        machine.live.delete(live)
        events.push(null)
        try {
          signalGroup(child, 9)
        } catch {
          // Already gone with the guest.
        }
      }
    }
    machine.live.add(live)
    const delay = controls.startedDelayMs?.(line)
    const started = () => {
      if (child.pid !== undefined) events.push({ kind: "started", pid: child.pid })
    }
    if (delay === undefined) started()
    else setTimeout(started, delay)
    child.stdout!.on("data", (data: Buffer) => events.push({ kind: "stdout", data: new Uint8Array(data) }))
    child.stderr!.on("data", (data: Buffer) => events.push({ kind: "stderr", data: new Uint8Array(data) }))
    const exitedDelay = controls.exitedDelayMs?.(line)
    child.on("close", (code) => {
      const exited = () => {
        machine.live.delete(live)
        events.push({ kind: "exited", code: code ?? -1 })
        events.push(null)
      }
      if (exitedDelay === undefined) exited()
      else setTimeout(exited, exitedDelay)
    })
    if (controls.loseOn?.(line) === true) live.lose()
    const recvFailure = controls.recvFailure?.(line)
    return {
      recv: () => recvFailure === undefined ? events.next() : Promise.reject(recvFailure),
      signal: async (signal) => {
        recorded.signals.push({ name: machine.name, signal })
        const refused = controls.signalFailure?.(line)
        if (refused !== undefined) throw refused
        signalGroup(child, signal)
      },
      kill: async () => {
        recorded.handleKills.push(line)
        const refused = controls.killFailure?.(line)
        if (refused !== undefined) throw refused
        signalGroup(child, 9)
      }
    }
  }

  const remove = (machine: Machine): void => {
    machine.status = "stopped"
    for (const live of [...machine.live]) live.lose()
    machines.delete(machine.name)
    rmSync(machine.root, { recursive: true, force: true })
    // A workspace under a regular file was never created, and rmSync's
    // `force` only forgives ENOENT, not the ENOTDIR that path raises.
    if (machine.workspace !== undefined && existsSync(machine.workspace)) {
      rmSync(machine.workspace, { recursive: true, force: true })
    }
  }

  const destroy = async (
    machine: Machine,
    options: { readonly timeoutMs: number; readonly force?: boolean }
  ): Promise<void> => {
    const force = options.force === true
    recorded.destroys.push({ name: machine.name, timeoutMs: options.timeoutMs, ...force ? { force } : {} })
    if (!machines.has(machine.name)) throw coded("sandboxNotFound", `sandbox not found: ${machine.name}`)
    const failed = controls.destroyFailure?.(machine.name, force)
    if (failed !== undefined) throw failed
    remove(machine)
  }

  const answering = (machine: Machine): void => {
    if (machine.wedged === true) throw agentGone(machine.name)
  }

  const sandboxFor = (machine: Machine): VendorSandbox => ({
    name: machine.name,
    backendKind: machine.backendKind,
    fs: () => ({
      write: async (path, data) => {
        answering(machine)
        const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
        realFs(() => writeFileSync(hostPath(machine, path), bytes))
      },
      read: async (path) => {
        answering(machine)
        if (controls.readFailure !== undefined) throw controls.readFailure()
        return realFs(() => new Uint8Array(readFileSync(hostPath(machine, path))))
      },
      readToString: async (path) => {
        if (controls.pingFailure !== undefined) throw controls.pingFailure
        return realFs(() => readFileSync(hostPath(machine, path), "utf8"))
      },
      mkdir: async (path) => {
        answering(machine)
        recorded.mkdirs.push(path)
        // The provider's first mkdir prepares its workspace; the test root
        // itself is shared by every machine and never belongs to one.
        if (machine.workspace === undefined && path.startsWith(`${root}/`)) machine.workspace = path
        realFs(() => mkdirSync(hostPath(machine, path), { recursive: true }))
      }
    }),
    execStreamWith: async (shell, configure) => {
      answering(machine)
      if (machine.status !== "running") {
        throw coded("sandboxNotRunning", `[SandboxNotRunning] microVM ${machine.name} is ${machine.status}`)
      }
      let args: Array<string> = []
      let cwd = ""
      let env: Record<string, string> = {}
      let stdin: Uint8Array | undefined
      const builder: ExecBuilder = {
        args(value) {
          args = [...value]
          return this
        },
        cwd(value) {
          cwd = value
          return this
        },
        envs(value) {
          env = { ...value }
          return this
        },
        stdinBytes(value) {
          stdin = new Uint8Array(value)
          return this
        }
      }
      configure(builder)
      const call: ExecCall = { name: machine.name, shell, args, cwd, env, stdin }
      recorded.execs.push(call)
      return await exec(machine, call)
    },
    destroy: (options) => destroy(machine, options)
  })

  const handleFor = (machine: Machine): VendorHandle => ({
    name: machine.name,
    status: machine.status,
    configJson: controls.configJson?.(machine.name) ?? JSON.stringify({ name: machine.name, labels: machine.labels }),
    connect: async () => {
      if (machine.status !== "running") throw new Error(`microVM ${machine.name} is stopped`)
      const refused = controls.connectFailure?.()
      if (refused !== undefined) throw refused
      recorded.connects.push(machine.name)
      return sandboxFor(machine)
    },
    start: async () => {
      if (controls.startFailure !== undefined) throw controls.startFailure()
      machine.status = "running"
      machine.wedged = false
      recorded.starts.push({ name: machine.name, detached: false })
      return sandboxFor(machine)
    },
    startDetached: async () => {
      if (controls.startFailure !== undefined) throw controls.startFailure()
      machine.status = "running"
      machine.wedged = false
      recorded.starts.push({ name: machine.name, detached: true })
      return sandboxFor(machine)
    },
    refresh: async () => {
      const failed = controls.refreshFailure?.(machine.name)
      if (failed !== undefined) throw failed
      return handleFor(machineAt(machine.name))
    },
    modify: async ({ labels, policy }) => {
      recorded.modifies.push({ name: machine.name, labels: { ...labels }, policy })
      if (controls.modifyFailure !== undefined) throw controls.modifyFailure()
      if (controls.modifyApplied === false) return { applied: false }
      machine.labels = { ...machine.labels, ...labels }
      return { applied: true }
    },
    stop: async () => {
      recorded.stops.push(machine.name)
      if (controls.stopFailure !== undefined) throw controls.stopFailure()
      machine.status = "stopped"
      machine.wedged = false
    },
    snapshot: async (name) => {
      const failed = controls.snapshotFailure?.(name)
      if (failed !== undefined) throw failed
      // The snapshot is the machine's whole disk: a real copy of its directory.
      const disk = join(root, "snapshots", name)
      cpSync(machine.root, disk, { recursive: true })
      snapshots.set(name, { name, createdAt: new Date(Date.now() + snapshots.size), source: machine.name, disk })
    },
    destroy: (options) => destroy(machine, options)
  })

  const snapshotEntry = (entry: { readonly name: string; readonly createdAt: Date }) => ({
    name: entry.name,
    createdAt: entry.createdAt
  })

  const sdk: Sdk = {
    Snapshot: {
      get: async (name) => {
        const failed = controls.snapshotReadFailure?.()
        if (failed !== undefined) throw failed
        const entry = snapshots.get(name)
        if (entry === undefined) throw new Error(`GenericFailure [SnapshotNotFound] snapshot not found: ${name}`)
        return snapshotEntry(entry)
      },
      list: async () => [...[...snapshots.values()].map(snapshotEntry), { name: null, createdAt: new Date(0) }],
      remove: async (name) => {
        if (!snapshots.delete(name)) throw new Error(`GenericFailure [SnapshotNotFound] snapshot not found: ${name}`)
      }
    },
    Sandbox: {
      builder: (name) => {
        const settings: Record<string, unknown> = {}
        const builder: Builder = {
          image(value) {
            settings["image"] = value
            return this
          },
          fromSnapshot(value) {
            settings["snapshot"] = value
            return this
          },
          cpus(value) {
            settings["cpus"] = value
            return this
          },
          maxCpus(value) {
            settings["maxCpus"] = value
            return this
          },
          memory(value) {
            settings["memory"] = value
            return this
          },
          maxMemory(value) {
            settings["maxMemory"] = value
            return this
          },
          security(value) {
            settings["security"] = value
            return this
          },
          pullPolicy(value) {
            settings["pullPolicy"] = value
            return this
          },
          labels(value) {
            settings["labels"] = { ...value }
            return this
          },
          scripts(value) {
            settings["scripts"] = { ...value }
            return this
          },
          maxDuration(value) {
            settings["maxDuration"] = value
            return this
          },
          idleTimeout(value) {
            settings["idleTimeout"] = value
            return this
          },
          ephemeral(value) {
            settings["ephemeral"] = value
            return this
          },
          detached(value) {
            settings["detached"] = value
            return this
          },
          disableNetwork() {
            settings["disableNetwork"] = true
            return this
          },
          rootDisk(value) {
            settings["rootDisk"] = value
            return this
          },
          network(configure) {
            configure({
              policy(value) {
                settings["networkPolicy"] = value
                return this
              }
            })
            return this
          },
          create: async () => {
            recorded.builds.push({ name, settings: { ...settings } })
            const refused = controls.createFailure?.()
            if (refused !== undefined) throw refused
            if (machines.has(name)) throw coded("sandboxAlreadyExists", `sandbox ${name} already exists`)
            const machine: Machine = {
              name,
              root: join(root, "machines", name),
              ephemeral: settings["ephemeral"] === true,
              backendKind: controls.machineBackend ?? "local",
              workspace: undefined,
              labels: { ...(settings["labels"] as Record<string, string>) },
              status: "running",
              live: new Set()
            }
            // A machine booted from a snapshot starts with the captured disk.
            const disk = snapshots.get(String(settings["snapshot"]))?.disk
            if (disk !== undefined) cpSync(disk, machine.root, { recursive: true })
            // The image ships a hostname; the fake machine really holds one.
            mkdirSync(join(machine.root, "etc"), { recursive: true })
            writeFileSync(join(machine.root, "etc", "hostname"), name)
            machines.set(name, machine)
            return sandboxFor(machine)
          }
        }
        return builder
      },
      get: async (name) => handleFor(machineAt(name)),
      listWith: async (configure) => {
        const labels: Record<string, string> = {}
        let cursor: string | undefined
        const list: ListBuilder = {
          label(key, value) {
            labels[key] = value
            return this
          },
          cursor(value) {
            cursor = value
            return this
          }
        }
        configure(list)
        recorded.lists.push({ labels: { ...labels }, cursor })
        if (controls.listFailure !== undefined) throw controls.listFailure()
        const matching = [...machines.values()]
          .filter((machine) => Object.entries(labels).every(([key, value]) => machine.labels[key] === value))
          .map(handleFor)
        const size = controls.listPageSize ?? matching.length
        const from = cursor === undefined ? 0 : Number(cursor)
        const next = from + size
        return {
          sandboxes: matching.slice(from, next),
          ...next < matching.length ? { nextCursor: String(next) } : {}
        }
      }
    },
    defaultBackendKind: () => controls.defaultBackend?.() ?? "local",
    setDefaultBackend: (backend) => {
      recorded.backends.push(backend)
    }
  }

  return {
    sdk,
    recorded,
    machines,
    snapshots,
    markStopped: (name: string): void => {
      machineAt(name).status = "stopped"
    },
    breakHostname: (name: string): void => {
      rmSync(join(machineAt(name).root, "etc", "hostname"), { force: true })
    },
    machineRoot: (name: string): string => machineAt(name).root,
    /** The machine dies: every running command's stream ends without an exit, and nothing new starts. */
    loseGuest: (name: string): void => {
      const machine = machineAt(name)
      machine.status = "crashed"
      for (const live of [...machine.live]) live.lose()
    },
    /** The guest stops answering, the machine still recorded as running. */
    wedge: (name: string): void => {
      machineAt(name).wedged = true
    },
    /** A machine some earlier process created and labelled. */
    plant: (name: string, labels: Record<string, string>, status: Machine["status"] = "running"): void => {
      const machine: Machine = {
        name,
        root: join(root, "machines", name),
        ephemeral: false,
        backendKind: "local",
        workspace: undefined,
        labels,
        status,
        live: new Set()
      }
      mkdirSync(join(machine.root, "etc"), { recursive: true })
      writeFileSync(join(machine.root, "etc", "hostname"), name)
      machines.set(name, machine)
    }
  }
}

const inSession = <A, E>(
  provider: Provider,
  key: string,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(key), body))

const output = (process: RemoteProcess) =>
  Effect.all(
    [
      Stream.mkString(Stream.decodeText(process.stdout)),
      Stream.mkString(Stream.decodeText(process.stderr)),
      process.exitCode
    ],
    { concurrency: "unbounded" }
  )

const sizeOf = (path: string): number => existsSync(path) ? statSync(path).size : 0

/** Whether a file stopped growing: two reads a quarter second apart agree. */
const settled = (path: string) =>
  Effect.gen(function*() {
    const before = sizeOf(path)
    yield* elapsed(250)
    return sizeOf(path) === before
  })

const ownership = (owner: string, holder: string) => ({
  "smithers.provider": "microsandbox",
  "smithers.owner": owner,
  "smithers.holder": holder
})

describe("MicrosandboxSandbox", () => {
  it.effect("keeps vendor credentials out of health messages and debug logs", () =>
    Effect.gen(function*() {
      const secret = "HEALTH_CANARY_CREDENTIAL"
      const cause = new Error(`request failed token=${secret}`)
      const fake = fakeSdk({ pingFailure: cause })
      const lines: Array<string> = []
      const keep = (line: string) => {
        lines.push(line)
      }
      yield* inSession(MicrosandboxSandbox.make({ sdk: fake.sdk }), "safe-health", (session) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(session.ping!)
          expect(error.cause).toBe(cause)
          const state = yield* SandboxHealth.probe({ ping: session.ping! }).pipe(
            Effect.provide(Logger.layer([Logger.map(Logger.formatJson, keep), Logger.map(Logger.formatLogFmt, keep)])),
            Effect.provideService(References.MinimumLogLevel, "Debug")
          )
          expect(state._tag).toBe("Unhealthy")
          expect(JSON.stringify(state)).not.toContain(secret)
          expect(error.message).not.toContain(secret)
          expect(error.message).toContain("did not answer")
          expect(lines).toHaveLength(2)
          for (const line of lines) {
            expect(line).toContain("sandbox ping failed")
            expect(line).not.toContain(secret)
          }
        }))
    }))

  it.effect("serves exclusive creation and modes through guest commands", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "files-ws")
      yield* inSession(MicrosandboxSandbox.make({ sdk: fake.sdk, workdir }), "files", (session) =>
        Effect.gen(function*() {
          const files = session.files!
          // A plain overwrite keeps the SDK's byte-typed write.
          yield* files.writeFile!(`${workdir}/plain.txt`, encoder.encode("plain"))
          expect(readFileSync(join(workdir, "plain.txt"), "utf8")).toBe("plain")
          // The guest scripts use GNU and BusyBox flags (`ln -T`, `chmod --`)
          // this host's BSD tools may lack, so only their carriage is
          // asserted here; the real microVM test proves the outcomes.
          yield* Effect.exit(files.chmod!(`${workdir}/plain.txt`, 0o640))
          expect(fake.recorded.execs.at(-1)!.args.at(-1)).toContain("chmod 640 --")
          yield* Effect.exit(
            files.writeFile!(`${workdir}/fresh.txt`, encoder.encode("fresh"), { flag: "wx", mode: 0o600 })
          )
          const exclusive = fake.recorded.execs.at(-1)!
          expect(exclusive.args.at(-1)).toContain("ln -T --")
          expect(new TextDecoder().decode(exclusive.stdin)).toBe("fresh")
          const refused = yield* Effect.flip(files.writeFile!(`${workdir}/x`, new Uint8Array(), { flag: "a" }))
          expect(refused.message).toContain("microVM writes support w without a mode")
        }))
    }))

  it.effect("classifies non-Error SDK filesystem failures and preserves their cause", () =>
    Effect.gen(function*() {
      const cause = { code: "sandboxFsOps", toString: () => "No such file or directory" }
      const fake = fakeSdk({ readFailure: () => cause })
      yield* inSession(MicrosandboxSandbox.make({ sdk: fake.sdk }), "read-failure", (session) =>
        Effect.gen(function*() {
          const error = yield* Effect.flip(session.readFile("/missing"))
          expect(error.code).toBe("not_found")
          expect(error.cause).toBe(cause)
        }))
    }))

  it.effect("runs a relative shell when no environment deletion was requested", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: root, shell: "sh" }),
        "relative-plain",
        (session) =>
          Effect.gen(function*() {
            const result = yield* Effect.scoped(Effect.flatMap(session.spawn("printf relative", {}), output))
            expect(result).toEqual(["relative", "", 0])
          })
      )
    }))

  it.effect("refuses deletion with a relative shell before guest execution", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: root, shell: "sh" })
      yield* inSession(provider, "relative-shell", (session) =>
        Effect.gen(function*() {
          const calls = fake.recorded.execs.length
          const error = yield* Effect.scoped(
            Effect.flip(session.spawn("true", { env: { HOME: undefined, PATH: undefined } }))
          )
          expect(error.code).toBe("spawn_error")
          expect(error.message).toContain("absolute shell path")
          expect(fake.recorded.execs).toHaveLength(calls)
        }))
    }))

  for (const inNix of [false, true]) {
    it.effect(
      `deletes guest inherited environment separately from command defaults (nix=${inNix})`,
      () =>
        Effect.gen(function*() {
          const fake = fakeSdk()
          const provider = MicrosandboxSandbox.make({
            sdk: fake.sdk,
            workdir: root,
            shell: "/bin/bash",
            ...(inNix ? { environment: { flake: "{ }", nix: fakeNix().nix } } : {})
          })
          yield* inSession(provider, "env-delete", (session) =>
            Effect.gen(function*() {
              const run = (command: string, env = {}) =>
                Effect.scoped(Effect.flatMap(session.spawn(command, { env }), output))
              expect((yield* run(`printf '%s' "\${HOME+present}"`))[0]).toBe("present")
              expect(
                yield* run(`printf '%s:%s' "\${HOME+present}" "$KEEP"`, {
                  KEEP: "a 'quoted' $value",
                  HOME: undefined,
                  PATH: undefined
                })
              ).toEqual([":a 'quoted' $value", "", 0])
              expect(fake.recorded.execs.at(-1)?.args.at(-1)).toContain("-u HOME -u PATH")
              expect(fake.recorded.execs.at(-1)?.args.at(-1)).toContain("/bin/bash -c")
            }))
        }),
      60_000
    )
  }

  it.live(
    "passes SandboxConformance, kill and interrupt included, running real processes against real files",
    () =>
      Effect.gen(function*() {
        const fake = fakeSdk()
        const workdir = join(root, "conformance-ws")
        const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })

        const violations = yield* SandboxConformance.check(provider, {
          provides: { ping: true, kill: true, interrupt: true, ephemeral: true }
        })

        expect(violations).toEqual([])
        expect(fake.recorded.builds.every(({ settings }) =>
          settings["image"] === "oven/bun:1" &&
          settings["ephemeral"] === true &&
          settings["detached"] === false
        )).toBe(true)
        // Every released ephemeral machine is removed under the bounded stop.
        expect(fake.recorded.destroys.length).toBe(fake.recorded.builds.length)
        expect(fake.recorded.destroys.every(({ timeoutMs }) => timeoutMs === 3_000)).toBe(true)
        // Commands run a plain shell, never a login shell, and never smuggle
        // file contents through the command line.
        const commands = fake.recorded.execs.filter(({ args }) => !args[1]?.includes("kill -s"))
        expect(commands.every(({ args, shell }) => shell === "/bin/sh" && args[0] === "-c")).toBe(true)
        expect(commands.every(({ args }) => args[1]?.includes("base64") !== true)).toBe(true)
        // Standard input rode the exec builder's byte channel.
        expect(fake.recorded.execs.some(({ stdin }) => stdin !== undefined && stdin.includes(255))).toBe(true)
      }),
    60_000
  )

  it.effect("carries every builder option and command setting without a builder workdir", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "options-ws")
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        image: "alpine:3.22",
        workdir,
        shell: "/bin/bash",
        env: { STATIC: "base", KEPT: "base" },
        cpus: 2,
        maxCpus: 4,
        memoryMib: 1024,
        maxMemoryMib: 2048,
        maxDurationSecs: 900,
        idleTimeoutSecs: 120,
        security: "restricted",
        pullPolicy: "if-missing",
        labels: { owner: "smithers", "smithers.holder": "forged" },
        scripts: { prepare: "echo ready" },
        detached: true,
        network: "none",
        owner: "installation-a",
        holder: "host-7"
      })

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const first = yield* provider.acquire("lane/one")
          const second = yield* provider.acquire("lane-one")
          // A path with no parent segment takes the bare write, backed by the
          // machine's own directory since it is not a test-root path.
          yield* first.writeFile("/root.bin", new Uint8Array([1, 2]))
          const spaced = new Uint8Array([0, 255, 7])
          yield* first.writeFile(`${workdir}/a b.bin`, spaced)
          expect(Array.from(yield* first.readFile(`${workdir}/a b.bin`))).toEqual(Array.from(spaced))
          const absolute = yield* first.spawn("pwd", {
            cwd: root,
            env: { STATIC: undefined, DYNAMIC: "yes" }
          })
          const printed = yield* output(absolute)
          // Closing a spawn's scope ends its command, so the exit is awaited.
          yield* Effect.scoped(Effect.flatMap(first.spawn("mkdir -p sub", {}), (made) => made.exitCode))
          const relative = yield* Effect.scoped(Effect.flatMap(first.spawn("pwd", { cwd: "./sub/" }), output))
          const emptied = yield* Effect.scoped(
            Effect.flatMap(first.spawn(`cat > ${workdir}/empty-stdin.bin`, { stdin: new Uint8Array() }), output)
          )
          const emptyCopy = yield* first.readFile(`${workdir}/empty-stdin.bin`)
          return {
            names: [first.remoteId, second.remoteId],
            printed,
            relative,
            emptied,
            emptyCopy
          }
        })
      )

      expect(result.names[0]).not.toBe(result.names[1])
      expect(result.names[0]).toMatch(/^smthrs-msb-lane-one-/)
      expect(result.printed).toEqual([`${root}\n`, "", 0])
      expect(result.relative).toEqual([`${workdir}/sub\n`, "", 0])
      expect(result.emptied[2]).toBe(0)
      expect(Array.from(result.emptyCopy)).toEqual([])
      const spawned = fake.recorded.execs.find(({ args }) => args[1]?.includes("DYNAMIC=yes"))
      expect(spawned).toMatchObject({
        shell: "/bin/bash",
        cwd: root,
        env: {}
      })
      expect(spawned?.env["STATIC"]).toBeUndefined()
      expect(spawned?.args[1]).toContain("-u STATIC KEPT=base DYNAMIC=yes /bin/bash -c")
      expect(fake.recorded.builds[0]?.settings).toEqual({
        image: "alpine:3.22",
        cpus: 2,
        maxCpus: 4,
        memory: 1024,
        maxMemory: 2048,
        security: "restricted",
        pullPolicy: "if-missing",
        // The ownership keys are the provider's own: a caller label cannot
        // forge the holder `reap` judges.
        labels: { owner: "smithers", ...ownership("installation-a", "host-7"), "smithers.network": "none" },
        scripts: { prepare: "echo ready" },
        maxDuration: 900,
        idleTimeout: 120,
        disableNetwork: true,
        ephemeral: true,
        detached: true
      })
      expect(fake.recorded.builds[0]?.settings["workdir"]).toBeUndefined()
      expect(fake.recorded.destroys).toHaveLength(2)
    }))

  it.effect("applies a network policy and a root disk to an image boot, and keeps a snapshot's own disk", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const policy: MicrosandboxSandbox.NetworkPolicy = {
        defaultEgress: "deny",
        defaultIngress: "deny",
        rules: [{
          direction: "egress",
          destination: { kind: "domain", domain: "registry.npmjs.org" },
          protocols: [],
          ports: [],
          action: "allow"
        }]
      }
      const workdir = join(root, "policy-ws")
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: fake.sdk, workdir, networkPolicy: policy, rootDiskMib: 32_768 }),
        "policy-image",
        () => Effect.void
      )
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: fake.sdk, workdir, snapshot: "base", rootDiskMib: 32_768 }),
        "policy-snapshot",
        () => Effect.void
      )
      const [image, snapshot] = fake.recorded.builds.map(({ settings }) => settings)
      expect(image).toMatchObject({ image: "oven/bun:1", rootDisk: 32_768, networkPolicy: policy })
      expect(snapshot).toMatchObject({ snapshot: "base" })
      expect(snapshot!["rootDisk"]).toBeUndefined()
      expect(image!["disableNetwork"]).toBeUndefined()
      // The neutral option and the vendor policy are exclusive at construction.
      expect(() => MicrosandboxSandbox.make({ sdk: fake.sdk, workdir, network: "none", networkPolicy: policy }))
        .toThrow("microsandbox: network and networkPolicy are exclusive; name one")
      expect(fake.recorded.builds).toHaveLength(2)
    }))

  it.effect("maps a neutral allowlist to deny-by-default egress that allows only the listed hosts", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      yield* inSession(
        MicrosandboxSandbox.make({
          sdk: fake.sdk,
          workdir: join(root, "allow-ws"),
          network: { allow: ["registry.npmjs.org", "*.github.com"] }
        }),
        "allow",
        () => Effect.void
      )
      const allow = (destination: object) => ({
        direction: "egress",
        destination,
        protocols: [],
        ports: [],
        action: "allow"
      })
      const policy = {
        defaultEgress: "deny",
        defaultIngress: "deny",
        rules: [
          // No resolver rule: the vendor matches each DNS query's name
          // against the domain rules, so they alone admit the listed names.
          allow({ kind: "domain", domain: "registry.npmjs.org" }),
          // A vendor domain-suffix rule also matches its apex, and the vendor
          // takes the first matching rule, so a deny on the apex comes first.
          { ...allow({ kind: "domain", domain: "github.com" }), action: "deny" },
          allow({ kind: "domainSuffix", suffix: "github.com" })
        ]
      }
      const settings = fake.recorded.builds[0]!.settings
      expect(settings["networkPolicy"]).toEqual(policy)
      expect(settings["disableNetwork"]).toBeUndefined()
      expect(settings["labels"]).toMatchObject({ "smithers.network": JSON.stringify(policy) })
    }))

  it.effect("resolves only listed names over UDP and TCP DNS", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      type Rule = {
        readonly direction: string
        readonly destination: {
          readonly kind: string
          readonly domain?: string
          readonly suffix?: string
          readonly group?: string
        }
        readonly protocols: ReadonlyArray<string>
        readonly ports: ReadonlyArray<{ readonly start: number; readonly end: number }>
        readonly action: string
      }
      type Policy = { readonly defaultEgress: string; readonly rules: ReadonlyArray<Rule> }
      const policyFor = (allow: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          yield* inSession(
            MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "dns-ws"), network: { allow } }),
            "dns",
            () => Effect.void
          )
          return fake.recorded.builds.at(-1)!.settings["networkPolicy"] as Policy
        })
      // microsandbox 0.6.16 `NetworkPolicy::evaluate_dns_query`
      // (crates/network/lib/policy/types.rs): first match wins; a domain or
      // suffix rule matches the query name, a host-group or any rule matches
      // the DNS transport's protocol and port, else the egress default.
      const resolves = (policy: Policy, name: string, protocol: "udp" | "tcp") => {
        const onTransport = (rule: Rule) =>
          (rule.protocols.length === 0 || rule.protocols.includes(protocol)) &&
          (rule.ports.length === 0 || rule.ports.some(({ end, start }) => start <= 53 && 53 <= end))
        const rule = policy.rules.find((rule) => {
          if (rule.direction === "ingress") return false
          const { destination } = rule
          switch (destination.kind) {
            case "domain":
              return destination.domain === name
            case "domainSuffix":
              return name === destination.suffix || name.endsWith(`.${destination.suffix}`)
            case "any":
              return onTransport(rule)
            case "group":
              return destination.group === "host" && onTransport(rule)
            default:
              return false
          }
        })
        return (rule?.action ?? policy.defaultEgress) === "allow"
      }
      const listed = yield* policyFor(["registry.npmjs.org", "*.github.com"])
      const empty = yield* policyFor([])
      for (const protocol of ["udp", "tcp"] as const) {
        expect(resolves(listed, "registry.npmjs.org", protocol)).toBe(true)
        expect(resolves(listed, "api.github.com", protocol)).toBe(true)
        expect(resolves(listed, "github.com", protocol)).toBe(false)
        expect(resolves(listed, "secret.attacker.example", protocol)).toBe(false)
        expect(resolves(empty, "registry.npmjs.org", protocol)).toBe(false)
      }
    }))

  it.effect("maps an empty allowlist to deny-all egress", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "empty-allow-ws"), network: { allow: [] } }),
        "empty-allow",
        () => Effect.void
      )
      expect(fake.recorded.builds[0]!.settings["networkPolicy"])
        .toEqual({ defaultEgress: "deny", defaultIngress: "deny", rules: [] })
    }))

  it.effect("admits a *. entry's subdomains but its apex only when another entry names it", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      type Policy = {
        readonly rules: ReadonlyArray<{
          readonly destination: { readonly kind: string; readonly domain?: string; readonly suffix?: string }
          readonly action: string
        }>
      }
      const policyFor = (allow: ReadonlyArray<string>) =>
        Effect.gen(function*() {
          yield* inSession(
            MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "apex-ws"), network: { allow } }),
            "apex",
            () => Effect.void
          )
          return fake.recorded.builds.at(-1)!.settings["networkPolicy"] as Policy
        })
      // The vendor's first-match-wins evaluation, with a domain-suffix rule
      // matching its apex as microsandbox 0.6.16 does.
      const admits = (policy: Policy, name: string) => {
        const rule = policy.rules.find(({ destination }) =>
          destination.kind === "domain"
            ? destination.domain === name
            : destination.kind === "domainSuffix" &&
              (name === destination.suffix || name.endsWith(`.${destination.suffix}`))
        )
        return rule?.action === "allow"
      }
      const wildcard = yield* policyFor(["*.example.com"])
      expect(admits(wildcard, "example.com")).toBe(false)
      expect(admits(wildcard, "api.example.com")).toBe(true)
      expect(admits(wildcard, "a.b.example.com")).toBe(true)
      expect(admits(wildcard, "example.org")).toBe(false)
      const withApex = yield* policyFor(["*.example.com", "example.com"])
      expect(admits(withApex, "example.com")).toBe(true)
      expect(admits(withApex, "api.example.com")).toBe(true)
      const nested = yield* policyFor(["*.b.example.com", "*.example.com"])
      expect(admits(nested, "b.example.com")).toBe(true)
      expect(admits(nested, "a.b.example.com")).toBe(true)
      expect(admits(nested, "example.com")).toBe(false)
      const mixedCase = yield* policyFor(["*.Example.com", "EXAMPLE.com"])
      expect(admits(mixedCase, "EXAMPLE.com")).toBe(true)
    }))

  it("refuses a malformed allowlist at construction", () => {
    const fake = fakeSdk()
    for (const allow of [["https://example.com"], ["exa mple.com"], [""], ["*"]]) {
      expect(() => MicrosandboxSandbox.make({ sdk: fake.sdk, network: { allow } }))
        .toThrow("microsandbox: network allowlist entry is not a host name")
    }
    expect(() => MicrosandboxSandbox.make({ sdk: fake.sdk, network: "open" as never }))
      .toThrow(`microsandbox: network must be "none" or { allow: string[] }`)
    expect(fake.recorded.builds).toEqual([])
  })

  it.effect("reattaches a sticky machine only under the network it was created with", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "network-reattach-ws")
      const sticky = (network?: "none" | { readonly allow: ReadonlyArray<string> }) =>
        MicrosandboxSandbox.make({
          sdk: fake.sdk,
          workdir,
          persistence: "sticky",
          ...network === undefined ? {} : { network }
        })
      yield* inSession(sticky(), "open", () => Effect.void)
      const refused = yield* Effect.exit(inSession(sticky("none"), "open", () => Effect.void))
      expect(refused).toMatchObject({ _tag: "Failure" })
      expect(String(Exit.isFailure(refused) ? refused.cause : "")).toContain("was created with another network")
      expect(fake.recorded.modifies).toEqual([])

      yield* inSession(sticky({ allow: ["example.com"] }), "fenced", () => Effect.void)
      yield* inSession(sticky({ allow: ["example.com"] }), "fenced", (session) => session.ping!)
      expect(fake.recorded.modifies).toHaveLength(1)
      const widened = yield* Effect.exit(
        inSession(sticky({ allow: ["example.com", "example.org"] }), "fenced", () => Effect.void)
      )
      expect(Exit.isFailure(widened)).toBe(true)
      expect(fake.recorded.modifies).toHaveLength(1)
    }))

  it.effect("labels every machine with a default owner and a holder minted per provider", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const first = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "labels-ws") })
      const second = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "labels-ws") })
      yield* inSession(first, "labels-a", () => Effect.void)
      yield* inSession(first, "labels-b", () => Effect.void)
      yield* inSession(second, "labels-c", () => Effect.void)
      const labels = fake.recorded.builds.map(({ settings }) => settings["labels"] as Record<string, string>)
      expect(labels.every((label) => label["smithers.provider"] === "microsandbox")).toBe(true)
      expect(labels.every((label) => label["smithers.owner"] === "smithers")).toBe(true)
      expect(labels[0]?.["smithers.holder"]).toMatch(/^[0-9a-f-]{36}$/)
      expect(labels[1]?.["smithers.holder"]).toBe(labels[0]?.["smithers.holder"])
      expect(labels[2]?.["smithers.holder"]).not.toBe(labels[0]?.["smithers.holder"])
    }))

  it.live("streams output as the guest writes it, before the command exits", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "stream-ws") })
      yield* inSession(provider, "streaming", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const gate = join(root, `stream-gate-${process.pid}`)
          const running = yield* session.spawn(
            `printf early; while [ ! -e ${gate} ]; do sleep 0.05; done; printf late; printf warned >&2; exit 4`,
            {}
          )
          const exit = yield* Effect.forkChild(running.exitCode)
          const rest = yield* Effect.forkChild(Stream.mkString(Stream.decodeText(running.stdout)))
          // The command is still blocked on the gate, yet its first chunk has
          // already arrived: output is not collected at completion.
          while (fake.recorded.execs.length === 0) yield* elapsed(20)
          yield* elapsed(300)
          expect(exit.pollUnsafe()).toBeUndefined()
          expect(rest.pollUnsafe()).toBeUndefined()
          writeFileSync(gate, "")
          expect(yield* Fiber.join(exit)).toBe(4)
          expect(yield* Fiber.join(rest)).toBe("earlylate")
          expect(yield* Stream.mkString(Stream.decodeText(running.stderr))).toBe("warned")
        })))
    }), 30_000)

  it.live("delivers the first chunk while the command is still running", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "first-chunk-ws") })
      yield* inSession(provider, "first-chunk", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const gate = join(root, `first-chunk-gate-${process.pid}`)
          const running = yield* session.spawn(`printf early; while [ ! -e ${gate} ]; do sleep 0.05; done`, {})
          const head = yield* Stream.runHead(Stream.decodeText(running.stdout))
          expect(head).toMatchObject({ _tag: "Some", value: "early" })
          writeFileSync(gate, "")
          expect(yield* running.exitCode).toBe(0)
        })))
    }), 30_000)

  it.live(
    "kills the command and every descendant, including one in its own process group",
    () =>
      Effect.gen(function*() {
        const fake = fakeSdk()
        const workdir = join(root, "tree-ws")
        const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })
        yield* inSession(provider, "tree", (session) =>
          Effect.scoped(Effect.gen(function*() {
            // `set -m` gives the background job a process group of its own, so
            // a signal to the command's group alone would miss it.
            const running = yield* session.spawn(
              "set -m; (while :; do printf x >> escaped.log; sleep 0.05; done) & " +
                "while :; do printf x >> direct.log; sleep 0.05; done",
              {}
            )
            while (sizeOf(join(workdir, "escaped.log")) === 0 || sizeOf(join(workdir, "direct.log")) === 0) {
              yield* elapsed(50)
            }
            yield* session.kill!(running, "SIGTERM")
            const code = yield* running.exitCode
            expect(code).not.toBe(0)
            expect(yield* settled(join(workdir, "escaped.log"))).toBe(true)
            expect(yield* settled(join(workdir, "direct.log"))).toBe(true)
            // A command seen to exit is never signalled again.
            const signals = fake.recorded.signals.length
            yield* session.kill!(running, "SIGKILL")
            expect(fake.recorded.signals).toHaveLength(signals)
          })))
      }),
    30_000
  )

  it.live("signals the process group when the pid is not known yet", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ startedDelayMs: (line) => line.includes("slow-start") ? 1_000 : undefined })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "early-kill-ws") })
      yield* inSession(provider, "early-kill", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const running = yield* session.spawn("sleep 30 # slow-start", {})
          yield* session.kill!(running, "SIGTERM")
          expect(yield* running.exitCode).not.toBe(0)
          expect(fake.recorded.signals.map(({ signal }) => signal)).toEqual([15])
        })))
    }), 30_000)

  it.live("skips the group signal when the tree walk already ended the command", () =>
    Effect.gen(function*() {
      // The walk's own exit is reported late, so the command it killed has
      // always ended by the time the walk returns.
      const fake = fakeSdk({ exitedDelayMs: (line) => line.includes("sleep 30") ? undefined : 300 })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "walked-kill-ws") })
      yield* inSession(provider, "walked-kill", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const running = yield* session.spawn("sleep 30", {})
          yield* elapsed(200)
          yield* session.kill!(running, "SIGTERM")
          expect(yield* running.exitCode).not.toBe(0)
          expect(fake.recorded.signals).toEqual([])
        })))
    }), 30_000)

  it.live("fails a signal neither the walk nor the group can deliver", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "lost-signal-ws") })
      yield* inSession(provider, "lost-signal", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const running = yield* session.spawn("sleep 30", {})
          yield* elapsed(200)
          // No Linux signal is named SIGLOST, and no shell `kill` knows it.
          const error = yield* Effect.flip(session.kill!(running, "SIGLOST"))
          expect(error).toBeInstanceOf(ProviderError)
          expect(error.message).toContain("SIGLOST")
          yield* session.kill!(running, "SIGKILL")
          expect(yield* running.exitCode).not.toBe(0)
        })))
    }), 30_000)

  it.live("escalates to SIGKILL when an interrupted command ignores SIGTERM", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "stubborn-ws")
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })
      yield* inSession(provider, "stubborn", (session) =>
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
            session.spawn("trap '' TERM; while :; do printf x >> stubborn.log; sleep 0.05; done", {}),
            (running) => running.exitCode
          )))
          while (sizeOf(join(workdir, "stubborn.log")) === 0) yield* elapsed(50)
          const began = Date.now()
          yield* Fiber.interrupt(fiber)
          const took = Date.now() - began
          // The grace is two seconds; the whole teardown is bounded by five.
          expect(took).toBeGreaterThanOrEqual(1_900)
          expect(took).toBeLessThan(5_500)
          expect(yield* settled(join(workdir, "stubborn.log"))).toBe(true)
        }))
    }), 30_000)

  it.live("stops the guest command when the consuming fiber is interrupted", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "interrupt-ws")
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })
      yield* inSession(provider, "interrupt", (session) =>
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
            session.spawn("printf started > started; sleep 1; printf survived > survived", {}),
            (running) => running.exitCode
          )))
          while (!existsSync(join(workdir, "started"))) yield* elapsed(20)
          yield* Fiber.interrupt(fiber)
          yield* elapsed(1_500)
          expect(existsSync(join(workdir, "survived"))).toBe(false)
        }))
    }), 30_000)

  it.live(
    "logs a teardown signal neither the walk nor the group delivers, and leaves the command to the machine",
    () =>
      Effect.gen(function*() {
        const fake = fakeSdk({
          execFailure: (line) => line.includes("p=") ? new Error("walk refused") : undefined,
          signalFailure: () => new Error("group refused")
        })
        const workdir = join(root, "undeliverable-ws")
        const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })
        yield* inSession(provider, "undeliverable", (session) =>
          Effect.gen(function*() {
            const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
              session.spawn("printf started > started; sleep 30", {}),
              (running) => running.exitCode
            )))
            while (!existsSync(join(workdir, "started"))) yield* elapsed(20)
            yield* Fiber.interrupt(fiber)
            // SIGTERM, then SIGKILL after the grace: both refused, both logged.
            expect(fake.recorded.signals.map(({ signal }) => signal)).toEqual([15, 9])
          }))
        expect(fake.recorded.destroys).toHaveLength(1)
      }),
    30_000
  )

  it.live("kills a command whose start the caller abandoned, once its handle arrives", () =>
    Effect.gen(function*() {
      let open: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      const fake = fakeSdk({ startGate: (line) => line.includes("late-start") ? gate : undefined })
      const workdir = join(root, "late-start-ws")
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })
      yield* inSession(provider, "late-start", (session) =>
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
            session.spawn("sleep 1; printf ran > ran # late-start", {}),
            (running) => running.exitCode
          )))
          yield* elapsed(100)
          yield* Fiber.interrupt(fiber)
          open()
          yield* elapsed(1_500)
          expect(fake.recorded.handleKills.some((line) => line.includes("late-start"))).toBe(true)
          expect(existsSync(join(workdir, "ran"))).toBe(false)
        }))
    }), 30_000)

  it.live("drops a failed kill of an abandoned start without an unhandled rejection", () =>
    Effect.gen(function*() {
      let open: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      const fake = fakeSdk({
        startGate: (line) => line.includes("refused-kill") ? gate : undefined,
        killFailure: (line) => line.includes("refused-kill") ? new Error("kill refused") : undefined
      })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "refused-kill-ws") })
      yield* inSession(provider, "refused-kill", (session) =>
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(
            session.spawn("sleep 30 # refused-kill", {}),
            (running) => running.exitCode
          )))
          yield* elapsed(100)
          yield* Fiber.interrupt(fiber)
          open()
          while (!fake.recorded.handleKills.some((line) => line.includes("refused-kill"))) yield* elapsed(20)
        }))
      // The machine's removal ended what the kill could not.
      expect(fake.recorded.destroys).toHaveLength(1)
    }), 30_000)

  it.live("fails a pending command promptly with unavailable when its machine is lost", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "lost-ws") })
      const began = Date.now()
      const failure = yield* inSession(provider, "lost", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const running = yield* session.spawn("sleep 30", {})
          const waiting = yield* Effect.forkChild(Effect.flip(running.exitCode))
          const streaming = yield* Effect.forkChild(Effect.flip(Stream.runDrain(running.stdout)))
          yield* elapsed(200)
          fake.loseGuest(session.remoteId)
          const stream = yield* Fiber.join(streaming)
          expect(stream.code).toBe("unavailable")
          return yield* Fiber.join(waiting)
        })))
      // Teardown of the lost command and the crashed machine is prompt too.
      expect(Date.now() - began).toBeLessThan(3_000)
      expect(failure).toBeInstanceOf(ProviderError)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toContain("ended before `sleep 30` reported its status")
      expect(fake.recorded.destroys).toHaveLength(1)
    }), 30_000)

  it.live(
    "fails a command the guest could not start with spawn_error, and signals nothing",
    () =>
      Effect.gen(function*() {
        const fake = fakeSdk()
        const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "unstarted-ws") })
        const failure = yield* inSession(provider, "unstarted", (session) =>
          Effect.scoped(Effect.gen(function*() {
            const running = yield* session.spawn("pwd", { cwd: "./no-such-directory" })
            const stream = yield* Effect.flip(Stream.runDrain(running.stdout))
            expect(stream.code).toBe("spawn_error")
            return yield* Effect.flip(running.exitCode)
          })))
        expect(failure.code).toBe("spawn_error")
        expect(failure.message).toContain("the guest could not start `pwd`")
        expect(fake.recorded.signals).toEqual([])
        expect(fake.recorded.execs).toHaveLength(1)
      }),
    30_000
  )

  it.live("fails the command with unavailable when its event stream breaks", () =>
    Effect.gen(function*() {
      const broken = new Error("agent protocol broke")
      const fake = fakeSdk({ recvFailure: (line) => line.includes("broken-stream") ? broken : undefined })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "broken-ws") })
      yield* inSession(provider, "broken", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const running = yield* session.spawn("sleep 1 # broken-stream", {})
          const failure = yield* Effect.flip(running.exitCode)
          expect(failure.code).toBe("unavailable")
          expect(failure.cause).toBe(broken)
        })))
    }), 30_000)

  it.effect("refuses to start when the SDK rejects the command", () =>
    Effect.gen(function*() {
      const refused = new Error("exec refused")
      const fake = fakeSdk({ execFailure: (line) => line.includes("refused") ? refused : undefined })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir: join(root, "refused-ws") })
      yield* inSession(provider, "refused", (session) =>
        Effect.gen(function*() {
          const failure = yield* Effect.flip(Effect.scoped(session.spawn("true # refused", {})))
          expect(failure.code).toBe("spawn_error")
          expect(failure.cause).toBe(refused)
        }))
    }))

  it.effect("refuses a hosted backend before provisioning, and accepts it only when asked", () =>
    Effect.gen(function*() {
      const cloud = fakeSdk({ defaultBackend: () => "cloud" })
      const refused = yield* Effect.flip(
        inSession(MicrosandboxSandbox.make({ sdk: cloud.sdk }), "cloud", () => Effect.void)
      )
      expect(refused.code).toBe("unavailable")
      expect(refused.message).toContain("default backend is cloud")
      expect(refused.message).toContain("setDefaultBackend(\"local\")")
      expect(cloud.recorded.builds).toEqual([])

      yield* inSession(
        MicrosandboxSandbox.make({ sdk: cloud.sdk, backend: "any", workdir: join(root, "any-ws") }),
        "any",
        () => Effect.void
      )
      expect(cloud.recorded.builds).toHaveLength(1)

      const unreadable = new Error("native binding unavailable")
      const broken = fakeSdk({
        defaultBackend: () => {
          throw unreadable
        }
      })
      const unnamed = yield* Effect.flip(
        inSession(MicrosandboxSandbox.make({ sdk: broken.sdk }), "unnamed", () => Effect.void)
      )
      expect(unnamed.code).toBe("unavailable")
      expect(unnamed.cause).toBe(unreadable)
      expect(broken.recorded.builds).toEqual([])

      // The default backend can change between the read and the create; the
      // machine's own report is checked too, and a refused machine is removed.
      const raced = fakeSdk({ machineBackend: "cloud" })
      const moved = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({ sdk: raced.sdk, workdir: join(root, "raced-ws") }),
          "raced",
          () => Effect.void
        )
      )
      expect(moved.code).toBe("unavailable")
      expect(moved.message).toContain("runs on the cloud backend")
      expect(raced.recorded.destroys).toHaveLength(1)
    }))

  // A fake `nix`: records its argv, fails on demand the way an unevaluable
  // flake would, and execs whatever follows `--command`. Real `nix` in the
  // nixos/nix image behaves the same from the provider's side.
  const fakeNix = (): { readonly nix: string; readonly log: string } => {
    const nixDir = mkdtempSync(join(root, "fake-nix-"))
    mkdirSync(nixDir, { recursive: true })
    const log = join(nixDir, "argv.log")
    const nix = join(nixDir, "nix")
    writeFileSync(
      nix,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        // Nix reports progress on stdout before an evaluation error; only
        // the error reaches the failure.
        `if [ "$NIX_FAKE_FAIL" = 1 ]; then echo 'evaluating'; echo 'error: flake evaluation failed' >&2; exit 7; fi`,
        `if [ -n "$NIX_FAKE_SLEEP" ]; then sleep "$NIX_FAKE_SLEEP"; fi`,
        "shift 2",
        `[ "$1" = --command ] || { echo 'expected --command' >&2; exit 2; }`,
        "shift",
        `exec "$@"`
      ].join("\n")
    )
    chmodSync(nix, 0o755)
    return { nix, log }
  }

  it.effect("plants the Nix environment, warms it, and runs every command under nix develop", () =>
    Effect.gen(function*() {
      const { log, nix } = fakeNix()
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        env: { BASE: "kept" },
        environment: { flake: "{ outputs = _: { }; }\n", lock: "{ \"version\": 7 }\n", attr: "ci", nix }
      })

      const result = yield* inSession(provider, "nix-lane", (session) =>
        Effect.scoped(Effect.gen(function*() {
          const flake = yield* session.readFile(`${session.workdir}/.smithers/nix/flake.nix`)
          const lock = yield* session.readFile(`${session.workdir}/.smithers/nix/flake.lock`)
          const printed = yield* Effect.flatMap(
            session.spawn("printf %s \"$BASE:$PWD\"", { env: { DYNAMIC: "yes" } }),
            output
          )
          return {
            flake: new TextDecoder().decode(flake),
            lock: new TextDecoder().decode(lock),
            printed,
            guestRoot: fake.machineRoot(session.remoteId)
          }
        })))

      expect(result.flake).toBe("{ outputs = _: { }; }\n")
      expect(result.lock).toBe("{ \"version\": 7 }\n")
      expect(result.printed).toEqual([`kept:${result.guestRoot}/workspace`, "", 0])
      // No image named with an environment: the microVM boots the Nix image.
      expect(fake.recorded.builds[0]?.settings["image"]).toBe("nixos/nix")
      expect(fake.recorded.execs.map(({ shell, args }) => [shell, ...args])).toEqual([
        [nix, "develop", "path:/workspace/.smithers/nix#ci", "--command", "true"],
        [nix, "develop", "path:/workspace/.smithers/nix#ci", "--command", "/bin/sh", "-c", "printf %s \"$BASE:$PWD\""]
      ])
      expect(fake.recorded.execs[0]).toMatchObject({ cwd: "/workspace", env: { BASE: "kept" } })
      expect(readFileSync(log, "utf8").split("\n").filter((line) => line !== "")).toHaveLength(2)
      expect(fake.recorded.destroys).toHaveLength(1)
    }))

  it.effect("looks for `nix` on the guest PATH when no executable is named", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, environment: { flake: "{ }" } })

      // This host has no `nix` on PATH, so the warm fails at the spawn: the
      // point is the program the guest was asked for.
      const failure = yield* Effect.flip(inSession(provider, "plain-nix", () => Effect.void))

      expect(failure.code).toBe("unavailable")
      expect(fake.recorded.execs.map(({ shell, args }) => [shell, ...args])).toEqual([
        ["nix", "develop", "path:/workspace/.smithers/nix", "--command", "true"]
      ])
      expect(fake.recorded.destroys).toHaveLength(1)
    }))

  it.effect("fails the acquire, not a later spawn, when the Nix environment cannot be realised", () =>
    Effect.gen(function*() {
      const { nix } = fakeNix()
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        image: "nixos/nix:2.29.0",
        env: { NIX_FAKE_FAIL: "1" },
        environment: { flake: "{ }", directory: "/opt/env", nix }
      })

      const failure = yield* Effect.flip(inSession(provider, "broken-lane", () => Effect.void))

      expect(failure).toBeInstanceOf(ProviderError)
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toContain("the Nix environment at /opt/env could not be realised")
      expect(failure.message).toContain("(nix develop exited 7): error: flake evaluation failed")
      expect(failure.message).not.toContain("evaluating")
      expect(fake.recorded.builds[0]?.settings["image"]).toBe("nixos/nix:2.29.0")
      expect(fake.recorded.execs.map(({ args }) => args)).toEqual([["develop", "path:/opt/env", "--command", "true"]])
      // The booted machine that could not be prepared is removed, not leaked.
      expect(fake.recorded.destroys).toHaveLength(1)
    }))

  it.live(
    "fails the acquire when the machine is lost or its stream breaks while the environment warms",
    () =>
      Effect.gen(function*() {
        const { nix } = fakeNix()
        const lost = fakeSdk({ loseOn: (line) => line.endsWith("--command true") })
        const gone = yield* Effect.flip(inSession(
          MicrosandboxSandbox.make({ sdk: lost.sdk, environment: { flake: "{ }", nix } }),
          "warm-lost",
          () => Effect.void
        ))
        expect(gone.code).toBe("unavailable")
        expect(gone.message).toContain("ended without reporting its status")

        const broken = new Error("agent protocol broke")
        const failing = fakeSdk({ recvFailure: (line) => line.endsWith("--command true") ? broken : undefined })
        const severed = yield* Effect.flip(inSession(
          MicrosandboxSandbox.make({ sdk: failing.sdk, environment: { flake: "{ }", nix } }),
          "warm-broken",
          () => Effect.void
        ))
        expect(severed.code).toBe("unavailable")
        expect(severed.cause).toBe(broken)
      }),
    30_000
  )

  for (const killFails of [false, true]) {
    it.live(
      `kills the warm command when acquisition is interrupted (kill fails: ${killFails})`,
      () =>
        Effect.gen(function*() {
          const { nix } = fakeNix()
          // A kill that fails is logged and left: the machine's removal ends it.
          const fake = fakeSdk({ killFailure: () => killFails ? new Error("kill refused") : undefined })
          const provider = MicrosandboxSandbox.make({
            sdk: fake.sdk,
            env: { NIX_FAKE_SLEEP: "30" },
            environment: { flake: "{ }", nix }
          })
          const fiber = yield* Effect.forkChild(inSession(provider, "warm-interrupted", () => Effect.void))
          while (fake.recorded.execs.length === 0) yield* elapsed(20)
          yield* elapsed(100)
          yield* Fiber.interrupt(fiber)
          expect(fake.recorded.handleKills.some((line) => line.endsWith("--command true"))).toBe(true)
          expect(fake.recorded.destroys).toHaveLength(1)
        }),
      30_000
    )
  }

  it.effect("keeps sticky machines, relabels them for the new holder, and reconnects running or stopped", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      // No workdir named: the default guest workspace lives under the
      // machine's directory and survives exactly as long as the machine.
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        snapshot: "snapshot-7",
        persistence: "sticky",
        detached: false,
        owner: "installation-a",
        holder: "first"
      })
      const bytes = new Uint8Array([0, 254, 8])

      const name = yield* inSession(provider, "sticky", (session) =>
        Effect.gen(function*() {
          expect(session.workdir).toBe("/workspace")
          yield* session.writeFile("/workspace/kept.bin", bytes)
          return session.remoteId
        }))
      expect(fake.recorded.destroys).toEqual([])
      expect(fake.recorded.builds[0]?.settings).toEqual({
        snapshot: "snapshot-7",
        labels: ownership("installation-a", "first"),
        ephemeral: false,
        detached: false
      })

      fake.markStopped(name)
      const second = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        snapshot: "snapshot-7",
        persistence: "sticky",
        detached: false,
        owner: "installation-a",
        holder: "second"
      })
      const reopened = yield* inSession(
        second,
        "sticky",
        (session) => session.readFile(`${session.workdir}/kept.bin`)
      )
      expect(Array.from(reopened)).toEqual(Array.from(bytes))
      expect(fake.recorded.starts).toEqual([{ name, detached: false }])
      expect(fake.recorded.modifies).toEqual([
        { name, labels: ownership("installation-a", "second"), policy: "next_start" }
      ])
      expect(fake.machines.get(name)?.labels["smithers.holder"]).toBe("second")

      yield* inSession(second, "sticky", (session) => session.ping!)
      expect(fake.recorded.connects).toEqual([name])
      expect(fake.recorded.destroys).toEqual([])

      const detachedFake = fakeSdk()
      const detached = MicrosandboxSandbox.make({
        sdk: detachedFake.sdk,
        persistence: "sticky"
      })
      const detachedName = yield* inSession(detached, "detached", (session) => Effect.succeed(session.remoteId))
      detachedFake.markStopped(detachedName)
      yield* inSession(detached, "detached", (session) => session.ping!)
      expect(detachedFake.recorded.starts).toEqual([{ name: detachedName, detached: true }])
    }))

  it.live("opens again after a transient vendor failure, and gives up on a lasting one", () =>
    Effect.gen(function*() {
      let refusals = 2
      const flaky = fakeSdk({
        createFailure: () =>
          refusals-- > 0 ? coded("runtime", "the microVM did not respond within 10000 ms") : undefined
      })
      const name = yield* inSession(
        MicrosandboxSandbox.make({ sdk: flaky.sdk }),
        "flaky-open",
        (session) => Effect.as(session.ping!, session.remoteId)
      )
      expect(flaky.recorded.builds).toHaveLength(3)
      expect(flaky.machines.has(name)).toBe(false)

      const down = fakeSdk({ createFailure: () => agentGone("down") })
      const refused = yield* Effect.flip(inSession(MicrosandboxSandbox.make({ sdk: down.sdk }), "down", Effect.succeed))
      expect(refused.message).toContain("could not be opened")
      expect(down.recorded.builds).toHaveLength(3)
    }), 30_000)

  it.live("restarts a sticky machine whose guest stopped answering, on its own disk", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, persistence: "sticky" })
      const bytes = new Uint8Array([1, 2, 3])
      const name = yield* inSession(provider, "wedged", (session) =>
        Effect.as(session.writeFile("/workspace/kept.bin", bytes), session.remoteId))

      // Reattached with the guest gone: the machine is stopped and started
      // again, and the workspace is still there.
      fake.wedge(name)
      const kept = yield* inSession(provider, "wedged", (session) =>
        session.readFile("/workspace/kept.bin"))
      expect(Array.from(kept)).toEqual([1, 2, 3])
      expect(fake.recorded.stops).toEqual([name])
      expect(fake.recorded.starts).toEqual([{ name, detached: true }])

      // Mid-session: a command whose start the gone guest refused runs once
      // the machine is back, and so do file operations.
      const ran = yield* inSession(provider, "wedged", (session) =>
        Effect.gen(function*() {
          fake.wedge(name)
          const [stdout, , code] = yield* output(yield* session.spawn("printf revived", {}))
          fake.wedge(name)
          yield* session.writeFile("/workspace/nested/after.txt", encoder.encode("after"))
          fake.wedge(name)
          const read = yield* session.readFile("/workspace/nested/after.txt")
          return [stdout, code, new TextDecoder().decode(read)] as const
        }).pipe(Effect.scoped))
      expect(ran).toEqual(["revived", 0, "after"])
      expect(fake.recorded.starts).toHaveLength(4)

      // Two commands that find the guest gone at once bring it back once.
      const both = yield* inSession(provider, "wedged", (session) =>
        Effect.gen(function*() {
          fake.wedge(name)
          return yield* Effect.all(
            ["printf one", "printf two"].map((command) =>
              Effect.flatMap(session.spawn(command, {}), output).pipe(Effect.map(([stdout]) =>
                stdout
              ))
            ),
            { concurrency: "unbounded" }
          )
        }).pipe(Effect.scoped))
      expect(both).toEqual(["one", "two"])
      expect(fake.recorded.starts).toHaveLength(5)
      expect(fake.recorded.destroys).toEqual([])
    }), 30_000)

  it.live("reconnects without a restart when the guest answers a fresh connection", () =>
    Effect.gen(function*() {
      let blips = 1
      const fake = fakeSdk({
        execFailure: (line) => line.includes("blip") && blips-- > 0 ? agentGone("blip") : undefined
      })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, persistence: "sticky" })
      const [stdout] = yield* inSession(provider, "blip", (session) =>
        Effect.flatMap(session.spawn("printf blip", {}), output).pipe(Effect.scoped))
      expect(stdout).toBe("blip")
      expect(fake.recorded.stops).toEqual([])
      expect(fake.recorded.starts).toEqual([])
    }), 30_000)

  it.live(
    "does not restart an ephemeral machine, and names a machine it could not bring back",
    () =>
      Effect.gen(function*() {
        const fake = fakeSdk()
        const lost = yield* Effect.flip(
          inSession(MicrosandboxSandbox.make({ sdk: fake.sdk }), "ephemeral-gone", (session) =>
            Effect.gen(function*() {
              fake.wedge(session.remoteId)
              return yield* session.spawn("true", {})
            }).pipe(Effect.scoped))
        )
        expect(lost.message).toContain("could not run in")
        expect(fake.recorded.starts).toEqual([])

        const dead = fakeSdk({
          startFailure: () => new Error("no hypervisor"),
          stopFailure: () => new Error("not running")
        })
        const provider = MicrosandboxSandbox.make({ sdk: dead.sdk, persistence: "sticky" })
        const name = yield* inSession(provider, "dead", (session) => Effect.succeed(session.remoteId))
        dead.wedge(name)
        const refused = yield* Effect.flip(inSession(provider, "dead", Effect.succeed))
        expect(refused.message).toContain(`the microVM ${name} stopped answering and could not be restarted`)
        expect(refused.cause).toEqual(new Error("no hypervisor"))

        // A crashed machine starts again attached when the session is not detached.
        const attached = fakeSdk()
        const inline = MicrosandboxSandbox.make({ sdk: attached.sdk, persistence: "sticky", detached: false })
        const [stdout] = yield* inSession(inline, "crashed", (session) =>
          Effect.gen(function*() {
            attached.loseGuest(session.remoteId)
            return yield* output(yield* session.spawn("printf back", {}))
          }).pipe(Effect.scoped))
        expect(stdout).toBe("back")
        expect(attached.recorded.starts).toEqual([{ name: attached.recorded.builds[0]!.name, detached: false }])

        // A guest that answers a fresh connection with a refusal is not restarted over it.
        let denials = 0
        const denied = fakeSdk({ connectFailure: () => denials++ === 0 ? undefined : new Error("permission denied") })
        const guarded = MicrosandboxSandbox.make({ sdk: denied.sdk, persistence: "sticky" })
        const machine = yield* inSession(guarded, "denied", (session) => Effect.succeed(session.remoteId))
        denied.wedge(machine)
        const kept = yield* Effect.flip(inSession(guarded, "denied", Effect.succeed))
        expect(kept.cause).toEqual(new Error("permission denied"))
        expect(denied.recorded.stops).toEqual([])
      }),
    30_000
  )

  it.effect("refuses to reattach a machine whose ownership labels it cannot record", () =>
    Effect.gen(function*() {
      for (const controls of [{ modifyApplied: false }, { modifyFailure: () => new Error("modify refused") }]) {
        const fake = fakeSdk(controls)
        const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, persistence: "sticky" })
        yield* inSession(provider, "unclaimable", () => Effect.void)
        const refused = yield* Effect.flip(inSession(provider, "unclaimable", () => Effect.void))
        expect(refused.code).toBe("unavailable")
        expect(refused.message).toContain("could not be opened")
        expect(fake.recorded.connects).toEqual([])
      }
    }))

  it.effect("rejects invalid configuration and cleans up partial provisioning", () =>
    Effect.gen(function*() {
      const invalidFake = fakeSdk()
      const invalid = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({
            sdk: invalidFake.sdk,
            image: "alpine",
            snapshot: "snapshot-7"
          }),
          "invalid",
          Effect.succeed
        )
      )
      expect((invalid as ProviderError).code).toBe("unavailable")
      expect((invalid as ProviderError).message).toContain("exclusive")
      expect(invalidFake.recorded.builds).toEqual([])

      const unavailableFake = fakeSdk({ createFailure: () => "no hypervisor" })
      const unavailable = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({ sdk: unavailableFake.sdk }),
          "unavailable",
          Effect.succeed
        )
      )
      expect((unavailable as ProviderError).code).toBe("unavailable")
      expect((unavailable as ProviderError).message).toContain("could not be opened")
      expect((unavailable as ProviderError).message).not.toContain("no hypervisor")
      expect((unavailable as ProviderError).cause).toBe("no hypervisor")

      // A real file where the workspace's parent should be refuses the mkdir.
      writeFileSync(join(root, "not-a-directory"), "occupied")
      const partialFake = fakeSdk()
      const partial = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({
            sdk: partialFake.sdk,
            workdir: join(root, "not-a-directory", "ws"),
            persistence: "sticky"
          }),
          "partial",
          Effect.succeed
        )
      )
      expect((partial as ProviderError).message).toContain("could not be prepared")
      expect(partialFake.recorded.destroys).toHaveLength(1)

      const destroyFailureFake = fakeSdk({ destroyFailure: () => new Error("could not remove") })
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: destroyFailureFake.sdk, workdir: join(root, "stop-failure-ws") }),
        "stop-failure",
        (session) => Effect.succeed(session.id)
      )
      // A failed graceful removal is retried once by force, and a removal
      // that still fails is logged, not raised: release does not fail.
      expect(destroyFailureFake.recorded.destroys.map(({ force }) => force === true)).toEqual([false, true])

      const forcedFake = fakeSdk({ destroyFailure: (_, force) => force ? undefined : new Error("stop timed out") })
      const forced = yield* inSession(
        MicrosandboxSandbox.make({ sdk: forcedFake.sdk, workdir: join(root, "forced-removal-ws") }),
        "forced-removal",
        (session) => Effect.succeed(session.remoteId)
      )
      expect(forcedFake.recorded.destroys).toEqual([
        { name: forced, timeoutMs: 3_000 },
        { name: forced, timeoutMs: 3_000, force: true }
      ])
      expect(forcedFake.machines.has(forced)).toBe(false)
    }))

  it.effect("maps guest filesystem, command, and ping failures", () =>
    Effect.gen(function*() {
      const workdir = join(root, "failures-ws")
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })

      const failures = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("failures")
          const locked = `${workdir}/locked.bin`
          yield* session.writeFile(locked, new Uint8Array([1]))
          chmodSync(locked, 0)
          const read = yield* Effect.flip(session.readFile(locked))
          // A real file where a parent directory should be refuses the parent
          // creation, and a real directory where the file should be refuses
          // the write itself.
          yield* session.writeFile(`${workdir}/occupied`, new Uint8Array([2]))
          const mkdir = yield* Effect.flip(session.writeFile(`${workdir}/occupied/out.bin`, new Uint8Array([3])))
          mkdirSync(join(workdir, "a-directory"), { recursive: true })
          const write = yield* Effect.flip(session.writeFile(`${workdir}/a-directory`, new Uint8Array([4])))
          fake.breakHostname(session.remoteId)
          const ping = yield* Effect.flip(session.ping!)
          const unknown = yield* session.spawn("definitely-not-a-command-9f2", {})
          const unknownOutput = yield* output(unknown)
          fake.markStopped(session.remoteId)
          const spawn = yield* Effect.flip(Effect.asVoid(session.spawn("printf late", {})))
          return { read, mkdir, write, ping, spawn, unknownOutput }
        })
      )

      expect((failures.read as ProviderError).code).toBe("unknown")
      expect((failures.mkdir as ProviderError).code).toBe("unknown")
      expect((failures.write as ProviderError).code).toBe("unknown")
      expect((failures.ping as ProviderError).code).toBe("unavailable")
      expect((failures.spawn as ProviderError).code).toBe("spawn_error")
      expect(failures.unknownOutput[2]).toBe(127)
      expect(failures.unknownOutput[1]).toContain("not found")
    }))
})

describe("MicrosandboxSandbox.reap", () => {
  const isAlive = (live: ReadonlyArray<string>) => (holder: string) => Effect.succeed(live.includes(holder))

  it.effect("removes only its owner's machines whose holder is dead, across pages", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ listPageSize: 1 })
      fake.plant("dead-running", ownership("installation-a", "dead"))
      fake.plant("dead-crashed", ownership("installation-a", "dead"), "crashed")
      fake.plant("alive", ownership("installation-a", "alive"))
      fake.plant("other-owner", ownership("installation-b", "dead"))
      fake.plant("foreign", { "smithers.owner": "installation-a", "smithers.holder": "dead" })
      fake.plant("no-holder", { "smithers.provider": "microsandbox", "smithers.owner": "installation-a" })

      const reaped = yield* MicrosandboxSandbox.reap({
        sdk: fake.sdk,
        owner: "installation-a",
        isAlive: isAlive(["alive"]),
        stopTimeoutMs: 1_000
      })

      expect(reaped).toEqual([
        { name: "dead-running", holder: "dead", status: "running" },
        { name: "dead-crashed", holder: "dead", status: "crashed" }
      ])
      expect([...fake.machines.keys()].sort()).toEqual(["alive", "foreign", "no-holder", "other-owner"])
      expect(fake.recorded.destroys).toEqual([
        { name: "dead-running", timeoutMs: 1_000 },
        { name: "dead-crashed", timeoutMs: 1_000 }
      ])
      // Four machines carry both labels (`foreign` lacks the provider label),
      // one per page.
      expect(fake.recorded.lists.map(({ cursor }) => cursor)).toEqual([undefined, "1", "2", "3"])
      expect(fake.recorded.lists[0]?.labels).toEqual({
        "smithers.provider": "microsandbox",
        "smithers.owner": "installation-a"
      })
    }))

  it.effect("leaves a dead holder's machine the caller retains by its labels", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("resumes", { ...ownership("installation-a", "dead"), "smithers.run": "live" })
      fake.plant("settled", { ...ownership("installation-a", "dead"), "smithers.run": "done" })
      fake.plant("unlabelled", ownership("installation-a", "dead"))
      const seen: Array<Readonly<Record<string, string>>> = []

      const reaped = yield* MicrosandboxSandbox.reap({
        sdk: fake.sdk,
        owner: "installation-a",
        isAlive: isAlive([]),
        retain: (labels) => {
          seen.push(labels)
          return Effect.succeed(labels["smithers.run"] === "live")
        }
      })

      expect(reaped.map(({ name }) => name).sort()).toEqual(["settled", "unlabelled"])
      expect([...fake.machines.keys()]).toEqual(["resumes"])
      expect(seen).toContainEqual({ ...ownership("installation-a", "dead"), "smithers.run": "live" })
    }))

  it.effect("skips a machine relabelled, vanished, or unreadable since the listing", () =>
    Effect.gen(function*() {
      let relabel = (): void => undefined
      const fake = fakeSdk({
        refreshFailure: (name) => {
          if (name === "relabelled") relabel()
          return name === "vanished" ? Object.assign(new Error("gone"), { code: "sandboxNotFound" }) : undefined
        },
        configJson: (name) => name === "garbled" ? "{not json" : undefined
      })
      fake.plant("relabelled", ownership("installation-a", "dead"))
      fake.plant("vanished", ownership("installation-a", "dead"))
      fake.plant("garbled", ownership("installation-a", "dead"))
      relabel = () => {
        fake.machines.get("relabelled")!.labels = ownership("installation-a", "reattached")
      }

      const reaped = yield* MicrosandboxSandbox.reap({ sdk: fake.sdk, owner: "installation-a", isAlive: isAlive([]) })

      expect(reaped).toEqual([])
      expect(fake.recorded.destroys).toEqual([])
      expect([...fake.machines.keys()].sort()).toEqual(["garbled", "relabelled", "vanished"])
    }))

  it.effect("forces a removal the graceful stop could not finish", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({
        destroyFailure: (name, force) => {
          if (force) return name === "stuck" ? new Error("force refused") : undefined
          // `settled` is removed by its graceful stop even though the stop
          // reports a failure, so the forced attempt finds nothing.
          if (name === "settled") fake.machines.delete(name)
          // `vanished` is gone before its removal is asked for.
          if (name === "vanished") return coded("sandboxNotFound", "gone")
          return new Error("stop timed out")
        }
      })
      fake.plant("forced", ownership("installation-a", "dead"))
      fake.plant("settled", ownership("installation-a", "dead"))
      fake.plant("vanished", ownership("installation-a", "dead"))
      fake.plant("stuck", ownership("installation-a", "dead"))

      const failure = yield* Effect.flip(
        MicrosandboxSandbox.reap({ sdk: fake.sdk, owner: "installation-a", isAlive: isAlive([]) })
      )

      expect(failure.message).toContain("1 orphaned microVM(s) could not be reaped: stuck")
      expect(fake.recorded.destroys.map(({ force, name }) => `${name}${force === true ? " forced" : ""}`)).toEqual([
        "forced",
        "forced forced",
        "settled",
        "settled forced",
        "vanished",
        "stuck",
        "stuck forced"
      ])
      expect([...fake.machines.keys()].sort()).toEqual(["stuck", "vanished"])
    }))

  it.effect("attempts every orphan and names the ones it could not remove", () =>
    Effect.gen(function*() {
      const stuck = new Error("destroy refused")
      const fake = fakeSdk({ destroyFailure: (name) => name === "stuck" ? stuck : undefined })
      fake.plant("stuck", ownership("installation-a", "dead"))
      fake.plant("removable", ownership("installation-a", "dead"))

      const failure = yield* Effect.flip(
        MicrosandboxSandbox.reap({ sdk: fake.sdk, owner: "installation-a", isAlive: isAlive([]) })
      )

      expect(failure.code).toBe("unavailable")
      expect(failure.message).toContain("1 orphaned microVM(s) could not be reaped: stuck")
      expect((failure.cause as ReadonlyArray<ProviderError>)[0]?.cause).toBe(stuck)
      expect([...fake.machines.keys()]).toEqual(["stuck"])
    }))

  it.effect("fails when the machines cannot be listed", () =>
    Effect.gen(function*() {
      const refused = new Error("database locked")
      const fake = fakeSdk({ listFailure: () => refused })
      const failure = yield* Effect.flip(
        MicrosandboxSandbox.reap({ sdk: fake.sdk, owner: "installation-a", isAlive: isAlive([]) })
      )
      expect(failure.code).toBe("unavailable")
      expect(failure.cause).toBe(refused)
    }))

  it("names the ownership labels", () => {
    expect([
      MicrosandboxSandbox.providerLabel,
      MicrosandboxSandbox.providerName,
      MicrosandboxSandbox.ownerLabel,
      MicrosandboxSandbox.holderLabel
    ]).toEqual(["smithers.provider", "microsandbox", "smithers.owner", "smithers.holder"])
  })
})

describe("MicrosandboxSandbox snapshots", () => {
  const token = "ghp_prepareTimeToken0123456789"
  /** Every file under `dir` whose bytes hold `needle`. */
  const holding = (dir: string, needle: string): Array<string> =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => readFileSync(path).includes(needle))

  /** Prepares a sticky machine with `token` in its environment, runs `setup` in it, and names the machine. */
  const prepared = (fake: ReturnType<typeof fakeSdk>, setup: string): Effect.Effect<string, ProviderError> =>
    inSession(
      MicrosandboxSandbox.make({ sdk: fake.sdk, persistence: "sticky", env: { GITHUB_TOKEN: token } }),
      "prepare",
      (session) =>
        Effect.scoped(Effect.map(Effect.flatMap(session.spawn(setup, {}), output), ([, stderr, code]) => {
          expect({ stderr, code }).toEqual({ stderr: "", code: 0 })
          return session.remoteId
        }))
    )

  it.effect("scrubs a token preparation stored in a credential file, so a restored machine holds none", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      // The workspace is /workspace, so ../root is the guest's /root.
      const machine = yield* prepared(
        fake,
        `echo installed > deps.txt && mkdir -p ../root/.config/gh ../home/dev ../root/.codex && ` +
          `printf 'https://x:%s@github.com\\n' "$GITHUB_TOKEN" > ../root/.git-credentials && ` +
          `printf 'github.com:\\n  oauth_token: %s\\n' "$GITHUB_TOKEN" > ../root/.config/gh/hosts.yml && ` +
          `printf 'machine github.com password %s\\n' "$GITHUB_TOKEN" > ../home/dev/.netrc && ` +
          `printf '{"tokens":"%s"}' "$GITHUB_TOKEN" > ../root/.codex/auth.json`
      )
      expect(holding(fake.machineRoot(machine), token)).toHaveLength(4)

      const name = yield* MicrosandboxSandbox.captureSnapshot({
        sdk: fake.sdk,
        machine,
        family: "env",
        member: "1",
        secrets: [token]
      })
      expect(fake.machines.has(machine)).toBe(false)
      // The secret reaches the guest's scan on standard input, never a command line.
      expect(fake.recorded.execs.some((exec) => exec.args.join(" ").includes(token))).toBe(false)

      const restored = yield* inSession(
        MicrosandboxSandbox.make({ sdk: fake.sdk, snapshot: name }),
        "restored",
        (session) =>
          Effect.gen(function*() {
            expect(new TextDecoder().decode(yield* session.readFile("/workspace/deps.txt"))).toBe("installed\n")
            const missing = yield* Effect.flip(session.readFile("/root/.git-credentials"))
            expect(missing.code).toBe("not_found")
            return holding(fake.machineRoot(session.remoteId), token)
          })
      )
      expect(restored).toEqual([])
      expect(holding(fake.snapshots.get(name)!.disk!, token)).toEqual([])
    }))

  it.effect("refuses to capture a disk that still holds a secret, names where, and removes the machine", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const machine = yield* prepared(fake, `mkdir -p cache && printf 'key=%s' "$GITHUB_TOKEN" > cache/config`)
      const refused = yield* Effect.flip(
        MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine,
          family: "env",
          member: "1",
          secrets: [`short\n${token}\n`]
        })
      )
      expect(refused).toMatchObject({
        code: "unavailable",
        message: `microsandbox: the microVM ${machine} was not captured as env.1: ` +
          "a secret is still on its disk at /workspace/cache/config"
      })
      expect(refused.message).not.toContain(token)
      expect(fake.snapshots.size).toBe(0)
      expect(fake.recorded.stops).toEqual([])
      expect(fake.machines.has(machine)).toBe(false)
    }))

  it.effect("searches for a multi-line secret's longest line, so an armor line elsewhere does not refuse", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      const armor = "-----BEGIN OPENSSH PRIVATE KEY-----"
      const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW"
      const key = `${armor}\n${body}\nQyNTUxOQAAACD=\n-----END OPENSSH PRIVATE KEY-----\n`
      mkdirSync(join(fake.machineRoot("prepared"), "etc", "ssh"), { recursive: true })
      writeFileSync(join(fake.machineRoot("prepared"), "etc", "ssh", "known"), `${armor}\n{\n}\n`)
      expect(
        yield* MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: [key, key]
        })
      ).toBe("base.1")
    }))

  it.effect("refuses a secret too short to search for before any guest call, and keeps the machine", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      const refused = yield* Effect.flip(
        MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: ["long enough secret", "abc\nde"]
        })
      )
      expect(refused).toMatchObject({
        code: "unavailable",
        message: "microsandbox: secret 1 has no line of 8 or more bytes to search prepared's disk for"
      })
      expect(refused.message).not.toContain("abc")
      expect(fake.recorded.execs).toEqual([])
      expect(fake.machines.has("prepared")).toBe(true)
    }))

  it.effect("names the files holding a secret even when the search could not read every file", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      const disk = fake.machineRoot("prepared")
      writeFileSync(join(disk, "etc", "leak"), `token=${token}`)
      writeFileSync(join(disk, "etc", "locked"), "unreadable")
      chmodSync(join(disk, "etc", "locked"), 0)
      const refused = yield* Effect.flip(
        MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: [token]
        })
      )
      expect(refused.message).toBe(
        "microsandbox: the microVM prepared was not captured as base.1: a secret is still on its disk at /etc/leak"
      )
      expect(fake.snapshots.size).toBe(0)
    }))

  it.effect("refuses to capture a disk it could not scrub, with the guest's words", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      // A directory where a credential file belongs: `rm -f` cannot remove it.
      mkdirSync(join(fake.machineRoot("prepared"), "root", ".netrc"), { recursive: true })
      const refused = yield* Effect.flip(
        MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: []
        })
      )
      expect(refused.code).toBe("unavailable")
      expect(refused.message).toMatch(
        /^microsandbox: the disk of prepared could not be scrubbed of credentials \(exit 2\): rm: .*\.netrc/
      )
      expect(fake.snapshots.size).toBe(0)
      expect(fake.machines.has("prepared")).toBe(false)
    }))

  it.effect("captures a running or stopped machine, removes it, and reports what exists", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      fake.plant("parked", ownership("installation-a", "host"), "stopped")
      expect(yield* MicrosandboxSandbox.hasSnapshot(fake.sdk, "base.1")).toBe(false)
      expect(
        yield* MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: []
        })
      )
        .toBe("base.1")
      expect(
        yield* MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "parked",
          family: "base",
          member: "2",
          secrets: [],
          stopTimeoutMs: 1_000
        })
      ).toBe("base.2")
      expect(yield* MicrosandboxSandbox.hasSnapshot(fake.sdk, "base.1")).toBe(true)
      expect(fake.recorded.stops).toEqual(["prepared", "parked"])
      expect(fake.recorded.starts).toEqual([{ name: "parked", detached: false }])
      expect(fake.snapshots.get("base.1")?.source).toBe("prepared")
      expect([...fake.machines.keys()]).toEqual([])
      expect(fake.recorded.destroys).toEqual([
        { name: "prepared", timeoutMs: 30_000, force: true },
        { name: "parked", timeoutMs: 1_000, force: true }
      ])
    }))

  it.effect("removes the machine even when the capture fails, and names both failures", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({
        snapshotFailure: () => new Error("disk busy"),
        snapshotReadFailure: () => "index locked"
      })
      fake.plant("prepared", ownership("installation-a", "host"))
      const captured = yield* Effect.flip(
        MicrosandboxSandbox.captureSnapshot({
          sdk: fake.sdk,
          machine: "prepared",
          family: "base",
          member: "1",
          secrets: []
        })
      )
      expect(captured.message).toBe("microsandbox: the microVM prepared could not be captured as base.1")
      expect(fake.machines.has("prepared")).toBe(false)
      const read = yield* Effect.flip(MicrosandboxSandbox.hasSnapshot(fake.sdk, "base.1"))
      expect(read).toMatchObject({ code: "unavailable", message: "microsandbox: snapshot base.1 could not be read" })
    }))

  it.effect("refuses a family and member that do not name exactly one family's snapshot, and keeps the machine", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("prepared", ownership("installation-a", "host"))
      for (const [family, member] of [["base", "1.2"], ["", "1"], ["base", ""]] as const) {
        const refused = yield* Effect.flip(
          MicrosandboxSandbox.captureSnapshot({ sdk: fake.sdk, machine: "prepared", family, member, secrets: [] })
        )
        expect(refused.code).toBe("unavailable")
        expect(refused.message).toContain(
          `family ${JSON.stringify(family)} and member ${JSON.stringify(member)} do not name`
        )
      }
      expect(fake.machines.has("prepared")).toBe(true)
      expect(fake.recorded.stops).toEqual([])
      expect(MicrosandboxSandbox.snapshotName("base", "1.2")).toBeUndefined()
      expect(MicrosandboxSandbox.snapshotName("smthrs-env.repo", "1")).toBe("smthrs-env.repo.1")
      expect(MicrosandboxSandbox.snapshotFamily("smthrs-env.repo.1")).toBe("smthrs-env.repo")
      expect(MicrosandboxSandbox.snapshotFamily("base")).toBeUndefined()
      expect(MicrosandboxSandbox.snapshotFamily(".1")).toBeUndefined()
      expect(MicrosandboxSandbox.snapshotFamily("base.")).toBeUndefined()
    }))

  it.effect("removes one snapshot, and one already gone, and names a removal that fails", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.plant("base", ownership("installation-a", "host"))
      yield* MicrosandboxSandbox.captureSnapshot({
        sdk: fake.sdk,
        machine: "base",
        family: "base",
        member: "1",
        secrets: []
      })
      yield* MicrosandboxSandbox.removeSnapshot(fake.sdk, "base.1")
      expect(fake.snapshots.has("base.1")).toBe(false)
      yield* MicrosandboxSandbox.removeSnapshot(fake.sdk, "base.1")
      const broken = {
        ...fake.sdk,
        Snapshot: { ...fake.sdk.Snapshot, remove: () => Promise.reject("index locked") }
      }
      const failure = yield* Effect.flip(MicrosandboxSandbox.removeSnapshot(broken, "base.1"))
      expect(failure).toMatchObject({
        code: "unavailable",
        message: "microsandbox: snapshot base.1 could not be removed"
      })
    }))

  it.effect("prunes a family down to its newest members and leaves every other snapshot", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      for (const [family, member] of [["fam", "a"], ["fam", "b"], ["fam", "c"], ["other", "a"]] as const) {
        fake.plant(member, ownership("installation-a", "host"))
        yield* MicrosandboxSandbox.captureSnapshot({ sdk: fake.sdk, machine: member, family, member, secrets: [] })
      }
      fake.snapshots.set("fam", { name: "fam", createdAt: new Date(0), source: "bare" })
      expect(yield* MicrosandboxSandbox.pruneSnapshots(fake.sdk, "fam", 1)).toEqual(["fam.b", "fam.a"])
      expect([...fake.snapshots.keys()].sort()).toEqual(["fam", "fam.c", "other.a"])
      expect(yield* MicrosandboxSandbox.pruneSnapshots(fake.sdk, "other", -1, ["other.a"])).toEqual([])
      expect(yield* MicrosandboxSandbox.pruneSnapshots(fake.sdk, "other", -1)).toEqual(["other.a"])
      const broken = {
        ...fake.sdk,
        Snapshot: { ...fake.sdk.Snapshot, list: () => Promise.reject(new Error("no index")) }
      }
      const failure = yield* Effect.flip(MicrosandboxSandbox.pruneSnapshots(broken, "fam", 1))
      expect(failure.message).toBe("microsandbox: the snapshot family fam could not be pruned")
    }))

  it.effect("prunes one family and leaves another whose name extends it", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      for (
        const [family, member] of [
          ["smthrs-env-aaaa-repo", "old"],
          ["smthrs-env-aaaa-repo", "new"],
          ["smthrs-env-aaaa-repo-other", "keep"]
        ] as const
      ) {
        fake.plant(member, ownership("installation-a", "host"))
        yield* MicrosandboxSandbox.captureSnapshot({ sdk: fake.sdk, machine: member, family, member, secrets: [] })
      }
      expect(yield* MicrosandboxSandbox.pruneSnapshots(fake.sdk, "smthrs-env-aaaa-repo", 1)).toEqual([
        "smthrs-env-aaaa-repo.old"
      ])
      expect([...fake.snapshots.keys()].sort()).toEqual(["smthrs-env-aaaa-repo-other.keep", "smthrs-env-aaaa-repo.new"])
      expect(yield* MicrosandboxSandbox.pruneSnapshots(fake.sdk, "smthrs-env-aaaa-repo-other", 0)).toEqual([
        "smthrs-env-aaaa-repo-other.keep"
      ])
      expect([...fake.snapshots.keys()]).toEqual(["smthrs-env-aaaa-repo.new"])
    }))
})
