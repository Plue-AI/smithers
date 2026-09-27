/**
 * TypeScript declaration builds.
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
 * Schema for declarations emitted by the TypeScript compiler.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TscTool = Schema.Struct({
  name: Schema.Literal("tsc"),
  /**
   * Whether the emit carries `.d.ts.map` files. Forced onto the compiler
   * explicitly, so the emitted tree matches the declared policy whatever the
   * tsconfig says.
   */
  declarationMap: Schema.Boolean
})

/**
 * Declarations emitted by the TypeScript compiler.
 *
 * @category models
 * @since 0.1.0
 */
export type TscTool = typeof TscTool.Type

/**
 * Schema for declarations emitted by tsup.
 *
 * tsup emits no declaration maps, so this variant carries no map policy: a
 * `declarationMap` declared beside `--dts-only` would be a policy nothing
 * enforces.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TsupTool = Schema.Struct({
  name: Schema.Literal("tsup")
})

/**
 * Declarations emitted by tsup.
 *
 * @category models
 * @since 0.1.0
 */
export type TsupTool = typeof TsupTool.Type

/**
 * Schema for the tool one declaration build runs.
 *
 * A discriminated union rather than one name and a flat bag of flags, so a
 * declaration cannot carry a flag the selected tool never reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tool = Schema.Union([TscTool, TsupTool])

/**
 * The tool one declaration build runs.
 *
 * @category models
 * @since 0.1.0
 */
export type Tool = typeof Tool.Type

/**
 * Attributes for {@link DtsBuild}.
 *
 * `cwd` is the workspace-relative package directory the tool runs in and
 * defaults to the workspace root, so `tsconfig`, `entries`, and `outDir`
 * stay package-relative. `tsconfig` and `entries` are declared input files;
 * `outDir` stays a string because it declares an output path rather than
 * referencing a file the target reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  srcs: Schema.Array(Input.Declared),
  entries: Schema.Array(Input.File),
  deps: Schema.Array(Target.Target),
  tsconfig: Input.File,
  tool: Tool,
  outDir: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link DtsBuild}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the declaration-emit argv from decoded attrs at plan time.
 *
 * Tools resolve through `pnpm exec`, matching the pnpm workspace install
 * target. For `tsc` the tsconfig owns the destination and `outDir` stays the
 * declared capture path.
 */
const declarationArgv = (attrs: Attrs): ReadonlyArray<string> =>
  attrs.tool.name === "tsc"
    ? PackageManager.exec(attrs.packageManager, [
      "tsc",
      "-p",
      attrs.tsconfig.path,
      "--declaration",
      "--emitDeclarationOnly",
      "--declarationMap",
      attrs.tool.declarationMap ? "true" : "false"
    ])
    : PackageManager.exec(attrs.packageManager, [
      "tsup",
      ...attrs.entries.map((entry) => entry.path),
      "--dts-only",
      "--out-dir",
      attrs.outDir
    ])

/**
 * Emits type declarations with `tsc --emitDeclarationOnly` or
 * `tsup --dts-only`.
 *
 * The plan runs the selected tool in `cwd` through the shared
 * {@link Exec.runTool}, then the shared output-capture step that digests
 * `outDir` into the {@link Outputs} success payload. Source and tsconfig
 * digests are declared through the attrs, and dependency target keys, entries,
 * declaration-map policy, output directory, and tool identity complete the
 * key material. This models tevm's `build:types` target and TypeScript
 * declaration emit.
 *
 * @category targets
 * @since 0.1.0
 */
export const DtsBuild = Target.make("DtsBuild", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: [attrs.outDir] }),
  implementation: (attrs) =>
    captureOutputs(
      Exec.runTool({ cwd: attrs.cwd, argv: declarationArgv(attrs) }),
      attrs.cwd,
      [attrs.outDir]
    )
})
