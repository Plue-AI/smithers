/**
 * ESLint checks.
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
 * Attributes for {@link EsLint}.
 *
 * `cwd` is the workspace-relative directory the tool runs in and defaults to
 * the workspace root. Config paths and source patterns resolve from `cwd`
 * unless prefixed with `//`, which anchors them at the workspace root.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  configs: Schema.Array(Input.File),
  maxWarnings: Schema.Number,
  fix: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link EsLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Reduces declared sources to the patterns ESLint lints.
 *
 * ESLint expands glob patterns itself. Workspace-rooted paths must first be
 * rendered from the tool's cwd; the declared inputs remain unchanged for keying.
 * A file contributes its path, and a git diff contributes nothing.
 */
const lintPatterns = (cwd: string, sources: ReadonlyArray<Input.Declared>): ReadonlyArray<string> =>
  sources.flatMap((source) => source._tag === "File" ? [source.path] : source._tag === "Glob" ? [source.pattern] : [])
    .map((pattern) => Input.rootRelative(cwd, pattern))

/**
 * Plans ESLint over declared source sets.
 *
 * The body records one {@link Exec.Exec} run of `eslint` from `cwd` with the
 * first declared flat config passed as `--config`, the warning budget as
 * `--max-warnings`, and `--fix` when fix mode is enabled. Every further
 * config is declared key material for files the flat config imports. Tools
 * resolve through `pnpm exec`, matching the pnpm workspace install target.
 * Key material contains source and flat-config digests, dependency keys,
 * warning policy, and fix mode. The target remains non-cacheable in either
 * mode until the external ESLint toolchain is complete key material. The target
 * follows ESLint flat-config prior art and this repository's current package
 * lint scripts. Executing the plan requires {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const EsLint = Target.make("EsLint", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) => {
    const config = attrs.configs[0]
    return Exec.runTool({
      cwd: attrs.cwd,
      argv: PackageManager.exec(attrs.packageManager, [
        "eslint",
        ...(config === undefined ? [] : ["--config", Input.rootRelative(attrs.cwd, config.path)]),
        "--max-warnings",
        String(attrs.maxWarnings),
        ...(attrs.fix ? ["--fix"] : []),
        ...lintPatterns(attrs.cwd, attrs.sources)
      ])
    })
  }
})
