/**
 * PACKAGE.ts as the source of truth for `package.json`.
 *
 * A package declares one value:
 *
 * ```ts
 * export const packageJson = PackageJson({
 *   name: "@smthrs/targets",
 *   version: "0.1.0",
 *   template,
 *   scripts: { build: lib, test },
 *   publish: { entry: lib }
 * })
 * ```
 *
 * The workspace index turns that one declaration into three targets —
 * `packageJsonCheck`, `packageJsonWrite`, and `packageJsonRefresh` — because
 * checking a manifest, rewriting it, and asking a model to rewrite its prose
 * fields are three verbs with three different safety properties. See
 * {@link targets}.
 *
 * This subsumes the former `PackageJsonGen` target, whose attrs restated in
 * PACKAGE.ts what the build targets already knew: the entry points, the output
 * layout, and the commands. Nothing here is restated. Entry points are derived
 * from the publish target's own attrs, and a script's command is derived from
 * the label the workspace resolves for the target it names.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Config from "./Config.ts"
import {
  checkGeneratedFile,
  DriftError,
  failureMessage,
  resolveOutputPath,
  WriteFileError,
  writeGeneratedFile
} from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import { promptEngine } from "./LlmLint.ts"
import * as ManifestJson from "./ManifestJson.ts"
import { Engine } from "./ModelEngine.ts"
import { assertNotManagerOwned, isTemplate, managerOwnedFields, type Template } from "./PackageJsonTemplate.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"
import * as TsBuild from "./TsBuild.ts"

/**
 * The SPDX identifiers a package may declare, `MIT` by default.
 *
 * The union is deliberately the common set rather than the full SPDX list: a
 * literal union is what turns a typo into a type error on the PACKAGE.ts line
 * that made it. A repository needing an identifier outside this set declares
 * it through `fields` and accepts that it is unvalidated.
 *
 * @category schemas
 * @since 0.1.0
 */
export const License = Schema.Literals([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "LGPL-3.0-only",
  "GPL-2.0-only",
  "GPL-3.0-only",
  "AGPL-3.0-only",
  "Unlicense",
  "CC0-1.0",
  "UNLICENSED"
]).pipe(Schema.withConstructorDefault(Effect.succeed("MIT" as const)))

/**
 * The SPDX identifiers a package may declare.
 *
 * @category models
 * @since 0.1.0
 */
export type License = typeof License.Type

/**
 * The license a declaration carries when it does not name one.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultLicense: License = "MIT"

/**
 * The prose fields a model may write.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GeneratedField = Schema.Literals(["description", "keywords"])

/**
 * The prose fields a model may write.
 *
 * @category models
 * @since 0.1.0
 */
export type GeneratedField = typeof GeneratedField.Type

/**
 * The marker a declaration uses in place of a literal description or keyword
 * list.
 *
 * @category models
 * @since 0.1.0
 */
export interface Generated {
  readonly _tag: "smithers-build/Generated"
}

/**
 * Asks for a model-written value instead of a literal one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const generated: Generated = { _tag: "smithers-build/Generated" }

/**
 * Checks whether a declared field asked for a model-written value.
 *
 * @category guards
 * @since 0.1.0
 */
export const isGenerated = (value: unknown): value is Generated =>
  typeof value === "object" &&
  value !== null &&
  !NodeUtil.isProxy(value) &&
  Object.getOwnPropertyDescriptor(value, "_tag")?.value === "smithers-build/Generated"

/**
 * The version of the generation prompt.
 *
 * It is part of the nonhermetic cache key. Editing the prompt without moving
 * this constant would keep answering with values the previous prompt produced.
 *
 * @category constants
 * @since 0.1.0
 */
export const promptVersion = "1"

/**
 * The canonical manifest key order.
 *
 * This is `sort-package-json`'s relative order for every key this generator
 * emits, so a generated manifest is already sorted and a
 * {@link SortPackageJson} target over it passes. Keys outside the list are
 * emitted after it in UTF-16 code-unit order, which is the same on every host;
 * `localeCompare` is not, and would order two machines' manifests differently.
 *
 * @category constants
 * @since 0.1.0
 */
export const fieldOrder: ReadonlyArray<string> = [
  "name",
  "version",
  "private",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "repository",
  "funding",
  "license",
  "author",
  "maintainers",
  "contributors",
  "sideEffects",
  "type",
  "imports",
  "exports",
  "main",
  "module",
  "browser",
  "types",
  "typings",
  "bin",
  "files",
  "workspaces",
  "scripts",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
  "packageManager",
  "pnpm",
  "engines",
  "publishConfig"
]

const orderIndex = new Map(fieldOrder.map((key, index) => [key, index]))

/** Orders strings by UTF-16 code unit, which does not vary with host locale. */
const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * npm's published name grammar: an optional `@scope/` prefix, then a name of
 * URL-safe lowercase characters.
 */
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const safeExactLabel = /^\/\/[A-Za-z0-9_@+=,./-]*:[A-Za-z0-9_@+=,.-]+$/
const invalidManifestText = /[\u0000-\u001f\u007f]/

const isLicense = Schema.is(License)
const isEngine = Schema.is(Engine)
/** The accepted engines, spelled the way the refusal reads them back. */
const acceptedEngines = Engine.literals.join(" or ")

const assertVersion = (name: string, version: unknown): string => {
  if (version === "") throw new Error(`PackageJson: ${name} declares an empty version`)
  if (
    typeof version !== "string" ||
    version.length > 256 ||
    !version.isWellFormed() ||
    !semanticVersion.test(version)
  ) {
    throw new Error(`PackageJson: ${name} declares an invalid semantic version: ${JSON.stringify(version)}`)
  }
  return version
}

const assertLiteralDescription = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    invalidManifestText.test(value)
  ) {
    throw new Error("PackageJson: description must be a trimmed, well-formed string of 1 to 1024 characters")
  }
  return value
}

