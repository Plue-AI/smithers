import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber, Layer, Option, Path, type PlatformError, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as CommandLine from "../src/CommandLine.ts"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { emptyPolicy, GrantStore } from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The kernel spawner over an absolute POSIX workspace. Effect's `Path.layer` is
 * POSIX-only, so a relative root would resolve against the process's own
 * directory, a drive path on Windows.
 */
const confinedGuarded = ChildProcessSpawner.layer.pipe(Layer.provide([Workspace.layer("/workspace"), Path.layer]))
const guarded = confinedGuarded.pipe(Layer.provide(ProcessConfinement.layerNoop))

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

/**
 * Effect's spawner tag fixes its error channel to `PlatformError`, so the
 * kernel projects a refusal into one and keeps the structured original on the
 * cause.
 */
const denial = (error: unknown) => Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))

const scriptedStore = (allowed: ReadonlySet<string>, checks: Array<Capability.Capability>) =>
  GrantStore.of({
    policy: closedPolicy,
    check: (capability) => {
      checks.push(capability)
      return allowed.has(`${capability.action}:${capability.resource}`)
        ? Effect.void
        : Effect.fail(Permission.permissionDenied(capability, "denied by test"))
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

/** A host spawner whose handle just replays a scripted stdout. */
const hostSpawner = (options: {
  readonly stdout: string
  readonly onSpawn?: (command: ChildProcess.Command) => void
}) =>
  makeSpawner((command) =>
    Effect.sync(() => {
      options.onSpawn?.(command)
      const output = Stream.fromArray([new TextEncoder().encode(options.stdout)])
      return makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )

describe("ChildProcessSpawner", () => {
  for (const length of [4096, 4097]) {
    itEffect(`keeps a ${length}-unit command resource in the typed channel`, () => {
      const checks: Array<Capability.Capability> = []
      let invoked = false
      return Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const error = denial(
          yield* Effect.flip(spawner.exitCode(ChildProcess.make("tool", ["x".repeat(length - "tool ".length)])))
        )
        expect(error.code).toBe(length === 4096 ? "permission_denied" : "invalid_resolution")
        if (length === 4097) expect(error).toMatchObject({ message: expect.stringContaining("4096") })
        expect(checks).toHaveLength(length === 4096 ? 1 : 0)
        expect(invoked).toBe(false)
      }).pipe(
        Effect.provide(guarded),
        Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "", onSpawn: () => (invoked = true) })),
        Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
      )
    })
  }

  itEffect("checks before spawning and does not delegate a denied command", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(
        denial(
          yield* Effect.flip(
            spawner.string(ChildProcess.make("blocked", ["--now"], { cwd: "/workspace/work" }))
          )
        )
      ).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked --now" },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "blocked --now" }])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("preserves PermissionRequired through the PlatformError projection", () => {
    let invoked = false
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (capability) =>
        Effect.fail(Permission.permissionRequired({
          requestId: "permission-7",
          runId: "run-1",
          capability,
          tier: "irreversible",
          meta: { surface: "process" }
        })),
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const failure = denial(yield* Effect.flip(spawner.exitCode(ChildProcess.make("blocked"))))
      expect(failure).toBeInstanceOf(Permission.PermissionRequired)
      expect(failure).toMatchObject({
        code: "permission_required",
        requestId: "permission-7",
        runId: "run-1",
        capability: { action: "proc:spawn", resource: "blocked" },
        meta: { surface: "process" }
      })
      expect(invoked).toBe(false)
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("preserves GrantStoreError through the PlatformError projection", () => {
    let invoked = false
    const store = GrantStore.of({
      policy: closedPolicy,
      check: () =>
        Effect.fail(
          new Permission.GrantStoreError({
            code: "journal_failed",
            message: "permission journal unavailable"
          })
        ),
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const failure = denial(yield* Effect.flip(spawner.exitCode(ChildProcess.make("blocked"))))
      expect(failure).toBeInstanceOf(Permission.GrantStoreError)
      expect(failure).toMatchObject({
        code: "journal_failed",
        message: "permission journal unavailable"
      })
      expect(invoked).toBe(false)
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("delegates allowed commands without changing their result", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.string(ChildProcess.make("tool"))).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("delegates the exact command snapshot approved before an attended wait", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const checked: Array<readonly [string, unknown]> = []
        let delegated: ChildProcess.Command | undefined
        const store = GrantStore.of({
          policy: closedPolicy,
          check: (capability, context) =>
            Effect.all([
              Effect.sync(() => checked.push([capability.resource, context])),
              Deferred.succeed(entered, undefined),
              Deferred.await(release)
            ]).pipe(Effect.asVoid),
          reply: () => Effect.die("not used by command snapshot test"),
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        const args = ["safe"]
        const env: Record<string, string> = { MODE: "safe" }
        const options: ChildProcess.CommandOptions = { cwd: "/workspace/safe", env, shell: false }
        const command = ChildProcess.make("tool", args, options)

        const running = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          return yield* spawner.string(command)
        }).pipe(
          Effect.provide(guarded),
          Effect.provideService(
            HostChildProcessSpawner,
            hostSpawner({
              stdout: "ok",
              onSpawn: (snapshot) => {
                delegated = snapshot
              }
            })
          ),
          Effect.provideService(GrantStore, store),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(entered)
        args[0] = "unsafe"
        env.MODE = "unsafe"
        ;(options as { cwd?: string; shell?: boolean }).cwd = "/unsafe"
        ;(options as { shell?: boolean }).shell = true
        ;(command as { command: string }).command = "other-tool"
        yield* Deferred.succeed(release, undefined)

        expect(yield* Fiber.join(running)).toBe("ok")
        expect(checked).toEqual([["env MODE -- tool safe", { cwd: "/workspace/safe", env: ["MODE"] }]])
        expect(delegated).toMatchObject({
          _tag: "StandardCommand",
          command: "tool",
          args: ["safe"],
          options: { cwd: "/workspace/safe", env: { MODE: "safe" }, shell: false }
        })
      })
    ))

  itEffect("checks every derived helper, not just `spawn`", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command = ChildProcess.make("tool")
      yield* Effect.scoped(spawner.spawn(command))
      yield* spawner.exitCode(command)
      yield* spawner.string(command)
      yield* spawner.lines(command)
      yield* Stream.runDrain(spawner.streamString(command))
      yield* Stream.runDrain(spawner.streamLines(command))
      expect(checks).toHaveLength(6)
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("acquires stream permission only when the stream is consumed", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stream = spawner.streamString(ChildProcess.make("tool"))
      expect(checks).toEqual([])
      expect(delegated).toBe(false)
      expect(yield* Stream.mkString(stream)).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
      expect(delegated).toBe(true)
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "out", onSpawn: () => (delegated = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("decorates Effect's own spawner tag, so there is nothing else to reach for", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      // One tag: the kernel re-export and Effect's own module name the same
      // service, and the guarded implementation is what both resolve to.
      expect(ChildProcessSpawner.ChildProcessSpawner).toBe(HostChildProcessSpawner)
      const raw = yield* HostChildProcessSpawner
      const failure = yield* Effect.flip(raw.string(ChildProcess.make("blocked")))
      expect(failure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "PermissionDenied", module: "ChildProcessSpawner", method: "spawn" }
      })
      expect(denial(failure)).toMatchObject({ code: "permission_denied" })
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("passes the command's cwd to the grant check without changing no-env metadata", () => {
    const seen: Array<unknown> = []
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (capability, context) => {
        seen.push({ capability, context })
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/workspace/work" }))
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/workspace/work", env: { OMITTED: undefined } }))
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/elsewhere" }))
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/workspace-sibling" }))
      expect(seen).toEqual([
        {
          capability: { action: "proc:spawn", resource: "tool" },
          context: { cwd: "/workspace/work" }
        },
        {
          capability: { action: "proc:spawn", resource: "tool" },
          context: { cwd: "/workspace/work" }
        },
        {
          capability: { action: "proc:spawn", resource: "cwd /elsewhere -- tool" },
          context: { cwd: "/elsewhere" }
        },
        {
          capability: { action: "proc:spawn", resource: "cwd /workspace-sibling -- tool" },
          context: { cwd: "/workspace-sibling" }
        }
      ])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("passes sorted environment names without values to the grant check", () => {
    const seen: Array<unknown> = []
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (capability, context) => {
        seen.push({ capability, context })
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], {
        env: { Z_TOKEN: "secret-z", OMITTED: undefined, A_PATH: "secret-a" }
      }))
      expect(seen).toEqual([{
        capability: { action: "proc:spawn", resource: "env A_PATH Z_TOKEN -- tool" },
        context: { cwd: "/workspace", env: ["A_PATH", "Z_TOKEN"] }
      }])
      expect(JSON.stringify(seen)).not.toContain("secret")
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("caps environment metadata at 64 sorted names and reports the omitted count", () => {
    const seen: Array<unknown> = []
    const environment = Object.fromEntries(
      Array.from({ length: 71 }, (_, index) => [`NAME_${String(index).padStart(2, "0")}`, `value-${index}`])
    )
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (_capability, context) => {
        seen.push(context)
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], { env: environment }))
      expect(seen).toEqual([{
        cwd: "/workspace",
        env: [...Array.from({ length: 64 }, (_, index) => `NAME_${String(index).padStart(2, "0")}`), "+7 more"]
      }])
      expect(JSON.stringify(seen)).not.toContain("value-")
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("reports exactly 64 environment names in full without an omitted-count marker", () => {
    const seen: Array<unknown> = []
    const environment = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`NAME_${String(index).padStart(2, "0")}`, `value-${index}`])
    )
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (_capability, context) => {
        seen.push(context)
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], { env: environment }))
      expect(seen).toEqual([{
        cwd: "/workspace",
        env: Array.from({ length: 64 }, (_, index) => `NAME_${String(index).padStart(2, "0")}`)
      }])
      expect(JSON.stringify(seen)).not.toContain("more")
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("roots a win32 workspace and passes drive and UNC directories through", () => {
    const checked: Array<unknown> = []
    const spawned: Array<string | undefined> = []
    const store = GrantStore.of({
      policy: closedPolicy,
      check: (_capability, context) => {
        checked.push(context?.cwd)
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const cwds = [undefined, "src", "E:\\other", "\\\\server\\share\\dir"]
    const expected = ["D:\\work", "D:\\work\\src", "E:\\other", "\\\\server\\share\\dir"]

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const cwd of cwds) yield* spawner.string(ChildProcess.make("tool", [], cwd === undefined ? {} : { cwd }))
      expect(checked).toEqual(expected)
      expect(spawned).toEqual(expected)
    }).pipe(
      Effect.provide(
        ChildProcessSpawner.layer.pipe(
          Layer.provide([Workspace.layer("D:\\work"), NodePath.layerWin32, ProcessConfinement.layerNoop])
        )
      ),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "out", onSpawn: (command) => spawned.push(CommandLine.cwd(command)) })
      ),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("checks a chained shell command as the explicit sh -c line the shell executes", () => {
    const checks: Array<Capability.Capability> = []
    const line = "sh -c 'echo safe; run privileged'"

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.exitCode(ChildProcess.make("echo", ["safe;", "run", "privileged"], { shell: true }))
      expect(checks).toEqual([{ action: "proc:spawn", resource: line }])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "" })),
      Effect.provideService(GrantStore, scriptedStore(new Set([`proc:spawn:${line}`]), checks))
    )
  })

  itEffect("includes a custom shell executable in the checked resource", () => {
    const checks: Array<Capability.Capability> = []
    const line = "/custom/shell -c 'echo hello world'"

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.exitCode(ChildProcess.make("echo", ["hello", "world"], { shell: "/custom/shell" }))
      expect(checks).toEqual([{ action: "proc:spawn", resource: line }])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "" })),
      Effect.provideService(GrantStore, scriptedStore(new Set([`proc:spawn:${line}`]), checks))
    )
  })

  itEffect("recursively snapshots pipeline options, streams, environments, and additional descriptors", () => {
    const checks: Array<Capability.Capability> = []
    let delegated: ChildProcess.Command | undefined
    const environment: Record<string, string | undefined> = { MODE: "safe", OPTIONAL: undefined }
    const byteSink = Sink.forEach((_chunk: Uint8Array) => Effect.void)
    Object.defineProperty(environment, "hidden", { enumerable: false, value: "ignored" })
    const hiddenFds = Object.defineProperty({}, "fd9", {
      enumerable: false,
      value: { type: "input" }
    }) as ChildProcess.CommandOptions["additionalFds"]
    const left = ChildProcess.make("producer", ["safe"], {
      killSignal: "SIGTERM",
      forceKillAfter: "1 second",
      cwd: "/workspace/work",
      env: environment,
      extendEnv: false,
      shell: false,
      detached: true,
      windowsHide: true,
      stdin: { stream: "ignore", endOnDone: false, encoding: "utf8" },
      stdout: { stream: "pipe" },
      stderr: "inherit",
      additionalFds: {
        fd3: { type: "input", stream: Stream.empty },
        fd4: { type: "output", sink: byteSink as never },
        fd5: { type: "input" },
        fd6: { type: "output" }
      }
    })
    const right = ChildProcess.make("consumer", ["safe"], {
      stdout: {} as never,
      additionalFds: hiddenFds
    })
    const pipeline = ChildProcess.pipeTo(right, { from: "stderr", to: "stdin" })(left)

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.string(pipeline)).toBe("ok")
      expect(delegated).toMatchObject({
        _tag: "PipedCommand",
        options: { from: "stderr", to: "stdin" },
        left: {
          command: "producer",
          args: ["safe"],
          options: {
            cwd: "/workspace/work",
            env: { MODE: "safe", OPTIONAL: undefined },
            stdin: { stream: "ignore", endOnDone: false, encoding: "utf8" },
            additionalFds: {
              fd3: { type: "input" },
              fd4: { type: "output" },
              fd5: { type: "input" },
              fd6: { type: "output" }
            }
          }
        },
        right: { command: "consumer", args: ["safe"] }
      })
      expect(delegated).not.toBe(pipeline)
      expect((delegated as ChildProcess.PipedCommand).left).not.toBe(left)
      expect(checks).toEqual([
        { action: "proc:spawn", resource: "env MODE -- producer safe" },
        { action: "proc:spawn", resource: "consumer safe" }
      ])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "ok", onSpawn: (command) => (delegated = command) })
      ),
      Effect.provideService(
        GrantStore,
        scriptedStore(new Set(["proc:spawn:env MODE -- producer safe", "proc:spawn:consumer safe"]), checks)
      )
    )
  })

  itEffect("snapshots a pipeline whose pipe options are both omitted", () => {
    const checks: Array<Capability.Capability> = []
    const pipeline = ChildProcess.pipeTo(ChildProcess.make("right"))(ChildProcess.make("left"))
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.string(pipeline)).toBe("ok")
      expect(checks).toEqual([
        { action: "proc:spawn", resource: "left" },
        { action: "proc:spawn", resource: "right" }
      ])
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "ok" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:left", "proc:spawn:right"]), checks))
    )
  })

  itEffect("rejects hostile or unsupported mutable command shapes before delegation", () => {
    let delegated = false
    const standard = (overrides: Record<string, unknown> = {}): ChildProcess.Command => ({
      _tag: "StandardCommand",
      command: "tool",
      args: [],
      options: {},
      ...overrides
    } as unknown as ChildProcess.Command)
    const piped = (overrides: Record<string, unknown> = {}): ChildProcess.Command => ({
      _tag: "PipedCommand",
      left: standard(),
      right: standard(),
      options: {},
      ...overrides
    } as unknown as ChildProcess.Command)
    const accessor = (name: string, base: Record<string, unknown>): ChildProcess.Command =>
      Object.defineProperty(base, name, { enumerable: true, get: () => "unsafe" }) as unknown as ChildProcess.Command
    const badEnvironment = Object.defineProperty({}, "TOKEN", { enumerable: true, get: () => "unsafe" })
    const badStream = Object.defineProperty({}, "stream", { enumerable: true, get: () => "ignore" })
    const badEnd = Object.defineProperties({}, {
      stream: { enumerable: true, value: "ignore" },
      endOnDone: { enumerable: true, get: () => false }
    })
    const badFdType = Object.defineProperty({}, "type", { enumerable: true, get: () => "input" })
    const badInput = Object.defineProperties({}, {
      type: { enumerable: true, value: "input" },
      stream: { enumerable: true, get: () => Stream.empty }
    })
    const badOutput = Object.defineProperties({}, {
      type: { enumerable: true, value: "output" },
      sink: { enumerable: true, get: () => Sink.forEach((_chunk: Uint8Array) => Effect.void) }
    })
    const badFrom = Object.defineProperty({}, "from", { enumerable: true, get: () => "stderr" })
    const cases: ReadonlyArray<ChildProcess.Command> = [
      accessor("_tag", { command: "tool", args: [], options: {} }),
      standard({ command: 1 }),
      standard({ args: "unsafe" }),
      standard({ args: [1] }),
      standard({ options: null }),
      standard({ options: { env: badEnvironment } }),
      standard({ options: { env: { TOKEN: 1 } } }),
      standard({ options: { stdin: badStream } }),
      standard({ options: { stdin: badEnd } }),
      standard({ options: { additionalFds: { fd3: null } } }),
      standard({ options: { additionalFds: { fd3: badFdType } } }),
      standard({ options: { additionalFds: { fd3: badInput } } }),
      standard({ options: { additionalFds: { fd3: badOutput } } }),
      standard({ options: { additionalFds: { fd3: { type: "unknown" } } } }),
      piped({ left: null }),
      piped({ right: null }),
      piped({ options: null }),
      piped({ options: badFrom }),
      { _tag: "UnknownCommand" } as unknown as ChildProcess.Command
    ]

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const command of cases) {
        expect(yield* Effect.flip(spawner.exitCode(command))).toMatchObject({
          _tag: "PlatformError",
          reason: {
            _tag: "InvalidData",
            module: "ChildProcessSpawner",
            method: "spawn"
          }
        })
      }
      expect(delegated).toBe(false)
    }).pipe(
      Effect.provide(guarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (delegated = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(), []))
    )
  })
})

