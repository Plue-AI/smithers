import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import { TestClock } from "effect/testing"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Container from "../src/Container.ts"
import { MAX_SHELL_OUTPUT_BYTES } from "../src/internal/Text.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

interface Response {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
}

/**
 * Records every argv the flow spawns and answers each from a table keyed by a
 * distinguishing fragment, so a test asserts on the invocation rather than on
 * the order the implementation happens to use.
 */
const host = (
  spawns: Array<ReadonlyArray<string>>,
  responses: ReadonlyArray<readonly [string, Response]>
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        // The working directory is part of what identifies a run: the baseline
        // is the same argv in the scratch worktree.
        const line = [...argv, standard.options.cwd ?? ""].join(" ")
        const found = responses.find(([fragment]) => line.includes(fragment))?.[1] ?? {}
        const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
        const stdout = encode(found.stdout ?? "")
        const stderr = encode(found.stderr ?? "")
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(found.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr,
          all: Stream.concat(stdout, stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  }))

/**
 * The shadow checkout's own commands, answered before a test's table so a
 * fragment naming the scratch directory only ever matches the baseline run.
 */
const shadowCheckout: ReadonlyArray<readonly [string, Response]> = [
  ["--show-toplevel", { stdout: "/repo\n/repo/.git\n/repo/.git/index\nsha1\n" }],
  ["--get-regexp", { exitCode: 1 }],
  ["init --quiet --bare", {}],
  ["stat -c %d", { stdout: "1\n1\n1\n" }],
  ["sh -c", {}],
  ["read-tree", {}],
  ["rm -rf --", {}]
]

/**
 * A judge that answers one attribution with the confidence it is given, so a
 * run's own attribution is a fixture rather than a reading of its output.
 */
const judging = (attribution: string, probability = 0.95): Layer.Layer<Evaluator.Evaluator> =>
  Evaluator.layerScripted((request) => {
    const options = Object.keys(
      (request.questions["attribution"] as { readonly criteria: Record<string, string> }).criteria
    )
    const rest = (1 - probability) / (options.length - 1)
    return {
      attribution: {
        choice: attribution,
        probabilities: Object.fromEntries(
          options.map((option) => [option, option === attribution ? probability : rest])
        )
      },
      executed: { probability: 0.9 }
    }
  })

/** The judgment every run that is not about the judgment gets: it is the tree. */
const tree = judging("tree")

const declaration = TestRunner.layer({ command: "python -m pytest -rA", cwd: "/repo" })

// Beside the spawner, a run needs the host's runner declaration and the judge
// that attributes a non-zero exit. A test about the attribution itself merges
// its own judge with `declaration` instead.
const runner = Layer.merge(declaration, tree)

const failureOf = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { code?: string; message?: string } | undefined
    : undefined