const assertLiteralKeywords = (value: unknown): ReadonlyArray<string> => {
  const copied = ManifestJson.cloneValue(value, "PackageJson keywords")
  if (!Array.isArray(copied) || copied.length > 256) {
    throw new Error("PackageJson: keywords must be an array of at most 256 strings")
  }
  return copied.map((member, index) => {
    if (
      typeof member !== "string" ||
      member.length === 0 ||
      member.length > 256 ||
      member !== member.trim() ||
      !member.isWellFormed() ||
      invalidManifestText.test(member)
    ) {
      throw new Error(`PackageJson: keyword ${index} must be a trimmed, well-formed string of 1 to 256 characters`)
    }
    return member
  })
}

const assertModel = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    !value.isWellFormed() ||
    invalidManifestText.test(value)
  ) {
    throw new Error("PackageJson: model must be a trimmed, well-formed string of 1 to 256 characters")
  }
  return value
}

/**
 * Validates an npm package name, or throws naming what is wrong with it.
 *
 * @category validation
 * @since 0.1.0
 */
export const assertPackageName = (name: string): string => {
  if (typeof name !== "string") throw new Error("PackageJson: the package name is not a string")
  if (name.length === 0) throw new Error("PackageJson: the package name is empty")
  if (name.length > 214) throw new Error(`PackageJson: the package name is longer than 214 characters: ${name}`)
  if (name !== name.toLowerCase()) {
    throw new Error(`PackageJson: the package name must be lowercase: ${JSON.stringify(name)}`)
  }
  if (!npmName.test(name)) {
    throw new Error(
      `PackageJson: ${JSON.stringify(name)} is not a publishable npm name; use ` +
        `"name" or "@scope/name" of lowercase letters, digits, ".", "_", and "-"`
    )
  }
  return name
}

/**
 * The verbs a script may bind to, most specific first.
 *
 * A script names a target, never a command line. The verb is the first of
 * these the target's target participates in, so `scripts: { build: lib }` becomes
 * `smithers-build build //pkg:lib` without the declaration restating what the target
 * already knows.
 *
 * @category constants
 * @since 0.1.0
 */
export const scriptVerbs: ReadonlyArray<Target.Kind> = ["build", "test", "lint", "run"]

/**
 * Renders one script command from a target and its resolved label.
 *
 * This fails at analysis time, with no execution value anywhere in the
 * picture, when the target's target participates in none of
 * {@link scriptVerbs}: a script no smithers-build verb can run is a manifest entry
 * that fails for every user of the published package.
 *
 * @category rendering
 * @since 0.1.0
 */
export const scriptCommand = (script: string, target: Target.AnyTarget, label: string): string => {
  if (!safeExactLabel.test(label)) {
    throw new Error(
      `PackageJson: the script ${JSON.stringify(script)} resolved to an unsafe or non-exact target label: ` +
        JSON.stringify(label)
    )
  }
  const metadata = Target.metadata(target)
  const verb = scriptVerbs.find((kind) => metadata.kinds.includes(kind))
  if (verb === undefined) {
    throw new Error(
      `PackageJson: the script ${JSON.stringify(script)} names ${label}, whose target ${metadata.target} ` +
        `participates in none of ${scriptVerbs.join(", ")}`
    )
  }
  return `smithers-build ${verb} ${label}`
}

/** Reads one string property of a decoded attrs value, or undefined. */
const attrString = (attrs: unknown, key: string): string | undefined => {
  if (typeof attrs !== "object" || attrs === null || !(key in attrs)) return undefined
  const value = (attrs as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

/** Requires a declared primary entry before deriving the build layout. */
const assertEntry = (attrs: unknown, label: string): void => {
  const entries = typeof attrs === "object" && attrs !== null && "entries" in attrs
    ? (attrs as { readonly entries: unknown }).entries
    : undefined
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`PackageJson: publish entry ${label} declares no entries to derive an export from`)
  }
  const first: unknown = entries[0]
  const path = typeof first === "string"
    ? first
    : typeof first === "object" && first !== null && "path" in first
    ? (first as { readonly path: unknown }).path
    : undefined
  if (typeof path !== "string" || path === "") {
    throw new Error(`PackageJson: publish entry ${label} declares an entry without a path`)
  }
}

/**
 * Derives `main`, `module`, `types`, `exports`, `files`, and `publishConfig`
 * from a build target's own declared output attrs.
 *
 * Every failure names the target and what it is missing, because the
 * alternative — guessing a layout — publishes a manifest whose entry points do
 * not exist, and npm reports that to a user rather than to the repository. The
 * derivation refuses a target whose `outDir` attr is absent or empty, whose
 * `format` attr is absent or is not one of `esm`, `cjs`, and `dual`, and one
 * that declares no entry. Only TsBuild layouts with declarations support this
 * derivation; tsup is refused because its invocation does not emit types.
 *
 * @category rendering
 * @since 0.1.0
 */
export const publishFields = (
  entry: Target.AnyTarget,
  label: string,
  options: { readonly access: "public" | "restricted"; readonly provenance: boolean }
): Record<string, unknown> => {
  const metadata = Target.metadata(entry)
  const outDir = attrString(metadata.attrs, "outDir")
  if (outDir === undefined || outDir === "") {
    throw new Error(
      `PackageJson: publish entry ${label} (target ${metadata.target}) declares no outDir attr, ` +
        `so no entry point can be derived from it`
    )
  }
  const format = attrString(metadata.attrs, "format")
  if (format !== "esm" && format !== "cjs" && format !== "dual") {
    throw new Error(
      `PackageJson: publish entry ${label} declares the format ${JSON.stringify(format ?? null)}; ` +
        `entry points can only be derived from "esm", "cjs", or "dual"`
    )
  }
  assertEntry(metadata.attrs, label)
  if (metadata.target !== "TsBuild" || !Schema.is(TsBuild.Attrs)(metadata.attrs)) {
    throw new Error(`PackageJson: publish entry ${label} has no supported TsBuild distribution layout`)
  }
  const root = resolveOutputPath(outDir)
  const layout = TsBuild.distributionLayout({ ...metadata.attrs, outDir: root })
  const declaration = layout.find((output) => output.declaration !== null)?.declaration
  if (declaration === undefined || declaration === null) {
    throw new Error(`PackageJson: publish entry ${label} declares no declarations to derive types from`)
  }
  const types = `./${declaration}`
  const esm = layout.find((output) => output.format === "esm")?.entry
  const cjs = layout.find((output) => output.format === "cjs")?.entry
  const conditions: Record<string, unknown> = { types }
  if (esm != null) conditions["import"] = `./${esm}`
  if (cjs != null) conditions["require"] = `./${cjs}`
  return {
    exports: { "./package.json": "./package.json", ".": conditions },
    main: `./${cjs ?? esm}`,
    ...(esm == null ? {} : { module: `./${esm}` }),
    types,
    files: [root, "README.md"],
    publishConfig: { access: options.access, provenance: options.provenance }
  }
}

