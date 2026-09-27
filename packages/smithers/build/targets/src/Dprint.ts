/**
 * dprint formatting checks.
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
 * Attributes for {@link Dprint}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. `config` is the dprint configuration file; the tool
 * discovers the files it checks from that configuration, so `sources` exists
 * purely as declared key material for the files a formatting verdict depends
 * on. Config paths resolve from `cwd` unless prefixed with `//`, which anchors
 * them at the workspace root.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  config: Input.File,
  fix: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Dprint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.
 *
 * The plan records one {@link Exec.Exec} run of `dprint` from `cwd` with the
 * declared configuration passed as `--config`, mirroring the repository's
 * package lint scripts (`... && dprint check`). Key material contains the
 * source and configuration digests, dependency keys, and the fix mode. The
 * target remains non-cacheable until the external dprint toolchain is
 * complete key material, matching {@link EsLint}'s posture. Executing the
 * plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Dprint = Target.make("Dprint", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "dprint",
        attrs.fix ? "fmt" : "check",
        "--config",
        Input.rootRelative(attrs.cwd, attrs.config.path)
      ])
    })
})
