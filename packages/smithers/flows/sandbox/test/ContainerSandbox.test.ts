import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit, PlatformError, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

// -----------------------------------------------------------------------------
// The container engine as a fake: real shells behind docker's argv contract.
// -----------------------------------------------------------------------------

// The fake emulates only what the docker CLI itself contributes — the
// create/start/exec/rm verbs, name uniqueness, exit codes, stderr text, and
// the engine's rule that an exec's argv is resolved through the exec
// environment's PATH — and every guest command runs through a real `/bin/sh`
// against a real directory, so pidfiles, signals, `cat`, and `pgrep` are all
// genuine. The fixed guest pid directory is remapped under the test root the
// way the AWS fake remaps it, and the guest program runs under a supervising
// local shell so a signalled command reports `128+signal` the way the docker
// client does instead of failing the local exit observation.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-container-sandbox-")))
const workdir = join(root, "workspace")
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// Use the host's contained native adapter: its pipe error listeners survive
// scope cleanup when a guest refuses a write before consuming all stdin.
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

const encoder = new TextEncoder()

// A long-running fixture whose duration is this process's own, kept below the
// conformance suite's 4200+ range, so no concurrent vitest worker's fixture
// can match this file's survivor probes. The probe brackets the last digit so
// it cannot match its own command line.
const sleepDuration = String(3700 + (process.pid % 150))
const sleeps = `sleep ${sleepDuration}`
const survivor = `pgrep -f 'sleep ${sleepDuration.slice(0, -1)}[${sleepDuration.slice(-1)}]'`

interface Call {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly input: string
}

interface Response {
  readonly wait?: Effect.Effect<void>

  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failSpawn?: boolean | undefined
  readonly failObserve?: boolean | undefined
}

const remap = (token: string): string => token.replaceAll("/tmp/.smthrs-sbx", `${root}/.pids`)

const engine = (fault: (args: ReadonlyArray<string>) => Response | undefined = () => undefined) => {
  const calls: Array<Call> = []
  const containers = new Map<string, { started: boolean; env: Record<string, string>; inspect: object }>()
  const canned = (response: Response) =>
    makeHandle({
      pid: ProcessId(1),
      exitCode: response.failObserve === true
        ? Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "exitCode", description: "lost" })
        )
        : Effect.as(response.wait ?? Effect.void, ExitCode(response.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: response.stdout === undefined ? Stream.empty : Stream.make(encoder.encode(response.stdout)),
      stderr: response.stderr === undefined ? Stream.empty : Stream.make(encoder.encode(response.stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  const spawner = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines" })
        )
      }
      const input = Stream.isStream(command.options.stdin)
        ? yield* Stream.runFold(command.options.stdin as Stream.Stream<Uint8Array>, () =>
          "", (text, bytes) =>
          text + new TextDecoder().decode(bytes))
        : ""
      calls.push({ file: command.command, input, args: command.args })
      const injected = fault(command.args)
      if (injected?.failSpawn === true) {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "engine gone" })
        )
      }
      if (injected !== undefined) {
        return canned(injected)
      }
      const args = [...command.args]
      if (args[0] === "create") {
        const name = args[args.indexOf("--name") + 1]!
        if (containers.has(name)) {
          return canned({
            exitCode: 125,
            stderr:
              `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "0123456789ab".\n`
          })
        }
        const env: Record<string, string> = {}
        if (args.includes("--env-file")) {
          expect(args[args.indexOf("--env-file") + 1]).toBe("/dev/stdin")
          for (
            const line of input.split("\n").filter((line) =>
              line.length > 0
            )
          ) {
            const separator = line.indexOf("=")
            env[line.slice(0, separator)] = line.slice(separator + 1)
          }
        }
        containers.set(name, {
          started: false,
          env,
          inspect: {
            Config: {
              Image: args.at(-3),
              WorkingDir: args[args.indexOf("--workdir") + 1],
              Labels: Object.fromEntries(args.flatMap((arg, index) =>
                arg === "--label"
                  ? [args[index + 1]!.split("=")] :
                  []
              ))
            },
            HostConfig: {
              NetworkMode: args[args.indexOf("--network") + 1],
              Privileged: args.includes("--privileged"),
              Binds: args.includes("--volume") ? [args[args.indexOf("--volume") + 1]] : []
            },
            Mounts: args.includes("--volume") ? [{ Type: "bind", Source: "/", Destination: "/host" }] : []
          }
        })
        return canned({ stdout: "0123456789ab\n" })
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const name = args[2]!
        return containers.has(name)
          ? canned({ stdout: JSON.stringify([containers.get(name)!.inspect]) })
          : canned({ exitCode: 1, stderr: `Error response from daemon: No such container: ${name}\n` })
      }
      if (args[0] === "start") {
        const held = containers.get(args[1]!)
        if (held === undefined) {
          return canned({ exitCode: 1, stderr: `Error response from daemon: No such container: ${args[1]}\n` })
        }
        held.started = true
        return canned({ stdout: `${args[1]}\n` })
      }
      if (args[0] === "rm") {
        const name = args.at(-1)!
        return containers.delete(name)
          ? canned({ stdout: `${name}\n` })
          : canned({ exitCode: 1, stderr: `Error response from daemon: No such container: ${name}\n` })
      }
      // exec [--interactive] [--workdir DIR] [--env K=V ...] NAME PROGRAM ARGS...
      let index = 1
      let interactive = false
      let cwd = root
      const env: Record<string, string> = {}
      while (args[index]?.startsWith("--") === true) {
        if (args[index] === "--interactive") {
          interactive = true
          index += 1
        } else if (args[index] === "--workdir") {
          cwd = args[index + 1]!
          index += 2
        } else {
          const assignment = args[index + 1]!
          const separator = assignment.indexOf("=")
          env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
          index += 2
        }
      }
      const name = args[index]!
      if (containers.get(name)?.started !== true) {
        return canned({ exitCode: 1, stderr: `Error response from daemon: container ${name} is not running\n` })
      }
      const program = args[index + 1]!
      // The engine resolves the exec's argv through the exec environment's
      // PATH, so a PATH override breaks any non-absolute program before it
      // starts. This rule is what the provider's absolute `/bin/sh` defeats.
      if (!program.startsWith("/") && env.PATH !== undefined) {
        return canned({
          exitCode: 126,
          stderr:
            `OCI runtime exec failed: exec failed: unable to start container process: exec: "${program}": executable file not found in $PATH: unknown\n`
        })
      }
      const child = yield* local.spawn(
        ChildProcess.make("/bin/sh", ["-c", `"$0" "$@"; exit "$?"`, program, ...args.slice(index + 2).map(remap)], {
          cwd,
          env: { ...containers.get(name)!.env, ...env },
          extendEnv: true,
          ...interactive && Stream.isStream(command.options.stdin)
            ? { stdin: command.options.stdin as Stream.Stream<Uint8Array> }
            : {}
        })
      )
      return makeHandle({
        pid: child.pid,
        exitCode: child.exitCode,
        isRunning: child.isRunning,
        kill: (killOptions) => child.kill(killOptions),
        stdin: Sink.drain,
        stdout: child.stdout,
        stderr: child.stderr,
        all: child.all,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: child.unref
      })
    })
  )
  return { calls, containers, spawner }
}