/** Whether a value is a plain object the deep merge may descend into. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Deep merges a package's fields over a base.
 *
 * The overriding side always wins. Two plain objects merge key by key, which is
 * what makes `scripts` additive: a template's shared `test` script and a
 * package's own `build` script both survive, and a package that declares `test`
 * replaces the template's. Every other collision replaces wholesale, arrays
 * included — a merged array would produce a `files` or `keywords` list neither
 * side declared.
 *
 * @category rendering
 * @since 0.1.0
 */
export const merge = (
  base: Readonly<Record<string, unknown>>,
  over: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  const safeBase = ManifestJson.cloneObject(base, "manifest merge base")
  const safeOver = ManifestJson.cloneObject(over, "manifest merge override")
  const merged = Object.create(null) as Record<string, unknown>
  Object.assign(merged, safeBase)
  for (const [key, value] of Object.entries(safeOver)) {
    const existing = merged[key]
    merged[key] = isPlainObject(existing) && isPlainObject(value) ? merge(existing, value) : value
  }
  return merged
}

/** Orders one manifest's keys by {@link fieldOrder}, then by code unit. */
const orderKeys = (keys: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...keys].sort((left, right) => {
    const leftIndex = orderIndex.get(left)
    const rightIndex = orderIndex.get(right)
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
    if (leftIndex !== undefined) return -1
    if (rightIndex !== undefined) return 1
    return byCodeUnit(left, right)
  })

/**
 * Renders one manifest deterministically, with a trailing newline.
 *
 * Top-level keys follow {@link fieldOrder}. `scripts` keys sort by code unit,
 * which is what `sort-package-json` does to them. Every other nested object
 * keeps the order the declaration built, because `exports` condition order is
 * semantic in Node's resolver: sorting it would change what a consumer
 * resolves.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (fields: Readonly<Record<string, unknown>>): string => {
  const safe = ManifestJson.cloneObject(fields)
  const ordered = Object.create(null) as Record<string, unknown>
  for (const key of orderKeys(Object.keys(safe))) {
    const value = safe[key]
    if (key === "scripts" && isPlainObject(value)) {
      const scripts = Object.create(null) as Record<string, unknown>
      for (const name of [...Object.keys(value)].sort(byCodeUnit)) scripts[name] = value[name]
      ordered[key] = scripts
      continue
    }
    ordered[key] = value
  }
  const rendered = `${JSON.stringify(ordered, undefined, 2)}\n`
  if (Buffer.byteLength(rendered, "utf8") > maximumManifestBytes) {
    throw new TypeError(`manifest fields exceed the ${maximumManifestBytes}-byte rendered manifest limit`)
  }
  return rendered
}

/** Renders one field value compactly for a diff line. */
const show = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return "undefined"
  return encoded.length <= 120 ? encoded : `${encoded.slice(0, 117)}...`
}

/**
 * Lists the differences between the generated manifest and the checked-in one,
 * one line per field.
 *
 * The diff is field level rather than byte level, so a failure says
 * `version: expected "0.2.0", found "0.1.0"` instead of "the file drifted".
 *
 * @category rendering
 * @since 0.1.0
 */
export const diffFields = (
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>
): ReadonlyArray<string> => {
  const safeExpected = ManifestJson.cloneObject(expected, "expected manifest")
  const safeActual = ManifestJson.cloneObject(actual, "actual manifest")
  const differences: Array<string> = []
  for (const key of orderKeys([...new Set([...Object.keys(safeExpected), ...Object.keys(safeActual)])])) {
    const hasLeft = Object.hasOwn(safeExpected, key)
    const hasRight = Object.hasOwn(safeActual, key)
    const left = safeExpected[key]
    const right = safeActual[key]
    if (hasLeft && hasRight && JSON.stringify(left) === JSON.stringify(right)) continue
    if (!hasLeft) differences.push(`${key}: unexpected ${show(right)}`)
    else if (!hasRight) differences.push(`${key}: missing, expected ${show(left)}`)
    else differences.push(`${key}: expected ${show(left)}, found ${show(right)}`)
  }
  return differences
}

/**
 * How a sync target treats the manifest.
 *
 * - `check` regenerates it in memory and compares. It never writes and never
 *   calls a model.
 * - `write` regenerates and writes the file.
 * - `refresh` calls the model for every generated field, records the answer in
 *   the nonhermetic field cache, and then writes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SyncMode = Schema.Literals(["check", "write", "refresh"])

/**
 * How a sync target treats the manifest.
 *
 * @category models
 * @since 0.1.0
 */
export type SyncMode = typeof SyncMode.Type

/**
 * Payload for one manifest sync.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SyncPayload = Schema.Struct({
  path: Schema.NonEmptyString,
  /** Workspace-relative for synthesized targets, absolute from declaration context. */
  packageDirectory: Schema.optional(Schema.String),
  mode: SyncMode,
  fields: Schema.Record(Schema.String, Schema.Unknown),
  generated: Schema.Array(GeneratedField),
  readme: Schema.NullOr(Input.File),
  sources: Schema.NullOr(Input.Glob),
  promptVersion: Schema.NonEmptyString,
  engine: Engine,
  model: Schema.NonEmptyString
})

/**
 * Payload for one manifest sync.
 *
 * @category models
 * @since 0.1.0
 */
export type SyncPayload = typeof SyncPayload.Type

/**
 * Regenerates one manifest and either compares it or writes it.
 *
 * @category actions
 * @since 0.1.0
 */
export const SyncPackageJson = Action.make("smithers-build/sync-package-json", {
  payload: SyncPayload,
  error: Schema.Union([WriteFileError, DriftError]),
  tier: "sealed"
})

