/**
 * The exec boundary's workspace confinement.
 *
 * Every path this action hands a child process is confined to the workspace,
 * symbolic links included. The cache directory is one of those paths: it is
 * substituted into argv immediately before the spawn, so a workspace whose
 * `.flows` is a link to somewhere else would otherwise hand a tool a directory
 * outside the workspace to write into.
 */
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Changesets from "../src/Changesets.ts"
import * as Exec from "../src/Exec.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"

let root: string
let outside: string

const payload = (argv: ReadonlyArray<string>, cwd = "."): Exec.Payload => ({
  cwd,
  argv: argv as [string, ...Array<string>],
  env: {},
  secrets: [],
  expectedExitCodes: [0],
  timeoutMs: Exec.defaultTimeoutMs
})

const run = (
  options: { readonly workspaceRoot: string; readonly cacheDirectory?: string | undefined },
  value: Exec.Payload
): Promise<Exit.Exit<Exec.Result, Exec.ExecError>> => Effect.runPromiseExit(Exec.run(options, value))

const failed = async (value: Exec.Payload, options: Parameters<typeof Exec.run>[0] = { workspaceRoot: root }) => {
  const exit = await Effect.runPromiseExit(Exec.run(options, value))
  if (Exit.isSuccess(exit)) throw new Error("expected an exec failure")
  const rendered = JSON.stringify(exit.cause)
  const parsed = JSON.parse(rendered) as { readonly failures?: ReadonlyArray<{ readonly error: Exec.ExecError }> }
  const error = parsed.failures?.[0]?.error
  if (error === undefined) throw new Error(`expected an ExecError: ${rendered}`)
  return error
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-exec-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-")))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

// No pull: this probe runs only with a reachable daemon and a locally cached image.
const dockerAvailable = spawnSync("docker", ["info"], { timeout: 5000, stdio: "ignore" }).status === 0
const dockerImage = "node:22-bookworm"
const dockerImageAvailable = dockerAvailable &&
  spawnSync("docker", ["image", "inspect", dockerImage], { timeout: 5000, stdio: "ignore" }).status === 0

describe("Docker cleanup", () => {
  it.skipIf(!dockerImageAvailable).each([
    "removes a real daemon container on cancellation",
    "removes a real daemon container on cancellation after a removal timeout"
  ])("%s", async (name) => {
    if (name.endsWith("after a removal timeout")) {
      const spawn = ScopedProcess.spawn
      let firstRemoval = true
      // Inject only a stuck removal CLI; run/start, retries and absence checks
      // still use the real daemon, without altering shared daemon behavior.
      vi.spyOn(ScopedProcess, "spawn").mockImplementation((options) => {
        if (options.args?.[0] === "rm" && firstRemoval) {
          firstRemoval = false
          return spawn({ ...options, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] })
        }
        return spawn(options)
      })
    }
    let containerName: string | undefined
    const wrap = ExecSandbox.wrap
    vi.spyOn(ExecSandbox, "wrap").mockImplementation((...args) => {
      const wrapped = wrap(...args)
      const index = wrapped.argv.indexOf("--name")
      if (index !== -1) containerName = wrapped.argv[index + 1]
      return wrapped
    })
    let ready!: () => void
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    let stdout = ""
    try {
      await Effect.runPromise(Effect.gen(function*() {
        const fiber = yield* Exec.run({
          workspaceRoot: root,
          sandbox: { policy: {}, reads: [], writes: [], mechanism: { _tag: "SandboxDocker", image: dockerImage } },
          onStdout: (chunk) => {
            stdout += Buffer.from(chunk).toString("utf8")
            if (stdout.includes("ready")) ready()
          }
        }, { ...payload(["node", "-e", "console.log('ready');setInterval(()=>{},1000)"]), timeoutMs: 45000 })
          .pipe(Effect.forkChild)
        try {
          const outcome = yield* Effect.promise(() =>
            Promise.race([
              started.then(() => "ready"),
              Effect.runPromise(Fiber.await(fiber)).then((exit) => JSON.stringify(exit))
            ])
          )
          expect(outcome).toBe("ready")
          expect(containerName).toBeDefined()
          expect(
            spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerName!], {
              timeout: 5000,
              encoding: "utf8"
            }).stdout.trim()
          ).toBe("true")
          yield* Fiber.interrupt(fiber)
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
          const listed = spawnSync("docker", [
            "ps",
            "-a",
            "--filter",
            `name=^/${containerName!}$`,
            "--format",
            "{{.Names}}"
          ], {
            timeout: 5000,
            encoding: "utf8"
          })
          expect(listed.status).toBe(0)
          expect(listed.stdout.trim()).toBe("")
        } finally {
          yield* Fiber.interrupt(fiber)
        }
      }))
    } finally {
      if (containerName !== undefined) {
        spawnSync("docker", ["rm", "--force", containerName], { timeout: 5000, stdio: "ignore" })
      }
    }
  }, 75000)

  it.each([
    "timeout",
    "interruption",
    "startup failure",
    "startup interruption",
    "success",
    "removal hangs",
    "removal fails",
    "removal exits nonzero",
    "removal timeout recovers",
    "removal spawn recovers",
    "removal exit recovers",
    "removal already absent",
    "removal misleading absence",
    "removal slow success",
    "removal cancellation recovers"
  ])(
    "removes the container after client cleanup and before scratch cleanup: %s",
    async (mode) => {
      const host = ExecSandbox.host()
      vi.spyOn(ExecSandbox, "host").mockReturnValue({ ...host, executable: () => "/fake/docker" })
      const events: Array<string> = []
      const calls: Array<ScopedProcess.Options> = []
      let removals = 0
      let scratch = ""
      const plan = ExecSandbox.plan
      vi.spyOn(ExecSandbox, "plan").mockImplementation((...args) => {
        const result = plan(...args)
        if (result !== undefined && !ExecSandbox.isUnenforceable(result)) scratch = result.tmp
        return result
      })
      let ready!: () => void
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      vi.spyOn(ScopedProcess, "spawn").mockImplementation((options) =>
        Effect.gen(function*() {
          const removing = options.args?.[0] === "rm"
          calls.push(options)
          if (removing) removals++
          const firstRemoval = removals === 1
          events.push(removing ? "remove" : "run")
          expect(NodeFs.existsSync(scratch)).toBe(true)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push(removing ? "remove closed" : "client closed")
            })
          )
          if (removing && (mode === "removal fails" || (mode === "removal spawn recovers" && firstRemoval))) {
            return yield* Effect.fail(PlatformError.systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "spawn",
              description: "daemon unavailable"
            }))
          }
          if (!removing) {
            ready()
            if (mode === "startup failure") {
              return yield* Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
                description: "startup failed"
              }))
            }
            if (mode === "startup interruption") return yield* Effect.never
          }
          return Object.assign(
            makeHandle({
              pid: ProcessId(1),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: removing &&
                  (mode === "removal already absent" && !firstRemoval || mode === "removal misleading absence")
                ? Stream.make(
                  new TextEncoder().encode(
                    `Error response from daemon: No such container: ${
                      mode === "removal misleading absence" ? "another-container" : options.args![2]
                    }\n`
                  )
                )
                : Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
              exitCode: removing
                ? mode === "removal hangs" ||
                    ((mode === "removal timeout recovers" || mode === "removal already absent" ||
                      mode === "removal cancellation recovers") && firstRemoval)
                  ? Effect.never
                  : mode === "removal slow success"
                  ? Effect.sleep(6000).pipe(Effect.as(ExitCode(0)))
                  : Effect.succeed(ExitCode(
                    mode === "removal misleading absence" || mode === "removal exits nonzero" ||
                      mode === "removal already absent" ||
                      (mode === "removal exit recovers" && firstRemoval) ?
                      1 :
                      0
                  ))
                : mode.startsWith("removal") && mode !== "removal cancellation recovers" || mode === "success"
                ? Effect.succeed(ExitCode(0))
                : Effect.never
            }),
            { targetPid: 1 }
          )
        })
      )
      const effect = Exec.run({
        workspaceRoot: root,
        sandbox: { policy: {}, reads: [], writes: [], mechanism: { _tag: "SandboxDocker", image: "fixture" } }
      }, { ...payload(["true"]), timeoutMs: mode === "timeout" ? 10 : "unbounded" })
      const warnings: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(String(Array.isArray(message) ? message.join(" ") : message))
        })
      ])
      const exit = await Effect.runPromise(
        Effect.gen(function*() {
          const fiber = yield* effect.pipe(Effect.forkChild)
          yield* Effect.promise(() => started)
          const interrupted = mode === "interruption" || mode === "startup interruption" ||
            mode === "removal cancellation recovers"
          const interrupt = interrupted ? yield* Fiber.interrupt(fiber).pipe(Effect.forkChild) : undefined
          yield* TestClock.adjust(30000)
          if (interrupt !== undefined) yield* Fiber.join(interrupt)
          return yield* Fiber.await(fiber)
        }).pipe(Effect.provide(capture), Effect.provide(TestClock.layer()))
      )
      expect(Exit.isSuccess(exit)).toBe(
        mode === "success" || mode.startsWith("removal") && mode !== "removal cancellation recovers"
      )
      const exhausted = mode === "removal misleading absence" || mode === "removal hangs" || mode === "removal fails" ||
        mode === "removal exits nonzero"
      const attempts = exhausted ? 3 : mode.endsWith("recovers") || mode === "removal already absent" ? 2 : 1
      expect(events).toEqual([
        "run",
        "client closed",
        ...Array.from({ length: attempts }, () => ["remove", "remove closed"]).flat()
      ])
      const args = calls[0]!.args!
      expect(args).toContain("--name")
      expect(calls[1]!.command).toBe(calls[0]!.command)
      const containerName = args[args.indexOf("--name") + 1]
      expect(calls[1]!.args).toEqual(["rm", "--force", containerName])
      if (exhausted) {
        expect(warnings).toEqual([
          expect.stringContaining(`could not remove docker container ${containerName} after 3 attempts:`)
        ])
      } else {
        expect(warnings).toEqual([])
      }
      for (const removal of calls.slice(1)) {
        expect(removal.command).toBe(calls[0]!.command)
        expect(removal.args).toEqual(["rm", "--force", containerName])
        expect(removal.env).toEqual(calls[0]!.env)
      }
      expect(NodeFs.existsSync(scratch)).toBe(false)
    }
  )
})

