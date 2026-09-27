/**
 * Generated TypeScript configuration.
 *
 * A `tsconfig.json` decides what the compiler reads and what it emits, which
 * makes it part of the build definition. Leaving it hand-maintained next to a
 * PACKAGE.ts file that declares the same sources means two descriptions of one
 * thing, free to disagree. This target makes PACKAGE.ts the only description: the
 * file is rendered from attrs, and `check` mode fails when the checked-in copy
 * has drifted.
 *
 * Include and exclude take the file inputs a declaration already writes —
 * {@link Input.Glob} and {@link Input.File} — beside plain tsconfig patterns,
 * so one file set is spelled one way. Each entry renders to its pattern text:
 * a glob's pattern, a file's path, and a `//`-rooted path rewritten relative
 * to `cwd` the way `extends` is.
 *
 * The declarations stay out of the target's digested inputs, and the rule
 * resolves each one to its text before the target is constructed, which is
 * what keeps them out. A generator's output depends on the pattern text, not
 * on which files currently match it: keying this target on matched files would
 * make the config regenerate whenever any source file changed, while changing
 * nothing about the bytes it writes. A glob's own `exclude` list is dropped
 * for the same reason it is not key material — tsconfig has no per-pattern
 * exclusion, and the file's `exclude` section is the place to say it.
 *
 * A `Filegroup` target is not an include member. A group names files rather
 * than patterns: expanding one would put a build edge and a digested file set
 * on a target whose bytes are pattern text, and a group whose `srcs` name
 * another target would silently contribute nothing.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as ManifestJson from "./ManifestJson.ts"
import * as Target from "./Target.ts"

/** The directory a declaration's paths resolve against when it names none. */
const defaultCwd = "."

/**
 * One `include` or `exclude` entry: a tsconfig pattern, a declared glob, or a
 * declared file.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Pattern = Schema.Union([Schema.NonEmptyString, Input.Glob, Input.File])

/**
 * One `include` or `exclude` entry.
 *
 * @category models
 * @since 0.1.0
 */
export type Pattern = typeof Pattern.Type

/**
 * Renders one entry as the pattern text tsconfig reads.
 *
 * A glob contributes its pattern and a file its path; both are then spelled
 * the way a config written into `cwd` needs, so a workspace-rooted `//`
 * declaration names the same file the planner would have resolved it to. The
 * `./` prefix `extends` carries is deliberately absent: the compiler resolves
 * a bare `extends` as a package name but reads an include pattern as a path,
 * and adding the prefix would rewrite every checked-in config.
 *
 * @category constructors
 * @since 0.1.0
 */
export const patternText = (cwd: string, pattern: Pattern): string =>
  Input.rootRelative(
    cwd,
    typeof pattern === "string" ? pattern : pattern._tag === "Glob" ? pattern.pattern : pattern.path
  )

/**
 * Attributes for {@link Tsconfig}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  /** Where the file is written, relative to `cwd`. @default "tsconfig.json" */
  path: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("tsconfig.json"))
  ),
  /** The base configuration this one extends, or `null`. @default null */
  extends: Schema.NullOr(Input.File).pipe(
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
  /** Compiler options, rendered verbatim. @default {} */
  compilerOptions: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
  ),
  /** Include patterns, declared globs, or declared files. @default [] */
  include: Schema.Array(Pattern).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Pattern>>([]))
  ),
  /** Exclude patterns, declared globs, or declared files. @default [] */
  exclude: Schema.Array(Pattern).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Pattern>>([]))
  ),
  /** Project references. @default [] */
  references: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([]))
  ),
  /** Whether to write the file or verify the checked-in copy. @default "check" */
  mode: Schema.Literals(["write", "check"]).pipe(
    Schema.withConstructorDefault(Effect.succeed("check" as const))
  ),
  /** The directory the path resolves against. @default "." */
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(defaultCwd)))
})