/**
 * The file the nonhermetic model answers live in, under the workspace cache
 * directory. It is host state: never a declared input, never key material.
 *
 * @category constants
 * @since 0.1.0
 */
export const fieldCacheDirectory = "package-json-fields"

/**
 * Maximum encoded size of one package manifest.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumManifestBytes = ManifestJson.maximumBytes
/**
 * Maximum README bytes supplied to package-field generation.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumReadmeBytes = 4 * 1024 * 1024
/**
 * Maximum bytes accepted from one package-field model response.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumGeneratedResponseBytes = 64 * 1024
/**
 * Maximum bytes accepted from one package-field cache entry.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumFieldCacheBytes = 64 * 1024

/** One cached set of model answers for one manifest at one input digest. */
interface CachedFields {
  readonly description?: string
  readonly keywords?: ReadonlyArray<string>
}

interface CachedFieldsEnvelope {
  readonly version: 1
  readonly contextDigest: string
  readonly fields: CachedFields
}

const keywordPattern = /^[a-z0-9][a-z0-9-]{0,63}$/

const validateDescription = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 120 ||
    value !== value.trim() ||
    /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    !value.isWellFormed()
  ) {
    throw new Error("the model returned an invalid description")
  }
  return value
}

const validateKeywords = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value) || value.length < 3 || value.length > 8) {
    throw new Error("the model returned an invalid keywords array")
  }
  const keywords: Array<string> = []
  const seen = new Set<string>()
  for (const member of value) {
    if (typeof member !== "string" || !member.isWellFormed() || !keywordPattern.test(member) || seen.has(member)) {
      throw new Error("the model returned an invalid keywords array")
    }
    seen.add(member)
    keywords.push(member)
  }
  return keywords
}

const parseCachedFields = (text: string, contextDigest: string): CachedFields | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    if (
      !isPlainObject(value) || Object.keys(value).some((key) => !["version", "contextDigest", "fields"].includes(key))
    ) {
      return undefined
    }
    if (value["version"] !== 1 || value["contextDigest"] !== contextDigest || !isPlainObject(value["fields"])) {
      return undefined
    }
    const fields = value["fields"]
    if (Object.keys(fields).some((key) => key !== "description" && key !== "keywords")) return undefined
    const parsed: { description?: string; keywords?: ReadonlyArray<string> } = {}
    if ("description" in fields) parsed.description = validateDescription(fields["description"])
    if ("keywords" in fields) parsed.keywords = validateKeywords(fields["keywords"])
    return parsed
  } catch {
    return undefined
  }
}

const cacheEntryPath = (cacheDirectory: string, manifestPath: string, contextDigest: string): string => {
  const hash = createHash("sha256")
  hash.update("smithers-build-package-json-field-cache/1\0")
  hash.update(`${Buffer.byteLength(manifestPath, "utf8")}:`, "utf8")
  hash.update(manifestPath, "utf8")
  hash.update(contextDigest, "ascii")
  return `${Config.normalizeCacheDirectory(cacheDirectory)}/${fieldCacheDirectory}/${hash.digest("hex")}.json`
}

const readFieldCache = async (
  workspaceRoot: string,
  relativePath: string,
  contextDigest: string,
  signal?: AbortSignal | undefined
): Promise<CachedFields | undefined> => {
  try {
    const root = await SafeFs.canonicalRoot(workspaceRoot)
    const text = await SafeFs.readText(NodePath.join(root, relativePath), {
      root,
      signal,
      symlinks: "reject",
      limit: maximumFieldCacheBytes,
      what: "package-json field cache entry"
    })
    return text === undefined ? undefined : parseCachedFields(text, contextDigest)
  } catch {
    // The field cache is an optimization over the checked-in value. Corrupt,
    // oversized, unreadable, or link-substituted cache state is a miss, never
    // a reason for an otherwise deterministic check to fail. Cancellation is
    // the one exception: callers must still be able to stop the operation.
    signal?.throwIfAborted()
    return undefined
  }
}

/** What a generated field is derived from. */
interface GenerationContext {
  readonly digest: string
  readonly readme: string
  readonly sources: ReadonlyArray<string>
}

/**
 * Digests the declared inputs a generated field is derived from: the prompt
 * version, the README bytes, and the listing of source paths.
 *
 * The listing, not the source bytes. A package's description does not change
 * because one line of one function did, and re-deriving it on every source edit
 * would turn a cached nonhermetic value into a model call per commit.
 *
 * @category execution
 * @since 0.1.0
 */
export const generationContext = async (
  workspaceRoot: string,
  payload: SyncPayload,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<GenerationContext> => {
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  let readme = ""
  if (payload.readme !== null) {
    const path = NodePath.join(root, Input.resolvePath("", payload.readme.path))
    const text = await SafeFs.readText(path, {
      root,
      signal: options.signal,
      limit: maximumReadmeBytes,
      what: "package-json generation README"
    })
    if (text === undefined) throw new Error(`package-json generation README is missing: ${payload.readme.path}`)
    readme = text
  }
  const declaringDirectory = payload.packageDirectory ?? ""
  const packageDirectory = Input.resolvePath(
    "",
    NodePath.isAbsolute(declaringDirectory)
      ? NodePath.relative(root, declaringDirectory).split(NodePath.sep).join("/")
      : declaringDirectory
  )
  const sources = payload.sources === null ? [] : await Input.expandGlob(root, packageDirectory, payload.sources, {
    cacheDirectory: options.cacheDirectory,
    signal: options.signal
  })
  const prompt = renderPrompt(payload, { digest: "", readme, sources })
  const hash = createHash("sha256")
  hash.update("smithers-build-package-json-generation/2\0")
  for (const value of [payload.promptVersion, payload.engine, payload.model, prompt]) {
    hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8")
    hash.update(value, "utf8")
  }
  return { digest: hash.digest("hex"), readme, sources }
}

/** Renders the deterministic generation prompt for one package. */
const renderPrompt = (payload: SyncPayload, context: GenerationContext): string =>
  [
    `You are writing npm manifest metadata for the package ${JSON.stringify(payload.fields["name"] ?? "")}.`,
    "Respond with one JSON object and nothing else: no prose, no code fences. The object has exactly the keys " +
    payload.generated.map((field) => JSON.stringify(field)).join(" and ") +
    ". \"description\" is one sentence under 120 characters. \"keywords\" is an array of 3 to 8 lowercase " +
    "single-word or hyphenated terms.",
    `=== README ===\n${context.readme}`,
    `=== SOURCE FILES ===\n${context.sources.join("\n")}`
  ].join("\n\n")

/**
 * Parses the model's JSON object answer into the fields that were asked for.
 *
 * @category execution
 * @since 0.1.0
 */
export const parseGenerated = (text: string, fields: ReadonlyArray<GeneratedField>): CachedFields => {
  if (Buffer.byteLength(text, "utf8") > maximumGeneratedResponseBytes) {
    throw new Error(`the model response exceeds ${maximumGeneratedResponseBytes} bytes`)
  }
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new Error("the generated field request is empty or contains duplicates")
  }
  const trimmed = text.trim()
  if (trimmed === "") throw new Error("the model response is empty")
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error("the model response is not strict JSON")
  }
  if (!isPlainObject(value)) throw new Error("the model response is not a JSON object")
  const expected = [...fields].sort(byCodeUnit)
  const actual = Object.keys(value).sort(byCodeUnit)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("the model response does not contain exactly the requested fields")
  }
  const parsed: { description?: string; keywords?: ReadonlyArray<string> } = {}
  for (const field of fields) {
    const candidate = value[field]
    if (field === "description") {
      parsed.description = validateDescription(candidate)
    } else {
      parsed.keywords = validateKeywords(candidate)
    }
  }
  return parsed
}

