/**
 * npm publication targets.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ExecIrreversible } from "./Changesets.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link NpmPublish}. `dryRun` defaults to true, so a real
 * publish is always an explicit opt-out in PACKAGE.ts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  packageJson: Input.File,
  artifacts: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  registry: Schema.NonEmptyString,
  access: Schema.Literals(["public", "restricted"]),
  provenance: Schema.Boolean,
  tag: Schema.NonEmptyString,
  dryRun: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
})

/**
 * Attributes for {@link NpmPublish}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans npm publication after versioning, build, and package validation deps.
 *
 * The body plans one `pnpm publish` in the directory of the declared
 * manifest, through {@link ExecIrreversible}: publication changes external
 * registry state, so it is irreversible tier and never cacheable. Registry,
 * access, and dist-tag come from attrs and land on argv; they mirror the
 * generated manifest's publishConfig, which pnpm reads from the manifest
 * itself. Provenance rides the environment so the attr wins over a stale
 * manifest or an inherited configuration: `false` is spelled out, never left
 * to the manager's default, and both `npm_config_provenance` (npm, pnpm 10)
 * and `pnpm_config_provenance` (pnpm 11) carry it. Git checks are disabled: tree policy
 * belongs to the release pipeline, not the publish step. `dryRun` defaults
 * to true and appends `--dry-run`. Key material records the manifest and
 * artifact digests, dependency keys, registry, access, provenance, tag, and
 * dry-run policy. Publication follows `npm publish` and Changesets prior
 * art and runs before JSR publication. Its `run` verb gate rejects inclusion
 * in build, test, and lint graphs, including through dependencies. Executing
 * the plan requires {@link ExecIrreversibleLive} from the Changesets module.
 *
 * @category targets
 * @since 0.1.0
 */
export const NpmPublish = Target.make("NpmPublish", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: ["run"],
  implementation: (attrs, context) => {
    const argv: Array<string> = PackageManager.publish(attrs.packageManager, [
      "--registry",
      attrs.registry,
      "--access",
      attrs.access,
      "--tag",
      attrs.tag,
      "--no-git-checks"
    ])
    if (attrs.dryRun) argv.push("--dry-run")
    const provenance = String(attrs.provenance)
    return ExecIrreversible.call({
      cwd: Input.declaredDirectory(attrs.packageJson.path, context),
      argv,
      env: { npm_config_provenance: provenance, pnpm_config_provenance: provenance }
    })
  }
})
