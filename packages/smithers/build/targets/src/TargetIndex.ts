/**
 * The declaration-derived target index as a checked-in file: one row per
 * labeled target, written or drift-checked as `.smithers/target-index.json`.
 *
 * A row carries only what a declaration states (the rule, the kinds, the
 * declared inputs and outputs, the labeled dependencies, the declaring file)
 * and nothing keyed on a host, so the file changes only when a declaration
 * changes. The rows are not an attr a `PACKAGE.ts` writes: the package planner
 * fills `targets` from the loaded declarations, the way `FactoryProjection`
 * carries the factory it read, so the declarations' content is key material
 * and an edit to any `PACKAGE.ts` re-keys the check.
 *
 * @since 1.0.0
 */
import type { Action } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * The workspace-relative file the index is written to.
 *
 * @category constants
 * @since 1.0.0
 */
export const indexPath = ".smithers/target-index.json"

/**
 * Output handling for the index. `check` is the default: only a target that
 * asks to `write`, or an executor run with `--write`, touches the file.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Mode = Schema.Literals(["write", "check"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("check" as const))
)

/**
 * Output handling for the index.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = typeof Mode.Type

/**
 * One declared input of an indexed target, with its path resolved from the
 * declaring package.
 *
 * This is a plain record keyed by `kind`, not the planner's tagged
 * `Input.Declared`: `Target.make` lifts every tagged input it finds anywhere
 * in a target's attrs into that target's own declared inputs, so rows shaped
 * as `Input.Declared` would key the index target on every input of every
 * target it lists. A `kind` record is data to the collector and to the file's
 * readers alike.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RowInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("glob"),
    pattern: Schema.NonEmptyString,
    exclude: Schema.Array(Schema.NonEmptyString)
  }),
  Schema.Struct({ kind: Schema.Literal("pnpm-workspace"), path: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("git-diff"),
    base: Schema.NonEmptyString,
    paths: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    added: Schema.optional(Schema.Array(Schema.NonEmptyString)),
    addedLines: Schema.optional(Schema.NonEmptyString)
  })
])

/**
 * One declared input of an indexed target.
 *
 * @category models
 * @since 1.0.0
 */
export type RowInput = typeof RowInput.Type

/**
 * One labeled target as its declaration states it.
 *
 * Paths are workspace-relative with no `//` prefix. `inputs` carries the
 * declared inputs as {@link RowInput} records with their paths resolved from
 * the declaring package. `mode` is present for the generator rules that
 * declare a `write` or `check` posture. `hosts` is present for a target
 * whose declaration restricts the hosts it runs on. `source` names the PACKAGE.ts that
 * declared the target and is absent for a synthesized target with no file.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  label: Schema.NonEmptyString,
  /** The declaring package directory, `""` for the workspace root. */
  package: Schema.String,
  /** The target name after the colon. */
  name: Schema.NonEmptyString,
  rule: Schema.NonEmptyString,
  kinds: Schema.Array(Target.Kind),
  summary: Schema.optional(Schema.String),
  featured: Schema.optional(Schema.Literal(true)),
  mode: Schema.optional(Schema.String),
  cacheable: Schema.Boolean,
  inputs: Schema.Array(RowInput),
  outputs: Schema.Array(Schema.String),
  dependencies: Schema.Array(Schema.String),
  /** The host platforms the target runs on, when its declaration restricts them. */
  hosts: Schema.optional(Schema.Array(Schema.String)),
  source: Schema.optional(Schema.Struct({ file: Schema.NonEmptyString })),
  /** Why a `Repo.Target` row resolved to nothing, when it did. */
  refusal: Schema.optional(Schema.String)
})

/**
 * One labeled target as its declaration states it.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

/**
 * Attributes for {@link TargetIndex}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attrs = Schema.Struct({
  /** The label pattern the index covers. @default "//..." */
  pattern: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("//..."))),
  /** The workspace-relative file the index is written to. @default ".smithers/target-index.json" */
  output: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(indexPath))),
  /** Whether to write the file or verify the checked-in copy. @default "check" */
  mode: Mode,
  /** The rows, sorted by label; filled by the package planner from the loaded declarations, never written in a `PACKAGE.ts`. */
  targets: Schema.optional(Schema.Array(Row))
})

/**
 * Attributes for {@link TargetIndex}.
 *
 * @category models
 * @since 1.0.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Renders the rows as the checked-in file: two-space JSON, one trailing
 * newline, the rows in the order given (the planner sorts them by label).
 *
 * @category rendering
 * @since 1.0.0
 */
export const render = (rows: ReadonlyArray<Row>): string => `${JSON.stringify(rows, null, 2)}\n`

type Requires =
  | GeneratedFile.FileRequirement
  | Action.Requirement<"smithers-build/not-implemented">

/**
 * The target index file.
 *
 * `check` is cacheable and keyed on the filled rows and the checked-in file,
 * so editing any declaration the pattern covers re-keys the check. The `lint`
 * verb maps `write` to `check`, so no lint or `ci` run mutates the file; the
 * executor's `--write` flips `check` to `write`. Outside the package planner
 * the rows are unfilled and the target plans the typed refusal.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const targetIndex = Smithers.TargetIndex({
 *   summary: "Regenerate and drift-check .smithers/target-index.json.",
 *   featured: true
 * })
 * ```
 *
 * @category targets
 * @since 1.0.0
 */
export const TargetIndex = Target.make("TargetIndex", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([GeneratedFile.WriteFileError, GeneratedFile.DriftError, Target.NotImplemented]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) => attrs.mode === "write" ? [] : [Input.file(`//${GeneratedFile.resolveOutputPath(attrs.output)}`)],
  outputs: (attrs) => ({
    cwd: ".",
    paths: attrs.mode === "write" ? [GeneratedFile.resolveOutputPath(attrs.output)] : []
  }),
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<void, GeneratedFile.WriteFileError | GeneratedFile.DriftError | Target.NotImplemented, Requires> =>
    attrs.targets === undefined
      ? Target.notImplemented("TargetIndex outside the package planner, which fills the rows")
      : GeneratedFile.generateFile(attrs.mode, {
        path: GeneratedFile.resolveOutputPath(attrs.output),
        contents: render(attrs.targets)
      })
})
