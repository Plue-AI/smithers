import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { untouchable } from "./helpers/untouchable.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

interface SandboxOptions {
  readonly enableDefaultSession?: boolean | undefined
  readonly keepAlive?: boolean | undefined
  readonly sleepAfter?: string | number | undefined
}

interface CommandOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

interface CommandResult {
  readonly success: boolean
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type ProcessExitMode = "wait" | "handle" | "none"

class CloudflareError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface Binding {
  readonly active: Map<string, FakeSandbox>
  readonly instances: Array<FakeSandbox>
  readonly resolutions: Array<{ readonly id: string; readonly options: SandboxOptions | undefined }>
  resolveFailure?: unknown
  processExitMode: ProcessExitMode
  nextInstance: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64Of = (content: Uint8Array): string => {
  let binary = ""
  for (const byte of content) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const bytesOfBase64 = (content: string): Uint8Array =>
  Uint8Array.from(atob(content), (character) => character.charCodeAt(0))

// -----------------------------------------------------------------------------
// The Cloudflare Sandbox SDK as a fake: real shells and real files behind the
// Durable Object surface.
// -----------------------------------------------------------------------------

// The fake emulates only what the vendor adds on top of a container: the
// binding resolution, the base64 file framing, the FILE_NOT_FOUND error shape,
// and the two execution surfaces. Underneath, every command is a REAL `sh -c`
// with the requested cwd and environment, and every file operation lands on a
// real file under the test's root. Guest-fixed absolute paths outside that
// root live under the instance's own directory, the way the AWS fake keeps
// guest pids under the test root.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-cf-sandbox-")))
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

const runSh = (
  command: string,
  cwd: string,
  env: Record<string, string | undefined> | undefined
): Promise<CommandResult> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* local.spawn(
          ChildProcess.make("sh", ["-c", command], { cwd, env: env ?? {}, extendEnv: true })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { success: exitCode === 0, exitCode, stdout, stderr }
      })
    )
  )

class FakeSandbox {
  readonly binding: Binding
  readonly id: string
  readonly processExitMode: ProcessExitMode
  /** The real directory backing guest-fixed paths outside the test root. */
  readonly root: string
  readonly events: Array<string> = []
  readonly readFailures = new Map<string, unknown>()
  readonly readContents = new Map<string, string>()
  failMkdir: unknown | undefined
  failWrite: unknown | undefined
  failExec: unknown | undefined
  failStart: unknown | undefined
  failDestroy: unknown | undefined
  execExitOverride: number | undefined
  destroyed = false

  constructor(binding: Binding, id: string, processExitMode: ProcessExitMode) {
    this.binding = binding
    this.id = id
    this.processExitMode = processExitMode
    this.root = join(root, "instances", `${id}-${binding.nextInstance++}`)
    mkdirSync(this.root, { recursive: true })
  }

  private assertLive(): void {
    if (this.destroyed) throw new CloudflareError("SESSION_DESTROYED", "sandbox destroyed")
  }

