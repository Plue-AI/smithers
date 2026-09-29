/**
 * The `test` flow over a real repository, a real git, and a real process.
 *
 * `TestRun.test.ts` drives every branch against a scripted spawner, which is
 * how the parsing and the attribution are pinned. It cannot say whether the
 * baseline half works, because the whole of that half is git: a ref written by
 * something else, a detached worktree checked out beside the tree under test,
 * a second run of the identical invocation inside it, and the removal
 * afterwards. The r91 wave is the reason that distinction is worth a file — it
 * shipped this flow with no composition binding it and measured zero `test`
 * calls across 45 runs, which is what an untried path costs.
 *
 * The runner here is a shell script in the repository, so nothing but `git` and
 * `bash` is assumed.
 */
import { NodeServices } from "@effect/platform-node"
import { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as TestRun from "../src/TestRun.ts"
import * as TestRunner from "../src/TestRunner.ts"

/**
 * The attribution judge, scripted: every run here fails, or passes, about the
 * tree. What the judge decides is `TestRun.test.ts`'s subject; what this file
 * needs is that the flow has one, because it refuses to answer without one.
 */
const tree = Evaluator.layerScripted(() => ({
  attribution: { choice: "tree" },
  executed: { probability: 0.95 }
}))

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A repository whose suite passes or fails according to one file's contents. */
const repository = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flows-testrun-")))
  writeFileSync(
    join(root, "runtests.sh"),
    [
      "#!/bin/bash",
      "passed=0; failed=0",
      "if grep -q FIXED mod.py; then echo 'tests/test_a.py::test_a PASSED'; passed=$((passed + 1));",
      "else echo 'FAILED tests/test_a.py::test_a - boom'; failed=$((failed + 1)); fi",
      "if grep -q BROKEN mod.py; then echo 'FAILED tests/test_b.py::test_b - boom'; failed=$((failed + 1)); fi",
      "printf '%s\\n' \"$@\" > selection.txt",
      "if [ \"$failed\" -eq 0 ]; then echo \"$passed passed in 0.1s\";",
      "else echo \"$failed failed, $passed passed in 0.1s\"; fi",
      ""
    ].join("\n"),
    { mode: 0o755 }
  )
  writeFileSync(join(root, "mod.py"), "x = 1\n")
  git(root, ["init", "-q"])
  git(root, ["config", "core.autocrlf", "false"])
  git(root, ["config", "user.email", "rig@localhost"])
  git(root, ["config", "user.name", "rig"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  return root
}

const run = (input: typeof TestRun.Input.Type, runner: TestRunner.Runner) =>
  Effect.runPromise(
    Effect.provide(
      TestRun.run(input),
      Layer.mergeAll(NodeServices.layer, TestRunner.layer(runner), tree)
    )
  )

describe("TestRun over a real repository", () => {
  it("keeps overlapping baseline runs intact", async () => {
    const root = repository()
    const paths: Array<string> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const native = yield* ChildProcessSpawner
        const entered = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        const run = TestRun.run({ against: "base" }).pipe(
          Effect.provide(TestRunner.layer({ command: "bash ./runtests.sh", cwd: root, root })),
          Effect.provideService(ChildProcessSpawner, {
            ...native,
            spawn: (command) => {
              const standard = command as ChildProcess.StandardCommand
              const cwd = standard.options.cwd ?? ""
              if (standard.command === "bash" && cwd !== root) {
                paths.push(cwd)
                if (paths.length === 1) {
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(released)),
                    Effect.andThen(Effect.sync(() => {
                      expect(readFileSync(join(cwd, "mod.py"), "utf8")).toBe("x = 1\n")
                    })),
                    Effect.andThen(native.spawn(command))
                  )
                }
                expect(readFileSync(join(cwd, "mod.py"), "utf8")).toBe("x = 1\n")
              }
              return native.spawn(command)
            }
          })
        )
        const first = yield* run.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const second = yield* run
        yield* Deferred.succeed(released, undefined)
        const initial = yield* Fiber.join(first)
        expect(initial.base?.parsed).toBe(true)
        expect(second.base?.parsed).toBe(true)
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, tree)))
    )
    expect(new Set(paths).size).toBe(2)
    for (const path of paths) expect(existsSync(path)).toBe(false)
  }, 60_000)

  it.each(["failure", "interruption"] as const)("removes the real baseline checkout after %s", async (ending) => {
    const root = repository()
    const commands: Array<string> = []
    let scratch = ""
    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const native = yield* ChildProcessSpawner
        const entered = yield* Deferred.make<void>()
        const run = TestRun.run({ against: "base" }).pipe(
          Effect.provide(TestRunner.layer({ command: "bash ./runtests.sh", cwd: root, root })),
          Effect.provideService(ChildProcessSpawner, {
            ...native,
            spawn: (command) => {
              const standard = command as ChildProcess.StandardCommand
              const cwd = standard.options.cwd ?? ""
              commands.push([standard.command, ...standard.args, cwd].join(" "))
              if (standard.command === "bash" && cwd !== root) {
                scratch = cwd
                expect(existsSync(join(scratch, "mod.py"))).toBe(true)
                return ending === "failure"
                  ? Effect.fail(new Error("spawn refused") as never)
                  : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              }
              return native.spawn(command)
            }
          })
        )
        if (ending === "failure") return yield* Effect.exit(run)
        const fiber = yield* run.pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, tree)))
    )
    expect(exit._tag).toBe("Failure")
    expect(scratch).not.toBe("")
    expect(existsSync(scratch)).toBe(false)
    const launched = commands.findIndex((line) => line.startsWith("bash ") && line.endsWith(scratch))
    expect(launched).toBeGreaterThan(-1)
    expect(commands.slice(launched + 1)).toContain(
      `rm -rf -- ${scratch} `
    )
    expect(git(root, ["worktree", "list"])).not.toContain(TestRun.scratchDirectory)
  }, 60_000)

  it("runs the base commit beside the working tree and attributes the difference", async () => {
    const root = repository()
    // The ref `evals/swebench/lib/snapshot-base.sh` writes, which is also the
    // flow's own default when a declaration names none.
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    writeFileSync(join(root, "mod.py"), "FIXED\nBROKEN\n")

    // The shape `NodeControl.testRunner` builds out of `FLOWS_TEST_COMMAND` and
    // its companions, for a host whose repository is not in a container.
    const output = await run(
      { against: "base", selection: ["tests/test_a.py::test_a[x y]"] },
      { command: "bash ./runtests.sh", cwd: root, root }
    )

    expect(output.parsed).toBe(true)
    expect(output.failed).toEqual(["tests/test_b.py::test_b"])
    expect(output.base?.ref).toBe(TestRunner.captureBase)
    expect(output.base?.commit).toBe(git(root, ["rev-parse", "HEAD"]).trim())
    expect(output.base?.failed).toEqual(["tests/test_a.py::test_a"])
    expect(output.introduced).toEqual(["tests/test_b.py::test_b"])
    expect(output.preexisting).toEqual([])
    expect(output.fixed).toEqual(["tests/test_a.py::test_a"])
    // A test id carries `::`, brackets and spaces routinely. It reaches the
    // runner as one argument because it travels as data, never as shell text.
    expect(readFileSync(join(root, "selection.txt"), "utf8").trim())
      .toBe("tests/test_a.py::test_a[x y]")
    // The baseline worktree is gone however the call ended.
    expect(git(root, ["worktree", "list"])).not.toContain(TestRun.scratchDirectory)
  }, 60_000)

  it("falls back to HEAD when no capture base was ever recorded", async () => {
    const root = repository()
    writeFileSync(join(root, "mod.py"), "FIXED\n")

    const output = await run({ against: "base" }, { command: "bash ./runtests.sh", cwd: root, root })

    expect(output.base?.ref).toBe("HEAD")
    expect(output.fixed).toEqual(["tests/test_a.py::test_a"])
  }, 60_000)

  it("uses a fresh baseline without deleting a standing worktree", async () => {
    const root = repository()
    const scratch = join(root, TestRun.scratchDirectory)
    git(root, ["worktree", "add", "--detach", scratch, "HEAD"])
    writeFileSync(join(root, "mod.py"), "FIXED\n")

    const output = await run({ against: "base" }, { command: "bash ./runtests.sh", cwd: root, root })

    expect(output.base?.parsed).toBe(true)
    expect(output.fixed).toEqual(["tests/test_a.py::test_a"])
    expect(readFileSync(join(scratch, "mod.py"), "utf8")).toBe("x = 1\n")
    git(root, ["worktree", "remove", "--force", scratch])
    expect(git(root, ["worktree", "list"])).not.toContain(TestRun.scratchDirectory)
  }, 60_000)

  it("refuses a declared base ref that does not resolve rather than baselining the wrong tree", async () => {
    const root = repository()
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          TestRun.run({ against: "base" }),
          Layer.mergeAll(
            NodeServices.layer,
            tree,
            TestRunner.layer({ command: "bash ./runtests.sh", cwd: root, root, baseRef: "refs/flows/absent" })
          )
        )
      )
    )

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("No pristine base to compare against")
  }, 60_000)
})