/**
 * Options accepted by {@link sync} and {@link SyncPackageJsonLive}.
 *
 * @category models
 * @since 0.1.0
 */
export interface SyncOptions {
  readonly workspaceRoot: string
  readonly cacheDirectory: string
  readonly executable?: string | undefined
}

/** The keys carried through from the checked-in manifest, never generated. */
const carried: ReadonlySet<string> = new Set(managerOwnedFields)

/**
 * Regenerates one manifest and either compares it or writes it.
 *
 * This is the body {@link SyncPackageJsonLive} installs, exported so the
 * optimistic model stays directly testable.
 *
 * ## The optimistic model
 *
 * `check` and `write` never call a model. A generated field resolves to the
 * cached model answer for the current input digest; failing that, to the value
 * already on disk; failing that, it is left out entirely. A fresh checkout with
 * a cold cache and no model CLI therefore still checks green, and CI never
 * depends on a network call. Only `refresh` calls the model, and it is a `run`
 * target a person invokes.
 *
 * ## What is never generated
 *
 * Every dependency block is carried through from the checked-in manifest
 * verbatim and excluded from the diff. The package manager owns them; a
 * generator that dropped them would uninstall the package.
 *
 * @category execution
 * @since 0.1.0
 */
export const sync = (
  options: SyncOptions,
  payload: SyncPayload
): Effect.Effect<void, WriteFileError | DriftError> =>
  Effect.gen(function*() {
    const failure = (message: string): WriteFileError | DriftError =>
      payload.mode === "check"
        // Regenerating does not answer any of these: the declared fields are
        // invalid, or the path does not resolve. They are `unreadable` for the
        // same reason a permissions failure is.
        ? new DriftError({ path: payload.path, message, reason: "unreadable" })
        : new WriteFileError({ path: payload.path, message })
    const relative = yield* Effect.try({
      try: () => resolveOutputPath(payload.path),
      catch: (cause) => failure(failureMessage(cause))
    })
    const declaredFields = yield* Effect.try({
      try: () => ManifestJson.cloneObject(payload.fields, "declared package manifest fields"),
      catch: (cause) => failure(`the declared manifest fields are invalid: ${failureMessage(cause)}`)
    })
    const safePayload: SyncPayload = { ...payload, fields: declaredFields }
    if (new Set(payload.generated).size !== payload.generated.length) {
      return yield* Effect.fail(failure("the generated field list contains duplicates"))
    }
    const existingText = yield* Effect.tryPromise({
      try: async (signal) => {
        const root = await SafeFs.canonicalRoot(options.workspaceRoot)
        return SafeFs.readText(NodePath.join(root, relative), {
          root,
          signal,
          symlinks: "reject",
          limit: maximumManifestBytes,
          what: "checked-in package manifest"
        })
      },
      catch: (cause) => failure(failureMessage(cause))
    })
    let existing: Record<string, unknown> = {}
    if (existingText !== undefined) {
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(existingText),
        catch: (cause) => failure(`the checked-in manifest is not valid JSON: ${failureMessage(cause)}`)
      })
      existing = yield* Effect.try({
        try: () => ManifestJson.cloneObject(parsed, "checked-in package manifest"),
        catch: (cause) => failure(`the checked-in manifest is invalid: ${failureMessage(cause)}`)
      })
    }

    let resolved: CachedFields = {}
    if (payload.generated.length > 0) {
      const context = yield* Effect.tryPromise({
        try: (signal) =>
          generationContext(options.workspaceRoot, safePayload, {
            cacheDirectory: options.cacheDirectory,
            signal
          }),
        catch: (cause) => failure(failureMessage(cause))
      })
      const cachePath = yield* Effect.try({
        try: () => cacheEntryPath(options.cacheDirectory, relative, context.digest),
        catch: (cause) => failure(`the generated field cache path is invalid: ${failureMessage(cause)}`)
      })
      const cached = yield* Effect.tryPromise({
        try: (signal) => readFieldCache(options.workspaceRoot, cachePath, context.digest, signal),
        catch: (cause) => failure(failureMessage(cause))
      })
      if (payload.mode === "refresh") {
        const answer = yield* promptEngine(
          { workspaceRoot: options.workspaceRoot, executable: options.executable },
          { engine: payload.engine, model: payload.model, prompt: renderPrompt(safePayload, context) }
        ).pipe(Effect.mapError((error) => failure(`the model call failed: ${error.message}`)))
        resolved = yield* Effect.try({
          try: () => parseGenerated(answer, payload.generated),
          catch: (cause) => failure(failureMessage(cause))
        })
        const envelope: CachedFieldsEnvelope = { version: 1, contextDigest: context.digest, fields: resolved }
        yield* writeGeneratedFile(options.workspaceRoot, {
          path: cachePath,
          contents: `${JSON.stringify(envelope, undefined, 2)}\n`
        }).pipe(
          Effect.mapError((error) => failure(`the generated field cache could not be written: ${error.message}`))
        )
      } else {
        for (const field of payload.generated) {
          const value = cached?.[field] ?? existing[field]
          if (
            field === "description" &&
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 1024 &&
            value.isWellFormed() &&
            !value.includes("\0")
          ) {
            resolved = { ...resolved, description: value }
          }
          if (
            field === "keywords" &&
            Array.isArray(value) &&
            value.length <= 256 &&
            value.every((member) =>
              typeof member === "string" && member.length <= 256 && member.isWellFormed() && !member.includes("\0")
            )
          ) {
            resolved = { ...resolved, keywords: value as ReadonlyArray<string> }
          }
        }
      }
    }

    const fields: Record<string, unknown> = { ...declaredFields }
    if (resolved.description !== undefined) fields["description"] = resolved.description
    if (resolved.keywords !== undefined) fields["keywords"] = resolved.keywords
    for (const key of carried) {
      if (key in existing) fields[key] = existing[key]
    }
    const contents = yield* Effect.try({
      try: () => render(fields),
      catch: (cause) => failure(`the generated manifest could not be rendered: ${failureMessage(cause)}`)
    })
    if (payload.mode !== "check") {
      return yield* writeGeneratedFile(options.workspaceRoot, { path: payload.path, contents })
    }
    return yield* checkGeneratedFile(options.workspaceRoot, { path: payload.path, contents }).pipe(
      Effect.mapError((error) => {
        if (existingText === undefined) return error
        const differences = diffFields(fields, existing)
        return new DriftError({
          path: payload.path,
          // The manifest-level diff replaces the message, never the reason the
          // file check reached: an unreadable manifest stays unreadable.
          reason: error.reason,
          message: differences.length === 0
            ? "the checked-in manifest carries the right fields but not the generated key order or formatting"
            : `the checked-in manifest drifted: ${differences.join("; ")}`
        })
      })
    )
  })

