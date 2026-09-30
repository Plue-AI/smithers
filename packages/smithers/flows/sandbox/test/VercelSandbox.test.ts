import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import * as VercelSandbox from "../src/VercelSandbox/index.ts"
import type { Sdk } from "../src/VercelSandbox/Sdk.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type CreateInput = Parameters<Sdk["Sandbox"]["getOrCreate"]>[0]
type VendorSandbox = Awaited<ReturnType<Sdk["Sandbox"]["getOrCreate"]>>
type RunInput = Parameters<VendorSandbox["runCommand"]>[0]
type CommandFinished = Awaited<ReturnType<VendorSandbox["runCommand"]>>

// -----------------------------------------------------------------------------
// The Vercel SDK as a fake: real programs behind the vendor's promise surface.
// -----------------------------------------------------------------------------

// The fake emulates only what `@vercel/sandbox` adds around a machine — the
// named-sandbox registry, the promise-shaped `runCommand` that resolves once
// the command finished with its output as strings, `readFile` answering a
// Node stream or `null`, and the vendor error shapes. Underneath, every
// command is the real program run by the platform spawner against a real
// directory tree, and the file surface reads and writes that same tree, so
// what the provider proves here is agreement with a machine, not with a
// script table.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-vercel-sandbox-")))
// The image's own working directory, which `/vercel/sandbox` is on the real
// machine: the default `cwd` of every command and the base of relative paths.
const home = join(root, "vercel-home")
mkdirSync(home)
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const dir = (label: string): string => mkdtempSync(join(root, `${label}-`))

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

interface FinishedRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const finishedRun = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined
): Promise<FinishedRun> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        // The sandbox image gives commands its own base environment plus the
        // caller's variables, which on this host is the process environment
        // plus the request's.
        const child = yield* local.spawn(ChildProcess.make(file, [...args], { cwd, env: { ...env }, extendEnv: true }))
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, exitCode }
      })
    )
  )

interface Faults {
  removeWait?: Effect.Effect<void>
  releaseWait?: Effect.Effect<void>
  removeExitCode?: number

  /** The control plane refuses the acquire call. */
  acquireFailure?: unknown
  /** `extendTimeout` is refused (plan limit reached). */
  extendFailure?: unknown
  /** `stop` is refused (the session already ended). */
  stopFailure?: unknown
  /** `readFile` is refused before any stream is handed out. */
  readFailure?: unknown
  /** Every `runCommand` call is refused (the API is unreachable). */
  runFailure?: unknown
  /** Fetching a finished command's stdout fails. */
  stdoutFailure?: unknown
  /** Fetching a finished command's stderr fails. */
  stderrFailure?: unknown
  /** The machine reports every command finished with this status (a dying VM). */
  commandFailure?: { readonly exitCode: number } | undefined
  /** File reads arrive as UTF-8 text chunks rather than bytes. */
  textReads?: boolean
  /** File reads reuse one backing buffer for every yielded chunk. */
  reuseReadBuffer?: boolean
  /** `writeFiles` overwrites byte buffers after it has consumed them. */
  mutateWriteBuffers?: boolean
  updateFailure?: Error
  /** The SDK reports no session deadline. */
  hideExpiry?: boolean
  /** The SDK reports no vCPU count. */
  hideVcpus?: boolean
}

interface Machine {
  readonly name: string
  running: boolean
  readonly vcpus?: number
  readonly timeout: number
  expiresAt: number
}

interface Recorded {
  readonly acquired: Array<CreateInput>
  readonly commands: Array<RunInput>
  readonly extended: Array<number>
  /** Each network policy update, with how many commands ran before it. */
  readonly updates: Array<{ readonly networkPolicy: unknown; readonly commandsBefore: number }>
  readonly stopped: Array<string>
  readonly writes: Array<{ readonly path: string; readonly content: Uint8Array }>
}