describe("ChildProcessSpawner confinement", () => {
  it.effect("checks all stages before wrapping nested pipeline and preserves routing", () =>
    Effect.scoped(Effect.gen(function*() {
      const events: Array<string> = []
      let spawned: ChildProcess.Command | undefined
      const store = {
        ...scriptedStore(new Set(), []),
        policy: emptyPolicy,
        check: (capability: Capability.Capability) =>
          Effect.sync(() => {
            events.push(`check:${capability.resource}`)
          })
      }
      const confinement = {
        confine: (command: ChildProcess.StandardCommand, profile: ProcessConfinement.Profile) =>
          Effect.sync(() => {
            events.push(`wrap:${command.command}`)
            expect(profile).toMatchObject({ workspaceRoot: "/workspace", writes: [], network: "none" })
            expect(command.options.cwd).toBe("/workspace")
            return ChildProcess.make("sandbox", [command.command, ...command.args], command.options)
          })
      }
      const command = ChildProcess.make("first", ["a"]).pipe(
        ChildProcess.pipeTo(ChildProcess.make("second"), { from: "stderr" }),
        ChildProcess.pipeTo(ChildProcess.make("third"))
      )
      yield* Effect.gen(function*() {
        const spawner = yield* HostChildProcessSpawner
        yield* spawner.spawn(command)
      }).pipe(
        Effect.provide(confinedGuarded),
        Effect.provideService(
          HostChildProcessSpawner,
          hostSpawner({
            stdout: "",
            onSpawn: (command) => {
              spawned = command
              events.push("spawn")
            }
          })
        ),
        Effect.provideService(GrantStore, store),
        Effect.provideService(ProcessConfinement.ProcessConfinement, confinement)
      )
      expect(events).toEqual([
        "check:first a",
        "check:second",
        "check:third",
        "wrap:first",
        "wrap:second",
        "wrap:third",
        "spawn"
      ])
      expect(CommandLine.stages(spawned!).map((stage) => stage.command)).toEqual(["sandbox", "sandbox", "sandbox"])
      if (spawned!._tag === "PipedCommand" && spawned!.left._tag === "PipedCommand") {
        expect(spawned!.left.options).toEqual({ from: "stderr" })
      }
    })))
  it.effect("later wrapper failure starts zero processes", () =>
    Effect.scoped(Effect.gen(function*() {
      let wraps = 0
      let spawns = 0
      const confinement = {
        confine: (command: ChildProcess.StandardCommand) =>
          ++wraps === 1 ? Effect.succeed(command) : Effect.fail(Permission.toPlatformError({
            module: "ChildProcessSpawner",
            method: "spawn",
            error: Permission.permissionDenied(
              new Capability.Capability({ action: "proc:spawn", resource: "second" }),
              "wrapper unavailable"
            )
          }))
      }
      const error = yield* Effect.gen(function*() {
        const spawner = yield* HostChildProcessSpawner
        return yield* Effect.flip(
          spawner.spawn(ChildProcess.make("first").pipe(ChildProcess.pipeTo(ChildProcess.make("second"))))
        )
      }).pipe(
        Effect.provide(confinedGuarded),
        Effect.provideService(
          HostChildProcessSpawner,
          hostSpawner({
            stdout: "",
            onSpawn: () => {
              spawns++
            }
          })
        ),
        Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:first", "proc:spawn:second"]), [])),
        Effect.provideService(ProcessConfinement.ProcessConfinement, confinement)
      )
      expect(denial(error)).toMatchObject({ reason: "wrapper unavailable" })
      expect(wraps).toBe(2)
      expect(spawns).toBe(0)
    })))
  it.effect("denied approval never wraps", () =>
    Effect.scoped(Effect.gen(function*() {
      let wraps = 0
      yield* Effect.gen(function*() {
        const spawner = yield* HostChildProcessSpawner
        yield* Effect.flip(spawner.spawn(ChildProcess.make("denied")))
      }).pipe(
        Effect.provide(confinedGuarded),
        Effect.provideService(
          HostChildProcessSpawner,
          hostSpawner({
            stdout: "",
            onSpawn: () => {
              throw new Error("must not spawn")
            }
          })
        ),
        Effect.provideService(GrantStore, scriptedStore(new Set(), [])),
        Effect.provideService(ProcessConfinement.ProcessConfinement, {
          confine: (command) =>
            Effect.sync(() => {
              wraps++
              return command
            })
        })
      )
      expect(wraps).toBe(0)
    })))
})

