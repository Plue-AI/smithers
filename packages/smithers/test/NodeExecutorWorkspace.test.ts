/**
 * A resumed history fork executes in its own checkout, so every capability the
 * executor equips the run with has to be equipped from that checkout. The test
 * runner is the one that grades the work: built from the project root instead,
 * the `test` flow runs against files the forked agent never touched and reports
 * the result as the fork's own.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import type * as StandardFlows from "@smthrs/agent/StandardFlows"
import { Control } from "@smthrs/control"
import * as Bash from "@smthrs/std/Bash"
import type * as TestRunner from "@smthrs/std/TestRunner"
import { Effect, Layer, Path } from "effect"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const observed = vi.hoisted(() => ({
  runners: [] as Array<TestRunner.Runner | undefined>,
  shells: [] as Array<Parameters<typeof StandardFlows.shell>[0]>
}))

// The shell's services are handed to `bash` alone; recording them lets the test
// run `bash` itself on exactly what a run's `bash` would get.
vi.mock("@smthrs/agent/StandardFlows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@smthrs/agent/StandardFlows")>()
  return {
    ...actual,
    shell: (...parameters: Parameters<typeof actual.shell>) => {
      observed.shells.push(parameters[0])
      return actual.shell(...parameters)
    }
  }
})

// The declaration is built inside the executor's registration phase and handed
// to the flow sources, which no service exposes afterwards. Recording what the
// composition constructed is the only way to ask which tree it named.
vi.mock("../src/internal/NativeEquipment.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/NativeEquipment.ts")>()
  return {
    ...actual,
    testRunner: (...parameters: Parameters<typeof actual.testRunner>) => {
      const runner = actual.testRunner(...parameters)
      observed.runners.push(runner)
      return runner
    }
  }
})

/** Builds the executor over `root`, executing in `workspace`, and runs `use` while it is open. */
const within = <A>(root: string, workspace: string, use: Effect.Effect<A>) => {
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const executor = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layer,
    environment: { SMITHERS_TEST_COMMAND: "project-test-command" },
    executionRoot: workspace
  })
  // Building the composition runs the registration phase, which is where
  // the flow sources are constructed.
  return Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      yield* control.plan({ flowId: "system/test", input: {} })
      return yield* use
    }).pipe(
      Effect.provide(Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>),
      Effect.scoped,
      Effect.orDie
    )
  )
}

describe("NodeControl.layerExecutor over a fork's checkout", () => {
  it("runs bash and resolves paths in the workspace it executes in, not the process directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flows-cli-fork-bash-")))
    const workspace = join(root, ".flows", "forks", "child")
    try {
      await mkdir(join(workspace, "src"), { recursive: true })
      expect(process.cwd()).not.toBe(workspace)
      observed.shells.length = 0
      const result = await within(
        root,
        workspace,
        Effect.suspend(() =>
          Effect.gen(function*() {
            const path = yield* Path.Path
            return {
              resolved: path.resolve("src"),
              pwd: (yield* Bash.run({ command: "pwd -P" })).stdout.trim(),
              nested: (yield* Bash.run({ command: "pwd -P", cwd: "src" })).stdout.trim()
            }
          }).pipe(Effect.provideContext(observed.shells.at(-1)!), Effect.orDie)
        )
      )
      expect(result).toEqual({ resolved: join(workspace, "src"), pwd: workspace, nested: join(workspace, "src") })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("declares the test runner against the workspace it executes in", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-fork-runner-"))
    const workspace = join(root, ".flows", "forks", "child")
    try {
      await mkdir(workspace, { recursive: true })
      observed.runners.length = 0
      await within(root, workspace, Effect.void)

      // `TestRun` executes at `cwd` and checks the pristine baseline out of
      // `root`, so a fork's runner has to name the fork under both.
      expect(observed.runners.at(-1)).toEqual({
        command: "project-test-command",
        cwd: workspace,
        root: workspace
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
