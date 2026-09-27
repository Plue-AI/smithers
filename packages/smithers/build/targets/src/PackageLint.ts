/**
 * Published package surface checks.
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link PackageLint}.
 *
 * `cwd` is the workspace-relative package directory both tools lint and
 * defaults to the workspace root. The built artifacts arrive through `deps`
 * edges, so `packageJson` and `artifacts` are declared key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  packageJson: Input.File,
  artifacts: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  strict: Schema.Boolean,
  pack: Schema.Boolean,
  attw: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link PackageLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Result of one package surface check: the publint exec result plus the
 * arethetypeswrong exec result, `null` when the attrs disabled it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageReport = Schema.Struct({
  publint: Exec.Result,
  attw: Schema.NullOr(Exec.Result)
})

/**
 * Result of one package surface check.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageReport = typeof PackageReport.Type

/**
 * Plans publint and optional packed-tarball type checks.
 *
 * The body records one {@link Exec.Exec} run of `publint` against `cwd`,
 * reporting warnings as errors when `strict` is enabled and reading the
 * directory as-is with `--pack false` when `pack` is disabled. When `attw`
 * is enabled a second run records `attw --pack .`, which packs the package
 * and checks the tarball's types. Tools resolve through `pnpm exec`,
 * matching the pnpm workspace install target. Key material contains the
 * manifest, built artifact digests, dependency target keys, strictness,
 * pack policy, and arethetypeswrong policy. This models tevm's
 * `lint:package` target and follows publint and attw prior art. Executing
 * the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const PackageLint = Target.make("PackageLint", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["lint"],
  success: PackageReport,
  error: Exec.ExecError,
  implementation: (attrs) => {
    const publint = Exec.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "publint",
        ...(attrs.strict ? ["--strict"] : []),
        ...(attrs.pack ? [] : ["--pack", "false"])
      ])
    })
    if (!attrs.attw) {
      return publint.pipe(Node.map((result) => ({ publint: result, attw: null })))
    }
    return publint.pipe(
      Node.bindPlanned((publint) =>
        Exec.runTool({
          cwd: attrs.cwd,
          argv: PackageManager.exec(attrs.packageManager, ["attw", "--pack", "."]),
          after: publint
        }).pipe(Node.bindPlanned((attw) => Node.succeed({ publint, attw })))
      )
    )
  }
})