  private hostPath(path: string): string {
    return path === root || path.startsWith(`${root}/`) ? path : join(this.root, path)
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean | undefined }): Promise<{ path: string }> {
    this.assertLive()
    this.events.push(`mkdir:${path}:${String(options?.recursive)}`)
    if (this.failMkdir !== undefined) {
      const cause = this.failMkdir
      this.failMkdir = undefined
      throw cause
    }
    mkdirSync(this.hostPath(path), { recursive: options?.recursive === true })
    return { path }
  }

  async writeFile(
    path: string,
    content: string,
    options?: { readonly encoding?: string | undefined }
  ): Promise<{ path: string; success: true }> {
    this.assertLive()
    this.events.push(`write:${path}:${String(options?.encoding)}`)
    if (this.failWrite !== undefined) {
      const cause = this.failWrite
      this.failWrite = undefined
      throw cause
    }
    writeFileSync(
      this.hostPath(path),
      options?.encoding === "base64" ? bytesOfBase64(content) : encoder.encode(content)
    )
    return { path, success: true }
  }

  async readFile(
    path: string,
    options?: { readonly encoding?: string | undefined }
  ): Promise<{ content: string; path: string; success: true }> {
    this.assertLive()
    this.events.push(`read:${path}:${String(options?.encoding)}`)
    if (this.readFailures.has(path)) throw this.readFailures.get(path)
    if (this.readContents.has(path)) {
      return { path, success: true, content: this.readContents.get(path)! }
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(this.hostPath(path)))
    } catch (cause) {
      if (Reflect.get(Object(cause), "code") === "ENOENT") {
        throw new CloudflareError("FILE_NOT_FOUND", `missing ${path}`)
      }
      throw cause
    }
    return {
      path,
      success: true,
      content: options?.encoding === "base64" ? base64Of(bytes) : decoder.decode(bytes)
    }
  }

  async exec(command: string, options?: CommandOptions): Promise<CommandResult> {
    this.assertLive()
    this.events.push(`exec:${command}`)
    if (this.failExec !== undefined) {
      const cause = this.failExec
      this.failExec = undefined
      throw cause
    }
    const result = await runSh(command, this.hostPath(options?.cwd ?? "/"), options?.env)
    if (this.execExitOverride !== undefined) {
      const exitCode = this.execExitOverride
      this.execExitOverride = undefined
      return { ...result, exitCode, success: exitCode === 0 }
    }
    return result
  }

  async startProcess(command: string, options?: CommandOptions) {
    this.assertLive()
    this.events.push(`start:${command}`)
    if (this.failStart !== undefined) {
      const cause = this.failStart
      this.failStart = undefined
      throw cause
    }
    const running = runSh(command, this.hostPath(options?.cwd ?? "/"), options?.env)
    const mode = this.processExitMode
    const events = this.events
    const process: {
      exitCode?: number | undefined
      waitForExit(timeout?: number): Promise<{ readonly exitCode?: number | undefined }>
      getLogs(): Promise<{ readonly stdout: string; readonly stderr: string }>
    } = {
      waitForExit: async () => {
        const result = await running
        events.push(`wait:${command}`)
        if (mode === "handle") process.exitCode = result.exitCode
        return mode === "wait" ? { exitCode: result.exitCode } : {}
      },
      getLogs: async () => {
        const result = await running
        events.push(`logs:${command}`)
        return { stdout: result.stdout, stderr: result.stderr }
      }
    }
    return process
  }

  async destroy(): Promise<void> {
    this.events.push("destroy")
    if (this.failDestroy !== undefined) throw this.failDestroy
    this.destroyed = true
    if (this.binding.active.get(this.id) === this) this.binding.active.delete(this.id)
  }
}

const binding = (processExitMode: ProcessExitMode = "wait"): Binding => ({
  active: new Map(),
  instances: [],
  resolutions: [],
  processExitMode,
  nextInstance: 0
})

const sdk = {
  getSandbox(workerBinding: Binding, id: string, options?: SandboxOptions): FakeSandbox {
    workerBinding.resolutions.push({ id, options })
    if (workerBinding.resolveFailure !== undefined) throw workerBinding.resolveFailure
    const existing = workerBinding.active.get(id)
    if (existing !== undefined) return existing
    const sandbox = new FakeSandbox(workerBinding, id, workerBinding.processExitMode)
    workerBinding.active.set(id, sandbox)
    workerBinding.instances.push(sandbox)
    return sandbox
  }
} satisfies CloudflareSandbox.Sdk<Binding>

const acquired = <A, E>(
  provider: ReturnType<typeof CloudflareSandbox.make<Binding>>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("session/key"), body))

const output = (
  process: RemoteProcess
): Effect.Effect<{ stdout: string; stderr: string; code: number }, ProviderError> =>
  Effect.all({
    stdout: Stream.mkString(Stream.decodeText(process.stdout)),
    stderr: Stream.mkString(Stream.decodeText(process.stderr)),
    code: process.exitCode
  })