describe("run", () => {
  it("removes scratch directories when preparing a write directory fails", async () => {
    const host = ExecSandbox.host()
    vi.spyOn(ExecSandbox, "host").mockReturnValue({
      ...host,
      platform: "linux",
      executable: (name) => `/usr/bin/${name}`
    })
    const plan = ExecSandbox.plan
    let scratch: string | undefined
    vi.spyOn(ExecSandbox, "plan").mockImplementationOnce((...args) => {
      const confinement = plan(...args)
      if (confinement === undefined || ExecSandbox.isUnenforceable(confinement)) {
        throw new Error("expected an enforceable plan")
      }
      scratch = confinement.tmp
      // A declared directory becomes a file between planning and preparation.
      NodeFs.writeFileSync(NodePath.join(root, "blocked"), "occupied")
      return confinement
    })
    const error = await failed(payload([process.execPath, "-e", "0"]), {
      workspaceRoot: root,
      sandbox: { policy: {}, reads: [], writes: ["blocked"] }
    })
    expect(error.code).toBe("spawn_failed")
    expect(error.stderr).toContain("could not prepare the confinement")
    expect(error.stderr).toContain("EEXIST")
    expect(scratch).toBeDefined()
    expect(NodeFs.existsSync(scratch!)).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "blocked"), "utf8")).toBe("occupied")
  })

  it.each(
    [
      ["linux", "sandbox: { network: true } on Linux"],
      ["darwin", "sandbox: { network: \"loopback\" } on macOS"]
    ] as const
  )("refuses declared secrets under a closed network on %s before spawning", async (platform, remedy) => {
    const host = ExecSandbox.host()
    vi.spyOn(ExecSandbox, "host").mockReturnValue({
      ...host,
      platform,
      executable: (name) => `/usr/bin/${name}`
    })
    const marker = NodePath.join(root, "spawned")
    const error = await failed({
      ...payload([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]),
      secrets: [Secret.HttpSecret(Secret.Secret("EXEC_TEST_TOKEN"), ["http://127.0.0.1:9"])]
    }, {
      workspaceRoot: root,
      sandbox: { policy: {}, reads: [], writes: [] }
    })
    expect(error.code).toBe("sandbox_unenforceable")
    expect(error.stderr).toContain("cannot reach the loopback secret proxy")
    expect(error.stderr).toContain(remedy)
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it("retains the bounded stderr tail and explanation when a tool times out", async () => {
    const error = await failed({
      ...payload([
        process.execPath,
        "-e",
        `process.stderr.write('x'.repeat(${
          Exec.stderrTailLimit * 2
        }) + '\\nwaiting for dependency lock\\n');setInterval(()=>{},1000)`
      ]),
      timeoutMs: 2000
    })
    expect(error.code).toBe("timed_out")
    expect(error.stderr).toContain("waiting for dependency lock")
    expect(error.stderr).toContain("the tool timed out after 2000ms")
    expect(error.stderr.length).toBeLessThanOrEqual(Exec.stderrTailLimit)
  })

  it("runs an unbounded tool until interruption and reaps its process", async () => {
    let resolveStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      resolveStarted = resolve
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Exec.run({
          workspaceRoot: root,
          onStdout: (chunk) => resolveStarted(Number(Buffer.from(chunk).toString("utf8")))
        }, {
          ...payload([process.execPath, "-e", "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"]),
          timeoutMs: "unbounded"
        }).pipe(Effect.forkChild)
        try {
          const outcome = yield* Effect.promise(() =>
            Promise.race([
              started.then((pid) => ({ pid })),
              Effect.runPromise(Fiber.await(fiber)).then((exit) => ({ exit }))
            ])
          )
          if (!("pid" in outcome)) {
            throw new Error(`service exited before interruption: ${JSON.stringify(outcome.exit)}`)
          }
          yield* TestClock.adjust(Exec.defaultTimeoutMs * 2)
          expect(fiber.pollUnsafe()).toBeUndefined()
          expect(() => process.kill(outcome.pid, 0)).not.toThrow()
          yield* Fiber.interrupt(fiber)
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
          expect(() => process.kill(outcome.pid, 0)).toThrow()
        } finally {
          yield* Fiber.interrupt(fiber)
        }
      }).pipe(Effect.provide(TestClock.layer()))
    )
  })

  it("executes the catalog refusal through its live layer", async () => {
    type Registered = (
      input: { readonly target: string },
      executionId: string
    ) => Effect.Effect<never, Target.NotImplemented>
    let registered: Registered | undefined
    const runtime = FlowRuntime.FlowRuntime.of(
      {
        register: (_flow: unknown, execute: Registered) =>
          Effect.sync(() => {
            registered = execute
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )

    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(
        Target.layerNotImplemented.pipe(Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime)))
      )
      if (registered === undefined) throw new Error("catalog refusal action was not registered")
      const instance = FlowRuntime.FlowInstance.of({
        executionId: "catalog-refusal-probe",
        actionState: { count: 0, latch: Latch.makeUnsafe() }
      } as never)
      return yield* Effect.exit(registered({ target: "Catalog.Probe" }, "catalog-refusal-probe")).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
    })))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("executes the irreversible action through its live layer", async () => {
    type Registered = (
      input: Exec.Payload,
      executionId: string
    ) => Effect.Effect<Exec.Result, Exec.ExecError>
    let registered: Registered | undefined
    const runtime = FlowRuntime.FlowRuntime.of(
      {
        register: (_flow: unknown, execute: Registered) =>
          Effect.sync(() => {
            registered = execute
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"]
    )

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(
        Changesets.ExecIrreversibleLive({ workspaceRoot: root }).pipe(
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
        )
      )
      if (registered === undefined) throw new Error("irreversible exec action was not registered")
      const instance = FlowRuntime.FlowInstance.of({
        executionId: "exec-irreversible-probe",
        actionState: { count: 0, latch: Latch.makeUnsafe() }
      } as never)
      return yield* registered(payload(["node", "-e", "process.stdout.write('ok')"]), "exec-irreversible-probe").pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime)
      )
    })))
    expect(result.stdout).toBe("ok")
    expect(result.exitCode).toBe(0)
  })

  it("inherits CI so spawned tools stay non-interactive on hosted runners", async () => {
    const previous = process.env.CI
    process.env.CI = "true"
    try {
      const exit = await run(
        { workspaceRoot: root },
        payload([
          "node",
          "-e",
          `require('node:fs').writeFileSync(process.argv[1], process.env.CI ?? "unset")`,
          "ci-probe.txt"
        ])
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "ci-probe.txt"), "utf8")).toBe("true")
    } finally {
      if (previous === undefined) delete process.env.CI
      else process.env.CI = previous
    }
  })

  it("substitutes the cache directory token for an ordinary directory", async () => {
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload([
        "node",
        "-e",
        `require('node:fs').writeFileSync(process.argv[1], 'ok')`,
        `${Exec.cacheDirectoryToken}.txt`
      ])
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, ".flows.txt"), "utf8")).toBe("ok")
  })

  it("substitutes the checked cache root when the child runs in a subdirectory", async () => {
    await Fs.mkdir(NodePath.join(root, "sub"))
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload([
        "node",
        "-e",
        `const fs = require('node:fs');
         fs.mkdirSync(require('node:path').dirname(process.argv[1]), { recursive: true });
         fs.writeFileSync(process.argv[1], 'ok');`,
        `${Exec.cacheDirectoryToken}/probe.txt`
      ], "sub")
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readdir(NodePath.join(root, "sub"))).toEqual([])
    expect(await Fs.readFile(NodePath.join(root, ".flows", "probe.txt"), "utf8")).toBe("ok")
  })

  /**
   * The gap this closes: substitution ran before anything validated the
   * directory it substituted. `normalizeCacheDirectory` settles the lexical
   * question only, so a `.flows` that is a link out of the workspace was
   * handed straight to the child.
   */
  it("refuses to substitute a cache directory that is a link out of the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, ".flows"))

    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readdir(outside)).toEqual([])
  })

  it("refuses a working directory that leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "linked"))
    const exit = await run({ workspaceRoot: root }, payload(["node", "-e", "0"], "linked"))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("reports the refusal with the unsubstituted argv", async () => {
    // The diagnostic names the declaration, not the host path the run refused
    // to resolve: a rejected substitution must not leak the location it would
    // have produced.
    await Fs.symlink(outside, NodePath.join(root, ".flows"))
    const exit = await run(
      { workspaceRoot: root, cacheDirectory: ".flows" },
      payload(["node", "-e", "0", Exec.cacheDirectoryToken])
    )

    if (!Exit.isFailure(exit)) throw new Error("expected a failure")
    const rendered = JSON.stringify(exit.cause)
    expect(rendered).toContain("leaves the workspace")
    expect(rendered).toContain("smthrs:cache-directory")
    expect(rendered).not.toContain(outside)
  })

  it("rejects accessor-backed payload data without invoking it", async () => {
    let calls = 0
    const value = payload(["node", "-e", "0"])
    Object.defineProperty(value.argv, "1", {
      enumerable: true,
      get: () => {
        calls += 1
        return "-e"
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects a Proxy payload without invoking its traps", async () => {
    let calls = 0
    const value = new Proxy(payload(["node", "-e", "0"]), {
      ownKeys: (target) => {
        calls += 1
        return Reflect.ownKeys(target)
      }
    })

    expect(Exit.isFailure(await run({ workspaceRoot: root }, value))).toBe(true)
    expect(calls).toBe(0)
  })

  it("rejects hostile payload records with a typed diagnostic", async () => {
    const inherited = Object.assign(Object.create({ inherited: true }) as object, payload(["node", "-e", "0"]))
    expect((await failed(inherited as Exec.Payload)).stderr).toContain("plain object")

    const unknown = { ...payload(["node", "-e", "0"]), typo: true }
    expect((await failed(unknown as Exec.Payload)).stderr).toContain("unknown property")

    const symbol = payload(["node", "-e", "0"]) as Exec.Payload & Record<PropertyKey, unknown>
    symbol[Symbol("extra")] = true
    expect((await failed(symbol)).stderr).toContain("unknown property")

    const nonEnumerable = payload(["node", "-e", "0"])
    Object.defineProperty(nonEnumerable, "cwd", { value: ".", enumerable: false })
    expect((await failed(nonEnumerable)).stderr).toContain("enumerable data property")
  })

  it("rejects arrays whose shape could hide or replace an argument", async () => {
    const wrongPrototype = payload(["node", "-e", "0"])
    Object.setPrototypeOf(wrongPrototype.argv, null)
    expect((await failed(wrongPrototype)).stderr).toContain("exec argv must be an array")

    const decorated = payload(["node", "-e", "0"])
    Object.defineProperty(decorated.argv, "extra", { value: true })
    expect((await failed(decorated)).stderr).toContain("dense array without extra properties")

    const missing = payload(["node", "-e", "0"])
    delete (missing.argv as unknown as Array<string>)[1]
    Object.defineProperty(missing.argv, "extra", { value: "balanced-name-count" })
    expect((await failed(missing)).stderr).toContain("dense array without extra properties")
  })

  it("rejects environment and executable declarations that are not portable", async () => {
    const symbolEnvironment = payload(["node", "-e", "0"])
    const env = symbolEnvironment.env as Record<PropertyKey, string>
    env[Symbol("hidden")] = "value"
    expect((await failed(symbolEnvironment)).stderr).toContain("symbol property")

    expect((await failed(payload(["", "-e", "0"]))).stderr).toContain("must name an executable")
    const wideArgument = "é".repeat(600_000)
    expect((await failed(payload(["node", wideArgument, wideArgument]))).stderr).toContain("exec argv exceeds")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { Name: "first", NAME: "second" }
      })).stderr
    ).toContain("repeats a case-insensitive name")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { LARGE: "x".repeat(2 * 1024 * 1024 + 1) }
      })).stderr
    ).toContain("environment exceeds")
    expect(
      (await failed(payload(["node", "-e", "0"]), {
        workspaceRoot: root,
        sensitiveEnv: ["not-portable"]
      })).stderr
    ).toContain("sensitive environment name is not portable")
  })

  it("names the payload member a caller left out rather than decoding around it", async () => {
    // `requiredDataMember` is what stands between a half-written payload and a
    // schema decode that would report the absence as a type mismatch three
    // layers down. The member is named so the author knows which one to add.
    const incomplete = payload(["node", "-e", "0"]) as Record<string, unknown>
    delete incomplete["timeoutMs"]

    expect((await failed(incomplete as Exec.Payload)).stderr).toContain("exec payload.timeoutMs is missing")
  })

  it("refuses a list longer than the bound its member declares", async () => {
    // Each list in the payload carries its own bound, and the refusal names the
    // list rather than the payload, so a caller generating exit codes in a loop
    // is pointed at the loop.
    const tooManyExitCodes = {
      ...payload(["node", "-e", "0"]),
      expectedExitCodes: Array.from({ length: 257 }, (_, index) => index)
    }

    expect((await failed(tooManyExitCodes)).stderr).toContain("exec expected exit codes has more than 256 entries")
  })

  it("refuses more sensitive environment names than it will fold", async () => {
    const names = Array.from({ length: 4_097 }, (_, index) => `SENSITIVE_${index}`)

    expect(
      (await failed(payload(["node", "-e", "0"]), { workspaceRoot: root, sensitiveEnv: names })).stderr
    ).toContain("too many sensitive environment names")
  })

  it("rejects duplicate secret bindings and conflicts with declared environment", async () => {
    const credential = Secret.HttpSecret(Secret.Secret("EXEC_TEST_TOKEN"), ["https://example.test"])
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        secrets: [credential, credential]
      })).stderr
    ).toContain("declares the secret \"EXEC_TEST_TOKEN\" twice")
    expect(
      (await failed({
        ...payload(["node", "-e", "0"]),
        env: { EXEC_TEST_TOKEN: "not-secret" },
        secrets: [credential]
      })).stderr
    ).toContain("also declares it as a secret")
  })

  it("resolves runtime and script placeholders immediately before the real spawn", async () => {
    const exit = await run(
      { workspaceRoot: root },
      {
        ...payload([
          Exec.runtimeBinToken,
          "-e",
          "process.stdout.write(process.argv[1])",
          `${Exec.scriptTokenPrefix}//scripts/generate.mjs}`
        ]),
        after: { completed: true }
      }
    )
    if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
    expect(exit.value.stdout).toBe("scripts/generate.mjs")
  })

  it("streams the exact stdout and stderr bytes to declared observers", async () => {
    const stdout: Array<number> = []
    const stderr: Array<number> = []
    const exit = await Effect.runPromiseExit(Exec.run({
      workspaceRoot: root,
      onStdout: (chunk) => stdout.push(...chunk),
      onStderr: (chunk) => stderr.push(...chunk)
    }, payload([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err')"])))
    if (!Exit.isSuccess(exit)) throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
    expect(Buffer.from(stdout).toString("utf8")).toBe("out")
    expect(Buffer.from(stderr).toString("utf8")).toBe("err")
  })

  it("flushes a partial UTF-8 sequence when the command times out", async () => {
    const error = await failed(
      {
        ...payload([
          process.execPath,
          "-e",
          "process.stdout.write(Buffer.from([0x61,0xe2,0x82]));setInterval(()=>{},1000)"
        ]),
        timeoutMs: 2000
      }
    )
    expect(error.code).toBe("timed_out")
    expect(error.stdout).toBe("a\uFFFD")
    expect(error.stderr).toContain("timed out")
  })

  it("keeps complete capture when optional output observers throw", async () => {
    const result = await Effect.runPromise(Exec.run({
      workspaceRoot: root,
      onStdout: () => {
        throw new Error("stdout observer failed")
      },
      onStderr: () => {
        throw new Error("stderr observer failed")
      }
    }, payload([process.execPath, "-e", "process.stdout.write('out');process.stderr.write('err')"])))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
  })
})

/**
 * The Windows half of the spawn: which file a bare command name names, and how
 * a batch shim reaches `cmd.exe`.
 *
 * `windows-latest` failed 61 of 67 package targets with `spawn pnpm ENOENT`
 * because pnpm installs as `pnpm.cmd` and libuv's own PATH walk appends only
 * `.com` and `.exe`. Nothing below needs a Windows host: `platform` and `env`
 * are parameters, and the fixture directory holds a real batch shim.
 *
 * Fixtures spell an extension in the same case as the `PATHEXT` entry that
 * finds it wherever the resolved path is asserted verbatim, so the assertion
 * reads the same on a case-sensitive and a case-insensitive filesystem. The
 * one test that deliberately mismatches the case says so.
 */
describe("brokered secret origins", () => {
  const credential = (audience: string) =>
    Secret.HttpSecret(Secret.Secret("EXEC_ORIGIN_TOKEN", { fallback: "real-origin-value" }), [audience])

  it("explains every audience the payload has no transport for", () => {
    const api = Secret.SecretOrigin("https://api.example.test")
    expect(
      Exec.unservableAudiences({
        argv: ["curl", `${api}/user`],
        env: {},
        secrets: [credential("https://api.example.test")]
      })
    )
      .toEqual([])
    expect(Exec.unservableAudiences({ argv: ["curl"], env: {}, secrets: [credential("http://127.0.0.1:9")] }))
      .toEqual([])
    expect(Exec.unservableAudiences({ argv: ["curl"], env: { API: api }, secrets: [] })).toEqual([
      "exec names S.SecretOrigin(\"https://api.example.test\"), but no declared S.HttpSecret is bound to that audience"
    ])
    expect(Exec.unservableAudiences({ argv: ["curl"], env: {}, secrets: [credential("https://api.example.test")] }))
      .toEqual([
        "the declared secret EXEC_ORIGIN_TOKEN is bound to https://api.example.test, which the tool can reach " +
        "with the secret substituted only through a brokered origin; point the tool at " +
        "S.SecretOrigin(\"https://api.example.test\") in argv or env"
      ])
  })

  it("refuses an HTTPS audience with no brokered origin before spawning", async () => {
    const marker = NodePath.join(root, "spawned")
    const error = await failed({
      ...payload([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]),
      secrets: [credential("https://api.example.test")]
    })
    expect(error.code).toBe("invalid_payload")
    expect(error.stderr).toContain("S.SecretOrigin(\"https://api.example.test\")")
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it("refuses a brokered origin no declared secret is bound to", async () => {
    const error = await failed({
      ...payload([process.execPath, "-e", "0"]),
      env: { API: Secret.SecretOrigin("https://api.example.test") }
    })
    expect(error.code).toBe("invalid_payload")
    expect(error.stderr).toContain("no declared S.HttpSecret is bound to that audience")
  })

  it("resolves tokens in argv and env to one loopback origin that substitutes the placeholder", async () => {
    const seen: Array<{ authorization: string | undefined; path: string }> = []
    const upstream = NodeHttp.createServer((request, response) => {
      seen.push({ authorization: request.headers.authorization, path: request.url ?? "" })
      response.end("upstream-ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (address === null || typeof address === "string") throw new Error("no upstream port")
    const audience = `http://127.0.0.1:${address.port}`
    const token = Secret.SecretOrigin(audience)
    const program = [
      "const [, fromArgv] = process.argv",
      "fetch(process.env.API + '/x', { headers: { authorization: 'token ' + process.env.EXEC_ORIGIN_TOKEN } })",
      "  .then((response) => response.text())",
      "  .then((body) => process.stdout.write(JSON.stringify({ env: process.env.API, fromArgv, body })))"
    ].join("\n")
    try {
      const exit = await run({ workspaceRoot: root }, {
        ...payload([process.execPath, "-e", program, `url=${token}/y`]),
        env: { API: token },
        secrets: [credential(audience)]
      })
      if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
      const output = JSON.parse(exit.value.stdout) as { env: string; fromArgv: string; body: string }
      expect(output.env).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(output.env).not.toBe(audience)
      expect(output.fromArgv).toBe(`url=${output.env}/y`)
      expect(output.body).toBe("upstream-ok")
      expect(seen).toEqual([{ authorization: "token real-origin-value", path: "/x" }])
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

describe("secret environment names", () => {
  const ownEnv = async (value: Exec.Payload) => {
    const program = "process.stdout.write(JSON.stringify(Object.fromEntries(" +
      "['__proto__', 'ORDINARY', 'EXEC_NAME_TOKEN'].filter((name) => Object.hasOwn(process.env, name))" +
      ".map((name) => [name, process.env[name]]))))"
    const exit = await run({ workspaceRoot: root }, { ...value, argv: [process.execPath, "-e", program] })
    if (!Exit.isSuccess(exit)) throw new Error(`expected a success: ${JSON.stringify(exit.cause)}`)
    return JSON.parse(exit.value.stdout) as Record<string, string>
  }
  const secret = (name: string) =>
    Secret.HttpSecret(Secret.Secret(name, { fallback: "never-in-child" }), [
      "http://127.0.0.1:9"
    ])
  const env = JSON.parse("{\"ORDINARY\":\"ordinary-env\",\"__proto__\":\"proto-env\"}") as Record<string, string>
  const placeholder = /^smithers-build-secret-[0-9a-f]{64}$/

  it("keeps an own __proto__ environment entry with or without a declared secret", async () => {
    const plain = await ownEnv({ ...payload(["node"]), env })
    expect(Object.keys(plain).sort()).toEqual(["ORDINARY", "__proto__"])
    expect(plain["__proto__"]).toBe("proto-env")
    const brokered = await ownEnv({ ...payload(["node"]), env, secrets: [secret("EXEC_NAME_TOKEN")] })
    expect(Object.keys(brokered).sort()).toEqual(["EXEC_NAME_TOKEN", "ORDINARY", "__proto__"])
    expect(brokered["ORDINARY"]).toBe("ordinary-env")
    expect(brokered["__proto__"]).toBe("proto-env")
    expect(brokered["EXEC_NAME_TOKEN"]).toMatch(placeholder)
  })

  it("mints a placeholder for a secret whose environment name is __proto__", async () => {
    const minted = await ownEnv({ ...payload(["node"]), secrets: [secret("__proto__")] })
    expect(Object.keys(minted)).toEqual(["__proto__"])
    expect(minted["__proto__"]).toMatch(placeholder)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)["ORDINARY"]).toBeUndefined()
  })
})

describe("windows executable resolution", () => {
  let bin: string
  const comspec = "C:\\WINDOWS\\system32\\cmd.exe"

  beforeEach(async () => {
    bin = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-winpath-")))
  })

  afterEach(async () => {
    await Fs.rm(bin, { recursive: true, force: true })
  })

  const shim = async (name: string): Promise<string> => {
    const path = NodePath.join(bin, name)
    await Fs.writeFile(path, "@echo off\n", { mode: 0o755 })
    return path
  }

  it("finds a PATHEXT extension libuv's own walk never appends", async () => {
    const shimPath = await shim("pnpm.CMD")
    expect(Exec.findOnPath("pnpm", { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, { platform: "win32" }))
      .toBe(shimPath)
  })

  it("prefers the earlier PATHEXT entry and keeps PATH order", async () => {
    const second = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-winpath2-")))
    try {
      await shim("tool.CMD")
      await shim("tool.EXE")
      await Fs.writeFile(NodePath.join(second, "tool.EXE"), "MZ", { mode: 0o755 })
      expect(Exec.findAllOnPath("tool", { PATH: `${bin};${second}`, PATHEXT: ".EXE;.CMD" }, { platform: "win32" }))
        .toEqual([NodePath.join(bin, "tool.EXE"), NodePath.join(second, "tool.EXE")])
    } finally {
      await Fs.rm(second, { recursive: true, force: true })
    }
  })

  it("tries a spelled-out extension first, and falls back to the default extension list", async () => {
    await shim("runner.py")
    expect(Exec.findOnPath("runner.py", { PATH: bin }, { platform: "win32" }))
      .toBe(NodePath.join(bin, "runner.py"))
    await shim("other.EXE")
    expect(Exec.findOnPath("other", { PATH: bin, PATHEXT: "  " }, { platform: "win32" }))
      .toBe(NodePath.join(bin, "other.EXE"))
  })

  /** Windows folds both the command name and the extension; the lookup must too. */
  it("matches an extension whose case differs from PATHEXT's, and skips an unreadable directory", async () => {
    await shim("pnpm.cmd")
    const found = Exec.findOnPath(
      "PNPM",
      { Path: `${NodePath.join(bin, "missing")};${bin}` },
      { platform: "win32" }
    )
    expect(found === undefined ? undefined : NodePath.dirname(found)).toBe(bin)
    expect(found?.toLowerCase()).toBe(NodePath.join(bin, "pnpm.cmd").toLowerCase())
  })

  it("routes a batch shim through ComSpec with a verbatim, quoted line", async () => {
    const shimPath = await shim("pnpm.CMD")
    expect(
      Exec.spawnShape(["pnpm", "exec", "vitest", "run", "a b"], {
        platform: "win32",
        env: { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: comspec }
      })
    ).toEqual({
      file: comspec,
      args: ["/d", "/s", "/c", `""${shimPath}" "exec" "vitest" "run" "a b""`],
      windowsVerbatimArguments: true
    })
  })

  it("reads ComSpec case-insensitively and defaults it", () => {
    expect(Exec.spawnShape(["x.cmd"], { platform: "win32", env: { COMSPEC: "X:\\cmd.exe" } }).file)
      .toBe("X:\\cmd.exe")
    expect(Exec.spawnShape(["x.cmd"], { platform: "win32", env: {} }).file).toBe("cmd.exe")
  })

  it("doubles only a trailing backslash run, which would escape the closing quote", () => {
    expect(Exec.spawnShape(["x.cmd", "C:\\dir\\", "C:\\a\\b"], { platform: "win32", env: {} }).args[3])
      .toBe(`""x.cmd" "C:\\dir\\\\" "C:\\a\\b""`)
  })

  it("refuses an argument cmd.exe cannot carry, naming it", () => {
    for (const argument of ["say \"hi\"", "100%DONE%", "one\nline", "trailing\r"]) {
      expect(() => Exec.spawnShape(["x.cmd", argument], { platform: "win32", env: {} }))
        .toThrow(/cannot reach a Windows \.cmd shim/)
    }
  })

  it("spawns a resolved image directly, and leaves an unresolvable name to the host", async () => {
    await Fs.writeFile(NodePath.join(bin, "node.EXE"), "MZ", { mode: 0o755 })
    const environment = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: comspec }
    expect(Exec.spawnShape(["node", "-e", "0"], { platform: "win32", env: environment })).toEqual({
      file: NodePath.join(bin, "node.EXE"),
      args: ["-e", "0"],
      windowsVerbatimArguments: false
    })
    expect(Exec.spawnShape(["absent-tool"], { platform: "win32", env: environment })).toEqual({
      file: "absent-tool",
      args: [],
      windowsVerbatimArguments: false
    })
    expect(Exec.spawnShape(["C:\\tools\\thing.exe", "--flag"], { platform: "win32", env: environment }).file)
      .toBe("C:\\tools\\thing.exe")
  })

  it("leaves POSIX exactly as it was: argv[0] verbatim, one candidate name, no PATHEXT", async () => {
    const shimPath = await shim("pnpm.CMD")
    const environment = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    expect(Exec.findOnPath("pnpm", environment, { platform: "linux" })).toBeUndefined()
    expect(Exec.findAllOnPath("pnpm.CMD", environment, { platform: "linux" })).toEqual([shimPath])
    expect(Exec.spawnShape(["pnpm", "exec", "vitest"], { platform: "linux", env: environment })).toEqual({
      file: "pnpm",
      args: ["exec", "vitest"],
      windowsVerbatimArguments: false
    })
  })

  it("reads the ambient platform and environment when neither is given", async () => {
    const shimPath = await shim("host-tool")
    const previous = process.env["PATH"]
    process.env["PATH"] = bin
    try {
      expect(Exec.findOnPath("host-tool")).toBe(process.platform === "win32" ? undefined : shimPath)
      expect(Exec.findAllOnPath("host-tool")).toEqual(process.platform === "win32" ? [] : [shimPath])
    } finally {
      if (previous === undefined) delete process.env["PATH"]
      else process.env["PATH"] = previous
    }
    expect(Exec.spawnShape([process.execPath, "-e", "0"]))
      .toEqual({ file: process.execPath, args: ["-e", "0"], windowsVerbatimArguments: false })
  })
})
