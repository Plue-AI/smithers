import { NodePath } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Fiber, Layer, Option, Path, Schema, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it, vi } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"
import * as Exec from "../src/internal/Exec.ts"
import { MAX_SHELL_OUTPUT_BYTES } from "../src/internal/Text.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** One spawned invocation, exactly as the host received it. */
interface Spawned {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string | undefined
  readonly shell: boolean
  readonly cwd: string | undefined
}

/**
 * Records what was spawned instead of running it. The scripted host in
 * `TestLayers` cannot supply standard input — `just-bash` has no pipe — so a
 * script-carrying call is observed here at the spawner boundary, which is
 * exactly where the payload stops being text and becomes data.
 */
/** Whether one spawn is the container's tree fingerprint rather than the command it brackets. */
const isFingerprint = (spawn: Spawned | ReadonlyArray<string>): boolean =>
  (Array.isArray(spawn) ? spawn : (spawn as Spawned).args).includes(TreeFingerprint.script())

/** The spawns that ran the caller's command, with the fingerprints either side of it left out. */
const commands = (spawns: ReadonlyArray<Spawned>): ReadonlyArray<Spawned> =>
  spawns.filter((spawn) => !isFingerprint(spawn))

const recorder = (spawns: Array<Spawned>) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.gen(function*() {
          const standard = command as ChildProcess.StandardCommand
          const stdin = standard.options.stdin
          const text = stdin !== undefined && typeof stdin !== "string" && Stream.isStream(stdin)
            ? yield* Stream.mkString(Stream.decodeText(stdin))
            : undefined
          spawns.push({
            file: standard.command,
            args: [...standard.args],
            stdin: text,
            shell: standard.options.shell === true,
            cwd: standard.options.cwd
          })
          return makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        })
    })),
    Path.layer
  )