const acquired = <A, E>(
  provider: ReturnType<typeof ContainerSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>,
  session = "run-1"
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(session), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("ContainerSandbox", () => {
  it.effect("bounds stalled process signalling on the platform timer", () =>
    stalledFinalizer((stall) => {
      const fake = engine((args) => args.at(-1)?.includes("kill -s TERM") === true ? { wait: stall } : undefined)
      return acquired(ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir }), (session) =>
        Effect.scoped(session.spawn("true", {})))
    }, ".pid"))

  it.effect("bounds stalled session removal on the platform timer", () =>
    stalledFinalizer((stall) => {
      const fake = engine((args) => args[0] === "rm" ? { wait: stall } : undefined)
      return acquired(ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir }), Effect.succeed)
    }, "smthrs-"))

  it.effect("rejects unverifiable or altered inspected containers before start or cleanup", () =>
    Effect.gen(function*() {
      for (
        const change of [
          "labels",
          "owner",
          "image",
          "workdir",
          "network",
          "privileged",
          "binds",
          "mounts",
          "json",
          "multiple",
          "empty"
        ] as const
      ) {
        let label = ""
        const fake = engine((args) => {
          if (args[0] === "create") {
            label = args[args.indexOf("--label") + 1]!.split("=")[1]!
            return { exitCode: 125 }
          }
          if (args[0] !== "container") return undefined
          const held = {
            Config: {
              Image: change === "image" ? "other" : "img",
              WorkingDir: change === "workdir" ? "/other" : workdir,
              Labels: change === "labels"
                ? {}
                : { "smithers.dev/sandbox-fingerprint": change === "owner" ? "other" : label }
            },
            HostConfig: {
              NetworkMode: change === "network" ? "host" : "none",
              Privileged: change === "privileged",
              Binds: change === "binds" ? ["/:/host"] : null
            },
            Mounts: change === "mounts" ? [{ Type: "bind" }] : []
          }
          return {
            stdout: change === "json"
              ? "{"
              : JSON.stringify(change === "empty" ? [] : change === "multiple" ? [held, held] : [held])
          }
        })
        const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        expect(yield* Effect.flip(Effect.scoped(provider.acquire("inspect")))).toMatchObject({ code: "unavailable" })
        expect(fake.calls.some(({ args }) => ["start", "exec", "rm"].includes(args[0]!))).toBe(false)
      }
    }))

  it.effect("refuses a container name the CLI would parse as an option, before any engine call", () =>
    Effect.gen(function*() {
      const fake = engine(() => undefined)
      const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", namePrefix: "" })
      const refused = yield* Effect.flip(Effect.scoped(provider.acquire("-uroot")))
      expect(refused).toMatchObject({ code: "spawn_error" })
      expect(refused.message).toContain("starts with \"-\"")
      expect(fake.calls).toEqual([])
    }))

  it.effect("reattaches matching explicit creation options and reordered environment records", () =>
    Effect.gen(function*() {
      for (const createArgs of [[], ["--memory", "1g"], ["--privileged", "--volume", "/:/host"]]) {
        const fake = engine()
        const leaked = yield* Scope.make()
        const options = { spawner: fake.spawner, image: "img", workdir, network: "host", createArgs }
        const first = yield* Effect.provideService(
          ContainerSandbox.make({ ...options, env: { A: "a", B: "b" } }).acquire("match"),
          Scope.Scope,
          leaked
        )
        const second = yield* Effect.scoped(
          ContainerSandbox.make({ ...options, env: { B: "b", A: "a" } }).acquire("match")
        )
        expect(second.remoteId).toBe(first.remoteId)
        yield* Scope.close(leaked, Exit.void)
      }
    }))

  it.effect("refuses a crash-left container with broader isolation", () =>
    Effect.gen(function*() {
      const fake = engine()
      const leaked = yield* Scope.make()
      const old = ContainerSandbox.make({
        spawner: fake.spawner,
        image: "old-image",
        workdir,
        network: "host",
        createArgs: ["--privileged", "--volume", "/:/host"]
      })
      yield* Effect.provideService(old.acquire("isolation"), Scope.Scope, leaked)
      fake.calls.length = 0
      const next = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      const result = yield* Effect.exit(Effect.scoped(next.acquire("isolation")))
      expect(Exit.isFailure(result)).toBe(true)
      expect(fake.calls.some(({ args }) => ["start", "exec", "rm"].includes(args[0]!))).toBe(false)
      yield* Scope.close(leaked, Exit.void)
    }))

  it.effect("refuses creation env values that the CLI env-file cannot represent before spawning", () =>
    Effect.gen(function*() {
      for (const value of ["first\nsecond", "first\rsecond", "first\u0000second"]) {
        const fake = engine()
        const error = yield* Effect.flip(
          acquired(
            ContainerSandbox.make({ spawner: fake.spawner, image: "img", env: { TOKEN: value } }),
            Effect.succeed
          )
        )
        expect(error).toBeInstanceOf(ProviderError)
        expect(error.code).toBe("spawn_error")
        expect(fake.calls).toEqual([])
      }
    }))

  it.effect("keeps creation and spawn environment values and stdin out of local argv", () =>
    Effect.gen(function*() {
      const fake = engine()
      const secret = "ARGV_ENV_CANARY_'_é\nsecond line $(printf injected)\n"
      const boot = "ARGV_BOOT_CANARY = ' spaces "
      const bytes = encoder.encode("ARGV_STDIN_CANARY\n\u0000tail")
      yield* acquired(
        ContainerSandbox.make({
          spawner: fake.spawner,
          image: "img",
          workdir,
          env: { BOOT: boot, smthrs_env: "inherited" }
        }),
        (session) =>
          Effect.gen(function*() {
            expect((yield* output(session, `printf '%s' "$BOOT"`)).stdout).toBe(boot)
            expect((yield* output(session, `printf '%s' "$TOKEN"`, { env: { TOKEN: secret } })).stdout).toBe(secret)
            expect((yield* output(session, `printf '%s' "$smthrs_env"`, { env: { TOKEN: secret } })).stdout).toBe(
              "inherited"
            )
            yield* output(session, "cat > canary.bin", { env: { TOKEN: secret }, stdin: bytes })
            expect(Array.from(yield* session.readFile(`${workdir}/canary.bin`))).toEqual(Array.from(bytes))
          })
      )
      const argv = fake.calls.flatMap((call) => call.args).join("\n")
      for (
        const value of [
          boot,
          "ARGV_ENV_CANARY",
          "ARGV_STDIN_CANARY",
          Buffer.from(secret).toString("base64"),
          Buffer.from(bytes).toString("base64")
        ]
      ) {
        expect(argv).not.toContain(value)
      }
      for (const call of fake.calls) {
        if (call.input.length > 0) expect(argv).not.toContain(call.input.trimEnd())
      }
    }), 30_000)

  it.effect("disables container networking when the provider omits a network mode", () =>
    Effect.gen(function*() {
      const fake = engine()
      yield* acquired(ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir }), Effect.succeed)
      expect(fake.calls[0]!.args.slice(0, 7)).toEqual([
        "create",
        "--name",
        expect.stringMatching(/^smthrs-sbx-run-1-/),
        "--workdir",
        workdir,
        "--network",
        "none"
      ])
    }))

  it("unsupported host allowlist fails at provider construction", () => {
    const fake = engine()
    expect(() =>
      ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir, network: { allow: ["example.com"] } })
    ).toThrow(/container-sandbox: cannot enforce a network allowlist/)
    expect(fake.calls).toEqual([])
  })

  it.effect("maps the neutral `none` network to the engine's none mode", () =>
    Effect.gen(function*() {
      const fake = engine()
      yield* acquired(
        ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir, network: "none" }),
        Effect.succeed
      )
      expect(fake.calls[0]!.args.slice(5, 7)).toEqual(["--network", "none"])
    }))

  it.effect("hands exec the cwd `Sandbox.fileSystem` would name for a relative path", () =>
    Effect.gen(function*() {
      const fake = engine()
      yield* acquired(ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir }), (session) =>
        Effect.gen(function*() {
          yield* output(session, "mkdir -p sub")
          yield* output(session, "true", { cwd: ".//sub" })
        }))
      const exec = fake.calls.filter((call) =>
        call.args[0] === "exec" && call.args.includes("--workdir")
      )
      expect(exec.map(({ args }) => args[args.indexOf("--workdir") + 1])).toEqual([workdir, `${workdir}/sub`])
    }))

  it.effect("forwards neutral limits to create and fingerprints them", () =>
    Effect.gen(function*() {
      const labelOf = (args: ReadonlyArray<string>) => args[args.indexOf("--label") + 1]
      const unlimited = engine()
      yield* acquired(ContainerSandbox.make({ spawner: unlimited.spawner, image: "img", workdir }), Effect.succeed)
      const limited = engine()
      yield* acquired(
        ContainerSandbox.make({
          spawner: limited.spawner,
          image: "img",
          workdir,
          limits: { cpus: 1.5, memoryMib: 512, timeoutSecs: 90 }
        }),
        Effect.succeed
      )
      const create = limited.calls[0]!.args
      expect(create.slice(7, 11)).toEqual(["--cpus", "1.5", "--memory", "512m"])
      expect(create.slice(-3)).toEqual(["img", "sleep", "90"])
      expect(unlimited.calls[0]!.args).not.toContain("--cpus")
      expect(labelOf(create)).not.toBe(labelOf(unlimited.calls[0]!.args))
    }))

  it("refuses createArgs that would override a neutral ceiling when make is called", () => {
    const { calls, spawner } = engine()
    const make =
      (limits: ContainerSandbox.ContainerSandboxOptions["limits"], createArgs: ReadonlyArray<string>) => () =>
        ContainerSandbox.make({ spawner, image: "img", workdir, limits, createArgs })
    const both = { cpus: 0.5, memoryMib: 64 }
    expect(make(both, ["--cpus", "2", "--memory", "128m"])).toThrow(
      "container-sandbox: createArgs --cpus would override limits.cpus; name one"
    )
    for (const [flag, args] of [["--cpus", ["--cpus=2"]], ["--cpu-quota", ["--cpu-quota", "200000"]]] as const) {
      expect(make({ cpus: 0.5 }, args)).toThrow(`createArgs ${flag} would override limits.cpus`)
    }
    for (const args of [["--memory=128m"], ["-m", "128m"], ["-m128m"], ["-itm", "128m"]]) {
      expect(make({ memoryMib: 64 }, args)).toThrow("createArgs -")
      expect(make({ memoryMib: 64 }, args)).toThrow("would override limits.memoryMib")
    }
    expect(make({ timeoutSecs: 60 }, ["--entrypoint", "/bin/sh"])).toThrow(
      "createArgs --entrypoint would override limits.timeoutSecs"
    )
    // A flag for a ceiling that is not set, or an unrelated flag, stays allowed.
    expect(make({ cpus: 0.5 }, ["--memory", "1g", "--cpu-shares", "512", "-e", "M=1"])).not.toThrow()
    expect(make(undefined, ["--cpus", "2", "--entrypoint", "/bin/sh"])).not.toThrow()
    expect(calls).toEqual([])
  })

  it("refuses a limit that is not a positive number when make is called", () => {
    const { spawner } = engine()
    for (const limits of [{ cpus: 0 }, { cpus: Number.NaN }, { memoryMib: 1.5 }, { timeoutSecs: -1 }]) {
      expect(() => ContainerSandbox.make({ spawner, image: "img", workdir, limits })).toThrow(/limits\./)
    }
  })

  it.effect("drives the full container lifecycle through the engine CLI", () =>
    Effect.gen(function*() {
      const spaced = join(root, "work dir")
      const { calls, spawner } = engine()
      const provider = ContainerSandbox.make({
        spawner,
        image: "img:tag",
        program: "podman",
        workdir: spaced,
        env: { SEED: "1" },
        network: "none",
        createArgs: ["--memory", "1g"],
        namePrefix: "t-"
      })
      const session = yield* acquired(provider, (session) => Effect.succeed(session))
      expect(session.id).toBe("run-1")
      expect(session.remoteId.startsWith("t-run-1-")).toBe(true)
      expect(session.workdir).toBe(spaced)
      expect(calls.map((call) => call.file)).toEqual(["podman", "podman", "podman", "podman"])
      expect(calls[0]!.args).toEqual([
        "create",
        "--name",
        session.remoteId,
        "--workdir",
        spaced,
        "--network",
        "none",
        "--env-file",
        "/dev/stdin",
        "--memory",
        "1g",
        "--label",
        expect.stringMatching(/^smithers\.dev\/sandbox-fingerprint=v1-[A-Za-z0-9_-]{43}$/),
        "img:tag",
        "sleep",
        "infinity"
      ])
      expect(calls[1]!.args).toEqual(["start", session.remoteId])
      expect(calls[2]!.args).toEqual([
        "exec",
        session.remoteId,
        "/bin/sh",
        "-c",
        `mkdir -p '${spaced}' && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx`
      ])
      expect(calls[3]!.args).toEqual(["rm", "--force", session.remoteId])
    }))

  it.effect("uses /bin/sh for every provider-owned helper", () =>
    Effect.gen(function*() {
      const fake = engine()
      const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile(`${workdir}/helper.bin`, new Uint8Array([1]))
          yield* session.readFile(`${workdir}/helper.bin`)
          yield* output(session, "true")
          yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(sleeps, {})
              yield* session.kill!(process, "SIGTERM")
              yield* process.exitCode
            })
          )
        }))
      // A container-wide PATH can omit `sh`, so every provider-owned shell
      // argv must use the absolute path before that environment can apply.
      const helpers = fake.calls.filter((call) => call.args.includes("-c"))
      expect(helpers.length).toBeGreaterThan(0)
      for (const helper of helpers) {
        const shell = helper.args[helper.args.indexOf("-c") - 1]
        expect(shell).toBe("/bin/sh")
        expect(helper.args).not.toContain("sh")
      }
    }), 30_000)

  it.effect("reattaches the container a crashed run left behind, workspace intact", () =>
    Effect.gen(function*() {
      const fake = engine()
      const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
      // A crash is a scope whose finalizers never ran.
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(provider.acquire("resume"), Scope.Scope, leaked)
      yield* first.writeFile(`${workdir}/survivor.txt`, encoder.encode("still here"))
      const resumed = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const bytes = yield* session.readFile(`${workdir}/survivor.txt`)
          return { remoteId: session.remoteId, text: new TextDecoder().decode(bytes) }
        }), "resume")
      expect(resumed.remoteId).toBe(first.remoteId)
      expect(resumed.text).toBe("still here")
      expect(fake.calls.filter((call) => call.args[0] === "create")).toHaveLength(2)
      // The reacquire's release already removed the container; closing the
      // leaked scope must tolerate that.
      expect(Exit.isSuccess(yield* Effect.exit(Scope.close(leaked, Exit.void)))).toBe(true)

      // No workdir given: the default applies, and the refused create keeps
      // the fake from ever preparing /workspace on this host.
      const refusing = engine((args) => args[0] === "create" ? { exitCode: 125, stderr: "no such image" } : undefined)
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: refusing.spawner, image: "img" }), Effect.succeed)
      )
      expect(refusal).toBeInstanceOf(ProviderError)
      expect((refusal as ProviderError).message).toContain("no such image")
      expect(refusing.calls[0]!.args).toContain("/workspace")

      // A conflict the engine words in some other language is still a
      // conflict. The reattach asks the engine whether the container is there
      // rather than reading its prose, so podman, a localized daemon, or a
      // reworded docker message reattaches like any other.
      let creates = 0
      const podman = engine((args) => {
        if (args[0] !== "create") return undefined
        creates += 1
        // The first create succeeds through the fake's own handler; the
        // second is refused in podman's wording, which shares no substring
        // with docker's.
        return creates === 1
          ? undefined
          : { exitCode: 125, stderr: `Error: creating container storage: the name is taken by an existing container` }
      })
      const podmanProvider = ContainerSandbox.make({ spawner: podman.spawner, image: "img", workdir })
      const leakedTwice = yield* Scope.make()
      const held = yield* Effect.provideService(podmanProvider.acquire("localized"), Scope.Scope, leakedTwice)
      const reattached = yield* acquired(podmanProvider, (session) => Effect.succeed(session.remoteId), "localized")
      expect(reattached).toBe(held.remoteId)
      expect(podman.calls.map((call) => call.args.slice(0, 2))).toContainEqual(["container", "inspect"])
      expect(Exit.isSuccess(yield* Effect.exit(Scope.close(leakedTwice, Exit.void)))).toBe(true)
    }), 30_000)

  it.effect("fails acquisition when the container cannot start or be prepared", () =>
    Effect.gen(function*() {
      const unstartable = engine((args) => args[0] === "start" ? { exitCode: 1, stderr: "dead engine" } : undefined)
      const startFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: unstartable.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((startFailure as ProviderError).message).toContain("could not be started")

      const unpreparable = engine((args) =>
        args[0] === "exec" && args.at(-1)?.startsWith("mkdir -p") === true
          ? { exitCode: 1, stderr: "ro fs" }
          : undefined
      )
      const prepareFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: unpreparable.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).message).toContain("could not be prepared")

      // A container that was created and then failed to start or prepare must
      // still be removed. Folding those steps into the acquire left them
      // outside the finalizer's protection and leaked a machine per failure.
      for (const failed of [unstartable, unpreparable]) {
        const created = failed.calls.find((call) => call.args[0] === "create")
        const removed = failed.calls.find((call) => call.args[0] === "rm")
        expect(created).toBeDefined()
        expect(removed?.args).toEqual(["rm", "--force", created!.args[2]!])
        expect(failed.containers.size).toBe(0)
      }
    }))

  it.effect("spawns with stdin, a rooted cwd, and an environment deletion", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine()
      const provider = ContainerSandbox.make({ spawner, image: "img", workdir, env: { DROP: "base" } })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const greeting = yield* output(session, `printf 'hello from %s' "$WHO"`, {
            env: { KEEP: "1", DROP: undefined, WHO: "guest" }
          })
          expect(greeting).toEqual({ stdout: "hello from guest", code: 0 })
          // A bare spawn runs in the workdir; a relative cwd is rooted there.
          expect((yield* output(session, "pwd")).stdout).toBe(`${workdir}\n`)
          yield* output(session, "mkdir -p sub/nested")
          expect((yield* output(session, "pwd", { cwd: "./sub/nested/" })).stdout).toBe(`${workdir}/sub/nested\n`)
          expect((yield* output(session, "pwd", { cwd: root })).stdout).toBe(`${root}\n`)
          // Standard input arrives on the exec's own input channel, verified
          // through the file the command writes.
          const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
          const copied = yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })
          expect(copied).toEqual({ stdout: "", code: 0 })
          expect(Array.from(yield* session.readFile(`${workdir}/stdin-copy.bin`))).toEqual(Array.from(bytes))
        }))
      const spawns = calls.filter((call) => call.args[1] === "--workdir" || call.args[1] === "--interactive")
      expect(spawns[0]!.args).toEqual([
        "exec",
        "--interactive",
        "--workdir",
        workdir,
        spawns[0]!.args[4]!,
        "/bin/sh",
        "-c",
        "echo $$ > /tmp/.smthrs-sbx/0.pid; if [ -e /tmp/.smthrs-sbx/0.pid.cancel ]; then exit 143; fi; "
        + `eval "$(IFS= read -r smthrs_env && smthrs_env=$(printf %s "$smthrs_env" | base64 -d) && printf 'set -- %s' "$smthrs_env" || printf 'exit 125')" || exit 125; `
        + `exec env "$@" /bin/sh -c 'printf '\\''hello from %s'\\'' "$WHO"'`
      ])
      expect(spawns[0]!.args).not.toContain("--env")
      expect(Buffer.from(spawns[0]!.input.trim(), "base64").toString()).toBe("-u DROP KEEP=1 WHO=guest")
      expect(spawns[1]!.args.slice(0, 3)).toEqual(["exec", "--workdir", workdir])
      // The rooting rule keeps a trailing slash, as `Sandbox.fileSystem` does;
      // the `pwd` above shows it names the same directory.
      expect(spawns[3]!.args.slice(1, 3)).toEqual(["--workdir", `${workdir}/sub/nested/`])
      const fed = spawns.find((call) => call.args.at(-1)?.includes("cat > stdin-copy.bin"))!
      expect(fed.args.slice(0, 4)).toEqual(["exec", "--interactive", "--workdir", workdir])
      // Both environment operands and command stdin use the input channel.
      expect(spawns.filter((call) => call.args.includes("--interactive"))).toHaveLength(2)
    }), 30_000)

  it.effect(
    "runs a command whose env overrides PATH, because no shell in the chain is bare",
    () =>
      Effect.gen(function*() {
        const fake = engine()
        const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            // The engine would refuse to resolve a bare `sh` under this PATH —
            // the fake proves that rule still holds for a non-absolute argv.
            const unresolved = yield* Effect.scoped(
              Effect.flatMap(
                fake.spawner.spawn(
                  ChildProcess.make("docker", ["exec", "--env", "PATH=/nowhere", session.remoteId, "sh", "-c", "true"])
                ),
                (handle) => handle.exitCode
              )
            )
            expect(unresolved).toBe(126)
            // A local spawner running `sh -c 'true'` under `PATH=/nowhere`
            // exits 0: the host names the shell itself and `true` is a
            // builtin. The provider must answer the same, which it can only do
            // if the caller's PATH reaches the command and neither shell.
            const overridden = yield* output(session, "true", { env: { PATH: "/nowhere" } })
            expect(overridden.code).toBe(0)
            // An empty value and a Unicode value survive; an undefined value
            // is a deletion.
            const delivered = yield* output(
              session,
              `printf '%s:[%s]' "$KEPT" "$EMPTY"`,
              { env: { "KEPT": "\u00e9\u00e0 two words", "EMPTY": "", "DROPPED": undefined } }
            )
            expect(delivered).toEqual({ stdout: "\u00e9\u00e0 two words:[]", code: 0 })
            // A name the guest shell would drop is refused before anything is
            // sent. The `env(1)` prefix does not save it: the inner `/bin/sh`
            // rebuilds its environment as it starts, and dash, `/bin/sh` on
            // Debian and Ubuntu, discards `WITH-DASH` there. Delivering it
            // would pass on macOS and lose the variable in production.
            const refused = yield* Effect.flip(
              Effect.scoped(session.spawn(`printenv WITH-DASH`, { env: { "WITH-DASH": "delivered" } }))
            )
            expect((refused as ProviderError).code).toBe("spawn_error")
            expect((refused as ProviderError).message).toContain("WITH-DASH")
            expect((yield* output(session, `printf '%s' "\${DROPPED-unset}"`, { env: { DROPPED: undefined } })).stdout)
              .toBe("unset")
          }))
        // Every wrapper in the chain names its shell absolutely, whether or
        // not the caller supplied an environment for the command.
        const wrapped = fake.calls.filter((call) => call.args.at(-1)?.includes("exec ") === true)
        expect(wrapped.length).toBeGreaterThan(0)
        expect(wrapped.every((call) => /exec (?:env .+ )?\/bin\/sh -c/.test(call.args.at(-1) ?? ""))).toBe(true)
        expect(wrapped.some((call) => /exec (?:env .+ )?sh -c/.test(call.args.at(-1) ?? ""))).toBe(false)
      }),
    30_000
  )

  it.effect(
    "signals the guest when a spawn scope closes on a live command, and not on an ended one",
    () =>
      Effect.gen(function*() {
        const fake = engine()
        const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "img", workdir })
        yield* acquired(provider, (session) =>
          Effect.gen(function*() {
            const kills = () => fake.calls.filter((call) => call.args.at(-1)?.includes("kids()") === true).length
            yield* Effect.scoped(Effect.asVoid(session.spawn(sleeps, {})))
            expect(kills()).toBe(1)
            expect((yield* output(session, survivor)).code).not.toBe(0)
            yield* output(session, "true")
            expect(kills()).toBe(1)
          }))
      }),
    30_000
  )

  it.effect("kills a spawned command by pid walk inside the container", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine()
      const provider = ContainerSandbox.make({ spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const signalled = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(sleeps, {})
              yield* session.kill!(process, "SIGTERM")
              return yield* process.exitCode
            })
          )
          expect(signalled).toBe(143)
          expect((yield* output(session, survivor)).code).not.toBe(0)
        }))
      const killCall = calls.find((call) => call.args.at(-1)?.includes("kids()") === true)
      expect(killCall).toBeDefined()
      expect(killCall!.args.at(-1)).toContain("cat /tmp/.smthrs-sbx/0.pid")
      // The script waits for a pid a just-started command has not written yet,
      // instead of reporting a delivered signal it never sent.
      expect(killCall!.args.at(-1)).toContain("while [ ! -s /tmp/.smthrs-sbx/0.pid ]")
      // One batch delivery to the collected set: killing children one at a
      // time before the parent lets a respawning parent replace them.
      expect(killCall!.args.at(-1)).toContain(`kill -s TERM "$@"`)

      const refusing = engine((args) =>
        args.at(-1)?.includes("kids()") === true ? { exitCode: 1, stderr: "no exec" } : undefined
      )
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: refusing.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(
            Effect.flatMap(session.spawn("sleep 30", {}), (process) => session.kill!(process, "SIGTERM"))
          ))
      )
      expect((refusal as ProviderError).code).toBe("unknown")
      expect((refusal as ProviderError).message).toContain("SIGTERM")
    }), 30_000)

  it.effect("reads files back as bytes, distinguishing absence from refusal", () =>
    Effect.gen(function*() {
      const { spawner } = engine()
      const provider = ContainerSandbox.make({ spawner, image: "img", workdir })
      const outcome = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const binary = new Uint8Array([0, 200, 10, 0, 7])
          yield* session.writeFile(`${workdir}/present.bin`, binary)
          const present = yield* session.readFile(`${workdir}/present.bin`)
          const absent = yield* Effect.flip(session.readFile(`${workdir}/absent.bin`))
          writeFileSync(`${workdir}/sealed.bin`, "sealed")
          chmodSync(`${workdir}/sealed.bin`, 0)
          const refused = yield* Effect.flip(session.readFile(`${workdir}/sealed.bin`))
          return { present: Array.from(present), absent, refused }
        }))
      expect(outcome.present).toEqual([0, 200, 10, 0, 7])
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect((outcome.refused as ProviderError).code).toBe("unknown")
      expect((outcome.refused as ProviderError).message).toContain("Permission denied")
    }), 30_000)

  it.effect("writes files through the exec's stdin, creating parents", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine()
      const provider = ContainerSandbox.make({ spawner, image: "img", workdir })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile(`${workdir}/deep/tree/out.bin`, new Uint8Array([1, 2]))
          expect(Array.from(yield* session.readFile(`${workdir}/deep/tree/out.bin`))).toEqual([1, 2])
          yield* session.writeFile(`${workdir}/empty.bin`, new Uint8Array())
          expect(Array.from(yield* session.readFile(`${workdir}/empty.bin`))).toEqual([])
          writeFileSync(`${workdir}/blocker`, "a file, not a directory")
          // The guest refuses before reading stdin, including input larger
          // than a pipe buffer that can still be pending when it exits.
          const refused = yield* Effect.flip(
            session.writeFile(`${workdir}/blocker/child`, new Uint8Array(256 * 1024).fill(3))
          )
          expect((refused as ProviderError).code).toBe("unknown")
        }))
      // The test root's path is made of shell-safe characters, so the quoter
      // leaves it bare; the lifecycle test's spaced workdir proves quoting.
      const writes = calls.filter((call) => call.args.includes("--interactive"))
      expect(writes[0]!.args.slice(0, 2)).toEqual(["exec", "--interactive"])
      expect(writes[0]!.args.at(-1)).toBe(`mkdir -p ${workdir}/deep/tree && cat > ${workdir}/deep/tree/out.bin`)
      const rootWrite = engine()
      yield* acquired(
        ContainerSandbox.make({ spawner: rootWrite.spawner, image: "img", workdir }),
        (session) => session.writeFile("rootless.bin", new Uint8Array([9]))
      )
      // A path with no parent to create takes the bare write.
      expect(rootWrite.calls.some((call) => call.args.at(-1) === "cat > rootless.bin")).toBe(true)
    }), 30_000)

  it.effect("answers pings from the engine and reports a dead container", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine()
      const alive = ContainerSandbox.make({ spawner, image: "img", workdir })
      yield* acquired(alive, (session) => session.ping!)
      expect(calls.some((call) => call.args.length === 3 && call.args[0] === "exec" && call.args[2] === "true"))
        .toBe(true)

      const dead = engine((args) =>
        args.at(-1) === "true" && args[0] === "exec" ? { exitCode: 1, stderr: "not running" } : undefined
      )
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: dead.spawner, image: "img", workdir }), (session) => session.ping!)
      )
      expect((refusal as ProviderError).code).toBe("unavailable")
    }))

  it.effect("restates transport failures in the provider vocabulary", () =>
    Effect.gen(function*() {
      const broken = engine((args) => args[0] === "create" ? { failSpawn: true } : undefined)
      const spawnFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: broken.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((spawnFailure as ProviderError).code).toBe("spawn_error")

      const lossy = engine((args) => args[0] === "create" ? { failObserve: true } : undefined)
      const observeFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: lossy.spawner, image: "img", workdir }), Effect.succeed)
      )
      expect((observeFailure as ProviderError).code).toBe("unknown")

      const failingWrite = engine((args) => args.includes("--interactive") ? { failSpawn: true } : undefined)
      const writeFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: failingWrite.spawner, image: "img", workdir }), (session) =>
          session.writeFile(`${workdir}/out`, new Uint8Array([1])))
      )
      expect((writeFailure as ProviderError).code).toBe("spawn_error")

      const failingExec = engine((args) =>
        args.at(-1)?.includes("exec /bin/sh -c") === true ? { failSpawn: true } : undefined
      )
      const execFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: failingExec.spawner, image: "img", workdir }), (session) =>
          Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
      )
      expect((execFailure as ProviderError).code).toBe("spawn_error")
    }))

  it.effect("passes SandboxConformance against the faithful engine fake", () =>
    Effect.gen(function*() {
      const fake = engine()
      const provider = ContainerSandbox.make({ spawner: fake.spawner, image: "alpine:3.20", workdir })
      const violations = yield* SandboxConformance.check(provider, {
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }), 120_000)
})