/**
 * Implements {@link SyncPackageJson} against the real filesystem, the workspace
 * field cache, and — in `refresh` mode only — the model CLI.
 *
 * @category layers
 * @since 0.1.0
 */
export const SyncPackageJsonLive = (
  options: SyncOptions
): Layer.Layer<Action.Requirement<"smithers-build/sync-package-json">, never, FlowRuntime.FlowRuntime> =>
  SyncPackageJson.toLayer((payload) => sync(options, payload))

/**
 * Attributes shared by every manifest sync target.
 *
 * `fields` is the already-merged, already-label-resolved manifest. The
 * declaration resolved its template, its scripts, and its publish entry before
 * the target existed, so nothing here needs a workspace at execution time and
 * every one of those resolutions failed at analysis time if it could not be
 * made.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  output: Schema.NonEmptyString,
  /** Explicit package anchor for synthesized targets; otherwise use the declaration context. */
  packageDirectory: Schema.optional(Schema.String),
  fields: Schema.Record(Schema.String, Schema.Unknown),
  generated: Schema.Array(GeneratedField),
  readme: Schema.NullOr(Input.File),
  sources: Schema.NullOr(Input.Glob),
  promptVersion: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(promptVersion))),
  engine: Engine.pipe(Schema.withConstructorDefault(Effect.succeed("claude" as const))),
  model: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("sonnet"))),
  mode: SyncMode
})

/**
 * Attributes shared by every manifest sync target.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** What executing a manifest sync node requires. */
type SyncRequirement = Action.Requirement<"smithers-build/sync-package-json">

const implementation = (
  attrs: Attrs,
  context: Target.ImplementationContext
): Node.Node<void, WriteFileError | DriftError, SyncRequirement> =>
  SyncPackageJson.call({
    path: resolveOutputPath(attrs.output),
    packageDirectory: attrs.packageDirectory ?? context.packageDirectory ?? "",
    mode: attrs.mode,
    fields: attrs.fields,
    generated: attrs.generated,
    readme: attrs.readme,
    sources: attrs.sources,
    promptVersion: attrs.promptVersion,
    engine: attrs.engine,
    model: attrs.model
  })

/**
 * Regenerates a package manifest in memory and fails on drift.
 *
 * This is the `lint` half of the pair. It is cacheable and it never touches the
 * working tree. The checked-in manifest is a declared input, so editing it
 * re-keys the target, and a drift failure names the fields that differ rather
 * than reporting that a file changed. Following aspect_bazel_lib's
 * `write_source_files`, the checking form is the one CI runs and the writing
 * form is a separate target a person invokes.
 *
 * @category targets
 * @since 0.1.0
 */
export const PackageJsonCheck = Target.make("PackageJsonCheck", {
  attrs: Attrs,
  kinds: ["lint"],
  error: Schema.Union([WriteFileError, DriftError]),
  cache: true,
  inputs: (attrs) => [Input.file(`//${resolveOutputPath(attrs.output)}`)],
  attrsForKind: (kind, attrs) => kind === "lint" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (attrs, context) => implementation({ ...attrs, mode: "check" }, context)
})

/**
 * Rewrites a package manifest from its PACKAGE.ts declaration.
 *
 * This is the `run` half of the pair. It mutates the source tree, so it
 * participates in the `run` verb alone — `build`, `test`, `lint`, and `ci` do
 * not select it — and it is never cache admissible: a hit for a target whose
 * whole purpose is to leave a file behind would report success for a manifest
 * that was never written.
 *
 * `mode: "refresh"` is the same write with the model call in front of it. See
 * {@link sync} for the optimistic model that keeps `check` and `write` offline.
 *
 * @category targets
 * @since 0.1.0
 */
export const PackageJsonWrite = Target.make("PackageJsonWrite", {
  attrs: Attrs,
  kinds: ["run"],
  error: Schema.Union([WriteFileError, DriftError]),
  inputs: (attrs) => [Input.file(`//${resolveOutputPath(attrs.output)}`)],
  cache: false,
  implementation
})