it.effect("confinement snapshot failure is typed and starts no process", () =>
  Effect.scoped(Effect.gen(function*() {
    let wrapped = false
    const error = yield* Effect.gen(function*() {
      const spawner = yield* HostChildProcessSpawner
      return yield* Effect.flip(spawner.spawn(ChildProcess.make("tool")))
    }).pipe(
      Effect.provide(confinedGuarded),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({
          stdout: "",
          onSpawn: () => {
            throw new Error("must not spawn")
          }
        })
      ),
      Effect.provideService(GrantStore, {
        ...scriptedStore(new Set(["proc:spawn:tool"]), []),
        policy: Effect.fail(new Permission.GrantStoreError({ code: "store_closed" }))
      }),
      Effect.provideService(ProcessConfinement.ProcessConfinement, {
        confine: (command) =>
          Effect.sync(() => {
            wrapped = true
            return command
          })
      })
    )
    expect(denial(error)).toMatchObject({ code: "store_closed" })
    expect(wrapped).toBe(false)
  })))

it.effect("missing confinement refuses approved commands without spawning", () =>
  Effect.scoped(Effect.gen(function*() {
    let spawns = 0
    const error = yield* Effect.gen(function*() {
      const spawner = yield* HostChildProcessSpawner
      return yield* Effect.flip(spawner.spawn(ChildProcess.make("tool")))
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer.pipe(Layer.provide([Workspace.layer("/workspace"), Path.layer]))),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({
          stdout: "",
          onSpawn: () => {
            spawns++
          }
        })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), []))
    )
    expect(error.reason._tag).toBe("NotFound")
    expect(error.reason.module).toBe("ProcessConfinement")
    expect(spawns).toBe(0)
  })))
