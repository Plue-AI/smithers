/**
 * The lockfile target.
 *
 * A lockfile is a generated file like any other: it is rendered from declared
 * inputs (the workspace manifests) and checked in. What is unusual is only who
 * renders it. The renderer is the package manager itself, because resolution
 * is the manager's job and no second resolver should exist. This target
 * therefore plans one manager command rather than a render function:
 * `--lockfile-only` resolves and writes without linking a tree.
 *
 * The {@link Install} target consumes the result. Depending on this target is
 * what orders regeneration before installation; the lockfile's content
 * reaches the install key through the install target's own declared inputs, so
 * a regenerated lockfile invalidates the install even though the same file is
 * this target's output.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

/**
 * Attributes for {@link Lockfile}.
 *
 * `manifests` are the target's declared inputs: a change to any of them
 * marks the lockfile affected. They do not select what the manager resolves.
 * The manager reads the workspace it finds in `cwd` (its root manifest and
 * workspace file), so the declaration must cover every manifest that
 * workspace includes. The default is the conventional workspace package glob;
 * a workspace with more layout declares its own, for example
 * `S.pnpmWorkspace("//pnpm-workspace.yaml")`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  /**
   * The file the manager writes, relative to `cwd`.
   *
   * A target's output tree is fixed when the declaration is evaluated, and the
   * workspace declaration is not read until the graph is planned, so a
   * declaration that leaves the manager to the workspace names the file it
   * expects instead. With a manager declared it defaults to the file that
   * manager writes.
   */
  lockfilePath: Schema.optional(Schema.NonEmptyString),
  /**
   * The manifests whose change marks the lockfile affected. They must cover
   * every manifest the manager reads from the workspace in `cwd`; they do not
   * narrow resolution.
   *
   * @default the workspace package glob
   */
  manifests: Schema.Array(Input.Declared).pipe(
    Schema.withConstructorDefault(
      Effect.succeed<ReadonlyArray<Input.Declared>>([Input.glob("packages/*/package.json")])
    )
  ),
  /**
   * The target that generates the workspace definition, or `null` when it is
   * hand-written. Resolution reads the workspace file, so a regenerated
   * definition must land before the manager runs; depending on the target is
   * what orders the two.
   *
   * @default null
   */
  workspace: Schema.NullOr(Target.Target).pipe(
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
  /** The directory the manager runs in. @default the workspace root */
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link Lockfile}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** The lockfile this declaration writes: the declared path, else the manager's. */
const lockfilePathOf = (attrs: Attrs): string => attrs.lockfilePath ?? PackageManager.lockfileName(attrs.packageManager)

/**
 * Regenerates the declared manager's lockfile without linking a tree.
 *
 * Resolution reaches the network and writes a file, so the target is never
 * cacheable: a replayed success would report a lockfile without having
 * produced one. The target participates in `build`, so the graph that builds
 * the workspace also keeps the lockfile current, and {@link Install} depends
 * on it so a stale lockfile is never linked from.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // The manager comes from the workspace declaration; the file it writes is
 * // named here because a target's output tree is fixed before any workspace
 * // declaration has been read.
 * export const lockfile = Smithers.Lockfile({ lockfilePath: "pnpm-lock.yaml" })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Lockfile = Target.make("Lockfile", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  cache: false,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: [lockfilePathOf(attrs)] }),
  implementation: (attrs) =>
    captureOutputs(
      Exec.runTool({
        cwd: attrs.cwd,
        argv: PackageManager.install(attrs.packageManager, {
          frozen: false,
          lockfileOnly: true
        })
      }),
      attrs.cwd,
      [lockfilePathOf(attrs)]
    )
})
