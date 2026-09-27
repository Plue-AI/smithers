/**
 * Deterministic package.json ordering checks.
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
 * Attributes for {@link SortPackageJson}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. Manifest paths resolve from `cwd` when the tool runs.
 * The list is non-empty so every manifest the tool reads is declared by the
 * caller and harvested from attrs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  manifests: Schema.NonEmptyArray(Input.File),
  deps: Schema.Array(Target.Target),
  check: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link SortPackageJson}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans `sort-package-json` validation or rewriting.
 *
 * The body records one {@link Exec.Exec} run of `sort-package-json` from
 * `cwd` over every declared manifest. With `check` enabled the run passes
 * `--check` and only reports, which suits the `lint` verb; without it the
 * run rewrites the manifests in place, which suits the `build` verb and is
 * non-cacheable. Tools resolve through `pnpm exec`, matching the pnpm
 * workspace install target. Key material contains every manifest digest,
 * dependency target keys, and check-versus-write mode. Every declared
 * manifest is captured after the tool exits, so a successful subprocess can
 * never claim outputs that disappeared or became unsafe links. This follows
 * sort-package-json and tevm's root manifest ordering scripts. Executing the
 * plan requires the shared exec and output-capture implementations.
 *
 * @category targets
 * @since 0.1.0
 */
export const SortPackageJson = Target.make("SortPackageJson", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build", "lint"],
  success: Outputs,
  error: BuildError,
  cache: false,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: attrs.manifests.map((manifest) => manifest.path) }),
  // The `lint` verb never rewrites a manifest. Without this a PACKAGE.ts that
  // declared `check: false` — the rewriting form, which belongs to `build` —
  // made `smithers-build lint` and `smithers-build ci` sort every declared manifest in
  // place, so a drift that should have failed the run was repaired by the
  // run that was supposed to report it.
  attrsForKind: (kind, attrs) => kind === "lint" && !attrs.check ? { ...attrs, check: true } : attrs,
  implementation: (attrs) => {
    const manifests = attrs.manifests.map((manifest) => manifest.path)
    return captureOutputs(
      Exec.runTool({
        cwd: attrs.cwd,
        argv: PackageManager.exec(attrs.packageManager, [
          "sort-package-json",
          ...(attrs.check ? ["--check"] : []),
          ...manifests
        ])
      }),
      attrs.cwd,
      manifests
    )
  }
})
