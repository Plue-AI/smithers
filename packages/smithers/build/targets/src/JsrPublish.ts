/**
 * JSR publication targets.
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
 * Schema for one exact release of the `jsr` CLI: three dot-separated numbers
 * with an optional prerelease suffix. Ranges, dist-tags, and anything a shell
 * could read as more than one word are refused, so the pin names one
 * immutable registry release.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CliVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\s\S])/)
)

/**
 * Attributes for {@link JsrPublish}. `dryRun` defaults to true, so a real
 * publish is always an explicit opt-out in PACKAGE.ts. `cliVersion`
 * is required: the publish command downloads the `jsr` CLI through `dlx`,
 * and an unpinned name would execute whatever the registry serves at run
 * time.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  config: Input.File,
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  package: Schema.NonEmptyString,
  cliVersion: CliVersion,
  allowDirty: Schema.Boolean,
  dryRun: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
})

/**
 * Attributes for {@link JsrPublish}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans JSR publication after npm publication and shared release deps.
 *
 * The body plans one `pnpm dlx jsr@<cliVersion> publish` in the directory of
 * the declared JSR config, through {@link ExecIrreversible}: publication
 * changes external registry state, so it is irreversible tier and never
 * cacheable. `cliVersion` pins the CLI release `dlx` fetches, so a publish
 * (dry run included) never executes an unpinned download. The `package` attr
 * is the published identity and stays key material; jsr reads the name from
 * the config file. `allowDirty` appends `--allow-dirty`. `dryRun` defaults to
 * true and appends `--dry-run`. Key material records JSR config and source
 * digests, dependency keys, package identity, the CLI pin, dirty-tree policy,
 * and dry-run policy. This models tevm's dual npm and JSR
 * release and follows `jsr publish`. Its `run` verb gate rejects inclusion in
 * build, test, and lint graphs, including through dependencies. Executing the
 * plan requires {@link ExecIrreversibleLive} from the Changesets module.
 *
 * @category targets
 * @since 0.1.0
 */
export const JsrPublish = Target.make("JsrPublish", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: ["run"],
  implementation: (attrs, context) => {
    const argv: Array<string> = PackageManager.dlx(attrs.packageManager, [`jsr@${attrs.cliVersion}`, "publish"])
    if (attrs.allowDirty) argv.push("--allow-dirty")
    if (attrs.dryRun) argv.push("--dry-run")
    return ExecIrreversible.call({
      cwd: Input.declaredDirectory(attrs.config.path, context),
      argv
    })
  }
})