/**
 * Runtime marker for a package manifest declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/PackageJson") as never

/**
 * One package's manifest declaration, before its labels are resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface Declaration {
  readonly [TypeId]: typeof TypeId
  readonly output: string
  readonly scripts: Readonly<Record<string, Target.AnyTarget>>
  readonly publish:
    | { readonly entry: Target.AnyTarget; readonly access: "public" | "restricted"; readonly provenance: boolean }
    | undefined
  readonly generated: ReadonlyArray<GeneratedField>
  readonly readme: Input.File | null
  readonly sources: Input.Glob | null
  readonly engine: Engine
  readonly model: string
  readonly promptVersion: string
  readonly fields: Readonly<Record<string, unknown>>
}

/**
 * Options accepted by {@link PackageJson}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The published npm name, validated against npm's grammar at declaration time. */
  readonly name: string
  /**
   * The published version, as a literal string.
   *
   * It is required and literal on purpose: this repository has no release
   * automation yet, so there is exactly one place a version lives and it is
   * this line. Versioning becomes configurable later — a version source file, a
   * Changesets-driven bump, or a workspace-wide lockstep value will replace the
   * literal — and this field keeps its name when it does.
   */
  readonly version: string
  /** @default "MIT" */
  readonly license?: License | undefined
  readonly description?: string | Generated | undefined
  readonly keywords?: ReadonlyArray<string> | Generated | undefined
  /** Scripts bound to real targets. Each command is derived from the resolved label. */
  readonly scripts?: Readonly<Record<string, Target.AnyTarget>> | undefined
  /** The build target whose declared output attrs become the package's entry points. */
  readonly publish?:
    | {
      readonly entry: Target.AnyTarget
      readonly access?: "public" | "restricted" | undefined
      readonly provenance?: boolean | undefined
    }
    | undefined
  readonly template?: Template | undefined
  /** Anything this interface does not model, passed through exactly as declared. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
  /** The manifest path, relative to the declaring package. @default "package.json" */
  readonly output?: string | undefined
  /** The README a generated prose field is derived from. @default "README.md" */
  readonly readme?: Input.File | undefined
  /** The sources whose listing a generated prose field is derived from. */
  readonly sources?: Input.Glob | undefined
  /** @default "claude" */
  readonly engine?: Engine | undefined
  /** @default "sonnet" */
  readonly model?: string | undefined
}

const packageOptionNames = new Set([
  "name",
  "version",
  "license",
  "description",
  "keywords",
  "scripts",
  "publish",
  "template",
  "fields",
  "output",
  "readme",
  "sources",
  "engine",
  "model"
])
const declarationOwnedFields = new Set(["name", "version", "description", "keywords", "scripts"])

/** Copies the outer options record without ever invoking an accessor. */
const copyPackageOptions = (options: Options): Record<string, unknown> => {
  if (typeof options !== "object" || options === null || Array.isArray(options) || NodeUtil.isProxy(options)) {
    throw new TypeError("PackageJson options must be a plain object")
  }
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("PackageJson options must be a plain object")
  }
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("PackageJson options must not carry symbol-keyed properties")
  }
  const copied = Object.create(null) as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!packageOptionNames.has(key)) {
      throw new TypeError(`PackageJson received an unknown option ${JSON.stringify(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`PackageJson option ${JSON.stringify(key)} is an accessor or non-enumerable property`)
    }
    if (descriptor.value !== undefined) copied[key] = descriptor.value
  }
  return copied
}

const assertTarget = (where: string, value: unknown): Target.AnyTarget => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    NodeUtil.isProxy(value) ||
    Object.getOwnPropertyDescriptor(value, Target.TargetTypeId)?.value === undefined
  ) {
    throw new TypeError(`${where} must name a target target`)
  }
  return value as Target.AnyTarget
}

const copyScripts = (value: unknown): Readonly<Record<string, Target.AnyTarget>> => {
  if (value === undefined) return Object.freeze(Object.create(null) as Record<string, Target.AnyTarget>)
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) {
    throw new TypeError("PackageJson scripts must be a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("PackageJson scripts must be a plain object without symbol keys")
  }
  const copied = Object.create(null) as Record<string, Target.AnyTarget>
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`PackageJson script ${JSON.stringify(name)} is an accessor or non-enumerable property`)
    }
    if (
      name.length === 0 ||
      name.length > 256 ||
      name !== name.trim() ||
      !name.isWellFormed() ||
      invalidManifestText.test(name)
    ) {
      throw new TypeError(`PackageJson script name is invalid: ${JSON.stringify(name)}`)
    }
    copied[name] = assertTarget(`PackageJson script ${JSON.stringify(name)}`, descriptor.value)
  }
  return Object.freeze(copied)
}

const copyPublish = (value: unknown): Declaration["publish"] => {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) {
    throw new TypeError("PackageJson publish must be a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("PackageJson publish must be a plain object without symbol keys")
  }
  const allowed = new Set(["entry", "access", "provenance"])
  const copied = Object.create(null) as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new TypeError(`PackageJson publish received an unknown option ${JSON.stringify(key)}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`PackageJson publish option ${JSON.stringify(key)} is an accessor or non-enumerable property`)
    }
    if (descriptor.value !== undefined) copied[key] = descriptor.value
  }
  const access = copied["access"] ?? "public"
  const provenance = copied["provenance"] ?? true
  if (access !== "public" && access !== "restricted") {
    throw new TypeError("PackageJson publish access must be \"public\" or \"restricted\"")
  }
  if (typeof provenance !== "boolean") throw new TypeError("PackageJson publish provenance must be a boolean")
  return Object.freeze({
    entry: assertTarget("PackageJson publish entry", copied["entry"]),
    access,
    provenance
  })
}

/**
 * Declares one package's manifest.
 *
 * Everything decidable without a workspace is decided here and throws here: the
 * npm name, the manager-owned fields nothing may generate, and the entry points
 * derived from the publish target's own attrs. What needs the workspace — a
 * script target's label — is resolved by {@link targets} when the index loads
 * the PACKAGE.ts file, which is still analysis time and still has no execution
 * value in reach.
 *
 * @category constructors
 * @since 0.1.0
 */
