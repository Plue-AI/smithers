/**
 * Non-watch Vitest runs.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Vitest}.
 *
 * `cwd` is the workspace-relative directory the runner starts in and defaults
 * to the workspace root. The `config` path resolves from `cwd` when the tool
 * runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  /**
   * The interpreter the runner runs under, when it is not the workspace's.
   *
   * A declaration overrides the interpreter by naming it here rather than by
   * restating a package manager: Bun is its own manager, so
   * `runtime: S.Runtime.Bun({ ... })` is the whole override. Omitted, the
   * executor fills in the workspace runtime and the run goes through the
   * workspace package manager.
   */
  runtime: Schema.optional(Runtime.Runtime),
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  environment: Schema.NonEmptyString,
  passWithNoTests: Schema.Boolean,
  /** Whether this target requires explicit selection and runs alone in the executor. */
  exclusive: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  /**
   * Whether the run may compute coverage. `false` renders
   * `--coverage.enabled=false`, which a config with coverage enabled needs on a
   * host whose engine has no V8 inspector — Bun runs JavaScriptCore, and
   * `@vitest/coverage-v8` cannot attach there.
   *
   * @default true
   */
  coverage: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  ),
  /**
   * How long the run may take before the tool is killed.
   *
   * The exec default of ten minutes is measured against a developer machine
   * and leaves a large suite no headroom on a hosted runner. `packages/smithers`
   * takes 142 s here and 600.4 s on a two-core runner, which is 4.2 times
   * slower and exactly the ten-minute cap, so the target died rather than
   * reporting. Twenty minutes is above that with room and still bounds a hang,
   * which does not finish at any budget. A package that wants a tighter bound
   * sets its own.
   *
   * @default 1_200_000
   */
  timeoutMs: Exec.TimeoutMs.pipe(Schema.withConstructorDefault(Effect.succeed(1_200_000)))
})

/**
 * Attributes for {@link Vitest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans a non-watch `vitest run` test target.
 *
 * The body records one {@link Exec.Exec} node that runs
 * `pnpm exec vitest run` from `cwd` with the declared config, environment,
 * and empty-suite policy. Test, source, and config declarations are the
 * target's inputs, so key material contains their digests plus dependency
 * target keys. This models tevm's `test:run` target and Vitest's
 * deterministic run mode. Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Vitest = Target.make("Vitest", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager", "runtime"],
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      timeoutMs: attrs.timeoutMs,
      argv: PackageManager.exec(PackageManager.under(attrs.packageManager, attrs.runtime), [
        "vitest",
        "run",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--environment",
        attrs.environment,
        ...(attrs.coverage ? [] : ["--coverage.enabled=false"]),
        ...(attrs.passWithNoTests ? ["--passWithNoTests"] : [])
      ])
    })
})
