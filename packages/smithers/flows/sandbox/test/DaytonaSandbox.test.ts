import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Logger, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DaytonaSandbox from "../src/DaytonaSandbox/index.ts"
import type { Sdk } from "../src/DaytonaSandbox/Sdk.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { untouchable } from "./helpers/untouchable.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type VendorSandbox = Awaited<ReturnType<Sdk["get"]>>
type CreateInput = NonNullable<Parameters<Sdk["create"]>[0]>
type NetworkSettings = Parameters<VendorSandbox["updateNetworkSettings"]>[0]

// -----------------------------------------------------------------------------
// The Daytona SDK as a fake: real shells behind the vendor's promise surface.
// -----------------------------------------------------------------------------

// The fake emulates only what `@daytonaio/sdk` 0.207 adds around a machine —
// the sandbox registry with its documented not-found shapes, the
// `executeCommand` response `{ exitCode, result, artifacts: { stdout } }`
// whose one `result` string is the command's merged output, and byte-typed
// `downloadFile`/`uploadFileStream`. Underneath, every command is a real
// `sh -c` run by the platform spawner in the machine's real directory, and
// the file operations touch that same tree, so the provider is proven against
// a machine rather than a script table.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-daytona-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

const combinedRun = (
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined
): Promise<{ readonly exitCode: number; readonly output: string }> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        // "Executes a shell command in the Sandbox", with the sandbox's own
        // environment beneath the caller's variables.
        const child = yield* local.spawn(
          ChildProcess.make("sh", ["-c", command], { cwd, env: { ...env }, extendEnv: true })
        )
        const [output, exitCode] = yield* Effect.all(
          [
            // The wire response carries one output string with standard error
            // merged in, which is what a combined gathering of both pipes is.
            Stream.mkString(Stream.decodeText(Stream.merge(child.stdout, child.stderr))),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { exitCode, output }
      })
    )
  )

/** The `{ exitCode, result, artifacts }` shape the vendor documents. */
interface VendorExecuteResponse {
  readonly exitCode: number
  readonly result: string
  readonly artifacts: { readonly stdout: string }
}

const vendorError = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields)

interface Machine {
  readonly id: string
  readonly name: string
  dir: string | undefined
  running: boolean
  createdAt?: string | undefined
  autoDestroyAt?: string | undefined
}

interface ExecuteCall {
  readonly command: string
  readonly cwd: string | undefined
  readonly env: Record<string, string> | undefined
}

interface Faults {
  removeWait?: Effect.Effect<void>
  releaseWait?: Effect.Effect<void>
  removeExitCode?: number

  /** `get` is refused with something other than the not-found shape. */
  getFailure?: unknown
  /** `create` is refused (quota, capacity). */
  createFailure?: unknown
  /** `start` is refused. */
  startFailure?: unknown
  /** `updateNetworkSettings` is refused. */
  networkFailure?: unknown
  /** `delete` is refused. */
  deleteFailure?: unknown
  /** `getWorkDir` is refused. */
  workdirFailure?: unknown
  /** Every `executeCommand` call is refused (the API is unreachable). */
  executeFailure?: unknown
  /** The machine reports every command finished with this status (a dying VM). */
  commandFailure?: { readonly exitCode: number; readonly result: string } | undefined
  /** `uploadFileStream` overwrites byte buffers after it has consumed them. */
  mutateUploadBuffers?: boolean
}

interface Recorded {
  readonly gets: Array<string>
  readonly creates: Array<CreateInput | undefined>
  readonly starts: Array<{ readonly id: string; readonly timeout: number | undefined }>
  readonly deletes: Array<
    { readonly id: string; readonly timeout: number | undefined; readonly wait: boolean | undefined }
  >
  readonly executes: Array<ExecuteCall>
  readonly uploads: Array<{ readonly path: string; readonly content: Uint8Array }>
  /** Each network update, with the number of guest commands executed before it. */
  readonly networkUpdates: Array<{ readonly settings: NetworkSettings; readonly executedBefore: number }>
  /** Each `setTtl`, with the number of starts before it. */
  readonly ttls: Array<{ readonly minutes: number; readonly startsBefore: number }>
}

