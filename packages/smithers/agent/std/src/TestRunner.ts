/**
 * The repository's own test invocation, declared once by the host.
 *
 * Every repository already knows how to run its tests, and the harness is told
 * so at setup. What the measured program shows is what happens when that fact
 * is not a *callable* thing: agents guess labels
 * (`management_commands.test_flush`, `tests/related_lookup`, `test_axis.py` —
 * none of which exist), and a guessed label costs a frame each time. Seven such
 * invocations are documented across the 45 instances.
 *
 * So the invocation is a declaration, not a parameter: a caller of the `test`
 * flow selects *which* tests, never *how* to run them.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer } from "effect"
import * as StdError from "./StdError.ts"

/**
 * The default ref naming a tree as it stood before the agent touched it.
 *
 * The engine records the pristine checkout under this ref, so a baseline run
 * reuses what already exists instead of inventing a second notion of "base".
 *
 * @category constants
 * @since 1.0.0
 */
export const captureBase = "refs/flows/capture-base"

/**
 * How this repository runs its tests.
 *
 * `cwd` is where the runner runs, and `root` is the host directory holding the
 * git repository. They differ exactly when the runner runs in a container: the
 * container sees the repository at `cwd`, the host sees it at `root`, and a
 * baseline worktree created at `<root>/<name>` is visible to the runner at
 * `<cwd>/<name>` because it is the same directory under two names.
 *
 * @category models
 * @since 1.0.0
 */
export interface Runner {
  /** The runner command line, without any test selection. */
  readonly command: string
  /** Where the runner runs; the container's path when `container` is set. */
  readonly cwd?: string | undefined
  /** The host path of the repository, when it differs from `cwd`. */
  readonly root?: string | undefined
  /** A container to route the run through, via the `Container` transport. */
  readonly container?: string | undefined
  /** Environment the runner needs. */
  readonly env?: Record<string, string> | undefined
  /** The ref whose commit is the pristine base; defaults to {@link captureBase}, then HEAD. */
  readonly baseRef?: string | undefined
  /** Default wall-clock budget for one run. */
  readonly timeoutMs?: number | undefined
}

/**
 * The declaration service.
 *
 * @category services
 * @since 1.0.0
 */
export interface TestRunner {
  readonly declared: Effect.Effect<Runner, StdError.StdError>
}

/**
 * The {@link TestRunner} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const TestRunner: Context.Service<TestRunner, TestRunner> = Context.Service("@smthrs/std/TestRunner")

/**
 * Declares one repository's runner.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (runner: Runner): TestRunner => TestRunner.of({ declared: Effect.succeed(runner) })

/**
 * Declares that this host knows of no runner.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (): TestRunner =>
  TestRunner.of({
    declared: Effect.fail(
      new StdError.StdError({
        code: "provider_unavailable",
        message:
          "No test runner is declared for this repository, so there is nothing for the test flow to run. Use bash with the command this project's own documentation gives."
      })
    )
  })

/**
 * Provides {@link make}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (runner: Runner): Layer.Layer<TestRunner> => Layer.succeed(TestRunner, make(runner))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop: Layer.Layer<TestRunner> = Layer.succeed(TestRunner, makeNoop())