describe("CloudflareSandbox", () => {
  it("refuses every resource limit at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (
      const [field, limits] of [
        ["cpus", { cpus: 1 }],
        ["memoryMib", { memoryMib: 512 }],
        ["timeoutSecs", { timeoutSecs: 60 }]
      ] as const
    ) {
      expect(() => CloudflareSandbox.make({ sdk: deps.value, binding: deps.value, limits }))
        .toThrow(`cloudflare-sandbox: cannot enforce limits.${field}`)
    }
    expect(() => CloudflareSandbox.make({ sdk: deps.value, binding: deps.value, limits: {} })).not.toThrow()
    expect(deps.touched).toEqual([])
  })

  it("refuses every network restriction and accepts \"open\" at construction, before touching its dependencies", () => {
    const deps = untouchable<never>()
    for (const network of ["none", { allow: ["example.com"] }] as const) {
      expect(() => CloudflareSandbox.make({ sdk: deps.value, binding: deps.value, network }))
        .toThrow("cloudflare-sandbox: cannot enforce a network policy; omit `network`")
    }
    expect(() => CloudflareSandbox.make({ sdk: deps.value, binding: deps.value, network: "open" })).not.toThrow()
    expect(deps.touched).toEqual([])
  })

  for (const operation of ["remove", "release"] as const) {
    it.effect(`bounds stalled ${operation} on the platform timer`, () =>
      stalledFinalizer((stall) => {
        const workerBinding = binding()
        return acquired(CloudflareSandbox.make({ sdk, binding: workerBinding, workdir: root }), (session) =>
          Effect.gen(function*() {
            const machine = workerBinding.instances[0]!
            if (operation === "release") {
              machine.destroy = () =>
                Effect.runPromise(stall)
            } else {
              const exec = machine.exec.bind(machine)
              machine.exec = async (command, options) => {
                if (command.startsWith("rm -f ")) await Effect.runPromise(stall)
                return exec(command, options)
              }
            }
            yield* Effect.scoped(Effect.flatMap(
              session.spawn(
                "true",
                operation === "remove"
                  ? { stdin: encoder.encode("input") } :
                  {}
              ),
              output
            ))
          }))
      }, operation === "remove" ? ".smthrs-stdin/" : "cloudflare sandbox"))
  }

  it.effect("reports failed staged stdin removal without claiming the file was removed", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const warnings: Array<unknown> = []
      yield* acquired(CloudflareSandbox.make({ sdk, binding: workerBinding, workdir: root }), (session) =>
        Effect.gen(function*() {
          const machine = workerBinding.instances[0]!
          const exec = machine.exec.bind(machine)
          machine.exec = (command, options) =>
            command.startsWith("rm -f ")
              ? Promise.resolve({ success: false, exitCode: 1, stdout: "", stderr: "" })
              : exec(command, options)
          yield* Effect.scoped(
            Effect.flatMap(session.spawn("true", { stdin: encoder.encode("private input") }), output)
          )
          const staged = machine.events.find((event) =>
            event.startsWith("write:")
          )!.slice(6, -7)
          expect(existsSync(staged)).toBe(true)
          expect(warnings).toHaveLength(1)
        })).pipe(Effect.provide(Logger.layer([Logger.make((entry) => {
          if (entry.logLevel === "Warn") warnings.push(entry)
        })])))
    }))

  for (const execution of ["exec", "process"] as const) {
    it.effect(`deletes guest inherited environment in ${execution} mode`, () =>
      Effect.gen(function*() {
        const workerBinding = binding()
        const provider = CloudflareSandbox.make({ sdk, binding: workerBinding, execution, workdir: root })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            const run = (command: string, env = {}) =>
              Effect.scoped(Effect.flatMap(session.spawn(command, { env }), output))
            expect((yield* run(`printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
            const result = yield* run(`printf '%s:%s' "\${HOME+present}" "$KEEP"`, {
              KEEP: "a 'quoted' $value",
              HOME: undefined,
              PATH: undefined
            })
            expect(result).toEqual({ stdout: ":a 'quoted' $value", stderr: "", code: 0 })
            expect(workerBinding.instances[0]!.events.some((event) => event.includes("-u HOME"))).toBe(true)
            expect((yield* run(`printf '%s' "\${HOME+present}"`)).stdout).toBe("present")
          }))
      }), 60_000)
  }

  it.effect("conforms in exec mode and forwards only named resolver options", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const workdir = join(root, "conformance-exec-ws")
      const provider = CloudflareSandbox.make({
        sdk,
        binding: workerBinding,
        workdir,
        keepAlive: true,
        sleepAfter: "3m"
      })
      const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
      expect(violations).toEqual([])
      expect(workerBinding.resolutions.length).toBeGreaterThan(1)
      expect(workerBinding.resolutions.every(({ options }) =>
        options?.enableDefaultSession === false && options.keepAlive === true && options.sleepAfter === "3m"
      )).toBe(true)
      expect(workerBinding.instances.every((instance) =>
        instance.destroyed
      )).toBe(true)
      expect(workerBinding.instances.some((instance) =>
        instance.events.includes(`write:${workdir}/conformance-bytes.bin:base64`) &&
        instance.events.includes(`read:${workdir}/conformance-bytes.bin:base64`)
      )).toBe(true)
      // Standard input was staged in the session-private directory under an
      // unguessable name, and every staged file was removed again when the
      // spawn's scope closed.
      const staged = workerBinding.instances.flatMap((instance) =>
        instance.events.flatMap((event) => {
          const match = /^write:(.*\/\.smthrs-stdin\/[0-9a-f]{32}):base64$/.exec(event)
          return match === null ? [] : [match[1]!]
        })
      )
      expect(staged.length).toBeGreaterThan(0)
      expect(new Set(staged).size).toBe(staged.length)
      const removals = workerBinding.instances.flatMap((instance) =>
        instance.events
      )
      expect(staged.every((path) => removals.includes(`exec:rm -f ${path}`))).toBe(true)
    }), 30_000)

  it.effect("conforms in process mode only after waiting and fetching logs", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const provider = CloudflareSandbox.make({
        sdk,
        binding: workerBinding,
        workdir: join(root, "conformance-process-ws"),
        execution: "process"
      })
      const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
      expect(violations).toEqual([])
      const processEvents = workerBinding.instances.flatMap((instance) => instance.events).filter((event) =>
        /^(?:start|wait|logs):/.test(event)
      )
      expect(processEvents.length).toBeGreaterThan(0)
      for (let index = 0; index < processEvents.length; index += 3) {
        expect(processEvents.slice(index, index + 3).map((event) => event.slice(0, event.indexOf(":")))).toEqual([
          "start",
          "wait",
          "logs"
        ])
      }
    }), 30_000)

  it.effect("delivers stdin through the workspace redirect and roots a relative cwd", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const workdir = join(root, "stdin-ws")
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding, workdir })
      const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const copied = yield* Effect.scoped(
            Effect.flatMap(session.spawn("cat > stdin-copy.bin", { stdin: bytes }), output)
          )
          expect(copied.code).toBe(0)
          expect(Array.from(yield* session.readFile(`${workdir}/stdin-copy.bin`))).toEqual(Array.from(bytes))
          // The staged input is gone once the command ends. The assertion names
          // the session-private directory rather than a file, because the
          // staged name is random: "this one literal path is absent" holds just
          // as well for an implementation that leaks every file it ever staged.
          const staging = `${workdir}/.smthrs-stdin`
          const leftovers = yield* Effect.scoped(
            Effect.flatMap(session.spawn(`test -d '${staging}' && ls -1A '${staging}'`, {}), output)
          )
          expect(leftovers).toEqual({ stdout: "", stderr: "", code: 0 })
          yield* Effect.scoped(Effect.asVoid(session.spawn("mkdir -p sub", {})))
          const rooted = yield* Effect.scoped(Effect.flatMap(session.spawn("pwd", { cwd: "./sub/" }), output))
          expect(rooted).toEqual({ stdout: `${workdir}/sub\n`, stderr: "", code: 0 })
        }))
    }))

  it.effect("reports process exits faithfully and filters command options", () =>
    Effect.gen(function*() {
      const handleBinding = binding("handle")
      const workdir = join(root, "process-handle-ws")
      const handleProvider = CloudflareSandbox.make({
        sdk,
        binding: handleBinding,
        workdir,
        execution: "process"
      })
      const handleResult = yield* acquired(handleProvider, (session) =>
        Effect.scoped(Effect.flatMap(
          session.spawn(`printf 'out %s' "${"$"}{KEEP:-}${"$"}{DROP:-}"; printf 'err' >&2; exit 4`, {
            env: { KEEP: "yes", DROP: undefined }
          }),
          output
        )))
      expect(handleResult).toEqual({ stdout: "out yes", stderr: "err", code: 4 })

      // An SDK that reports no exit status anywhere is a provider failure,
      // never an invented exit code.
      const noneBinding = binding("none")
      const noneProvider = CloudflareSandbox.make({
        sdk,
        binding: noneBinding,
        workdir: join(root, "process-none-ws"),
        execution: "process"
      })
      const missing = yield* Effect.flip(acquired(noneProvider, (session) =>
        Effect.scoped(Effect.flatMap(session.spawn("printf 'lost'", {}), (process) =>
          process.exitCode))))
      expect(missing).toMatchObject({ code: "spawn_error" })
      expect(missing.message).toContain("no exit status")
      expect(noneBinding.resolutions[0]?.options).toEqual({ enableDefaultSession: false })
    }))

  it.effect("maps vendor failures and releases half-prepared sandboxes", () =>
    Effect.gen(function*() {
      const resolveBinding = binding()
      resolveBinding.resolveFailure = new Error("binding unavailable")
      const resolveProvider = CloudflareSandbox.make({ sdk, binding: resolveBinding })
      const resolveFailure = yield* Effect.flip(Effect.scoped(resolveProvider.acquire("key")))
      expect(resolveFailure).toMatchObject({ code: "unavailable" })

      const setupBinding = binding()
      const setupSdk = {
        getSandbox(workerBinding: Binding, id: string, options?: SandboxOptions) {
          const sandbox = sdk.getSandbox(workerBinding, id, options)
          sandbox.failMkdir = new Error("mkdir failed")
          return sandbox
        }
      } satisfies CloudflareSandbox.Sdk<Binding>
      const setupProvider = CloudflareSandbox.make({
        sdk: setupSdk,
        binding: setupBinding,
        workdir: join(root, "setup-ws")
      })
      const setupFailure = yield* Effect.flip(Effect.scoped(setupProvider.acquire("key")))
      expect(setupFailure).toMatchObject({ code: "unavailable" })
      expect(setupBinding.instances[0]?.events).toContain("destroy")

      const workerBinding = binding()
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding, workdir: join(root, "destroy-ws") })
      yield* Effect.scoped(
        Effect.flatMap(provider.acquire("key"), (session) =>
          Effect.sync(() => {
            workerBinding.instances.at(-1)!.failDestroy = new Error("destroy failed")
            expect(session.remoteId).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{16}$/)
          }))
      )
    }))

  it.effect("preserves detailed file and process failure codes", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const workdir = join(root, "failure-ws")
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding, workdir })
      yield* Effect.scoped(
        Effect.flatMap(provider.acquire("edge"), (session) =>
          Effect.gen(function*() {
            const live = workerBinding.instances.at(-1)!
            // A path with no separator and a path directly under the root both
            // take the bare write, like every other provider: the root always
            // exists, so neither creates a parent. Both are real files under
            // the instance's own directory.
            const before = live.events.length
            yield* session.writeFile("leaf", new Uint8Array())
            yield* session.writeFile("/leaf", new Uint8Array([0, 255]))
            expect(live.events.slice(before).filter((event) => event.startsWith("mkdir:"))).toEqual([])
            expect(Array.from(yield* session.readFile("/leaf"))).toEqual([0, 255])

            live.readContents.set("/invalid", "not base64 %")
            expect(yield* Effect.flip(session.readFile("/invalid"))).toMatchObject({ code: "unknown" })

            live.readFailures.set("/without-code", new Error("read failed"))
            live.readFailures.set("/null", null)
            live.readFailures.set("/string", "read failed")
            for (const path of ["/without-code", "/null", "/string"]) {
              expect(yield* Effect.flip(session.readFile(path))).toMatchObject({ code: "unknown" })
            }

            live.failMkdir = new Error("parent failed")
            expect(yield* Effect.flip(session.writeFile("/new/leaf", new Uint8Array()))).toMatchObject({
              code: "unknown"
            })
            live.failWrite = new Error("write failed")
            expect(yield* Effect.flip(session.writeFile("/leaf", new Uint8Array()))).toMatchObject({
              code: "unknown"
            })

            live.failExec = new Error("exec failed")
            expect(yield* Effect.flip(Effect.scoped(session.spawn("pwd", {})))).toMatchObject({
              code: "spawn_error"
            })
            live.execExitOverride = 8
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
            live.failExec = new Error("ping rejected")
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
          }))
      )

      const processBinding = binding()
      const processProvider = CloudflareSandbox.make({
        sdk,
        binding: processBinding,
        workdir: join(root, "failure-process-ws"),
        execution: "process"
      })
      yield* Effect.scoped(
        Effect.flatMap(processProvider.acquire("edge"), (session) => {
          processBinding.instances.at(-1)!.failStart = new Error("start failed")
          return Effect.asVoid(Effect.flip(Effect.scoped(session.spawn("pwd", {}))))
        })
      )
    }))
})