describe("Bash", () => {
  it.each([undefined, "other-task"])("refuses a sealed command targeting %s before spawning", async (container) => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.sealed("task-1")({ mode: "unhermetic", container, command: "true" })),
      recorder(spawns)
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      expect(failure?.code).toBe("outside_container")
      expect(failure?.message).toContain("only inside container \"task-1\"")
      expect(failure?.message).toContain(container === undefined ? "container: \"task-1\"" : "not \"other-task\"")
    }
    expect(spawns).toEqual([])
  })

  it("runs a sealed command through the named container transport", async () => {
    const spawns: Array<Spawned> = []
    const output = await execute(Effect.provide(
      Bash.sealed("task-1")({ mode: "unhermetic", container: "task-1", command: "printf done", cwd: "/testbed" }),
      Layer.merge(recorder(spawns), Layer.succeed(Container.Container)(Container.makeCommand()))
    ))
    expect(output.exitCode).toBe(0)
    expect(commands(spawns)).toEqual([{
      file: "docker",
      args: ["exec", "-w", "/testbed", "--", "task-1", "bash", "-lc", "printf done"],
      stdin: undefined,
      shell: false,
      cwd: undefined
    }])
    expect(spawns.every((spawn) => spawn.file === "docker" && spawn.args.includes("task-1"))).toBe(true)
  })

  it("returns non-zero exit codes as successful results", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "failing-command"
      }),
      layer({
        commands: {
          "failing-command": { stdout: "partial output", stderr: "failed", exitCode: 23 }
        }
      })
    ))

    expect(result).toMatchObject({
      exitCode: 23,
      stdout: "partial output",
      stderr: "failed",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutDroppedBytes: 0,
      stderrDroppedBytes: 0
    })
  })

  it("caps stdout and stderr independently and retains each multibyte tail", async () => {
    const stdout = `${"🙂".repeat(7_501)}TAIL`
    const stderr = `${"é".repeat(15_002)}END`
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        command: "large-output"
      }),
      layer({
        commands: {
          "large-output": { stdout, stderr, exitCode: 0 }
        }
      })
    ))

    const encoder = new TextEncoder()
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout.endsWith("TAIL")).toBe(true)
    expect(result.stderr.endsWith("END")).toBe(true)
    expect(encoder.encode(result.stdout)).toHaveLength(MAX_SHELL_OUTPUT_BYTES)
    expect(encoder.encode(result.stderr).byteLength).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_BYTES)
    expect(result.stdoutDroppedBytes).toBe(8)
    expect(result.stderrDroppedBytes).toBe(8)
    expect(result.stdoutDroppedBytes).toBe(encoder.encode(stdout).byteLength - encoder.encode(result.stdout).byteLength)
    expect(result.stderrDroppedBytes).toBe(encoder.encode(stderr).byteLength - encoder.encode(result.stderr).byteLength)
  })

  it("passes the shell output budget into capture before reading oversized streams", async () => {
    const exec = vi.spyOn(Exec, "exec")
    try {
      const stdout = `${"prefix".repeat(20_000)}TAIL`
      const result = await execute(Effect.provide(
        Bash.run({ mode: "unhermetic", command: "oversized-capture" }),
        layer({ commands: { "oversized-capture": { stdout, exitCode: 0 } } })
      ))

      expect(exec).toHaveBeenCalledWith(
        "oversized-capture",
        expect.objectContaining({ maxCaptureBytes: MAX_SHELL_OUTPUT_BYTES })
      )
      expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(MAX_SHELL_OUTPUT_BYTES)
      expect(result.stdout.endsWith("TAIL")).toBe(true)
      expect(result.stdoutDroppedBytes).toBe(
        new TextEncoder().encode(stdout).byteLength - new TextEncoder().encode(result.stdout).byteLength
      )
    } finally {
      exec.mockRestore()
    }
  })

  it("maps shell timeouts to the typed timeout error", async () => {
    // A process that never exits, so the handler's own deadline is the only
    // thing that can end the run.
    const stalled = ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    const exit = await execute(
      Effect.exit(Bash.run({
        mode: "unhermetic",
        command: "timeout-command",
        timeoutMs: 1
      })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(stalled),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("timeout")
    }
  })

  it("ends a stalled command at the ten-minute default timeout", async () => {
    const expectedDefault = 600_000
    const stalled = ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    const outcome = await execute(
      Effect.gen(function*() {
        const fiber = yield* Effect.race(
          Effect.exit(Bash.run({ mode: "unhermetic", command: "stalled-default" })),
          Effect.sleep(expectedDefault + 1).pipe(Effect.as("still-running" as const))
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(expectedDefault + 1)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(stalled),
          Path.layer
        )),
        Effect.provide(TestClock.layer())
      )
    )

    expect(Bash.DEFAULT_TIMEOUT_MS).toBe(expectedDefault)
    expect(outcome).not.toBe("still-running")
    if (outcome !== "still-running") {
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) {
        const failure = Cause.findErrorOption(outcome.cause)
        expect(Option.isSome(failure) && failure.value.code).toBe("timeout")
      }
    }
  })

  it("runs hermetic commands whose path references are declared", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat ./input.txt > ./output.txt",
        cwd: "/work",
        reads: ["/work", "/work/input.txt"],
        writes: ["/work/output.txt"]
      }),
      layer({
        // The spawner resolves `cwd` against the filesystem, so the working
        // directory has to exist for the command to start.
        files: { "/work/input.txt": "seed" },
        commands: {
          "cat ./input.txt > ./output.txt": { stdout: "done", exitCode: 0 }
        }
      })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("checks command references when cwd is the explicit default", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/default.txt",
        cwd: ".",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/default.txt"
        })
      }
    }
  })

  it.each(
    [
      ["POSIX", NodePath.layerPosix, "/outside/absolute.txt"],
      ["Windows", NodePath.layerWin32, "\\outside\\absolute.txt"]
    ] as const
  )("checks command references when cwd is the absolute resolved base (%s)", async (_, paths, outside) => {
    const cwd = Effect.runSync(Effect.map(Path.Path, (path) => path.resolve(".")).pipe(Effect.provide(paths)))
    const exit = await execute(Effect.provide(
      Effect.exit(
        Bash.run({
          mode: "hermetic",
          command: "cat /outside/absolute.txt",
          cwd,
          reads: [],
          writes: []
        }).pipe(Effect.provide(paths))
      ),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: outside
        })
      }
    }
  })

  it("refuses an undeclared cwd outside the resolved base", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "true",
        cwd: "/elsewhere",
        reads: [],
        writes: []
      })),
      layer()
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/elsewhere"
        })
      }
    }
  })

  it("keeps omitted cwd unchanged", async () => {
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "true",
        reads: [],
        writes: []
      }),
      layer({ commands: { true: { stdout: "done", exitCode: 0 } } })
    ))

    expect(result).toMatchObject({ exitCode: 0, stdout: "done" })
  })

  it("fails before spawn when a hermetic command reads an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /outside/secret.txt",
        reads: ["/work/**"],
        writes: []
      })),
      layer({
        commands: {
          "cat /outside/secret.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_reads",
          path: "/outside/secret.txt"
        })
      }
    }
  })

  it("fails before spawn when a hermetic command writes an undeclared path", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "touch /outside/result.txt",
        reads: [],
        writes: []
      })),
      layer({
        commands: {
          "touch /outside/result.txt": { stdout: "must not run", exitCode: 0 }
        }
      })
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({
          code: "outside_declared_writes",
          path: "/outside/result.txt"
        })
      }
    }
  })

  it.each([
    { name: "rm", script: "echo hi\nrm -rf /work/target\n", path: "/work/target" },
    { name: "mv", script: "echo hi\nmv /work/a /work/b\n", path: "/work/b" },
    { name: "tee", script: "echo hi\ntee /work/out\n", path: "/work/out" }
  ])("refuses an undeclared $name write on the second script line", async ({ script, path }) => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        script,
        reads: ["/work/**"],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_writes",
        path
      })
    }
    expect(spawns).toEqual([])
  })

  it("selects the command behind an env prefix before classifying writes", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "env FOO=bar rm /work/target",
        reads: ["/work/**"],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_writes",
        path: "/work/target"
      })
    }
    expect(spawns).toEqual([])
  })

  // `FOO="a b" rm /work/target` used to tokenize as `FOO="a`, `b"`, `rm`,
  // `/work/target`. Only the first token carried an `=`, so the command was
  // read as `b"`, the delete was classified as a read, and the call spawned
  // with `writes: []`.
  it.each([
    { name: "a double-quoted assignment value", command: `FOO="a b" rm /work/target` },
    { name: "a single-quoted assignment value", command: `FOO='a b' rm /work/target` },
    { name: "two quoted assignments", command: `FOO="a b" BAR='c d' rm /work/target` }
  ])("selects the command behind $name whose value holds whitespace", async ({ command }) => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({ mode: "hermetic", command, reads: ["/work/**"], writes: [] })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_writes",
        path: "/work/target"
      })
    }
    expect(spawns).toEqual([])
  })

  it("keeps a quoted path holding whitespace as one declared reference", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: `cat "/work/a b.txt"`,
        reads: ["/work/**"],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(false)
    expect(spawns).toHaveLength(1)
  })

  it("spawns a multi-line hermetic script when every line is declared", async () => {
    const spawns: Array<Spawned> = []
    const script = "cat /work/input\nrm /work/target\nmv /work/a /work/b\ntee /work/out\n"
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        script,
        reads: ["/work/input", "/work/a"],
        writes: ["/work/target", "/work/b", "/work/out"]
      }),
      recorder(spawns)
    ))

    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.stdin).toBe(script)
  })

  it("ignores path-like text on a shell comment line", async () => {
    const spawns: Array<Spawned> = []
    const script = "#comment /outside/ignored\necho ready\n"
    const result = await execute(Effect.provide(
      Bash.run({ mode: "hermetic", script, reads: [], writes: [] }),
      recorder(spawns)
    ))

    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
  })

  it.each([
    { label: "bare directory", reads: ["/work"] },
    { label: "recursive glob", reads: ["/work/**"] }
  ])("refuses an absolute dot-dot escape from a $label declaration", async ({ reads }) => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /work/../outside/x",
        reads,
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/outside/x"
      })
    }
    expect(spawns).toEqual([])
  })

  it("normalizes a dev path before deciding whether it is exempt", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /dev/../etc/passwd",
        reads: [],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/etc/passwd"
      })
    }
    expect(spawns).toEqual([])
  })

  it("keeps a canonical dev path exempt from the filesystem envelope", async () => {
    const spawns: Array<Spawned> = []
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat /dev/null",
        reads: [],
        writes: []
      }),
      recorder(spawns)
    ))

    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
  })

  it("refuses a relative dot-dot escape from the working directory", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat ../outside/x",
        cwd: "/work/project",
        reads: ["/work/project"],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/work/outside/x"
      })
    }
    expect(spawns).toEqual([])
  })

  it("resolves a relative declaration and path against the same working directory", async () => {
    const spawns: Array<Spawned> = []
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat ../shared/input",
        cwd: "/work/project",
        reads: [".", "../shared"],
        writes: []
      }),
      recorder(spawns)
    ))

    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
  })

  it("normalizes repeated separators in declarations and command paths", async () => {
    const spawns: Array<Spawned> = []
    const result = await execute(Effect.provide(
      Bash.run({
        mode: "hermetic",
        command: "cat /work//input",
        cwd: "/work",
        reads: ["/work/"],
        writes: []
      }),
      recorder(spawns)
    ))

    expect(result.exitCode).toBe(0)
    expect(spawns).toHaveLength(1)
  })

  it("does not let an empty read declaration authorize an absolute path", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        command: "cat /etc/shadow",
        reads: [""],
        writes: []
      })),
      recorder(spawns)
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/etc/shadow"
      })
    }
    expect(spawns).toEqual([])
  })

  it("rejects empty hermetic declarations at the schema boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(Bash.Input)({
        mode: "hermetic",
        command: "cat /etc/shadow",
        reads: [""],
        writes: []
      })
    ).toThrow()
  })

  it("reads an omitted mode as unhermetic, the envelope it declares anyway", () => {
    const decoded = Schema.decodeUnknownSync(Bash.Input)({ command: "cd apps/tui && bun run typecheck" })
    expect(decoded).toEqual({ mode: "unhermetic", command: "cd apps/tui && bun run typecheck" })
    expect(Bash.effectsFor(decoded)).toEqual(Bash.effects)
  })

  it("still requires declarations when hermetic is named", () => {
    expect(() => Schema.decodeUnknownSync(Bash.Input)({ mode: "hermetic", command: "ls" })).toThrow()
  })

  it("points a checkpoint cwd at the third ctx.call argument", () => {
    expect(() => Schema.decodeUnknownSync(Bash.Input)({ command: "ls", cwd: { at: "base" } }))
      .toThrow("{ at: ctx.base } as the third ctx.call argument")
  })

  it("names the numeric millisecond requirement for timeoutMs", () => {
    expect(() => Schema.decodeUnknownSync(Bash.Input)({ command: "ls", timeoutMs: "1000" }))
      .toThrow("timeoutMs must be a number of milliseconds")
  })

  it("hands a script to its interpreter as data, never as a quoted line", async () => {
    const spawns: Array<Spawned> = []
    const script = "import sys\nprint('single ' + \"double\" + `back` + '''triple''')\n"
    await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        interpreter: "python3",
        script,
        args: ["--flag", "a b"],
        cwd: "/work"
      }),
      recorder(spawns)
    ))
    expect(spawns).toEqual([{
      file: "python3",
      args: ["-", "--flag", "a b"],
      stdin: script,
      shell: false,
      cwd: "/work"
    }])
  })

  it("defaults a script to the shell and passes stdin for a command", async () => {
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", script: "echo hello" }),
      recorder(spawns)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "cat", stdin: "payload" }),
      recorder(spawns)
    ))
    expect(spawns[0]).toMatchObject({ file: "bash", args: ["-s"], stdin: "echo hello", shell: false })
    expect(spawns[1]).toMatchObject({ file: "cat", args: [], stdin: "payload", shell: true })
  })

  it("keeps the login shell inside the container, where the profile it reads lives", async () => {
    // The wrapper exists because an image activates the project's interpreter
    // from its own profile. A hermetic run is refused a container outright, and
    // a local spawn already has the host's environment, so neither may acquire
    // a login shell as a side effect of the container path: `-l` there reads
    // the developer's own profile into a run that declared its envelope.
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "hermetic", script: "echo hello", reads: [], writes: [] }),
      recorder(spawns)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "hermetic", command: "echo hello", reads: [], writes: [] }),
      recorder(spawns)
    ))
    expect(spawns[0]).toMatchObject({ file: "bash", args: ["-s"], stdin: "echo hello" })
    expect(spawns[1]).toMatchObject({ file: "echo hello", shell: true })
    for (const spawn of spawns) {
      expect(spawn.args ?? []).not.toContain("-l")
      expect(spawn.args ?? []).not.toContain("-lc")
      expect(spawn.args ?? []).not.toContain(`exec "$@"`)
    }
  })

  it("builds the container argv through the injected transport, with no quoting of its own", async () => {
    const spawns: Array<Spawned> = []
    const transport = Layer.succeed(Container.Container)(Container.makeCommand())
    await execute(Effect.provide(
      Bash.run({
        mode: "unhermetic",
        container: "swebench-1",
        cwd: "/testbed",
        env: { PYTHONHASHSEED: "0" },
        interpreter: "python",
        script: "print('it ran')"
      }),
      Layer.merge(recorder(spawns), transport)
    ))
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", container: "swebench-1", cwd: "/testbed", command: "pytest -q tests/test_x.py" }),
      Layer.merge(recorder(spawns), transport)
    ))
    // Both shapes reach the container through a login shell. The image's own
    // profile is what activates the project's interpreter, and r91 measured
    // what skipping it costs: `interpreter: "python3"` resolved to a Python
    // without the repository's dependencies on 30 of 45 graded instances.
    // `exec "$@"` replaces the shell with the interpreter, so the script still
    // arrives on the inherited standard input and no argument is re-parsed.
    expect(commands(spawns)[0]).toEqual({
      file: "docker",
      args: [
        "exec",
        "-i",
        "-w",
        "/testbed",
        "-e",
        "SMITHERS_CONTAINER_ENV_PYTHONHASHSEED",
        "--",
        "swebench-1",
        "sh",
        "-c",
        `PYTHONHASHSEED="$SMITHERS_CONTAINER_ENV_PYTHONHASHSEED"; export PYTHONHASHSEED; unset SMITHERS_CONTAINER_ENV_PYTHONHASHSEED; exec "$@"`,
        "sh",
        "bash",
        "-lc",
        `exec "$@"`,
        "bash",
        "python",
        "-"
      ],
      stdin: "print('it ran')",
      shell: false,
      // The container owns the working directory, so the host spawn does not.
      cwd: undefined
    })
    expect(commands(spawns)[1]).toMatchObject({
      file: "docker",
      args: ["exec", "-w", "/testbed", "--", "swebench-1", "bash", "-lc", "pytest -q tests/test_x.py"],
      stdin: undefined
    })
  })

  it("keeps a containerised environment value out of the argv and out of a timeout error", async () => {
    // `env` on a containerised command is a host credential as often as it is
    // a knob. It must not reach the process table through the argv, nor a
    // model through the error a timeout renders.
    const spawns: Array<ReadonlyArray<string>> = []
    const environments: Array<Record<string, string> | undefined> = []
    const stalled = ChildProcessSpawner.makeNoop({
      spawn: (command) => {
        const standard = command as ChildProcess.StandardCommand
        spawns.push([...standard.args])
        environments.push(standard.options.env as Record<string, string> | undefined)
        return Effect.never
      }
    })
    const exit = await execute(
      Effect.exit(Bash.run({
        mode: "unhermetic",
        container: "swebench-1",
        env: { DATABASE_PASSWORD: "s3cret-value" },
        command: "pytest",
        timeoutMs: 1
      })).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(stalled),
          Layer.succeed(Container.Container)(Container.makeCommand()),
          Path.layer
        ))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      expect(failure?.code).toBe("timeout")
      expect(failure?.message).not.toContain("s3cret-value")
      expect(failure?.message).toBe("Command timed out: pytest")
      expect(Cause.pretty(exit.cause)).not.toContain("s3cret-value")
    }
    expect(spawns.find((spawn) => !isFingerprint(spawn))).toContain("SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD")
    expect(spawns.find((spawn) => !isFingerprint(spawn))?.join(" ")).not.toContain("s3cret-value")
    // The value still has to reach the container, so it rides on the
    // environment of the transport process the host spawns, under a prefixed
    // name the transport itself never reads.
    const transport = environments[spawns.findIndex((spawn) => !isFingerprint(spawn))]
    expect(transport?.["SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD"]).toBe("s3cret-value")
    expect(transport?.["DATABASE_PASSWORD"]).toBeUndefined()
  })

  it("asks a containerised shell script for no login flag of its own", async () => {
    // The wrapper is already a login shell, so the inner interpreter is asked
    // for nothing but "read the program from stdin". Two login shells would
    // read the profile twice for the same activation.
    const spawns: Array<Spawned> = []
    await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", container: "swebench-1", script: "echo hello" }),
      Layer.merge(recorder(spawns), Layer.succeed(Container.Container)(Container.makeCommand()))
    ))
    expect(commands(spawns)[0]).toMatchObject({
      file: "docker",
      args: ["exec", "-i", "--", "swebench-1", "bash", "-lc", `exec "$@"`, "bash", "bash", "-s"],
      stdin: "echo hello"
    })
  })

  /**
   * A spawner that answers every fingerprint from a queue and every command
   * with exit 0, so a case states what the container's tree looked like
   * before and after the command and nothing else.
   */
  const fingerprinting = (
    answers: Array<{ readonly exitCode?: number; readonly stdout: string }>,
    spawns: Array<Spawned>
  ) =>
    Layer.mergeAll(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
        spawn: (command) =>
          Effect.sync(() => {
            const standard = command as ChildProcess.StandardCommand
            const spawn: Spawned = {
              file: standard.command,
              args: [...standard.args],
              stdin: undefined,
              shell: standard.options.shell === true,
              cwd: standard.options.cwd
            }
            spawns.push(spawn)
            const answer = isFingerprint(spawn) ? answers.shift() ?? { exitCode: 1, stdout: "" } : { stdout: "" }
            return makeHandle({
              pid: ProcessId(1),
              exitCode: Effect.succeed(ExitCode(answer.exitCode ?? 0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(answer.stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void)
            })
          })
      })),
      Layer.succeed(Container.Container)(Container.makeCommand()),
      Path.layer
    )

  const contained = { mode: "unhermetic", container: "task-1", cwd: "/app", command: "python3 fix.py" } as const

  it("measures the container's working directory either side of the command and reports a move", async () => {
    // The blindness this closes, measured 2026-09-22 on Terminal-Bench 4.0:
    // every write an agent made through `docker exec` read as an idle frame,
    // because the host's workspace walk cannot see a container's filesystem.
    const spawns: Array<Spawned> = []
    const output = await execute(Effect.provide(
      Bash.run(contained),
      fingerprinting([{ stdout: "11 20\n2\n" }, { stdout: "99 24\n3\n" }], spawns)
    ))
    expect(output.mutated).toBe(true)
    // Both fingerprints run where the command runs: same container, same
    // working directory, through the same transport, as a plain `sh` script.
    const fingerprints = spawns.filter(isFingerprint)
    expect(fingerprints).toHaveLength(2)
    expect(fingerprints[0]?.args.slice(0, 5)).toEqual(["exec", "-w", "/app", "--", "task-1"])
    expect(fingerprints[0]?.args.slice(5, 7)).toEqual(["sh", "-c"])
    expect(spawns.map(isFingerprint)).toEqual([true, false, true])
  })

  it("reports a tree that held still as unmoved, so a read-only container call still counts as one", async () => {
    const spawns: Array<Spawned> = []
    const output = await execute(Effect.provide(
      Bash.run(contained),
      fingerprinting([{ stdout: "11 20\n2\n" }, { stdout: "11 20\n2\n" }], spawns)
    ))
    expect(output.mutated).toBe(false)
  })

  it("reports nothing when the tree could not be measured, never an unchanged tree", async () => {
    const unmeasured = async (answers: Array<{ readonly exitCode?: number; readonly stdout: string }>) => {
      const spawns: Array<Spawned> = []
      const output = await execute(Effect.provide(Bash.run(contained), fingerprinting(answers, spawns)))
      expect(output.exitCode).toBe(0)
      return output.mutated
    }
    // A container without `find` or `stat -c`, or a shell that fails.
    expect(await unmeasured([{ exitCode: 127, stdout: "" }, { stdout: "11 20\n2\n" }])).toBeUndefined()
    expect(await unmeasured([{ stdout: "11 20\n2\n" }, { exitCode: 1, stdout: "" }])).toBeUndefined()
    // A listing that reached the bound covers a prefix, and a prefix cannot
    // say that the tree held still.
    expect(await unmeasured([{ stdout: `11 20\n${TreeFingerprint.maxPaths + 1}\n` }, { stdout: "11 20\n3\n" }]))
      .toBeUndefined()
    expect(await unmeasured([{ stdout: "garbage" }, { stdout: "11 20\n2\n" }])).toBeUndefined()
  })

  it("measures nothing for a command that runs on the host", async () => {
    // The host's own workspace walk covers a host command; a second
    // measurement here would count the host tree twice.
    const spawns: Array<Spawned> = []
    const output = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "true" }),
      fingerprinting([{ stdout: "11 20\n2\n" }, { stdout: "99 24\n3\n" }], spawns)
    ))
    expect(output.mutated).toBeUndefined()
    expect(spawns.filter(isFingerprint)).toHaveLength(0)
  })

  it("refuses a container when the host binds no transport", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({ mode: "unhermetic", container: "absent", command: "true" })),
      recorder(spawns)
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value.code).toBe("provider_unavailable")
      expect(Option.isSome(failure) && failure.value.message).toContain("no container transport")
    }
    expect(spawns).toEqual([])
  })

  it("refuses the input shapes that cannot mean one thing", async () => {
    const spawns: Array<Spawned> = []
    const refuse = async (input: Parameters<typeof Bash.run>[0]) => {
      const exit = await execute(Effect.provide(Effect.exit(Bash.run(input)), recorder(spawns)))
      const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      return Option.getOrUndefined(failure)?.message ?? ""
    }
    expect(await refuse({ mode: "unhermetic", command: "true", script: "true" })).toContain("never both")
    expect(await refuse({ mode: "unhermetic" })).toContain("Give either command")
    expect(await refuse({ mode: "unhermetic", script: "true", stdin: "x" })).toContain("already arrives")
    expect(await refuse({ mode: "unhermetic", command: "true", args: ["x"] })).toContain("args belong to a script")
    expect(await refuse({ mode: "unhermetic", command: "true", interpreter: "python" })).toContain("runs a script")
    expect(await refuse({ mode: "hermetic", command: "true", container: "c", reads: [], writes: [] }))
      .toContain("mode:unhermetic")
    expect(await refuse({ mode: "hermetic", script: "x = 1", interpreter: "python", reads: [], writes: [] }))
      .toContain("not a shell")
    expect(spawns).toEqual([])
  })

  it("pre-checks a hermetic shell script's paths exactly as it pre-checks a command", async () => {
    const spawns: Array<Spawned> = []
    const exit = await execute(Effect.provide(
      Effect.exit(Bash.run({
        mode: "hermetic",
        script: "cat /outside/secret.txt\n",
        reads: ["/work/**"],
        writes: []
      })),
      recorder(spawns)
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
        code: "outside_declared_reads",
        path: "/outside/secret.txt"
      })
    }
    expect(spawns).toEqual([])
  })

  it("keeps hermetic and unhermetic tiers irreversible", () => {
    expect(Bash.effects).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
    expect(Bash.effectsFor({
      mode: "hermetic",
      command: "true",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })).toMatchObject({
      tier: "irreversible",
      mode: "hermetic",
      reads: ["/work/input"],
      writes: ["/work/output"]
    })
    expect(Bash.effectsFor({
      mode: "unhermetic",
      command: "true"
    })).toMatchObject({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })
  })

  it("separates the shell's refusal to start a command from a check that failed", async () => {
    // 127 is the shell saying it never found the program, which is a fact its
    // exit code carries. Reading a runner's wording is a judgment, and the
    // `test` flow is where Jev is asked for it; a shell call takes no judge.
    const broken = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "pytest tests/admin_views" }),
      layer({
        commands: { "pytest tests/admin_views": { stderr: "bash: pytest: command not found", exitCode: 127 } }
      })
    ))
    expect(broken.exitCode).toBe(127)
    expect(broken.invalidProbe).toMatchObject({
      reason: "unknown-command",
      evidence: "the command exited 127"
    })
    expect(broken.invalidProbe?.message).toContain("not a reproduction")

    // The same failure to find a name, reported by the runner rather than by
    // the shell, is an ordinary non-zero exit here.
    const ran = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "python -m pytest tests/admin_views" }),
      layer({
        commands: {
          "python -m pytest tests/admin_views": { stdout: "1 failed, 412 passed", exitCode: 1 }
        }
      })
    ))
    expect(ran.exitCode).toBe(1)
    expect(ran.invalidProbe).toBeUndefined()
  })

  it("omits the invalid-probe key entirely from an ordinary result", async () => {
    const result = await execute(Effect.provide(
      Bash.run({ mode: "unhermetic", command: "true" }),
      layer({ commands: { true: { stdout: "", exitCode: 0 } } })
    ))

    expect(Object.hasOwn(result, "invalidProbe")).toBe(false)
  })
})