const fakeSdk = (faults: Faults = {}): {
  readonly sdk: Sdk
  readonly recorded: Recorded
  readonly machines: Map<string, Machine>
  readonly seed: (name: string, dir?: string) => Machine
} => {
  const recorded: Recorded = {
    gets: [],
    creates: [],
    starts: [],
    deletes: [],
    executes: [],
    uploads: [],
    networkUpdates: [],
    ttls: []
  }
  const machines = new Map<string, Machine>()
  let nextId = 1
  const seed = (name: string, dir?: string): Machine => {
    const machine: Machine = {
      id: `sandbox-${nextId++}`,
      name,
      dir: dir ?? mkdtempSync(join(root, "machine-")),
      running: false
    }
    machines.set(name, machine)
    machines.set(machine.id, machine)
    return machine
  }
  const instance = (machine: Machine): VendorSandbox => ({
    id: machine.id,
    name: machine.name,
    // The runner applies network settings as iptables rules on a running
    // sandbox container.
    updateNetworkSettings: async (settings) => {
      if (!machine.running) throw new Error(`the fake was asked to update a stopped sandbox: ${machine.name}`)
      recorded.networkUpdates.push({ settings, executedBefore: recorded.executes.length })
      if (faults.networkFailure !== undefined) throw faults.networkFailure
    },
    createdAt: machine.createdAt,
    autoDestroyAt: machine.autoDestroyAt,
    setTtl: async (minutes) => {
      recorded.ttls.push({ minutes, startsBefore: recorded.starts.length })
    },
    getWorkDir: () =>
      faults.workdirFailure === undefined ? Promise.resolve(machine.dir) : Promise.reject(faults.workdirFailure),
    process: {
      executeCommand: async (command, cwd, env): Promise<VendorExecuteResponse> => {
        if (!machine.running) throw new Error(`the fake was asked to execute on a stopped sandbox: ${machine.name}`)
        recorded.executes.push({ command, cwd, env })
        if (command.startsWith("rm -f ") && faults.removeWait !== undefined) await Effect.runPromise(faults.removeWait)
        if (command.startsWith("rm -f ") && faults.removeExitCode !== undefined) {
          return { exitCode: faults.removeExitCode, result: "", artifacts: { stdout: "" } }
        }
        if (faults.executeFailure !== undefined) throw faults.executeFailure
        if (faults.commandFailure !== undefined) {
          const { exitCode, result } = faults.commandFailure
          return { exitCode, result, artifacts: { stdout: result } }
        }
        const run = await combinedRun(command, cwd ?? machine.dir ?? root, env)
        return { exitCode: run.exitCode, result: run.output, artifacts: { stdout: run.output } }
      }
    },
    fs: {
      downloadFile: async (path) => {
        if (!existsSync(path)) {
          // The documented `DaytonaFileNotFoundError` shape: code
          // `FILE_NOT_FOUND` on HTTP 404.
          throw vendorError(`file not found: ${path}`, { code: "FILE_NOT_FOUND", statusCode: 404 })
        }
        return new Uint8Array(readFileSync(path))
      },
      uploadFileStream: async (content, path) => {
        // Relative remote paths resolve against the sandbox working
        // directory, the way the vendor's own examples use them.
        recorded.uploads.push({ path, content: content.slice() })
        writeFileSync(path.startsWith("/") ? path : join(machine.dir ?? root, path), content)
        if (faults.mutateUploadBuffers === true) content.fill(0)
      }
    }
  })
  const sdk: Sdk = {
    get: async (idOrName) => {
      recorded.gets.push(idOrName)
      if (faults.getFailure !== undefined) throw faults.getFailure
      const machine = machines.get(idOrName)
      if (machine === undefined) {
        // The documented `DaytonaNotFoundError` shape: HTTP 404.
        throw vendorError(`sandbox not found: ${idOrName}`, { statusCode: 404 })
      }
      return instance(machine)
    },
    create: async (input) => {
      recorded.creates.push(input)
      if (faults.createFailure !== undefined) throw faults.createFailure
      const machine = seed(input?.name ?? `generated-${nextId}`)
      machine.running = true
      return instance(machine)
    },
    start: async (sandbox, timeout) => {
      recorded.starts.push({ id: sandbox.id, timeout })
      if (faults.startFailure !== undefined) throw faults.startFailure
      const machine = machines.get(sandbox.id)
      if (machine === undefined) throw vendorError("sandbox not found", { statusCode: 404 })
      machine.running = true
    },
    delete: async (sandbox, timeout, wait) => {
      recorded.deletes.push({ id: sandbox.id, timeout, wait })
      if (faults.releaseWait !== undefined) await Effect.runPromise(faults.releaseWait)
      if (faults.deleteFailure !== undefined) throw faults.deleteFailure
      const machine = machines.get(sandbox.id)
      if (machine === undefined) throw vendorError("sandbox not found", { statusCode: 404 })
      machine.running = false
      machines.delete(machine.id)
      machines.delete(machine.name)
      // Deleting a sandbox destroys its filesystem.
      if (machine.dir !== undefined && machine.dir.startsWith(root)) {
        rmSync(machine.dir, { recursive: true, force: true })
      }
    }
  }
  return { sdk, recorded, machines, seed }
}