const fakeSdk = (faults: Faults = {}): { readonly sdk: Sdk; readonly recorded: Recorded } => {
  const recorded: Recorded = { acquired: [], commands: [], extended: [], updates: [], stopped: [], writes: [] }
  // The test clock stands at the epoch, so session deadlines are offsets from it.
  const machines = new Map<string, Machine>()
  const finished = (result: FinishedRun): CommandFinished => ({
    exitCode: result.exitCode,
    stdout: () =>
      faults.stdoutFailure === undefined ? Promise.resolve(result.stdout) : Promise.reject(faults.stdoutFailure),
    stderr: () =>
      faults.stderrFailure === undefined ? Promise.resolve(result.stderr) : Promise.reject(faults.stderrFailure)
  })
  // Relative paths resolve the way the vendor documents them: "Defaults to
  // writing to /vercel/sandbox unless an absolute path is specified."
  const resolve = (path: string): string => isAbsolute(path) ? path : join(home, path)
  const instance = (machine: Machine): VendorSandbox => ({
    name: machine.name,
    vcpus: faults.hideVcpus === true ? undefined : machine.vcpus,
    get expiresAt() {
      return faults.hideExpiry === true ? undefined : new Date(machine.expiresAt)
    },
    runCommand: async (request) => {
      recorded.commands.push(request)
      if (request.cmd === "rm" && faults.removeWait !== undefined) await Effect.runPromise(faults.removeWait)
      if (request.cmd === "rm" && faults.removeExitCode !== undefined) {
        return finished({ exitCode: faults.removeExitCode, stdout: "", stderr: "" })
      }
      if (faults.runFailure !== undefined) throw faults.runFailure
      // "A persistent sandbox still auto-resumes on the first SDK call that
      // needs a running session (such as `runCommand`)."
      machine.running = true
      if (faults.commandFailure !== undefined) {
        return finished({ stdout: "", stderr: "", exitCode: faults.commandFailure.exitCode })
      }
      return finished(await finishedRun(request.cmd, request.args ?? [], request.cwd ?? home, request.env))
    },
    readFile: async ({ path }) => {
      if (faults.readFailure !== undefined) throw faults.readFailure
      const at = resolve(path)
      if (!existsSync(at)) return null
      if (faults.reuseReadBuffer === true) {
        const content = new Uint8Array(readFileSync(at))
        return (async function*() {
          const reused = new Uint8Array(2)
          for (let offset = 0; offset < content.length; offset += reused.length) {
            const length = Math.min(reused.length, content.length - offset)
            reused.fill(0)
            reused.set(content.subarray(offset, offset + length))
            yield reused.subarray(0, length)
          }
        })()
      }
      return faults.textReads === true ? createReadStream(at, "utf8") : createReadStream(at)
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const content = typeof file.content === "string" ? encoder.encode(file.content) : file.content
        recorded.writes.push({ path: file.path, content: content.slice() })
        writeFileSync(resolve(file.path), content)
        if (faults.mutateWriteBuffers === true && typeof file.content !== "string") file.content.fill(0)
      }
    },
    extendTimeout: async (duration) => {
      recorded.extended.push(duration)
      if (faults.extendFailure !== undefined) throw faults.extendFailure
      machine.expiresAt += duration
    },
    update: async ({ networkPolicy }) => {
      recorded.updates.push({ networkPolicy, commandsBefore: recorded.commands.length })
      if (faults.updateFailure !== undefined) throw faults.updateFailure
    },
    stop: async () => {
      recorded.stopped.push(machine.name)
      machine.running = false
      if (faults.releaseWait !== undefined) await Effect.runPromise(faults.releaseWait)
      if (faults.stopFailure !== undefined) throw faults.stopFailure
    }
  })
  // The vendor's documented `getOrCreate` flow: try `get` first, and on
  // not_found create a sandbox with that name (sandbox.d.ts).
  const get = (name: string) => machines.get(name)
  // "Your sandbox will get the amount of vCPUs you specify here" (sandbox.d.ts);
  // a sandbox created without `resources` gets the vendor default of 2.
  // A created sandbox keeps `timeout` as its own and every session it starts
  // runs on that one: "The default timeout of this sandbox" (sandbox.d.ts).
  const create = (name: string, vcpus = 2, timeout = 5 * 60_000) => {
    const machine: Machine = { name, running: true, vcpus, timeout, expiresAt: timeout }
    machines.set(name, machine)
    return machine
  }
  const getOrCreate: Sdk["Sandbox"]["getOrCreate"] = async (input) => {
    recorded.acquired.push(input)
    if (faults.acquireFailure !== undefined) throw faults.acquireFailure
    const existing = get(input.name)
    if (existing === undefined) return instance(create(input.name, input.resources?.vcpus, input.timeout))
    if (input.resume === true && !existing.running) {
      existing.running = true
      existing.expiresAt = existing.timeout
    }
    return instance(existing)
  }
  return { sdk: { Sandbox: { getOrCreate } }, recorded }
}

