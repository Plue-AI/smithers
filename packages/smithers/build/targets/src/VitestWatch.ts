/**
 * Interactive Vitest watch sessions.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link VitestWatch}.
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
  tests: Schema.Array(Input.Declared),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Schema.NullOr(Input.File),
  environment: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("."))
  ),
  /** Maximum run time in milliseconds. Defaults to twenty minutes. */
  timeoutMs: Exec.TimeoutMs.pipe(Schema.withConstructorDefault(Effect.succeed(1_200_000)))
})

/**
 * Attributes for {@link VitestWatch}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans an interactive Vitest watch session.
 *
 * The body records one {@link Exec.Exec} node that runs
 * `pnpm exec vitest watch` from `cwd` with the declared config and
 * environment. The spawn is a pass-through: the node succeeds when the
 * session exits cleanly and interrupting the fiber kills the process. Inputs
 * and dependency keys describe startup invalidation, but the target is
 * non-cacheable because it is a long-lived process. This follows Vitest watch
 * mode and tevm's `test:watch` target. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const VitestWatch = Target.make("VitestWatch", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      timeoutMs: attrs.timeoutMs,
      argv: PackageManager.exec(attrs.packageManager, [
        "vitest",
        "watch",
        ...(attrs.config === null ? [] : ["--config", attrs.config.path]),
        "--environment",
        attrs.environment
      ])
    })
})