const acquired = <A, E>(
  provider: ReturnType<typeof DaytonaSandbox.make>,
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

describe("DaytonaSandbox", () => {
  const policies = [
    { network: "none", settings: { networkBlockAll: true } },
    { network: { allow: [] }, settings: { networkBlockAll: true } },
    {
      network: { allow: ["registry.npmjs.org", "*.github.com"] },
      settings: { domainAllowList: "registry.npmjs.org,*.github.com" }
    }
  ] as const

  it.effect("creates a sandbox under the vendor network settings for each policy", () =>
    Effect.gen(function*() {
      for (const { network, settings } of policies) {
        const fake = fakeSdk()
        yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk, network }), Effect.succeed)
        expect(fake.recorded.creates).toEqual([{ name: `smthrs-${sessionSlug("run-1")}`, ...settings }])
        expect(fake.recorded.networkUpdates).toEqual([])
      }
    }))

  it.effect("re-applies the policy to a reattached sandbox before any guest command", () =>
    Effect.gen(function*() {
      for (const { network, settings } of policies) {
        const fake = fakeSdk()
        fake.seed(`smthrs-${sessionSlug("run-1")}`)
        yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk, network }), Effect.succeed)
        expect(fake.recorded.creates).toEqual([])
        expect(fake.recorded.networkUpdates).toEqual([{ settings, executedBefore: 0 }])
      }
    }))

  it.effect("leaves a reattached sandbox's network alone when no policy is set", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      fake.seed(`smthrs-${sessionSlug("run-1")}`)
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk }), Effect.succeed)
      expect(fake.recorded.networkUpdates).toEqual([])
    }))

  it.effect("fails a reattach whose network update is refused, runs nothing, and deletes it", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ networkFailure: new Error("runner refused") })
      const machine = fake.seed(`smthrs-${sessionSlug("run-1")}`)
      const failure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: fake.sdk, network: "none" }), Effect.succeed)
      )
      expect((failure as ProviderError).code).toBe("unavailable")
      expect(fake.recorded.executes).toEqual([])
      expect(fake.recorded.deletes.map(({ id }) => id)).toEqual([machine.id])
    }))

  it("refuses a malformed allowlist at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    expect(() => DaytonaSandbox.make({ sdk: deps.value, network: { allow: ["https://example.com"] } }))
      .toThrow("daytona-sandbox: network allowlist entry is not a host name")
    expect(deps.touched).toEqual([])
  })

  it.effect("bounds a reattached sandbox to the neutral lifetime counted from its creation", () =>
    Effect.gen(function*() {
      // The test clock stands at the epoch, so creation times are offsets from it.
      const at = (minutes: number) => new Date(minutes * 60_000).toISOString()
      const name = `smthrs-${sessionSlug("run-1")}`
      const reattach = (machine: Partial<Machine>) => {
        const fake = fakeSdk()
        Object.assign(fake.seed(name), machine)
        return Effect.map(
          Effect.exit(acquired(DaytonaSandbox.make({ sdk: fake.sdk, limits: { timeoutSecs: 3600 } }), Effect.succeed)),
          (exit) => ({ exit, recorded: fake.recorded })
        )
      }

      // Created 10 minutes ago with no TTL: pulled in to 50 minutes from now, before it starts.
      const unbounded = yield* reattach({ createdAt: at(-10) })
      expect(Exit.isSuccess(unbounded.exit)).toBe(true)
      expect(unbounded.recorded.ttls).toEqual([{ minutes: 50, startsBefore: 0 }])
      expect(unbounded.recorded.creates).toEqual([])
      // Created with a longer TTL: pulled in as well.
      const longer = yield* reattach({ createdAt: at(-10), autoDestroyAt: at(120) })
      expect(longer.recorded.ttls).toEqual([{ minutes: 50, startsBefore: 0 }])
      // Already due sooner than the requested lifetime: left alone.
      const sooner = yield* reattach({ createdAt: at(-10), autoDestroyAt: at(20) })
      expect(Exit.isSuccess(sooner.exit)).toBe(true)
      expect(sooner.recorded.ttls).toEqual([])

      // Older than the requested lifetime, or of unknown age: refused before it starts.
      for (
        const [machine, message] of [
          [{ createdAt: at(-60) }, "has outlived limits.timeoutSecs 3600"],
          [{}, "reports no creation time"]
        ] as const
      ) {
        const refused = yield* reattach(machine)
        expect(String(Exit.isFailure(refused.exit) ? refused.exit.cause : "")).toContain(message)
        expect(refused.recorded.starts).toEqual([])
        expect(refused.recorded.executes).toEqual([])
      }
    }))

  it.effect("creates under the neutral lifetime as ttlMinutes", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk, limits: { timeoutSecs: 5400 } }), Effect.succeed)
      expect(fake.recorded.creates).toEqual([{ name: `smthrs-${sessionSlug("run-1")}`, ttlMinutes: 90 }])
    }))

  it("refuses cpu, memory, and part-minute lifetimes at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    expect(() => DaytonaSandbox.make({ sdk: deps.value, limits: { cpus: 2 } }))
      .toThrow("daytona-sandbox: cannot enforce limits.cpus")
    expect(() => DaytonaSandbox.make({ sdk: deps.value, limits: { memoryMib: 1024 } }))
      .toThrow("daytona-sandbox: cannot enforce limits.memoryMib")
    expect(() => DaytonaSandbox.make({ sdk: deps.value, limits: { timeoutSecs: 90 } }))
      .toThrow("daytona-sandbox: limits.timeoutSecs must be whole minutes")
    expect(deps.touched).toEqual([])
  })

  for (const operation of ["remove", "release"] as const) {
    it.effect(`bounds stalled ${operation} on the platform timer`, () =>
      stalledFinalizer((stall) => {
        const fake = fakeSdk(operation === "remove" ? { removeWait: stall } : { releaseWait: stall })
        return acquired(DaytonaSandbox.make({ sdk: fake.sdk }), (session) =>
          output(session, "true", operation === "remove" ? { stdin: encoder.encode("input") } : {}))
      }, operation === "remove" ? ".smthrs-stdin/" : "smthrs-"))
  }

  it.effect("reports failed staged stdin removal without claiming the file was removed", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ removeExitCode: 1 })
      const provider = DaytonaSandbox.make({ sdk: fake.sdk })
      const warnings: Array<unknown> = []
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* output(session, "true", { stdin: encoder.encode("private input") })
          expect(existsSync(fake.recorded.uploads.at(-1)!.path)).toBe(true)
          expect(warnings).toHaveLength(1)
        })).pipe(Effect.provide(Logger.layer([Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry)
        })])))
    }))

  it.effect("deletes guest inherited environment separately from command defaults", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = DaytonaSandbox.make({ sdk: fake.sdk, commandEnv: { DEFAULT: "default" } })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect((yield* output(session, `printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
          const result = yield* output(session, `printf '%s:%s:%s' "\${HOME+present}" "$DEFAULT" "$KEEP"`, {
            env: { KEEP: "a 'quoted' $value", HOME: undefined, PATH: undefined, DEFAULT: undefined }
          })
          expect(result).toEqual({ stdout: "::a 'quoted' $value", code: 0 })
          expect(fake.recorded.executes.at(-1)?.command).toContain("-u HOME")
          expect((yield* output(session, `printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
        }))
    }), 60_000)

  it.effect("passes SandboxConformance running real shells against a real tree", () =>
    Effect.gen(function*() {
      const { sdk } = fakeSdk()
      const violations = yield* SandboxConformance.check(DaytonaSandbox.make({ sdk }), {
        provides: { ping: true }
      })
      expect(violations).toEqual([])
    }), 60_000)

  it.effect("attaches, starts, discovers the workdir, and deletes synchronously", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const name = `lane-${sessionSlug("run-1")}`
      const quoted = join(root, "workspace with quote's")
      mkdirSync(quoted)
      const machine = fake.seed(name, quoted)
      const provider = DaytonaSandbox.make({
        sdk: fake.sdk,
        namePrefix: "lane-",
        startTimeoutSeconds: 17,
        deleteTimeoutSeconds: 29,
        commandEnv: { STATIC_PROOF: "static", KEEP_ME: "kept", REMOVE_ME: "base" }
      })
      const answer = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect(session.id).toBe("run-1")
          expect(session.remoteId).toBe(machine.id)
          expect(session.workdir).toBe(quoted)
          return yield* output(session, `printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`, {
            cwd: "/tmp",
            env: { SPAWN_PROOF: "spawn", REMOVE_ME: undefined, OMITTED: undefined }
          })
        }))

      expect(answer).toEqual({ stdout: "static:spawn", code: 0 })
      expect(fake.recorded.gets).toEqual([name])
      expect(fake.recorded.creates).toEqual([])
      expect(fake.recorded.starts).toEqual([{ id: machine.id, timeout: 17 }])
      expect(fake.recorded.deletes).toEqual([{ id: machine.id, timeout: 29, wait: true }])
      // The workspace with a quote in its name survived a real shell because
      // the provider quoted it; the recorded line is that rendering.
      expect(fake.recorded.executes[0]?.command).toBe(`mkdir -p '${quoted.replaceAll("'", `'\\''`)}'`)
      expect(fake.recorded.executes[1]).toMatchObject({
        cwd: "/tmp"
      })
      expect(fake.recorded.executes[1]?.env).toEqual({})
      expect(fake.recorded.executes[1]?.command).toContain(
        "-u REMOVE_ME -u OMITTED STATIC_PROOF=static KEEP_ME=kept SPAWN_PROOF=spawn /bin/sh -c"
      )
      expect(fake.machines.size).toBe(0)
    }))

  it.effect("delivers stdin, merged stderr, rooted cwds, and byte-faithful files", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const bytes = new Uint8Array([0, 255, 254, 1, 10, 13, 7])
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk }), (session) =>
        Effect.gen(function*() {
          const work = session.workdir
          yield* session.writeFile(`${work}/deep/tree/out.bin`, bytes)
          expect(yield* session.readFile(`${work}/deep/tree/out.bin`)).toEqual(bytes)

          // A path with no parent to create takes the bare write, and the
          // vendor roots it at the sandbox working directory.
          yield* session.writeFile("rooted.bin", new Uint8Array([42]))
          expect(Array.from(yield* session.readFile(`${work}/rooted.bin`))).toEqual([42])

          // Standard input is staged in the session-private directory,
          // delivered, and taken away when the spawn's scope closes.
          //
          // The assertion names the DIRECTORY, not a file. The staged name is
          // random, so asserting one literal path is absent proves nothing: it
          // holds just as well for an implementation that leaks every file it
          // ever staged. `test -d` says the redirect staged where it claims to,
          // and the empty listing says nothing survived the command.
          expect(yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })).toEqual({ stdout: "", code: 0 })
          expect(yield* session.readFile(`${work}/stdin-copy.bin`)).toEqual(bytes)
          const staging = `${work}/.smthrs-stdin`
          expect(yield* output(session, `test -d '${staging}' && ls -1A '${staging}'`))
            .toEqual({ stdout: "", code: 0 })

          // `executeCommand` merges standard error into its one output, so
          // the text arrives on stdout and stderr is honestly empty.
          const merged = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn("printf 'to-stderr' >&2; printf 'to-stdout'", {})
              const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
              const stderr = yield* Stream.mkString(Stream.decodeText(process.stderr))
              return { stdout, stderr, code: yield* process.exitCode }
            })
          )
          expect(merged.stdout).toContain("to-stderr")
          expect(merged.stdout).toContain("to-stdout")
          expect(merged.stderr).toBe("")
          expect(merged.code).toBe(0)

          expect((yield* output(session, "mkdir -p nested/leaf")).code).toBe(0)
          expect((yield* output(session, "pwd", { cwd: "nested/leaf" })).stdout).toBe(`${work}/nested/leaf\n`)
          expect((yield* output(session, "pwd", { cwd: "./nested" })).stdout).toBe(`${work}/nested\n`)
          expect((yield* output(session, "pwd", { cwd: "" })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: "." })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: work })).stdout).toBe(`${work}\n`)
        }))
    }), 30_000)

  it.effect("uses an explicit workspace over discovery", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const explicit = mkdtempSync(join(root, "explicit-"))
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk, workdir: explicit }), (session) =>
        Effect.gen(function*() {
          expect(session.workdir).toBe(explicit)
          yield* session.writeFile(`${explicit}/probe.bin`, new Uint8Array([7]))
          expect(Array.from(yield* session.readFile(`${explicit}/probe.bin`))).toEqual([7])
        }))
      expect(fake.recorded.deletes[0]).toMatchObject({ timeout: 60, wait: true })
    }))

  it.effect("isolates caller bytes from an SDK that mutates upload buffers", () =>
    Effect.gen(function*() {
      const fake = fakeSdk({ mutateUploadBuffers: true })
      const content = new Uint8Array([0, 1, 2, 253, 254, 255])
      const expected = content.slice()

      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk }), (session) =>
        Effect.gen(function*() {
          const path = `${session.workdir}/bytes.bin`
          yield* session.writeFile(path, content)
          expect(Array.from(fake.recorded.uploads.at(-1)!.content)).toEqual(Array.from(expected))
          expect(Array.from(content)).toEqual(Array.from(expected))
          expect(Array.from(yield* session.readFile(path))).toEqual(Array.from(expected))
        }))
    }))

  it.effect("rejects invalid and undiscoverable workdirs", () =>
    Effect.gen(function*() {
      const invalid = fakeSdk()
      const invalidFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: invalid.sdk, workdir: "relative" }), Effect.succeed)
      )
      expect((invalidFailure as ProviderError).code).toBe("spawn_error")
      expect(invalid.recorded.gets).toEqual([])

      for (const workdir of [undefined, "relative"] as const) {
        const fake = fakeSdk()
        const expected = `bad-${sessionSlug("run-1")}`
        fake.seed(expected).dir = workdir
        const failure = yield* Effect.flip(
          acquired(DaytonaSandbox.make({ sdk: fake.sdk, namePrefix: "bad-" }), Effect.succeed)
        )
        expect((failure as ProviderError).code).toBe("unavailable")
        expect(fake.recorded.deletes).toHaveLength(1)
      }
    }))

  it.effect("maps acquisition and setup failures after registering teardown", () =>
    Effect.gen(function*() {
      const unavailable = fakeSdk({ getFailure: new Error("gateway offline") })
      const getFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: unavailable.sdk }), Effect.succeed)
      )
      expect((getFailure as ProviderError).code).toBe("unavailable")
      expect(unavailable.recorded.creates).toEqual([])

      const nullFailure = fakeSdk({ getFailure: null })
      const nullGetFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: nullFailure.sdk }), Effect.succeed)
      )
      expect((nullGetFailure as ProviderError).code).toBe("unavailable")

      const create = fakeSdk({ createFailure: new Error("quota reached") })
      const createFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: create.sdk }), Effect.succeed))
      expect((createFailure as ProviderError).code).toBe("unavailable")
      expect(create.recorded.deletes).toEqual([])

      const start = fakeSdk({ startFailure: new Error("cannot start") })
      start.seed(`smthrs-${sessionSlug("run-1")}`)
      const startFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: start.sdk }), Effect.succeed))
      expect((startFailure as ProviderError).code).toBe("unavailable")
      expect(start.recorded.deletes).toHaveLength(1)

      const discovery = fakeSdk({ workdirFailure: new Error("metadata unavailable") })
      const discoveryFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: discovery.sdk }), Effect.succeed)
      )
      expect((discoveryFailure as ProviderError).code).toBe("unavailable")
      expect(discovery.recorded.deletes).toHaveLength(1)

      const execute = fakeSdk({ executeFailure: new Error("exec refused") })
      const executeFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: execute.sdk }), Effect.succeed))
      expect((executeFailure as ProviderError).code).toBe("spawn_error")
      expect(execute.recorded.deletes).toHaveLength(1)

      // A workspace that really cannot be created refuses the session.
      const blocked = fakeSdk()
      const blocker = join(mkdtempSync(join(root, "prepare-")), "blocker")
      writeFileSync(blocker, "a file, not a directory")
      const prepareFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: blocked.sdk, workdir: `${blocker}/work` }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).code).toBe("unavailable")
      expect(blocked.recorded.deletes).toHaveLength(1)

      // A delete that fails is logged, and the acquisition still succeeds.
      const ignoredDelete = fakeSdk({ deleteFailure: new Error("already gone") })
      yield* acquired(DaytonaSandbox.make({ sdk: ignoredDelete.sdk }), Effect.succeed)
      expect(ignoredDelete.recorded.deletes).toHaveLength(1)
    }))

  it.effect("maps file, spawn, and ping failures", () =>
    Effect.gen(function*() {
      const faults: Faults = {}
      const fake = fakeSdk(faults)
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk }), (session) =>
        Effect.gen(function*() {
          const work = session.workdir
          faults.executeFailure = new Error("exec failed")
          const spawnFailure = yield* Effect.flip(Effect.scoped(session.spawn("true", {})))
          expect((spawnFailure as ProviderError).code).toBe("spawn_error")
          faults.executeFailure = undefined

          // A parent that is really a file cannot become a directory.
          writeFileSync(join(work, "occupied"), "a file, not a directory")
          const directoryFailure = yield* Effect.flip(session.writeFile(`${work}/occupied/child`, new Uint8Array()))
          expect((directoryFailure as ProviderError).code).toBe("unknown")

          // A directory that refuses writes fails the upload itself.
          mkdirSync(join(work, "sealed-dir"))
          chmodSync(join(work, "sealed-dir"), 0o555)
          const uploadFailure = yield* Effect.flip(
            session.writeFile(`${work}/sealed-dir/child`, new Uint8Array([1]))
          )
          expect((uploadFailure as ProviderError).code).toBe("unknown")

          const absent = yield* Effect.flip(session.readFile(`${work}/absent`))
          expect((absent as ProviderError).code).toBe("not_found")

          // A file that exists but cannot be read is broken, not absent.
          writeFileSync(join(work, "sealed.bin"), "sealed")
          chmodSync(join(work, "sealed.bin"), 0)
          const sealed = yield* Effect.flip(session.readFile(join(work, "sealed.bin")))
          expect((sealed as ProviderError).code).toBe("unknown")

          // A dying machine reports commands as finished without running them.
          faults.commandFailure = { exitCode: 9, result: "" }
          const pingFailure = yield* Effect.flip(session.ping!)
          expect((pingFailure as ProviderError).code).toBe("unavailable")
          faults.commandFailure = undefined
        }))
    }))
})