describe("TestRun", () => {
  it("answers with a reading of the runner's report, not its output", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ selection: ["tests/test_widen.py::test_narrows"] }),
      Layer.merge(
        host(spawns, [["pytest", {
          stdout: "FAILED tests/test_widen.py::test_narrows - boom\n1 failed, 41 passed in 1.2s\n",
          exitCode: 1
        }]]),
        runner
      )
    ))
    expect(result).toMatchObject({
      exitCode: 1,
      passed: 41,
      failed: ["tests/test_widen.py::test_narrows"],
      parsed: true
    })
    // The selection travels as arguments; a test id full of :: and brackets is
    // never quoted into a command line.
    expect(spawns).toEqual([[
      "bash",
      "-lc",
      "python -m pytest -rA \"$@\"",
      "python -m pytest -rA",
      "tests/test_widen.py::test_narrows"
    ]])
    expect(result.command).toContain("python -m pytest -rA")
    expect(Object.hasOwn(result, "base")).toBe(false)
  })

  it("keeps the raw tail when the report cannot be read", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.merge(host(spawns, [["pytest", { stderr: "Segmentation fault\n", exitCode: 139 }]]), runner)
    ))
    expect(result).toMatchObject({ parsed: false, passed: 0, failed: [], tailTruncated: false })
    expect(result.tail).toContain("Segmentation fault")
  })

  it("judges the tail it returns, and the command it reports, and nothing else", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const judged: Array<Record<string, unknown>> = []
    const recording = Evaluator.layerScripted((request) => {
      judged.push(request.state as Record<string, unknown>)
      return { attribution: { choice: "tree" }, executed: { probability: 0.9 } }
    })
    const output = `ModuleNotFoundError: No module named 'missing_probe'\n${
      "x".repeat(
        MAX_SHELL_OUTPUT_BYTES + 100
      )
    }`
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.mergeAll(host(spawns, [["pytest", { stdout: output, exitCode: 1 }]]), declaration, recording)
    ))

    expect(result.tailTruncated).toBe(true)
    expect(result.tail).not.toContain("missing_probe")
    expect(result.invalidProbe).toBeUndefined()
    expect(judged).toHaveLength(1)
    expect(judged[0]?.["output"]).toBe(result.tail)
    expect(judged[0]?.["command"]).toBe(result.command)
    expect(judged[0]?.["exitCode"]).toBe(1)
  })

  it("reports the reason the judge decided on", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ selection: ["tests/test_admin.py::nope"] }),
      Layer.mergeAll(
        host(spawns, [["pytest", { stderr: "ERROR: not found: tests/test_admin.py::nope\n", exitCode: 4 }]]),
        declaration,
        judging("unknown-test", 0.92)
      )
    ))
    expect(result.invalidProbe).toMatchObject({ reason: "unknown-test" })
    expect(result.invalidProbe?.message).toContain("not a reproduction")
  })

  it("keeps the shell's reserved exit codes out of the judge's hands", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const asked: Array<unknown> = []
    const recording = Evaluator.layerScripted((request) => {
      asked.push(request.state)
      return { attribution: { choice: "tree" }, executed: { probability: 0.9 } }
    })
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.mergeAll(
        host(spawns, [["pytest", { stderr: "bash: pytest: command not found\n", exitCode: 127 }]]),
        declaration,
        recording
      )
    ))
    expect(result.invalidProbe).toMatchObject({ reason: "unknown-command", evidence: "the command exited 127" })
    expect(asked).toEqual([])
  })

  it("fails the call when the judge does not answer, rather than reporting an unjudged run", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await execute(Effect.provide(
      Effect.exit(TestRun.run({})),
      Layer.mergeAll(
        host(spawns, [["pytest", { stdout: "1 failed, 41 passed in 1.2s\n", exitCode: 1 }]]),
        declaration,
        Evaluator.layerUnavailable()
      )
    ))
    expect(failureOf(exit)?.code).toBe("provider_unavailable")
    expect(failureOf(exit)?.message).toContain("not judged")
  })

  it("bounds captured output and includes capture loss in the returned tail count", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const output = "x".repeat(8_000_100)
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.merge(host(spawns, [["pytest", { stdout: output }]]), runner)
    ))

    expect(TestRun.MAX_CAPTURE_BYTES).toBe(8_000_000)
    expect(result.tail).toHaveLength(MAX_SHELL_OUTPUT_BYTES)
    expect(result.tailDroppedBytes).toBe(output.length - MAX_SHELL_OUTPUT_BYTES)
  })

  it("uses a ten-minute timeout when neither input nor runner supplies one", async () => {
    const stalled = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
      ChildProcessSpawner.makeNoop({ spawn: () => Effect.never })
    )
    const exit = await execute(
      Effect.gen(function*() {
        const fiber = yield* TestRun.run({}).pipe(
          Effect.provide(Layer.merge(stalled, runner)),
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust(600_000)
        return fiber.pollUnsafe()
      }).pipe(Effect.provide(TestClock.layer()))
    )

    expect(TestRun.DEFAULT_TIMEOUT_MS).toBe(600_000)
    expect(exit).toBeDefined()
    if (exit !== undefined) expect(failureOf(exit)?.code).toBe("timeout")
  })

  it("runs the pristine base in a scratch worktree and attributes every failure", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ against: "base" }),
      Layer.merge(
        host(spawns, [
          ...shadowCheckout,
          ["rev-parse", { stdout: "abc123\n" }],
          [TestRun.scratchDirectory, { stdout: "FAILED tests/b.py::stale - old\n1 failed, 40 passed\n", exitCode: 1 }],
          ["pytest", {
            stdout: "FAILED tests/a.py::mine - new\nFAILED tests/b.py::stale - old\n2 failed, 39 passed\n",
            exitCode: 1
          }]
        ]),
        runner
      )
    ))
    expect(result.failed).toEqual(["tests/a.py::mine", "tests/b.py::stale"])
    expect(result.base).toMatchObject({
      ref: TestRunner.captureBase,
      commit: "abc123",
      failed: ["tests/b.py::stale"],
      passed: 40
    })
    expect(result.introduced).toEqual(["tests/a.py::mine"])
    expect(result.preexisting).toEqual(["tests/b.py::stale"])
    expect(result.fixed).toEqual([])
    const lines = spawns.map((argv) => argv.join(" "))
    expect(lines[1]).toBe(
      `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /repo rev-parse --verify --quiet ${TestRunner.captureBase}^{commit}`
    )
    const scratch = spawns.find((argv) => argv[0] === "sh" && argv[2]?.includes("mv --"))?.[5]
    expect(scratch).toMatch(/^\/repo\/\.flows-test-base\/run-[0-9a-f-]{36}$/)
    // The baseline tree is written from a shadow GIT_DIR, never by a worktree
    // of the workspace repository, whose `.git` the agent can write.
    expect(lines).toContainEqual(expect.stringMatching(
      new RegExp(
        `^git --git-dir=(\\S+/smithers-git-[0-9a-f-]{36}) --work-tree=\\1/${
          scratch!.slice(scratch!.lastIndexOf("/") + 1)
        } .* read-tree --reset -u abc123$`
      )
    ))
    expect(lines.some((line) => line.includes("worktree add"))).toBe(false)
    const baseline = spawns.findIndex((argv, index) => index > 0 && argv.join(" ") === lines[0])
    expect(baseline).toBeGreaterThan(1)
    expect(lines.at(-1)).toBe(`rm -rf -- ${scratch}`)
  })

  it("omits attribution when either side has an incomplete failure reading", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ against: "base" }),
      Layer.merge(
        host(spawns, [
          ...shadowCheckout,
          ["rev-parse", { stdout: "abc123\n" }],
          [TestRun.scratchDirectory, { stdout: "2 failed in 0.1s\n", exitCode: 1 }],
          ["pytest", { stdout: "FAILED tests/a.py::mine - new\n1 failed in 0.1s\n", exitCode: 1 }]
        ]),
        runner
      )
    ))

    expect(result.parsed).toBe(true)
    expect(result.base?.parsed).toBe(false)
    expect(Object.hasOwn(result, "introduced")).toBe(false)
    expect(Object.hasOwn(result, "preexisting")).toBe(false)
    expect(Object.hasOwn(result, "fixed")).toBe(false)
  })

  it("falls back from the capture base to HEAD, and says which it used", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const result = await execute(Effect.provide(
      TestRun.run({ against: "base" }),
      Layer.merge(
        host(spawns, [
          ...shadowCheckout,
          [`${TestRunner.captureBase}^`, { exitCode: 1 }],
          ["rev-parse", { stdout: "deadbee\n" }],
          ["pytest", { stdout: "3 passed\n" }]
        ]),
        runner
      )
    ))
    expect(result.base?.ref).toBe("HEAD")
    expect(result.base?.commit).toBe("deadbee")
  })

  it("refuses a baseline it cannot anchor rather than comparing against the wrong tree", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await execute(Effect.provide(
      Effect.exit(TestRun.run({ against: "base" })),
      Layer.merge(
        host(spawns, [["rev-parse", { exitCode: 1 }], ["pytest", { stdout: "3 passed\n" }]]),
        Layer.merge(TestRunner.layer({ command: "pytest", cwd: "/repo", baseRef: "refs/flows/absent" }), tree)
      )
    ))
    expect(failureOf(exit)?.code).toBe("not_found")
    expect(failureOf(exit)?.message).toContain("refs/flows/absent")
    expect(spawns.some((argv) => argv.join(" ").includes("worktree add"))).toBe(false)
  })

  it("removes the scratch worktree even when the baseline run fails to start", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    let failedAt = -1
    const stalled = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) => {
        const standard = command as ChildProcess.StandardCommand
        const argv = [standard.command, ...standard.args]
        spawns.push(argv)
        const line = argv.join(" ")
        if ((standard.options.cwd ?? "").includes(TestRun.scratchDirectory)) {
          failedAt = spawns.length - 1
          return Effect.fail(new Error("spawn refused") as never)
        }
        const stdout = Stream.make(
          new TextEncoder().encode(
            line.includes("--show-toplevel")
              ? "/repo\n/repo/.git\n/repo/.git/index\nsha1\n"
              : line.includes("stat -c %d")
              ? "1\n1\n1\n"
              : line.includes("rev-parse")
              ? "abc123\n"
              : line.includes("--get-regexp")
              ? ""
              : "3 passed\n"
          )
        )
        return Effect.succeed(makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: stdout,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        }))
      }
    }))
    const exit = await execute(
      Effect.provide(Effect.exit(TestRun.run({ against: "base" })), Layer.merge(stalled, runner))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failedAt).toBeGreaterThan(-1)
    expect(spawns.slice(failedAt + 1).some((argv) => argv.join(" ").startsWith("rm -rf -- /repo/.flows-test-base/")))
      .toBe(true)
  })

  it("routes the run through the container transport when the declaration names one", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    await execute(Effect.provide(
      TestRun.run({ selection: ["tests/test_x.py"] }),
      Layer.mergeAll(
        host(spawns, [["pytest", { stdout: "1 passed\n" }]]),
        TestRunner.layer({ command: "pytest -rA", cwd: "/testbed", root: "/work/repo", container: "swebench-1" }),
        tree,
        Layer.succeed(Container.Container)(Container.makeCommand())
      )
    ))
    expect(spawns[0]).toEqual([
      "docker",
      "exec",
      "-w",
      "/testbed",
      "--",
      "swebench-1",
      "bash",
      "-lc",
      "pytest -rA \"$@\"",
      "pytest -rA",
      "tests/test_x.py"
    ])
  })

  it("never reports a declared environment value in the command it answers with", async () => {
    // A host that gives a containerised runner a credential through
    // `Runner.env` must not have it read back: `command` is model-facing and
    // is recorded by whatever consumes the result. The transport forwards the
    // variable by name and the value travels on the spawned process.
    const spawns: Array<ReadonlyArray<string>> = []
    const environments: Array<Record<string, string> | undefined> = []
    const capture = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
      spawn: (command) =>
        Effect.sync(() => {
          const standard = command as ChildProcess.StandardCommand
          spawns.push([standard.command, ...standard.args])
          environments.push(standard.options.env as Record<string, string> | undefined)
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
    }))
    const result = await execute(Effect.provide(
      TestRun.run({}),
      Layer.mergeAll(
        capture,
        TestRunner.layer({
          command: "pytest",
          cwd: "/repo",
          container: "test-worker",
          env: { DATABASE_PASSWORD: "s3cret-value" }
        }),
        tree,
        Layer.succeed(Container.Container)(Container.makeCommand())
      )
    ))

    expect(result.command).not.toContain("s3cret-value")
    expect(result.command).toBe("bash -lc pytest \"$@\" pytest")
    expect(result.tail).toBe("")
    expect(spawns[0]).toContain("SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD")
    expect(spawns[0]?.join(" ")).not.toContain("s3cret-value")
    // The value still has to reach the container, so it rides on the
    // environment of the transport process the host spawns.
    expect(environments[0]?.["SMITHERS_CONTAINER_ENV_DATABASE_PASSWORD"]).toBe("s3cret-value")
  })

  it("says plainly when the host declares no runner", async () => {
    const spawns: Array<ReadonlyArray<string>> = []
    const exit = await execute(Effect.provide(
      Effect.exit(TestRun.run({})),
      Layer.mergeAll(host(spawns, []), TestRunner.layerNoop, tree)
    ))
    expect(failureOf(exit)?.code).toBe("provider_unavailable")
    expect(spawns).toEqual([])
  })

  it("declares the irreversible tier and the spawn capability", () => {
    expect(TestRun.effects).toMatchObject({ tier: "irreversible", mode: "expected" })
    expect(TestRun.effectsFor({})).toBe(TestRun.effects)
    expect(TestRun.capabilities).toEqual(["proc:spawn:*"])
  })
})