const acquired = <A, E>(
  provider: ReturnType<typeof VercelSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("VercelSandbox", () => {
  for (const operation of ["remove", "release"] as const) {
    it.effect(`bounds stalled ${operation} on the platform timer`, () =>
      stalledFinalizer((stall) => {
        const fake = fakeSdk(operation === "remove" ? { removeWait: stall } : { releaseWait: stall })
        return acquired(VercelSandbox.make({ sdk: fake.sdk, workdir: dir("stalled-finalizer") }), (session) =>
          output(session, "true", operation === "remove" ? { stdin: encoder.encode("input") } : {}))
      }, operation === "remove" ? ".smthrs-stdin/" : "smthrs-"))
  }

  it.effect("forwards a neutral network allowlist and reapplies it to a resumed sandbox before preparing the guest", () =>
    Effect.gen(function*() {
      const { sdk, recorded } = fakeSdk()
      const provider = VercelSandbox.make({
        sdk,
        workdir: dir("network-policy"),
        network: { allow: ["registry.npmjs.org", "*.github.com"] }
      })
      yield* acquired(provider, () => Effect.void)
      yield* acquired(provider, () => Effect.void)
      const policy = { allow: ["registry.npmjs.org", "*.github.com"] }
      expect(recorded.acquired.map((input) => input.networkPolicy)).toEqual([policy, policy])
      // Each update lands before the workspace-preparing `mkdir` of its acquire.
      expect(recorded.updates).toEqual([
        { networkPolicy: policy, commandsBefore: 0 },
        { networkPolicy: policy, commandsBefore: 1 }
      ])
      expect(recorded.commands.map((command) => command.cmd)).toEqual(["mkdir", "mkdir"])
    }))

  it.effect("forwards neutral limits as vcpus and lifetime, and refuses a resumed sandbox of another size", () =>
    Effect.gen(function*() {
      const { sdk, recorded } = fakeSdk()
      const workdir = dir("limits")
      yield* acquired(
        VercelSandbox.make({ sdk, workdir, limits: { cpus: 4, memoryMib: 8192, timeoutSecs: 900 } }),
        () => Effect.void
      )
      expect(recorded.acquired[0]).toMatchObject({ resources: { vcpus: 4 }, timeout: 5 * 60_000 })
      expect(recorded.extended).toEqual([10 * 60_000])
      const resized = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk, workdir, limits: { memoryMib: 4096 } }), () => Effect.void)
      )
      expect(recorded.acquired[1]?.resources).toEqual({ vcpus: 2 })
      expect(resized.code).toBe("unavailable")
      expect(resized.message).toContain("holds 4 vCPU, not the requested 2")
      expect(recorded.commands.map((command) => command.cmd)).toEqual(["mkdir"])
      expect(recorded.stopped).toHaveLength(2)
      yield* acquired(VercelSandbox.make({ sdk, workdir: dir("unlimited") }), () => Effect.void)
      expect(recorded.acquired[2]).not.toHaveProperty("resources")
    }))

  it.effect("holds a resumed session to the neutral lifetime and extends from its real deadline", () =>
    Effect.gen(function*() {
      const refusal = (error: ProviderError) => `${error.code}: ${error.message}`

      // A stopped sandbox created with a five-minute timeout resumes on it,
      // not on the 60 seconds asked for now.
      const stopped = fakeSdk()
      const workdir = dir("lifetime")
      yield* acquired(
        VercelSandbox.make({ sdk: stopped.sdk, workdir, limits: { timeoutSecs: 300 } }),
        () => Effect.void
      )
      const resumed = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: stopped.sdk, workdir, limits: { timeoutSecs: 60 } }), () => Effect.void)
      )
      expect(refusal(resumed)).toMatch(
        /^unavailable: vercel-sandbox: smthrs-run-1-\S+ runs 240000ms past limits\.timeoutSecs 60$/
      )
      expect(stopped.recorded.commands.map((command) => command.cmd)).toEqual(["mkdir"])

      // A running session keeps its own deadline.
      const running = fakeSdk()
      const inner = yield* acquired(
        VercelSandbox.make({ sdk: running.sdk, workdir, timeoutMs: 15 * 60_000 }),
        () =>
          Effect.flip(
            acquired(VercelSandbox.make({ sdk: running.sdk, workdir, limits: { timeoutSecs: 60 } }), () => Effect.void)
          )
      )
      expect(inner.message).toContain("runs 840000ms past limits.timeoutSecs 60")
      expect(running.recorded.commands.map((command) => command.cmd)).toEqual(["mkdir"])

      // A session with no reported deadline cannot be held to one.
      const blind = fakeSdk({ hideExpiry: true })
      const unknown = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: blind.sdk, workdir, limits: { timeoutSecs: 60 } }), () => Effect.void)
      )
      expect(unknown.message).toContain("reports no session deadline, so limits.timeoutSecs cannot be enforced")
      expect(blind.recorded.commands).toEqual([])
      // Without a ceiling to hold, an unreported deadline extends by the create remainder.
      yield* acquired(VercelSandbox.make({ sdk: blind.sdk, workdir, timeoutMs: 15 * 60_000 }), () => Effect.void)
      expect(blind.recorded.extended).toEqual([10 * 60_000])
      // An unreported vCPU count cannot be held to one either.
      const unsized = fakeSdk({ hideVcpus: true })
      const sized = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: unsized.sdk, workdir, limits: { cpus: 2 } }), () => Effect.void)
      )
      expect(sized.message).toContain("holds an unreported number of vCPU, not the requested 2")

      // A resumed session on a two-minute sandbox timeout is extended by what
      // it lacks, not by the gap a fresh five-minute session would have.
      const short = fakeSdk()
      yield* acquired(VercelSandbox.make({ sdk: short.sdk, workdir, timeoutMs: 2 * 60_000 }), () => Effect.void)
      yield* acquired(VercelSandbox.make({ sdk: short.sdk, workdir, limits: { timeoutSecs: 900 } }), () => Effect.void)
      expect(short.recorded.extended).toEqual([13 * 60_000])
    }))

  it("refuses limits Vercel cannot enforce when make is called", () => {
    const { sdk } = fakeSdk()
    expect(() => VercelSandbox.make({ sdk, limits: { cpus: 1.5 } })).toThrow(/limits\.cpus.*whole vCPUs/)
    expect(() => VercelSandbox.make({ sdk, limits: { memoryMib: 3000 } })).toThrow(/limits\.memoryMib.*whole vCPUs/)
    expect(() => VercelSandbox.make({ sdk, limits: { cpus: 2, memoryMib: 2048 } })).toThrow(/2 vCPU at 4096 MiB/)
    expect(() => VercelSandbox.make({ sdk, limits: { timeoutSecs: 60 }, timeoutMs: 60_000 })).toThrow(/exclusive/)
    expect(() => VercelSandbox.make({ sdk, limits: { cpus: 0 } })).toThrow(/positive/)
  })

  it.effect("maps `none` and an omitted option to deny-all and `open` to allow-all", () =>
    Effect.gen(function*() {
      const { sdk, recorded } = fakeSdk()
      yield* acquired(VercelSandbox.make({ sdk, workdir: dir("network-none"), network: "none" }), () => Effect.void)
      yield* acquired(VercelSandbox.make({ sdk, workdir: dir("network-default") }), () => Effect.void)
      yield* acquired(VercelSandbox.make({ sdk, workdir: dir("network-open"), network: "open" }), () => Effect.void)
      expect(recorded.acquired[0]?.networkPolicy).toBe("deny-all")
      expect(recorded.acquired[1]?.networkPolicy).toBe("deny-all")
      // `open` lifts an earlier policy a resumed sandbox still carries.
      expect(recorded.acquired[2]?.networkPolicy).toBe("allow-all")
      expect(recorded.updates).toEqual([
        { networkPolicy: "deny-all", commandsBefore: 0 },
        { networkPolicy: "deny-all", commandsBefore: 1 },
        { networkPolicy: "allow-all", commandsBefore: 2 }
      ])
    }))

  it.effect("maps an empty allowlist to deny-all on create and on the reattach update", () =>
    Effect.gen(function*() {
      const { sdk, recorded } = fakeSdk()
      // Vercel's documented DNS block is `deny-all`, so an empty list says it.
      yield* acquired(VercelSandbox.make({ sdk, workdir: dir("network-empty"), network: { allow: [] } }), () =>
        Effect.void)
      expect(recorded.acquired[0]?.networkPolicy).toBe("deny-all")
      expect(recorded.updates).toEqual([{ networkPolicy: "deny-all", commandsBefore: 0 }])
    }))

  it.effect("fails the acquire without a guest command when the policy cannot be applied", () =>
    Effect.gen(function*() {
      const { sdk, recorded } = fakeSdk({ updateFailure: new Error("policy refused") })
      const error = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk, workdir: dir("network-refused"), network: "none" }), () => Effect.void)
      )
      expect(error).toMatchObject({ code: "unavailable" })
      expect(recorded.commands).toEqual([])
      expect(recorded.stopped).toHaveLength(1)
    }))

  it("refuses a malformed network policy at construction", () => {
    const { sdk, recorded } = fakeSdk()
    expect(() => VercelSandbox.make({ sdk, network: { allow: ["http://example.com"] } }))
      .toThrow("vercel-sandbox: network allowlist entry is not a host name: http://example.com")
    expect(() => VercelSandbox.make({ sdk, network: { allow: "example.com" } as never }))
      .toThrow(`vercel-sandbox: network must be "none", "open" or { allow: string[] }`)
    expect(recorded.acquired).toEqual([])
  })

  it.effect("reports failed staged stdin removal without claiming the file was removed", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ removeExitCode: 1 })
      const provider = VercelSandbox.make({ sdk: fake.sdk, workdir: dir("remove-failure") })
      const warnings: Array<unknown> = []
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* output(session, "true", { stdin: encoder.encode("private input") })
          expect(existsSync(fake.recorded.writes.at(-1)!.path)).toBe(true)
          expect(warnings).toHaveLength(1)
        })).pipe(Effect.provide(Logger.layer([Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry)
        })])))
    }))

  it.effect("omits vendor credentials from teardown warnings", () =>
    Effect.gen(function*() {
      const secret = "TEARDOWN_CANARY_CREDENTIAL"
      const fake = fakeSdk({ stopFailure: new Error(`Authorization: Bearer ${secret}`) })
      const lines: Array<string> = []
      const records: Array<unknown> = []
      const capture = Logger.make((options) => {
        records.push({ message: options.message, cause: options.cause.reasons })
      })
      const keep = (line: string) => {
        lines.push(line)
      }
      yield* acquired(VercelSandbox.make({ sdk: fake.sdk, workdir: dir("safe-stop") }), Effect.succeed).pipe(
        Effect.provide(
          Logger.layer([capture, Logger.map(Logger.formatJson, keep), Logger.map(Logger.formatLogFmt, keep)])
        )
      )
      expect(fake.recorded.stopped).toHaveLength(1)
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        expect(line).not.toContain(secret)
        expect(line).toContain("unknown")
      }
      expect(records).toEqual([{
        message: ["sandbox teardown failed", { provider: "vercel", operation: "stop", code: "unknown" }],
        cause: []
      }])
    }))

  it.effect("deletes guest inherited environment separately from command defaults", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = VercelSandbox.make({
        sdk: fake.sdk,
        workdir: dir("env-delete"),
        commandEnv: { DEFAULT: "default" }
      })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect((yield* output(session, `printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
          const result = yield* output(session, `printf '%s:%s:%s' "\${HOME+present}" "$DEFAULT" "$KEEP"`, {
            env: { KEEP: "a 'quoted' $value", HOME: undefined, PATH: undefined, DEFAULT: undefined }
          })
          expect(result).toEqual({ stdout: "::a 'quoted' $value", code: 0 })
          expect(fake.recorded.commands.at(-1)?.args?.join(" ")).toContain("-u HOME")
          expect((yield* output(session, `printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
        }))
    }), 60_000)

  it.effect("passes SandboxConformance running real programs against a real tree", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      const violations = yield* SandboxConformance.check(
        VercelSandbox.make({ sdk, workdir: dir("conformance") }),
        { provides: { ping: true } }
      )
      expect(violations).toEqual([])
      // Every shell line reaches the machine as `sh -c`, never a login shell
      // whose profile output would land in parsed stdout.
      const shells = recorded.commands.filter((command) => command.cmd === "sh")
      expect(shells.length).toBeGreaterThan(0)
      expect(shells.every((command) => command.args?.[0] === "-c")).toBe(true)
    }), 60_000)

  it.effect("uses deterministic persistence, explicit credentials, and the timeout remainder", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      const work = dir("persist")
      const provider = VercelSandbox.make({
        sdk,
        oidcToken: "explicit-oidc",
        token: "pat",
        teamId: "team",
        projectId: "project",
        env: { VERCEL_OIDC_TOKEN: "ambient-oidc" },
        timeoutMs: 15 * 60_000,
        maxDurationMs: 15 * 60_000,
        runtime: "node22",
        commandEnv: { STATIC_PROOF: "static", KEEP_ME: "kept", REMOVE_ME: "base" },
        workdir: work
      })
      const first = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect(session.id).toBe("run-1")
          yield* session.writeFile(`${work}/persisted.bin`, new Uint8Array([0, 255]))
          return yield* Effect.scoped(
            Effect.flatMap(
              session.spawn(`printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`, {
                env: { SPAWN_PROOF: "spawn", REMOVE_ME: undefined, OMITTED: undefined }
              }),
              (process) => Stream.mkString(Stream.decodeText(process.stdout))
            )
          )
        }))
      const second = yield* acquired(
        provider,
        (session) =>
          Effect.map(session.readFile(`${work}/persisted.bin`), (content) => ({
            remoteId: session.remoteId,
            content
          }))
      )

      expect(first).toBe("static:spawn")
      expect(second.remoteId).toBe(recorded.acquired[0]?.name)
      expect(second.content).toEqual(new Uint8Array([0, 255]))
      expect(recorded.acquired).toHaveLength(2)
      expect(recorded.acquired[0]).toMatchObject({
        token: "explicit-oidc",
        timeout: 5 * 60_000,
        persistent: true,
        resume: true,
        runtime: "node22"
      })
      expect(recorded.acquired[0]?.name).toMatch(/^smthrs-run-1-/)
      expect(recorded.extended).toEqual([10 * 60_000, 10 * 60_000])
      expect(recorded.stopped).toHaveLength(2)
      const spawned = recorded.commands.find((command) => command.cmd === "sh")
      expect(spawned?.args?.[0]).toBe("-c")
      expect(spawned?.env).toEqual({})
      expect(spawned?.args?.[1]).toContain(
        "-u REMOVE_ME -u OMITTED STATIC_PROOF=static KEEP_ME=kept SPAWN_PROOF=spawn /bin/sh -c"
      )
    }))

  it.effect("resolves caller-supplied credential sources in precedence order", () =>
    Effect.gen(function*() {
      const work = dir("credentials")
      const ambient = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: ambient.sdk,
          token: "pat",
          teamId: "team",
          projectId: "project",
          env: { VERCEL_OIDC_TOKEN: "ambient" },
          workdir: work
        }),
        Effect.succeed
      )
      expect(ambient.recorded.acquired[0]).toMatchObject({ token: "ambient" })
      expect(ambient.recorded.acquired[0]).not.toHaveProperty("teamId")

      const personal = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: personal.sdk,
          env: { VERCEL_TOKEN: "env-pat", VERCEL_TEAM_ID: "env-team", VERCEL_PROJECT_ID: "env-project" },
          workdir: work
        }),
        Effect.succeed
      )
      expect(personal.recorded.acquired[0]).toMatchObject({
        token: "env-pat",
        teamId: "env-team",
        projectId: "env-project"
      })

      // A personal token is used only when every identifier arrives with it.
      const incomplete: Array<VercelSandbox.Credentials> = [
        { oidcToken: "", token: "pat", teamId: "team", projectId: "" },
        { token: "", teamId: "team", projectId: "project" },
        { token: "pat", teamId: "", projectId: "project" },
        { token: "pat", teamId: "team" },
        { token: "pat", projectId: "project" },
        {}
      ]
      for (const credentials of incomplete) {
        const missing = fakeSdk()
        yield* acquired(VercelSandbox.make({ sdk: missing.sdk, workdir: work, ...credentials }), Effect.succeed)
        expect(missing.recorded.acquired[0]).not.toHaveProperty("token")
        expect(missing.recorded.acquired[0]).not.toHaveProperty("teamId")
        expect(missing.recorded.acquired[0]).not.toHaveProperty("projectId")
      }
    }))

  it.effect("refuses invalid local configuration before acquiring a sandbox", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      for (
        const provider of [
          VercelSandbox.make({ sdk, timeoutMs: 0 }),
          VercelSandbox.make({ sdk, timeoutMs: Number.POSITIVE_INFINITY }),
          VercelSandbox.make({ sdk, timeoutMs: 60_000, maxDurationMs: 30_000 }),
          VercelSandbox.make({ sdk, workdir: "relative" })
        ]
      ) {
        const failure = yield* Effect.flip(acquired(provider, Effect.succeed))
        expect(failure).toBeInstanceOf(ProviderError)
      }
      expect(recorded.acquired).toEqual([])

      const capped = yield* Effect.flip(
        acquired(
          VercelSandbox.make({ sdk, timeoutMs: 60_000, maxDurationMs: 30_000 }),
          Effect.succeed
        )
      )
      expect((capped as ProviderError).message).toContain("60000ms")
      expect((capped as ProviderError).message).toContain("30000ms")
    }))

  it.effect("delivers standard input, roots relative cwds, and drains text reads", () =>
    Effect.gen(function*() {
      const faults: Faults = {}
      const { sdk } = fakeSdk(faults)
      const work = dir("behavior")
      yield* acquired(VercelSandbox.make({ sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          const bytes = new Uint8Array([0, 1, 2, 255, 10, 13, 7])
          expect(yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })).toEqual({ stdout: "", code: 0 })
          expect(yield* session.readFile(`${work}/stdin-copy.bin`)).toEqual(bytes)
          // The redirect stages input in the session-private directory and
          // takes it away when the spawn's scope closes. The assertion names
          // the directory rather than a file, because the staged name is
          // random: "this one literal path is absent" holds just as well for an
          // implementation that leaks every file it ever staged.
          const staging = `${work}/.smthrs-stdin`
          expect(yield* output(session, `test -d '${staging}' && ls -1A '${staging}'`))
            .toEqual({ stdout: "", code: 0 })

          expect((yield* output(session, "mkdir -p nested/leaf")).code).toBe(0)
          expect((yield* output(session, "pwd", { cwd: "nested/leaf" })).stdout).toBe(`${work}/nested/leaf\n`)
          expect((yield* output(session, "pwd", { cwd: "./nested" })).stdout).toBe(`${work}/nested\n`)
          expect((yield* output(session, "pwd", { cwd: "" })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: "." })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: work })).stdout).toBe(`${work}\n`)

          // A path with no parent to create takes the bare write, and the
          // vendor roots it at the sandbox's own working directory.
          yield* session.writeFile("rooted.bin", new Uint8Array([42]))
          expect(Array.from(yield* session.readFile(join(home, "rooted.bin")))).toEqual([42])

          // A vendor stream may hand contents back as text chunks.
          faults.textReads = true
          yield* session.writeFile(`${work}/text-file`, encoder.encode("plain text"))
          expect(decoder.decode(yield* session.readFile(`${work}/text-file`))).toBe("plain text")
          faults.textReads = false

          const process = yield* Effect.scoped(session.spawn("printf 'ok'", {}))
          faults.stdoutFailure = new Error("stdout unavailable")
          expect(yield* Effect.flip(Stream.runDrain(process.stdout))).toBeInstanceOf(ProviderError)
          faults.stdoutFailure = undefined
          faults.stderrFailure = new Error("stderr unavailable")
          expect(yield* Effect.flip(Stream.runDrain(process.stderr))).toBeInstanceOf(ProviderError)
          faults.stderrFailure = undefined
        }))
    }), 30_000)

  it.effect("isolates caller bytes from an SDK that mutates write buffers", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ mutateWriteBuffers: true })
      const work = dir("mutating-write")
      const content = new Uint8Array([0, 1, 2, 253, 254, 255])
      const expected = content.slice()

      yield* acquired(VercelSandbox.make({ sdk: fake.sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          const path = `${work}/bytes.bin`
          yield* session.writeFile(path, content)
          expect(Array.from(fake.recorded.writes.at(-1)!.content)).toEqual(Array.from(expected))
          expect(Array.from(content)).toEqual(Array.from(expected))
          expect(Array.from(yield* session.readFile(path))).toEqual(Array.from(expected))
        }))
    }))

  it.effect("copies chunks from an SDK read stream that reuses its backing buffer", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ reuseReadBuffer: true })
      const work = dir("reused-read")
      const expected = new Uint8Array([1, 2, 3, 4, 5, 6])

      yield* acquired(VercelSandbox.make({ sdk: fake.sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          const path = `${work}/bytes.bin`
          yield* session.writeFile(path, expected)
          expect(Array.from(yield* session.readFile(path))).toEqual(Array.from(expected))
        }))
    }))

  it.effect("maps vendor and command failures and still runs teardown", () =>
    Effect.gen(function*() {
      // The default workdir is only reachable on the real machine; refusing
      // the acquire keeps the fake off the host's root filesystem.
      const unavailable = fakeSdk({ acquireFailure: new Error("service offline") })
      const acquireFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: unavailable.sdk }), Effect.succeed)
      )
      expect((acquireFailure as ProviderError).code).toBe("unavailable")

      const extend = fakeSdk({ extendFailure: new Error("limit") })
      const extendFailure = yield* Effect.flip(
        acquired(
          VercelSandbox.make({ sdk: extend.sdk, timeoutMs: 6 * 60_000, workdir: dir("extend") }),
          Effect.succeed
        )
      )
      expect((extendFailure as ProviderError).code).toBe("unavailable")
      expect(extend.recorded.stopped).toHaveLength(1)

      // The transport refusing every command stops acquisition at the
      // workspace preparation.
      const rejected = fakeSdk({ runFailure: new Error("api unreachable") })
      const rejectedFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: rejected.sdk, workdir: dir("rejected") }), Effect.succeed)
      )
      expect((rejectedFailure as ProviderError).code).toBe("unavailable")
      expect(rejected.recorded.stopped).toHaveLength(1)

      // A workspace that really cannot be created refuses the session.
      const blocked = fakeSdk()
      const blocker = join(dir("prepare"), "blocker")
      writeFileSync(blocker, "a file, not a directory")
      const prepareFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: blocked.sdk, workdir: `${blocker}/work` }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).code).toBe("unavailable")
      expect(blocked.recorded.stopped).toHaveLength(1)

      const faults: Faults = {}
      const active = fakeSdk(faults)
      const work = dir("runtime")
      yield* acquired(VercelSandbox.make({ sdk: active.sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          faults.runFailure = new Error("command refused")
          const spawnFailure = yield* Effect.flip(Effect.scoped(session.spawn("true", {})))
          expect((spawnFailure as ProviderError).code).toBe("spawn_error")
          faults.runFailure = undefined

          // A parent that is really a file cannot become a directory.
          writeFileSync(join(work, "occupied"), "a file, not a directory")
          const directoryFailure = yield* Effect.flip(
            session.writeFile(`${work}/occupied/child`, new Uint8Array([1]))
          )
          expect((directoryFailure as ProviderError).code).toBe("unknown")

          // A directory that refuses writes fails the upload itself.
          mkdirSync(join(work, "sealed-dir"))
          chmodSync(join(work, "sealed-dir"), 0o555)
          const writeFailure = yield* Effect.flip(
            session.writeFile(`${work}/sealed-dir/child`, new Uint8Array([1]))
          )
          expect((writeFailure as ProviderError).code).toBe("unknown")

          faults.readFailure = new Error("read refused")
          const readFailure = yield* Effect.flip(session.readFile(`${work}/anything`))
          expect((readFailure as ProviderError).code).toBe("unknown")
          faults.readFailure = undefined

          // A file that exists but cannot be opened fails while draining.
          writeFileSync(join(work, "sealed.bin"), "sealed")
          chmodSync(join(work, "sealed.bin"), 0)
          const sealed = yield* Effect.flip(session.readFile(join(work, "sealed.bin")))
          expect(sealed).toMatchObject({ code: "unknown" })

          // A dying machine reports commands as finished without running them.
          faults.commandFailure = { exitCode: 9 }
          const pingFailure = yield* Effect.flip(session.ping!)
          expect((pingFailure as ProviderError).code).toBe("unavailable")
          faults.commandFailure = undefined
        }))

      // A stop that fails is logged, and the acquisition still succeeds.
      const ignoredStop = fakeSdk({ stopFailure: new Error("already stopped") })
      yield* acquired(VercelSandbox.make({ sdk: ignoredStop.sdk, workdir: dir("stop") }), Effect.succeed)
      expect(ignoredStop.recorded.stopped).toHaveLength(1)
    }), 30_000)
})
