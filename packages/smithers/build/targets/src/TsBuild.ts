/**
 * JavaScript distribution builds for TypeScript packages.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"
import { BuildError, captureOutputs, Outputs } from "./ToolBuild.ts"

/**
 * Schema for a distribution built by the TypeScript compiler.
 *
 * The tsconfig owns every emit option, so this variant carries no flags of its
 * own. It carries no `external` in particular: `tsc` resolves imports through
 * the tsconfig and has no bundle to exclude a package from, so an external list
 * declared beside it would be text that changes the key and nothing else.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TscTool = Schema.Struct({
  name: Schema.Literal("tsc")
})

/**
 * A distribution built by the TypeScript compiler.
 *
 * @category models
 * @since 0.1.0
 */
export type TscTool = typeof TscTool.Type

/**
 * Schema for a distribution built by tsup.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TsupTool = Schema.Struct({
  name: Schema.Literal("tsup"),
  /** Packages the bundle must not inline, forwarded as `--external`. */
  external: Schema.Array(Schema.NonEmptyString)
})

/**
 * A distribution built by tsup.
 *
 * @category models
 * @since 0.1.0
 */
export type TsupTool = typeof TsupTool.Type

/**
 * Schema for a distribution built by a program the package owns.
 *
 * `tsc` performs one emit per invocation, so a package that publishes both
 * module formats cannot be built by `tsc` alone: the ESM half and its
 * declarations come from one compiler run, and the CommonJS half from a second
 * pass over the same sources. This variant declares the program that runs
 * both. `entry` is a declared file, so editing the program re-keys the target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ProgramTool = Schema.Struct({
  name: Schema.Literal("program"),
  entry: Input.File
})

/**
 * A distribution built by a program the package owns.
 *
 * @category models
 * @since 0.1.0
 */
export type ProgramTool = typeof ProgramTool.Type

/**
 * Schema for the tool one distribution build runs.
 *
 * A discriminated union rather than one name and a flat bag of flags, so a
 * declaration cannot carry a flag the selected tool never reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tool = Schema.Union([TscTool, TsupTool, ProgramTool])

/**
 * The tool one distribution build runs.
 *
 * @category models
 * @since 0.1.0
 */
export type Tool = typeof Tool.Type

/**
 * Attributes for {@link TsBuild}.
 *
 * `cwd` is the workspace-relative package directory the tool runs in and
 * defaults to the workspace root, so `tsconfig`, `entries`, and `outDir`
 * stay package-relative. `tsconfig` and `entries` are declared input files;
 * `outDir` stays a string because it declares an output path rather than
 * referencing a file the target reads.
 *
 * `entries` and `format` sit beside `tool` rather than inside its `tsup`
 * variant because `PackageJson` derives a published package's `exports` from
 * the distribution layout for compiler and program builds. Tsup has no
 * declaration output and cannot supply automatic publish fields. The
 * derivation is the reason `format` is checked rather than trusted: it publishes
 * a `require` condition for every `dual` entry, so a target that declares `dual` and emits one half
 * ships a manifest whose CommonJS entry point does not exist.
 *
 * The check refuses `tsc` with `dual`. One `tsc -p` invocation emits one
 * module format, so the combination names a distribution no run of that tool
 * can produce. A package that publishes both formats declares
 * {@link ProgramTool} instead.
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
  format: Schema.Literals(["esm", "cjs", "dual"]),
  outDir: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
}).check(
  Schema.makeFilter((attrs) =>
    attrs.tool.name === "tsc" && attrs.format === "dual"
      ? "one tsc invocation emits one module format, so the tsc tool cannot produce the dual format; " +
        "declare esm or cjs, or declare a program tool that runs both passes"
      : undefined
  )
)

/**
 * Attributes for {@link TsBuild}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the distribution argv from decoded attrs at plan time.
 *
 * Installed tools resolve through the declared package manager, matching the
 * workspace install target. For `tsc` the tsconfig owns every emit option, so
 * `entries` and `outDir` stay declared key material. For `tsup` those attrs
 * map to their CLI flags. A `program` tool is the package's own build program,
 * run under the manager's runtime; the tsconfig it compiles through and the
 * `outDir` it writes to stay declared key material there too.
 */
