/**
 * TypeDoc API documentation generation.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

/**
 * Attributes for {@link TypedocDocs}.
 *
 * `sources`, `tsconfig`, `config`, and `entryPoints` are declared inputs.
 * `outDir` stays a string because it declares an output path rather than
 * referencing a file the target reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  config: Schema.NullOr(Input.File),
  entryPoints: Schema.Array(Input.File),
  outDir: Schema.NonEmptyString,
  plugin: Schema.Array(Schema.NonEmptyString)
})

/**
 * Attributes for {@link TypedocDocs}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans TypeDoc generation into the declared documentation directory.
 *
 * The body plans one `pnpm exec typedoc` run at the workspace root through
 * the shared sealed exec action: the declared tsconfig, the optional TypeDoc
 * options file, every plugin, and the entry points land on argv, and `--out`
 * points at `outDir`. Key material contains source, tsconfig, and TypeDoc
 * config digests, dependency keys, entry points, plugins, and output path.
 * A zero-exit TypeDoc invocation is not enough: the shared output-capture step
 * requires `outDir` to exist and records its deterministic digest. The target
 * remains non-cacheable until generated-output restoration and complete
 * external toolchain identity are wired. This models tevm's `generate:docs`
 * target and follows TypeDoc prior art. Executing the plan requires the shared
 * exec and output-capture action implementations.
 *
 * @category targets
 * @since 0.1.0
 */
export const TypedocDocs = Target.make("TypedocDocs", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  outputs: (attrs) => ({ cwd: ".", paths: [attrs.outDir] }),
  implementation: (attrs) => {
    const argv: Array<string> = PackageManager.exec(attrs.packageManager, [
      "typedoc",
      "--out",
      Input.rootRelative(".", attrs.outDir),
      "--tsconfig",
      Input.rootRelative(".", attrs.tsconfig.path)
    ])
    if (attrs.config !== null) argv.push("--options", Input.rootRelative(".", attrs.config.path))
    for (const plugin of attrs.plugin) argv.push("--plugin", plugin)
    for (const entry of attrs.entryPoints) argv.push(Input.rootRelative(".", entry.path))
    return captureOutputs(Exec.runTool({ cwd: ".", argv }), ".", [attrs.outDir])
  }
})