/**
 * Attributes for {@link Tsconfig}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Renders the file contents for one declaration.
 *
 * Key order is fixed rather than alphabetical, matching how the compiler's own
 * documentation orders the sections, so a generated file reads like a
 * hand-written one and a diff against the checked-in copy is legible. The
 * trailing newline is deliberate: a file without one is a diff every editor
 * offers to fix.
 *
 * @category constructors
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  const options = ManifestJson.cloneObject(attrs.compilerOptions, "Tsconfig compilerOptions")
  const document: Record<string, ManifestJson.Value> = {}
  if (attrs.extends !== null) document["extends"] = relative(attrs.cwd, attrs.extends.path)
  if (Object.keys(options).length > 0) document["compilerOptions"] = options
  if (attrs.include.length > 0) {
    document["include"] = attrs.include.map((entry) => patternText(attrs.cwd, entry))
  }
  if (attrs.exclude.length > 0) {
    document["exclude"] = attrs.exclude.map((entry) => patternText(attrs.cwd, entry))
  }
  if (attrs.references.length > 0) {
    document["references"] = attrs.references.map((path) => ({ path }))
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Spells a declared path the way a tsconfig `extends` needs it.
 *
 * The compiler resolves a bare specifier as a package name, so a sibling file
 * has to carry an explicit relative prefix. A workspace-rooted `//` path is
 * rewritten relative to the directory the generated file is written into, not
 * merely stripped of its anchor: `//tsconfig.base.json` written under
 * `packages/foo` is `../../tsconfig.base.json`, and stripping alone would name
 * a sibling that is not there.
 */
const relative = (cwd: string, path: string): string => {
  const stripped = Input.rootRelative(cwd, path)
  return stripped.startsWith("./") || stripped.startsWith("../") ? stripped : `./${stripped}`
}

const definition = Target.make("Tsconfig", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([GeneratedFile.WriteFileError, GeneratedFile.DriftError]),
  cache: false,
  outputs: (attrs) => attrs.mode === "write" ? { cwd: attrs.cwd, paths: [attrs.path] } : { cwd: attrs.cwd, paths: [] },
  // The check verb reads the checked-in file and writes nothing, so it is safe
  // in a lint graph; the write verb is what a build graph runs.
  attrsForKind: (kind, attrs) => kind === "lint" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (attrs) =>
    GeneratedFile.generateFile(attrs.mode, {
      path: attrs.cwd === "." ? attrs.path : `${attrs.cwd}/${attrs.path}`,
      contents: render(attrs)
    })
})

/**
 * Resolves every declared `include` and `exclude` entry to its pattern text.
 *
 * This runs before {@link Target.make}'s own attr walk, which is the whole
 * point: that walk records every declared input it finds anywhere in attrs, so
 * a glob left in place would be expanded and digested, and the config would
 * re-key whenever a matched file changed. Resolving first leaves the target
 * keyed on the text it writes, which is the only thing its bytes depend on.
 */
const resolveDeclarations = (
  attrs: (typeof Attrs)["~type.make.in"]
): (typeof Attrs)["~type.make.in"] => {
  // Target.guard has already rejected proxies, accessors and custom
  // prototypes and supplied a plain-data snapshot. Normalize that snapshot;
  // do not maintain a second, unreachable declaration-validation path here.
  const cwd = attrs.cwd ?? defaultCwd
  const text = (entries: ReadonlyArray<(typeof Pattern)["~type.make.in"]>): ReadonlyArray<string> =>
    entries.map((entry) => patternText(cwd, Pattern.make(entry)))
  return {
    ...attrs,
    ...(attrs.include === undefined ? {} : { include: text(attrs.include) }),
    ...(attrs.exclude === undefined ? {} : { exclude: text(attrs.exclude) })
  }
}

/**
 * Generates and drift-checks a `tsconfig.json`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const tsconfig = Smithers.Tsconfig({
 *   extends: Smithers.file("tsconfig.base.json"),
 *   compilerOptions: { noEmit: true, module: "NodeNext" },
 *   include: [Smithers.glob("packages/*\/src/**\/*"), Smithers.file("PACKAGE.ts")]
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Tsconfig = Target.guard(
  Target.rule(
    definition,
    (attrs: (typeof Attrs)["~type.make.in"] & Target.Presentation): ReturnType<typeof definition> =>
      definition(resolveDeclarations(attrs))
  ),
  // The existing guard snapshots nested inputs before normalization reads
  // their patterns. Normalization itself supplies no additional validation.
  () => {}
)
