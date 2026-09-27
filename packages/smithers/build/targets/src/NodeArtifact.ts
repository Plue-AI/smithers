/**
 * Derived file and compatibility targets used by Node workspaces.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/** Attrs for copying one file artifact.
 *
 * @category targets
 * @since 0.1.0
 */
export const CopyAttrs = Schema.Struct({
  from: Schema.Union([Target.Target, Input.File]),
  to: Schema.NonEmptyString
})
const copyDefinition = Target.make("Copy", {
  attrs: CopyAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Copy")
})
/** Copies one declared artifact or file-producing target to a path.
 *
 * @category targets
 * @since 0.1.0
 */
export const Copy = copyDefinition

/** Attrs for materializing literal text.
 *
 * @category targets
 * @since 0.1.0
 */
export const LiteralAttrs = Schema.Struct({
  path: Schema.NonEmptyString,
  content: Schema.String
})
const literalDefinition = Target.make("Literal", {
  attrs: LiteralAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Literal")
})
/** Materializes fixed bytes at a declared path.
 *
 * @category targets
 * @since 0.1.0
 */
export const Literal = literalDefinition

/** Attrs for a derived overlay file set.
 *
 * @category targets
 * @since 0.1.0
 */
export const OverlayAttrs = Schema.Struct({
  base: Target.Target,
  replace: Schema.Record(Schema.String, Input.File)
})
const overlayDefinition = Target.make("Overlay", {
  attrs: OverlayAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Overlay")
})
/** A derived file set with selected members replaced.
 *
 * @category targets
 * @since 0.1.0
 */
export const Overlay = overlayDefinition

/** Attrs for Markdown fenced code extraction.
 *
 * `file` is the page whose fences compile. `context` lists other pages whose
 * titled fences are written beside this page's files before compiling, for a
 * page that continues another page's project (`import "./engine.ts"` where a
 * previous tutorial created `engine.ts`). Context fences are inputs, not
 * blocks: they are never judged on their own, only reached through imports.
 *
 * @category targets
 * @since 0.1.0
 */
export const CodeBlocksAttrs = Schema.Struct({
  file: Input.File,
  lang: Schema.Array(Schema.NonEmptyString),
  context: Schema.optional(Schema.Array(Input.File))
})
const codeBlocksDefinition = Target.make("Markdown.CodeBlocks", {
  attrs: CodeBlocksAttrs,
  kinds: ["build", "test"],
  cache: true,
  implementation: () => Target.notImplemented("Markdown.CodeBlocks")
})
/** Extracts and validates fenced source blocks from one Markdown file.
 *
 * Every fence in one of `lang` becomes a scratch file under the declaring
 * package and compiles with `tsc --strict`. The fence's info string steers
 * how:
 *
 * - `title="<path>"` (Expressive Code syntax) names the file the fence is or
 *   extends. Fences on one page with the same title concatenate in document
 *   order into one file at that relative path, so a tutorial that grows
 *   `greeting.ts` across three fences compiles as one module and another
 *   titled fence's `import "./greeting.ts"` resolves. A directory-qualified
 *   title (`src/greeting.ts`) lands at that path.
 * - `fragment` marks a fence that is not a compilable unit (the middle of a
 *   function, an edit to an earlier declaration). The lane skips it and
 *   counts it in the report. Use it sparingly: a skipped fence can teach an
 *   API that does not ship.
 * - An untitled fence compiles standalone as `block-N.ts`.
 *
 * @category targets
 * @since 0.1.0
 */
export const CodeBlocks = codeBlocksDefinition

/** Attrs for declaration compatibility checking.
 *
 * @category targets
 * @since 0.1.0
 */
export const ApiCompatAttrs = Schema.Struct({
  baseline: Target.Target,
  surface: Target.Target,
  manifest: Input.File
})
const apiCompatDefinition = Target.make("Api.Compat", {
  attrs: ApiCompatAttrs,
  kinds: ["test"],
  cache: true,
  implementation: Target.catalogNotImplemented
})
/** Checks that a declaration delta is covered by the manifest version.
 *
 * @category targets
 * @since 0.1.0
 */
export const Compat = apiCompatDefinition

/** Attrs for package size budgets.
 *
 * @category targets
 * @since 0.1.0
 */
export const SizeBudgetsAttrs = Schema.Struct({
  manifest: Input.File,
  data: Schema.optional(Attr.Data)
})
const sizeBudgetsDefinition = Target.make("Size.Budgets", {
  attrs: SizeBudgetsAttrs,
  kinds: ["test"],
  cache: true,
  implementation: () => Target.notImplemented("Size.Budgets")
})
/** Runs every size budget declared by a package manifest.
 *
 * @category targets
 * @since 0.1.0
 */
export const Budgets = sizeBudgetsDefinition