export const PackageJson = (options: Options): Declaration => {
  const safe = copyPackageOptions(options)
  const name = assertPackageName(safe["name"] as string)
  const version = assertVersion(name, safe["version"])
  const license = safe["license"] ?? defaultLicense
  if (!isLicense(license)) throw new Error(`PackageJson: ${name} declares an unsupported license`)
  const fields: Record<string, unknown> = {
    name,
    version,
    license
  }
  const generated: Array<GeneratedField> = []
  if (safe["description"] !== undefined) {
    if (isGenerated(safe["description"])) generated.push("description")
    else fields["description"] = assertLiteralDescription(safe["description"])
  }
  if (safe["keywords"] !== undefined) {
    if (isGenerated(safe["keywords"])) generated.push("keywords")
    else fields["keywords"] = assertLiteralKeywords(safe["keywords"])
  }
  if (safe["fields"] !== undefined) {
    const declared = ManifestJson.cloneObject(safe["fields"], `PackageJson(${name}) fields`)
    assertNotManagerOwned(`PackageJson(${name})`, declared)
    for (const key of Object.keys(declared)) {
      if (declarationOwnedFields.has(key)) {
        throw new Error(`PackageJson(${name}) fields declares modeled field ${JSON.stringify(key)} twice`)
      }
    }
    Object.assign(fields, declared)
  }
  const template = safe["template"]
  if (template !== undefined && !isTemplate(template)) throw new TypeError("PackageJson template is not a template")
  const output = safe["output"] ?? "package.json"
  if (typeof output !== "string") throw new TypeError("PackageJson output must be a string")
  const engine = safe["engine"] ?? "claude"
  if (!isEngine(engine)) throw new TypeError(`PackageJson engine must be ${acceptedEngines}`)
  const model = assertModel(safe["model"] ?? "sonnet")
  const readme = safe["readme"]
  if (readme !== undefined && (NodeUtil.isProxy(readme) || !Schema.is(Input.File)(readme))) {
    throw new TypeError("PackageJson readme must be an Input.File")
  }
  const sources = safe["sources"]
  if (sources !== undefined && (NodeUtil.isProxy(sources) || !Schema.is(Input.Glob)(sources))) {
    throw new TypeError("PackageJson sources must be an Input.Glob")
  }
  const merged = template === undefined ? fields : merge(template.fields, fields)
  const declaration: Declaration = {
    [TypeId]: TypeId,
    output: resolveOutputPath(output),
    scripts: copyScripts(safe["scripts"]),
    publish: copyPublish(safe["publish"]),
    generated: Object.freeze(generated),
    readme: readme ?? (generated.length === 0 ? null : Input.file("README.md")),
    sources: sources ?? (generated.length === 0 ? null : Input.glob("src/**/*.ts")),
    engine,
    model,
    promptVersion,
    fields: ManifestJson.cloneObject(merged, `PackageJson(${name}) manifest`)
  }
  return Object.freeze(declaration)
}

/**
 * Checks whether a PACKAGE.ts export is a package manifest declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDeclaration = (value: unknown): value is Declaration => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  return Object.getOwnPropertyDescriptor(value, TypeId)?.value === TypeId
}

/**
 * The three targets one declaration expands into.
 *
 * @category models
 * @since 0.1.0
 */
export interface Targets {
  readonly check: Target.AnyTarget
  readonly write: Target.AnyTarget
  readonly refresh: Target.AnyTarget
}

/**
 * Expands one declaration into its check, write, and refresh targets.
 *
 * `label` resolves a script or publish target to its workspace label and must
 * throw when it cannot: a script naming a target that is not in the graph is a
 * manifest entry no user could run, and it fails here — at analysis time, with
 * no execution value anywhere — rather than being discovered by whoever
 * installed the published package.
 *
 * `packageDirectory` is the workspace-relative directory the declaration was
 * made in. The manifest path, the README, and the source glob all resolve
 * against it and are anchored at the workspace root, so a synthesized target
 * carries the same declared inputs no matter which package the index resolves
 * it from.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const targets = (
  declaration: Declaration,
  packageDirectory: string,
  label: (target: Target.AnyTarget) => string
): Targets => {
  const packagePath = packageDirectory === "" || packageDirectory === "."
    ? ""
    : Input.resolvePath("", packageDirectory)
  const targetLabel = (target: Target.AnyTarget): string => {
    const value = label(target)
    if (typeof value !== "string" || !safeExactLabel.test(value)) {
      throw new Error(`PackageJson: a target resolved to an unsafe or non-exact label: ${JSON.stringify(value)}`)
    }
    return value
  }
  const scripts: Record<string, string> = {}
  for (const name of Object.keys(declaration.scripts).sort(byCodeUnit)) {
    const target = declaration.scripts[name]!
    scripts[name] = scriptCommand(name, target, targetLabel(target))
  }
  const derived = declaration.publish === undefined ? {} : publishFields(
    declaration.publish.entry,
    targetLabel(declaration.publish.entry),
    { access: declaration.publish.access, provenance: declaration.publish.provenance }
  )
  // The derivation sits UNDER the declaration: a package that states its own
  // `exports` means it, and the derived entry points are a default.
  const declared = merge(derived, declaration.fields)
  const fields = Object.keys(scripts).length === 0 ? declared : merge(declared, {
    scripts: merge(isPlainObject(declared["scripts"]) ? declared["scripts"] : {}, scripts)
  })
  const anchored = (value: string): string => `//${Input.resolvePath(packagePath, value)}`
  const shared = {
    output: anchored(declaration.output),
    packageDirectory: packagePath,
    fields,
    generated: declaration.generated,
    readme: declaration.readme === null ? null : Input.file(anchored(declaration.readme.path)),
    sources: declaration.sources === null ? null : Input.glob(anchored(declaration.sources.pattern), {
      exclude: declaration.sources.exclude.map(anchored)
    }),
    promptVersion: declaration.promptVersion,
    engine: declaration.engine,
    model: declaration.model
  }
  return {
    check: PackageJsonCheck({ ...shared, mode: "check" }),
    write: PackageJsonWrite({ ...shared, mode: "write" }),
    refresh: PackageJsonWrite({ ...shared, mode: "refresh" })
  }
}