const buildArgv = (attrs: Attrs): ReadonlyArray<string> => {
  switch (attrs.tool.name) {
    case "tsc":
      return PackageManager.exec(attrs.packageManager, ["tsc", "-p", attrs.tsconfig.path])
    case "program":
      return Runtime.run(attrs.packageManager?.runtime, [Input.rootRelative(attrs.cwd, attrs.tool.entry.path)])
    case "tsup":
      return PackageManager.exec(attrs.packageManager, [
        "tsup",
        ...attrs.entries.map((entry) => entry.path),
        "--format",
        attrs.format === "dual" ? "esm,cjs" : attrs.format,
        "--out-dir",
        attrs.outDir,
        ...attrs.tool.external.flatMap((name) => ["--external", name])
      ])
  }
}

/**
 * One format's declared output tree and publishable primary entry.
 *
 * Entry paths are package-relative. A null entry means the tool has no
 * publishable entry contract; a null declaration means it does not emit types
 * for this format. In a dual build, declarations belong to ESM only.
 *
 * @category models
 * @since 0.1.0
 */
export interface DistributionLayout {
  readonly format: "esm" | "cjs"
  readonly directory: string
  readonly entry: string | null
  readonly declaration: string | null
}

/**
 * Describes the distribution used by output capture and manifest derivation.
 *
 * Compiler and program builds use the repository's per-format layout. Tsup
 * owns a flat tree and is invoked without declaration emission, so it has no
 * publishable entry contract. Its JavaScript filenames also depend on package
 * configuration, which these attrs do not describe.
 *
 * @category rendering
 * @since 0.1.0
 */
export const distributionLayout = (attrs: Attrs): ReadonlyArray<DistributionLayout> => {
  const formats: ReadonlyArray<"esm" | "cjs"> = attrs.format === "dual" ? ["esm", "cjs"] : [attrs.format]
  const source = attrs.entries[0]
  const base = source === undefined ? undefined : NodePath.basename(source.path).replace(/\.(?:m|c)?tsx?$/, "")
  return formats.map((format) => {
    const directory = attrs.tool.name === "tsup" ? attrs.outDir : `${attrs.outDir}/${format}`
    const entry = attrs.tool.name === "tsup" || base === undefined ? null : `${directory}/${base}.js`
    return {
      format,
      directory,
      entry,
      declaration: entry === null || (attrs.format === "dual" && format === "cjs")
        ? null
        : `${directory}/${base}.d.ts`
    }
  })
}

/**
 * The output paths one distribution build must produce.
 *
 * A `tsc` or `program` build emits through a tsconfig `outDir`, which this
 * repository sets to a per-format subdirectory of the declared `outDir`, so
 * the declared `format` names exactly the subdirectories that must exist when
 * the tool exits. Capture requires every declared output, so a build that
 * claims `dual` and writes one half fails its own target instead of reaching
 * the release pack. `tsup` writes one flat tree, and its output stays the
 * declared `outDir`.
 *
 * @category rendering
 * @since 0.1.0
 */
export const outputPaths = (
  attrs: Attrs
): ReadonlyArray<string> => [...new Set(distributionLayout(attrs).map((layout) => layout.directory))]

/**
 * Builds a JavaScript distribution with `tsc -p <tsconfig>`, `tsup`, or the
 * package's own build program.
 *
 * The plan runs the selected tool in `cwd` through the shared
 * {@link Exec.runTool}, then the shared output-capture step that digests
 * {@link outputPaths} into the {@link Outputs} success payload. Source and
 * tsconfig digests are declared through the attrs, and dependency target keys,
 * entries, output format, external packages, and tool identity complete the
 * key material. This models tevm's `build:dist` target and follows tsup and
 * TypeScript project build conventions.
 *
 * The declared `format` is produced, not asserted in prose: it selects the
 * output paths capture requires, so a target that declares `dual` and emits
 * only ESM fails.
 *
 * @category targets
 * @since 0.1.0
 */
export const TsBuild = Target.make("TsBuild", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: outputPaths(attrs) }),
  implementation: (attrs) =>
    captureOutputs(
      Exec.runTool({ cwd: attrs.cwd, argv: buildArgv(attrs) }),
      attrs.cwd,
      outputPaths(attrs)
    )
})
