/**
 * Syntax-only import resolution and transitive closure over workspace files.
 *
 * The resolver parses TypeScript and JavaScript modules with the installed
 * `typescript` API — no type checking, no emit — extracts their import,
 * export-from, require, and dynamic-import specifiers, and resolves each one
 * against the workspace: relative paths with extension probing (`.js` maps to
 * its TypeScript sibling), `tsconfig.json` `baseUrl`/`paths`, and node_modules
 * specifiers validated through `package.json` `exports`/`main` to a
 * package-level node, never into the package. Local package `#imports` targets
 * join the file closure together with their controlling manifest. Every row outcome is explicit:
 * `resolved-file`, `package`, `builtin`, `unresolved`, or `dynamic`.
 *
 * A closure is a breadth-first walk over rows from a set of entry files. Its
 * result is the sorted `(path, digest)` reachable file set, the sorted
 * imported package set, and the unresolved and dynamic rows carried
 * explicitly so consumers can fail closed on them.
 *
 * Per-file parse rows are cached in the existing {@link Cache.CacheStore},
 * keyed on file digest, resolver-config digest, and the resolver
 * implementation fingerprint. A cached row elides parsing only: specifier
 * resolution re-runs against the current tree on every closure, because
 * resolution depends on neighbouring files a content digest cannot see
 * (creating `b.ts` changes what `./b` means without touching the importer).
 * Directory listings are read once per closure, so revalidation stays cheap;
 * exact-name membership in the listing decides existence, so a
 * case-insensitive filesystem cannot resolve a specifier Linux would refuse.
 *
 * The two layers at the bottom implement the resolver actions declared in
 * `@smthrs/targets/Compose`: {@link ImportClosureLive} executes
 * `S.ImportClosure` and {@link CheckFilesDifferenceLive} executes
 * `S.Test({expect: S.Files.difference(..), toBe: "empty"})`.
 *
 * @since 0.1.0
 */

import type { Action, FlowRuntime } from "@smthrs/flow"
import * as Compose from "@smthrs/targets/Compose"
import { failureMessage } from "@smthrs/targets/GeneratedFile"
import * as Input from "@smthrs/targets/Input"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser"
import type { Dirent } from "node:fs"
import * as NodeFs from "node:fs/promises"
import { builtinModules } from "node:module"
import * as NodePath from "node:path"
import { version as typescriptVersion } from "typescript"
import * as ts from "typescript/unstable/ast"
import type { CachedResult, CacheStore } from "./Cache.ts"
import { jsExtensionSiblings } from "./internal/js-extension-siblings.js"
import { parseModule } from "./internal/ParseModule.ts"
import * as Path from "./internal/Path.ts"
import { posix, sha256Hex as sha256 } from "./internal/Text.ts"

/**
 * Identity of this resolver implementation, combined with the compiler version into
 * every resolver-config digest. Bump the trailing number whenever extraction,
 * probing order, or row shape changes behaviour, so stale rows can never
 * answer for a different algorithm.
 *
 * @category constants
 * @since 0.1.0
 */
export const implementationFingerprint = "smthrs-resolver/3"

/**
 * Maximum files one closure may reach before it refuses loudly.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumClosureFiles = 200_000

/**
 * Maximum bytes of one module admitted to the parser.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumModuleBytes = 8 * 1024 * 1024

/** Bound kept of a dynamic import's expression text in a row. */
const dynamicTextLimit = 200

/** Extensions whose files are parsed for specifiers. */
const scannableExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

/** Extension probe order for extensionless specifiers, the compiler's order. */
const probeExtensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json"] as const

/** Index files probed inside a directory specifier, in order. */
const indexNames = ["index.ts", "index.tsx", "index.d.ts", "index.js", "index.jsx"] as const

const builtinNames: ReadonlySet<string> = new Set(builtinModules)

/**
 * The outcome of resolving one specifier.
 *
 * @category models
 * @since 0.1.0
 */
export type EdgeStatus = "resolved-file" | "package" | "builtin" | "unresolved" | "dynamic"

/**
 * One resolved specifier row: the specifier as written, its status, the
 * workspace-relative file it resolved to when `resolved-file`, and the
 * package-level name when `package`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RowEdge {
  readonly specifier: string
  readonly status: EdgeStatus
  readonly resolved?: string | undefined
  readonly packageName?: string | undefined
}

/**
 * One extracted import site: the specifier text for a static site, the
 * bounded expression text for a dynamic one.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExtractedImport {
  readonly specifier: string
  readonly dynamic: boolean
  /** Require sites select CommonJS imports-map conditions. */
  readonly mode?: "require" | undefined
}

/**
 * A resolver row for one file: content digest plus every resolved specifier.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileRow {
  readonly path: string
  readonly digest: string
  readonly edges: ReadonlyArray<RowEdge>
}

/** JSON with sorted object keys, so digests never depend on insertion order. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      sorted[key] = record[key]
    }
    return sorted
  })

/**
 * A resolver-configuration error: the tsconfig chain could not be read or
 * used, or an anchored entry lies outside the workspace.
 *
 * @category errors
 * @since 0.1.0
 */
export class ResolverConfigError extends Data.TaggedError("smithers-build/ResolverConfigError")<{
  /** Which part of the configuration refused. */
  readonly reason: "outside_workspace" | "extends_too_deep" | "unreadable" | "invalid" | "unsupported"
  readonly message: string
}> {
  constructor(reason: ResolverConfigError["reason"], message: string) {
    super({ reason, message })
  }
}

/**
 * The loaded resolver configuration one closure resolves under.
 *
 * `baseUrl` and `paths` are workspace-relative; `sources` records the
 * tsconfig chain that produced them; `configDigest` keys rows together with
 * each file's content digest and covers the implementation fingerprint, the
 * TypeScript version, probing order, and the chain's exact bytes. Row keys
 * further include the nearest package manifest's path and exact byte digest.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolverConfig {
  readonly workspaceRoot: string
  readonly configDigest: string
  readonly baseUrl: string | undefined
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly targets: ReadonlyArray<string> }>
  readonly sources: ReadonlyArray<{ readonly path: string; readonly digest: string }>
}

interface TsconfigLayer {
  readonly directory: string
  readonly compilerOptions: Record<string, unknown>
}

const workspaceRelative = (workspaceRoot: string, absolute: string, what: string): string => {
  const relative = Path.containedRelative(workspaceRoot, absolute)
  if (relative === undefined) {
    throw new ResolverConfigError("outside_workspace", `${what} resolves outside the workspace: ${absolute}`)
  }
  return posix(relative)
}

/** Reads bounded text and hashes its exact bytes against the same admitted file identity. */
const readWorkspaceText = async (
  path: string,
  options: { readonly root: string; readonly limit: number; readonly what: string }
): Promise<{ readonly text: string; readonly digest: string }> => {
  const entry = await SafeFs.resolveFile(path, options)
  if (entry === undefined) throw new Error(`${options.what} does not exist: ${path}`)
  const text = await SafeFs.readText(entry.path, options)
  if (text === undefined) throw new Error(`${options.what} disappeared: ${path}`)
  // readText decodes UTF-8 and removes its BOM. Hash the original bytes, and
  // revalidate the original entry so changes between the two reads fail closed.
  const digest = await SafeFs.digestEntry(entry, { ...options, maximumBytes: options.limit })
  if (digest === undefined) throw new Error(`${options.what} disappeared: ${path}`)
  return { text, digest }
}

const readTsconfigChain = async (
  workspaceRoot: string,
  relativePath: string,
  layers: Array<TsconfigLayer>,
  sources: Array<{ path: string; digest: string }>,
  depth: number
): Promise<void> => {
  if (depth > 8) {
    throw new ResolverConfigError("extends_too_deep", `tsconfig extends chain exceeds 8 files at ${relativePath}`)
  }
  const absolute = NodePath.join(workspaceRoot, relativePath)
  let text: string
  let digest: string
  try {
    const content = await readWorkspaceText(absolute, {
      root: await SafeFs.canonicalRoot(workspaceRoot),
      limit: SafeFs.defaultTextBytes,
      what: "tsconfig"
    })
    text = content.text
    digest = content.digest
  } catch (cause) {
    throw new ResolverConfigError("unreadable", `tsconfig could not be read: ${relativePath}: ${failureMessage(cause)}`)
  }
  sources.push({ path: posix(NodePath.normalize(relativePath)), digest })
  const errors: Array<ParseError> = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  if (errors.length > 0) {
    throw new ResolverConfigError(
      "invalid",
      `tsconfig is not valid JSONC: ${relativePath}: ${printParseErrorCode(errors[0]!.error)}`
    )
  }
  if (parsed !== undefined && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
    throw new ResolverConfigError("invalid", `tsconfig must be a JSONC object: ${relativePath}`)
  }
  const config = (parsed ?? {}) as Record<string, unknown>
  const extendsValue = config["extends"]
  if (extendsValue !== undefined) {
    if (typeof extendsValue !== "string" || !(extendsValue.startsWith("./") || extendsValue.startsWith("../"))) {
      throw new ResolverConfigError(
        "unsupported",
        `tsconfig extends form is not supported by the resolver yet (only a single relative path): ${relativePath}`
      )
    }
    const parentAbsolute = NodePath.resolve(NodePath.dirname(absolute), extendsValue)
    const withExtension = NodePath.extname(parentAbsolute) === "" ? `${parentAbsolute}.json` : parentAbsolute
    await readTsconfigChain(
      workspaceRoot,
      workspaceRelative(workspaceRoot, withExtension, "tsconfig extends target"),
      layers,
      sources,
      depth + 1
    )
  }
  const compilerOptions = config["compilerOptions"]
  layers.push({
    directory: NodePath.dirname(absolute),
    compilerOptions: typeof compilerOptions === "object" && compilerOptions !== null
      ? compilerOptions as Record<string, unknown>
      : {}
  })
}

/**
 * Loads the resolver configuration for one workspace.
 *
 * `tsconfig` names the workspace-relative tsconfig to honour; when omitted,
 * a root `tsconfig.json` is used when present and no tsconfig otherwise.
 * The file is read as JSONC; a single relative
 * `extends` chain is followed, later files overriding `baseUrl` and
 * replacing `paths` whole; every other `extends` form refuses loudly.
 *
 * @category configuration
 * @since 0.1.0
 */
export const loadResolverConfig = async (options: {
  readonly workspaceRoot: string
  readonly tsconfig?: string | undefined
}): Promise<ResolverConfig> => {
  const workspaceRoot = NodePath.resolve(options.workspaceRoot)
  let tsconfigPath = options.tsconfig
  if (tsconfigPath === undefined) {
    try {
      await NodeFs.access(NodePath.join(workspaceRoot, "tsconfig.json"))
      tsconfigPath = "tsconfig.json"
    } catch {
      tsconfigPath = undefined
    }
  }
  const layers: Array<TsconfigLayer> = []
  const sources: Array<{ path: string; digest: string }> = []
  if (tsconfigPath !== undefined) {
    await readTsconfigChain(workspaceRoot, tsconfigPath, layers, sources, 0)
  }
  let baseUrl: string | undefined
  let pathsMap: { readonly directory: string; readonly map: Record<string, unknown> } | undefined
  for (const layer of layers) {
    const declaredBaseUrl = layer.compilerOptions["baseUrl"]
    if (typeof declaredBaseUrl === "string") {
      baseUrl = workspaceRelative(
        workspaceRoot,
        NodePath.resolve(layer.directory, declaredBaseUrl),
        "tsconfig baseUrl"
      )
    }
    const declaredPaths = layer.compilerOptions["paths"]
    if (typeof declaredPaths === "object" && declaredPaths !== null && !Array.isArray(declaredPaths)) {
      pathsMap = { directory: layer.directory, map: declaredPaths as Record<string, unknown> }
    }
  }
  const paths: Array<{ pattern: string; targets: ReadonlyArray<string> }> = []
  if (pathsMap !== undefined) {
    const pathsBase = baseUrl === undefined
      ? workspaceRelative(workspaceRoot, pathsMap.directory, "tsconfig paths directory")
      : baseUrl
    for (const pattern of Object.keys(pathsMap.map).sort()) {
      const targets = pathsMap.map[pattern]
      if (!Array.isArray(targets) || targets.some((entry) => typeof entry !== "string")) {
        throw new ResolverConfigError(
          "invalid",
          `tsconfig paths entry ${JSON.stringify(pattern)} must map to an array of strings`
        )
      }
      if ((pattern.match(/\*/g) ?? []).length > 1) {
        throw new ResolverConfigError(
          "invalid",
          `tsconfig paths pattern ${JSON.stringify(pattern)} has more than one *`
        )
      }
      paths.push({
        pattern,
        targets: (targets as Array<string>).map((target) => {
          if ((target.match(/\*/g) ?? []).length > 1) {
            throw new ResolverConfigError(
              "invalid",
              `tsconfig paths target ${JSON.stringify(target)} has more than one *`
            )
          }
          const joined = posix(NodePath.normalize(NodePath.join(pathsBase, target)))
          if (joined === ".." || joined.startsWith("../")) {
            throw new ResolverConfigError(
              "outside_workspace",
              `tsconfig paths target ${JSON.stringify(target)} escapes the workspace`
            )
          }
          return joined === "." ? "" : joined
        })
      })
    }
  }
  const configDigest = sha256(canonicalJson({
    fingerprint: implementationFingerprint,
    tsVersion: typescriptVersion,
    sources,
    baseUrl: baseUrl ?? null,
    paths,
    probeExtensions,
    indexNames
  }))
  return { workspaceRoot, configDigest, baseUrl, paths, sources }
}

const boundedText = (node: ts.Node, source: ts.SourceFile): string => {
  const text = node.getText(source).replace(/\s+/g, " ")
  return text.length > dynamicTextLimit ? `${text.slice(0, dynamicTextLimit - 3)}...` : text
}

/**
 * Extracts every import site from one module, without resolving anything.
 *
 * Covered syntax: `import ... from`, `export ... from`, `export * from`,
 * `import x = require(...)`, `require(...)`, `require.resolve(...)`, and
 * `import(...)`. A call whose argument is a string literal or an
 * untemplated template literal is a static site; any other argument is a
 * dynamic site carrying the bounded expression text. Type-only imports are
 * included: for reachability a type-only edge still makes a file live.
 *
 * The parse is syntax only. A file the parser cannot make sense of still
 * yields the sites the parser recovered, exactly as the compiler's own
 * error-tolerant parse does.
 *
 * @category extraction
 * @since 0.1.0
 */
export const extractSpecifiers = (path: string, text: string): ReadonlyArray<ExtractedImport> => {
  const source = parseModule(path, text)
  const found: Array<ExtractedImport> = []
  const literalText = (expression: ts.Expression): string | undefined =>
    ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : undefined
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier === undefined ? undefined : literalText(node.moduleSpecifier)
      if (specifier !== undefined) found.push({ specifier, dynamic: false })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression === undefined
        ? undefined
        : literalText(node.moduleReference.expression)
      if (specifier !== undefined) found.push({ specifier, dynamic: false, mode: "require" })
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === "require"
      const isRequireResolve = ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) && callee.expression.text === "require" &&
        callee.name.text === "resolve"
      if (isImportCall || isRequire || isRequireResolve) {
        const argument = node.arguments[0]
        const specifier = argument === undefined ? undefined : literalText(argument)
        if (specifier !== undefined) {
          found.push(isImportCall ? { specifier, dynamic: false } : { specifier, dynamic: false, mode: "require" })
        } else {
          found.push({
            specifier: argument === undefined ? boundedText(node, source) : boundedText(argument, source),
            dynamic: true
          })
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

/**
 * What one workspace path is: a regular file, a directory, or anything else.
 *
 * @category models
 * @since 0.1.0
 */
export type EntryKind = "file" | "dir" | "other"

/**
 * A read-only existence view of one workspace tree, the only filesystem
 * surface specifier resolution consumes.
 *
 * @category models
 * @since 0.1.0
 */
export interface TreeView {
  /** Absolute workspace root the relative paths anchor at. */
  readonly root: string
  /** The kind of one workspace-relative posix path, or null when absent. */
  kind(relativePath: string): Promise<EntryKind | null>
}

/**
 * One closure's read-once view of the workspace tree.
 *
 * Every existence question is answered from a directory listing read at most
 * once per run, by exact-name membership. Symbolic link entries classify by
 * what they resolve to; a broken link is `other`.
 */
class TreeReader implements TreeView {
  private readonly directories = new Map<string, ReadonlyMap<string, EntryKind> | null>()
  private readonly manifests = new Map<string, Promise<ImportsManifest | null>>()
  readonly root: string
  constructor(root: string) {
    this.root = root
  }

  importsManifest(fromDirectory: string): Promise<ImportsManifest | null> {
    let manifest = this.manifests.get(fromDirectory)
    if (manifest === undefined) {
      manifest = readImportsManifest(this, fromDirectory)
      this.manifests.set(fromDirectory, manifest)
    }
    return manifest
  }

  private async listing(relativeDirectory: string): Promise<ReadonlyMap<string, EntryKind> | null> {
    const cached = this.directories.get(relativeDirectory)
    if (cached !== undefined) return cached
    let entries: Array<Dirent>
    try {
      entries = await NodeFs.readdir(NodePath.join(this.root, relativeDirectory), { withFileTypes: true })
    } catch {
      this.directories.set(relativeDirectory, null)
      return null
    }
    const listing = new Map<string, EntryKind>()
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        try {
          const stat = await NodeFs.stat(NodePath.join(this.root, relativeDirectory, entry.name))
          listing.set(entry.name, stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other")
        } catch {
          listing.set(entry.name, "other")
        }
        continue
      }
      listing.set(entry.name, entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other")
    }
    this.directories.set(relativeDirectory, listing)
    return listing
  }

  /** The kind of one workspace-relative path, or null when absent. */
  async kind(relativePath: string): Promise<EntryKind | null> {
    if (relativePath === "") return "dir"
    const slash = relativePath.lastIndexOf("/")
    const directory = slash === -1 ? "" : relativePath.slice(0, slash)
    const name = slash === -1 ? relativePath : relativePath.slice(slash + 1)
    if (name === "") return null
    const listing = await this.listing(directory)
    return listing?.get(name) ?? null
  }
}

/** Joins and normalizes to a workspace-relative posix path, or null on escape. */
const containedJoin = (...segments: ReadonlyArray<string>): string | null => {
  const joined = posix(NodePath.normalize(NodePath.join(...segments)))
  if (joined === ".." || joined.startsWith("../") || NodePath.isAbsolute(joined)) return null
  return joined === "." ? "" : joined
}

const extensionOf = (path: string): string | null => {
  const slash = path.lastIndexOf("/")
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? null : name.slice(dot)
}

/**
 * Probes one workspace-relative module path the way the compiler would.
 *
 * A JavaScript-suffixed path probes its TypeScript siblings, then itself. A
 * path with any other extension probes itself, then extension variants, then
 * a directory index. An extensionless path probes extension variants, then
 * the literal file, then a directory index.
 */
const probeModulePath = async (reader: TreeView, raw: string): Promise<string | null> => {
  const extension = extensionOf(raw)
  if (extension !== null && extension in jsExtensionSiblings) {
    const stem = raw.slice(0, raw.length - extension.length)
    for (const sibling of jsExtensionSiblings[extension]!) {
      const candidate = `${stem}${sibling}`
      if (await reader.kind(candidate) === "file") return candidate
    }
    return await reader.kind(raw) === "file" ? raw : null
  }
  if (extension !== null && await reader.kind(raw) === "file") return raw
  for (const probe of probeExtensions) {
    const candidate = `${raw}${probe}`
    if (await reader.kind(candidate) === "file") return candidate
  }
  if (extension === null && await reader.kind(raw) === "file") return raw
  if (await reader.kind(raw) === "dir") {
    for (const index of indexNames) {
      const candidate = `${raw}/${index}`
      if (await reader.kind(candidate) === "file") return candidate
    }
  }
  return null
}

const parsePackageSpecifier = (specifier: string): { readonly name: string; readonly subpath: string } | null => {
  const segments = specifier.split("/")
  if (specifier.startsWith("@")) {
    if (segments.length < 2 || segments[0] === "@" || segments[1] === "") return null
    const name = `${segments[0]}/${segments[1]}`
    return { name, subpath: segments.length === 2 ? "." : `./${segments.slice(2).join("/")}` }
  }
  if (segments[0] === "") return null
  return { name: segments[0]!, subpath: segments.length === 1 ? "." : `./${segments.slice(1).join("/")}` }
}

const readManifest = async (root: string, relativePath: string): Promise<Record<string, unknown> | null> => {
  let text: string
  try {
    text = await NodeFs.readFile(NodePath.join(root, relativePath), "utf8")
  } catch {
    return null
  }
  if (text.length > 1024 * 1024) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Whether a conditions object or target admits any resolvable leaf. */
const exportTargetUsable = (target: unknown, depth: number): boolean => {
  if (depth > 8) return false
  if (typeof target === "string") return true
  if (Array.isArray(target)) return target.some((entry) => exportTargetUsable(entry, depth + 1))
  if (typeof target === "object" && target !== null) {
    return Object.values(target as Record<string, unknown>).some((entry) => exportTargetUsable(entry, depth + 1))
  }
  return false
}

/**
 * Whether a `package.json` `exports` value admits one subpath.
 *
 * The check is deliberately package-level: it answers whether the subpath is
 * exported at all, under any condition, without resolving into the package.
 * A subpath map matches an exact key first, then the most specific single-`*`
 * pattern, exactly as Node orders patterns; a matched `null` target means the
 * subpath is explicitly blocked.
 */
const exportsAdmits = (exportsField: unknown, subpath: string): boolean => {
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return subpath === "."
  if (typeof exportsField !== "object" || exportsField === null) return false
  const record = exportsField as Record<string, unknown>
  const keys = Object.keys(record)
  if (!keys.some((key) => key.startsWith("."))) {
    return subpath === "." && exportTargetUsable(record, 0)
  }
  if (subpath in record) return exportTargetUsable(record[subpath], 0)
  let best: { readonly key: string; readonly target: unknown } | undefined
  for (const key of keys) {
    const star = key.indexOf("*")
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (best === undefined || prefix.length > best.key.indexOf("*"))
    ) {
      best = { key, target: record[key] }
    }
  }
  return best !== undefined && exportTargetUsable(best.target, 0)
}

const ancestorsOf = (relativeDirectory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let current = relativeDirectory
  for (;;) {
    found.push(current)
    if (current === "") return found
    const slash = current.lastIndexOf("/")
    current = slash === -1 ? "" : current.slice(0, slash)
  }
}

interface ImportsManifest {
  readonly path: string
  readonly directory: string
  readonly digest: string
  readonly imports: unknown
}

/** The nearest package scope controls #imports, even without a usable map. */
const readImportsManifest = async (reader: TreeView, fromDirectory: string): Promise<ImportsManifest | null> => {
  for (const directory of ancestorsOf(fromDirectory)) {
    const path = directory === "" ? "package.json" : `${directory}/package.json`
    if (await reader.kind(path) !== "file") continue
    let content: { readonly text: string; readonly digest: string }
    try {
      content = await readWorkspaceText(NodePath.join(reader.root, path), {
        root: await SafeFs.canonicalRoot(reader.root),
        limit: SafeFs.defaultTextBytes,
        what: "package imports manifest"
      })
    } catch (cause) {
      throw new ClosureError("unreadable", `imports manifest could not be read: ${path}: ${failureMessage(cause)}`)
    }
    let imports: unknown
    try {
      const value: unknown = JSON.parse(content.text)
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        imports = (value as Record<string, unknown>)["imports"]
      }
    } catch {
      // A malformed nearest manifest still ends the package scope search.
    }
    return { path, directory, digest: content.digest, imports }
  }
  return null
}

/** Select conditions in declaration order; undefined permits a later condition. */
const importsTarget = (target: unknown, mode: "import" | "require", depth = 0): string | null | undefined => {
  if (depth > 8) return undefined
  if (target === null || typeof target === "string") return target
  if (Array.isArray(target)) {
    for (const entry of target) {
      const selected = importsTarget(entry, mode, depth + 1)
      if (typeof selected === "string") return selected
    }
    return null
  }
  if (typeof target === "object") {
    for (const [condition, entry] of Object.entries(target)) {
      if (condition !== "default" && condition !== "types" && condition !== "node" && condition !== mode) continue
      const selected = importsTarget(entry, mode, depth + 1)
      if (selected !== undefined) return selected
    }
  }
  return undefined
}

const matchImportsTarget = (imports: unknown, specifier: string, mode: "import" | "require"): string | null => {
  if (typeof imports !== "object" || imports === null || Array.isArray(imports)) return null
  const record = imports as Record<string, unknown>
  if (Object.hasOwn(record, specifier)) return importsTarget(record[specifier], mode) ?? null
  let best: { readonly key: string; readonly star: number; readonly matched: string } | undefined
  for (const key of Object.keys(record)) {
    if (!key.startsWith("#")) continue
    const star = key.indexOf("*")
    if (star === -1 || key.indexOf("*", star + 1) !== -1) continue
    const suffix = key.slice(star + 1)
    if (
      specifier.length > star + suffix.length && specifier.startsWith(key.slice(0, star)) &&
      specifier.endsWith(suffix) &&
      (best === undefined || star > best.star || (star === best.star && key.length > best.key.length))
    ) {
      best = { key, star, matched: specifier.slice(star, specifier.length - suffix.length) }
    }
  }
  if (best === undefined) return null
  const target = importsTarget(record[best.key], mode)
  return typeof target === "string" ? target.split("*").join(best.matched) : null
}

const resolvePackageSpecifier = async (
  reader: TreeView,
  fromDirectory: string,
  specifier: string
): Promise<RowEdge> => {
  const parsed = parsePackageSpecifier(specifier)
  if (parsed === null) return { specifier, status: "unresolved" }
  for (const ancestor of ancestorsOf(fromDirectory)) {
    const packageRoot = containedJoin(ancestor, "node_modules", parsed.name)
    if (packageRoot === null || await reader.kind(packageRoot) !== "dir") continue
    const manifest = await readManifest(reader.root, `${packageRoot}/package.json`)
    if (manifest !== null && manifest["exports"] !== undefined) {
      return exportsAdmits(manifest["exports"], parsed.subpath)
        ? { specifier, status: "package", packageName: parsed.name }
        : { specifier, status: "unresolved" }
    }
    return { specifier, status: "package", packageName: parsed.name }
  }
  return { specifier, status: "unresolved" }
}

/** Matches one bare specifier against tsconfig paths, most specific first. */
const pathsCandidates = (config: ResolverConfig, specifier: string): ReadonlyArray<string> => {
  let exact: ReadonlyArray<string> | undefined
  let best:
    | { readonly prefixLength: number; readonly matched: string; readonly targets: ReadonlyArray<string> }
    | undefined
  for (const entry of config.paths) {
    const star = entry.pattern.indexOf("*")
    if (star === -1) {
      if (entry.pattern === specifier) exact = entry.targets
      continue
    }
    const prefix = entry.pattern.slice(0, star)
    const suffix = entry.pattern.slice(star + 1)
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (best === undefined || prefix.length > best.prefixLength)
    ) {
      best = {
        prefixLength: prefix.length,
        matched: specifier.slice(prefix.length, specifier.length - suffix.length),
        targets: entry.targets
      }
    }
  }
  if (exact !== undefined) return exact
  if (best === undefined) return []
  const matched = best.matched
  return best.targets.map((target) => target.includes("*") ? target.replace("*", matched) : target)
}

const stripQuery = (specifier: string): string => {
  const query = specifier.indexOf("?")
  return query === -1 ? specifier : specifier.slice(0, query)
}

/**
 * Resolves one extracted import from one file into an explicit row edge.
 *
 * @category resolution
 * @since 0.1.0
 */
export const resolveSpecifier = async (
  config: ResolverConfig,
  reader: TreeView,
  fromFile: string,
  site: ExtractedImport
): Promise<RowEdge> => {
  if (site.dynamic) return { specifier: site.specifier, status: "dynamic" }
  const specifier = stripQuery(site.specifier)
  if (specifier === "") return { specifier: site.specifier, status: "unresolved" }
  if (specifier.startsWith("node:")) return { specifier: site.specifier, status: "builtin" }
  const bareName = specifier.split("/")[0]!
  if (builtinNames.has(specifier) || builtinNames.has(bareName)) {
    return { specifier: site.specifier, status: "builtin" }
  }
  const slash = fromFile.lastIndexOf("/")
  const fromDirectory = slash === -1 ? "" : fromFile.slice(0, slash)
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
    const raw = containedJoin(fromDirectory, specifier)
    if (raw === null) return { specifier: site.specifier, status: "unresolved" }
    const resolved = await probeModulePath(reader, raw === "" ? "." : raw)
    return resolved === null
      ? { specifier: site.specifier, status: "unresolved" }
      : { specifier: site.specifier, status: "resolved-file", resolved }
  }
  if (specifier.startsWith("/") || /^[A-Za-z]:/.test(specifier) || specifier.includes(":")) {
    return { specifier: site.specifier, status: "unresolved" }
  }
  if (specifier.startsWith("#")) {
    const unresolved: RowEdge = { specifier: site.specifier, status: "unresolved" }
    if (specifier === "#" || specifier.startsWith("#/")) return unresolved
    const manifest = reader instanceof TreeReader
      ? await reader.importsManifest(fromDirectory)
      : await readImportsManifest(reader, fromDirectory)
    if (manifest === null) return unresolved
    const target = matchImportsTarget(manifest.imports, specifier, site.mode ?? "import")
    if (target === null) return unresolved
    if (target.startsWith("./")) {
      const local = containedJoin(target)
      if (local === null || local === "") return unresolved
      const raw = containedJoin(manifest.directory, local)
      if (raw === null) return unresolved
      const resolved = await probeModulePath(reader, raw)
      if (resolved === null) return unresolved
      await SafeFs.resolveFile(NodePath.join(reader.root, resolved), {
        root: await SafeFs.canonicalRoot(reader.root),
        what: "package imports target"
      })
      return { specifier: site.specifier, status: "resolved-file", resolved }
    }
    if (target.startsWith("node:") || builtinNames.has(target)) {
      return { specifier: site.specifier, status: "builtin" }
    }
    if (
      target === "" || target.startsWith(".") || target.startsWith("/") || target.startsWith("#") ||
      target.includes(":")
    ) {
      return unresolved
    }
    const edge = await resolvePackageSpecifier(reader, manifest.directory, target)
    return { ...edge, specifier: site.specifier }
  }
  for (const candidate of pathsCandidates(config, specifier)) {
    const resolved = await probeModulePath(reader, candidate === "" ? "." : candidate)
    if (resolved !== null) return { specifier: site.specifier, status: "resolved-file", resolved }
  }
  if (config.baseUrl !== undefined) {
    const raw = containedJoin(config.baseUrl, specifier)
    if (raw !== null) {
      const resolved = await probeModulePath(reader, raw === "" ? "." : raw)
      if (resolved !== null) return { specifier: site.specifier, status: "resolved-file", resolved }
    }
  }
  return resolvePackageSpecifier(reader, fromDirectory, specifier)
}

/**
 * The stored shape of one cached resolver row: the file digest it answers
 * for and the extracted import sites. Resolution is never stored — it
 * depends on the surrounding tree, which the key cannot see — so a hit
 * elides the parse and re-resolves against the current tree.
 */
const StoredRow = Schema.Struct({
  digest: Schema.String,
  specifiers: Schema.Array(Schema.Struct({
    specifier: Schema.String,
    dynamic: Schema.Boolean,
    mode: Schema.optional(Schema.Literal("require"))
  }))
})

const decodeStoredRow = Schema.decodeUnknownOption(StoredRow)

/**
 * The cache target name resolver rows are stored under.
 *
 * @category constants
 * @since 0.1.0
 */
export const rowCacheTarget = "ImportClosureRow"

/**
 * The cache key of one resolver row: file digest, resolver-config digest
 * (which already covers the implementation fingerprint and TypeScript
 * version), bound under a row-namespace prefix.
 *
 * @category caching
 * @since 0.1.0
 */
export const rowCacheKey = (fileDigest: string, configDigest: string): string =>
  sha256(`smthrs-resolver-row\u0000${fileDigest}\u0000${configDigest}`)

/**
 * Work counters for one closure: `parsed` files went through extraction,
 * `cached` answered from stored rows.
 *
 * @category models
 * @since 0.1.0
 */
export interface ClosureStats {
  readonly parsed: number
  readonly cached: number
}

/**
 * One computed closure: the deterministic result and this run's counters.
 *
 * @category models
 * @since 0.1.0
 */
export interface ClosureOutcome {
  readonly result: Compose.ClosureResult
  readonly stats: ClosureStats
}

/**
 * A closure computation failed: an entry does not exist, a file vanished
 * between probe and read, a module exceeds the parse bound, or the closure
 * exceeded {@link maximumClosureFiles}.
 *
 * @category errors
 * @since 0.1.0
 */
export class ClosureError extends Data.TaggedError("smithers-build/ClosureError")<{
  /** Which bound or read refused. */
  readonly reason: "unreadable" | "too_many_files" | "invalid_entry" | "missing_entry"
  readonly message: string
}> {
  constructor(reason: ClosureError["reason"], message: string) {
    super({ reason, message })
  }
}

const compareIssues = (left: Compose.ClosureIssue, right: Compose.ClosureIssue): number =>
  left.file < right.file ? -1 : left.file > right.file ? 1 : left.specifier < right.specifier
    ? -1
    : left.specifier > right.specifier
    ? 1
    : 0

/**
 * Computes the transitive import closure of `entries` under one
 * configuration.
 *
 * Entries are workspace-relative files and must exist. Every reachable file
 * joins the result with its content digest; files whose extension is not a
 * module extension join as leaves without parsing. Unresolved and dynamic
 * rows are carried explicitly. The result is fully sorted, so two runs over
 * one tree are byte-identical regardless of traversal order or cache state.
 *
 * @category closure
 * @since 0.1.0
 */
export const computeClosure = async (options: {
  readonly config: ResolverConfig
  readonly entries: ReadonlyArray<string>
  readonly cache?: CacheStore | undefined
  readonly maximumFiles?: number | undefined
}): Promise<ClosureOutcome> => {
  const { cache, config } = options
  const maximumFiles = options.maximumFiles ?? maximumClosureFiles
  const root = await SafeFs.canonicalRoot(config.workspaceRoot)
  const reader = new TreeReader(config.workspaceRoot)
  const files = new Map<string, string>()
  const packages = new Set<string>()
  const unresolved = new Map<string, Compose.ClosureIssue>()
  const dynamic = new Map<string, Compose.ClosureIssue>()
  let parsed = 0
  let cached = 0
  const entrySet = new Set(options.entries)
  const queue: Array<string> = [...options.entries]
  const queued = new Set(queue)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const path = queue[cursor]!
    if (files.has(path)) continue
    if (files.size >= maximumFiles) {
      throw new ClosureError("too_many_files", `import closure exceeds ${maximumFiles} files`)
    }
    if (containedJoin(path) !== path || path === "") {
      throw new ClosureError(
        "invalid_entry",
        `closure entry is not a normalized workspace-relative path: ${JSON.stringify(path)}`
      )
    }
    const extension = extensionOf(path)
    const scannable = extension !== null && scannableExtensions.has(extension)
    let text: string | undefined
    let digest: string | undefined
    try {
      const absolute = NodePath.join(config.workspaceRoot, path)
      if (scannable) {
        const content = await readWorkspaceText(absolute, {
          root,
          limit: maximumModuleBytes,
          what: "module (parse bound)"
        })
        text = content.text
        digest = content.digest
      } else {
        digest = await SafeFs.digestFile(absolute, { root, what: "closure file" })
      }
      if (digest === undefined) throw new Error(`file does not exist: ${path}`)
    } catch (cause) {
      throw new ClosureError(
        entrySet.has(path) ? "missing_entry" : "unreadable",
        entrySet.has(path)
          ? `closure entry does not exist: ${path}: ${failureMessage(cause)}`
          : `closure file could not be read: ${path}: ${failureMessage(cause)}`
      )
    }
    files.set(path, digest)
    if (text === undefined) continue
    const slash = path.lastIndexOf("/")
    const manifest = await reader.importsManifest(slash === -1 ? "" : path.slice(0, slash))
    const configDigest = manifest === null ? config.configDigest : sha256(canonicalJson({
      config: config.configDigest,
      importsManifest: { path: manifest.path, digest: manifest.digest }
    }))
    const key = rowCacheKey(digest, configDigest)
    let specifiers: ReadonlyArray<ExtractedImport> | undefined
    if (cache !== undefined) {
      const stored = await cache.get(key)
      if (stored !== null && stored.exitOk && stored.target === rowCacheTarget) {
        const decoded = decodeStoredRow(stored.output)
        if (Option.isSome(decoded) && decoded.value.digest === digest) {
          specifiers = decoded.value.specifiers
          cached += 1
        }
      }
    }
    if (specifiers === undefined) {
      specifiers = extractSpecifiers(path, text)
      parsed += 1
      if (cache !== undefined) {
        const row: CachedResult = {
          key,
          target: rowCacheTarget,
          label: path,
          exitOk: true,
          output: { digest, specifiers },
          storedAt: new Date().toISOString()
        }
        await cache.put(key, row)
      }
    }
    if (manifest !== null && specifiers.some((site) => !site.dynamic && site.specifier.startsWith("#"))) {
      if (!files.has(manifest.path) && files.size >= maximumFiles) {
        throw new ClosureError("too_many_files", `import closure exceeds ${maximumFiles} files`)
      }
      files.set(manifest.path, manifest.digest)
    }
    for (const site of specifiers) {
      const edge = await resolveSpecifier(config, reader, path, site)
      switch (edge.status) {
        case "resolved-file": {
          if (!queued.has(edge.resolved!)) {
            queued.add(edge.resolved!)
            queue.push(edge.resolved!)
          }
          break
        }
        case "package": {
          packages.add(edge.packageName!)
          break
        }
        case "builtin": {
          break
        }
        case "unresolved": {
          unresolved.set(`${path}\u0000${edge.specifier}`, { file: path, specifier: edge.specifier })
          break
        }
        case "dynamic": {
          dynamic.set(`${path}\u0000${edge.specifier}`, { file: path, specifier: edge.specifier })
          break
        }
      }
    }
  }
  return {
    result: {
      files: [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, digest]) => ({ path, digest })),
      packages: [...packages].sort(),
      unresolved: [...unresolved.values()].sort(compareIssues),
      dynamic: [...dynamic.values()].sort(compareIssues)
    },
    stats: { parsed, cached }
  }
}

/**
 * Maps one anchored base onto its workspace-relative package path.
 *
 * @category expansion
 * @since 0.1.0
 */
export const packageDirectoryOf = (workspaceRoot: string, base: string): string => {
  if (base === "") return ""
  const relative = Path.containedRelative(NodePath.resolve(workspaceRoot), base)
  if (relative === undefined) {
    throw new ResolverConfigError("outside_workspace", `anchored source is declared outside the workspace: ${base}`)
  }
  if (relative === "") return ""
  return posix(relative)
}

/**
 * Expands anchored sources to a sorted set of workspace-relative files.
 *
 * Globs expand through `Input.expandGlob`, so package scope, `.gitignore`,
 * and host-state exclusion apply exactly as they do to declared inputs.
 * Declared files that do not exist are dropped when `requireFiles` is false
 * and refused loudly when it is true.
 *
 * @category expansion
 * @since 0.1.0
 */
export const expandAnchoredSources = async (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly sources: ReadonlyArray<Compose.AnchoredSource>
  readonly requireFiles: boolean
}): Promise<ReadonlyArray<string>> => {
  const found = new Set<string>()
  for (const { base, source } of options.sources) {
    const packageDirectory = packageDirectoryOf(options.workspaceRoot, base)
    if (source._tag === "File") {
      const path = Input.resolvePath(packageDirectory, source.path)
      try {
        await NodeFs.access(NodePath.join(options.workspaceRoot, path))
        found.add(path)
      } catch {
        if (options.requireFiles) {
          throw new ClosureError("missing_entry", `declared entry file does not exist: ${path}`)
        }
      }
      continue
    }
    const matches = await Input.expandGlob(options.workspaceRoot, packageDirectory, source, {
      cacheDirectory: options.cacheDirectory
    })
    for (const match of matches) {
      const basename = NodePath.posix.basename(match)
      // PACKAGE/WORKSPACE modules are build declarations, not members of a
      // source glob. They remain available when named explicitly as S.file.
      if (basename !== "PACKAGE.ts" && basename !== "WORKSPACE.ts") found.add(match)
    }
  }
  return [...found].sort()
}

/**
 * Options shared by the resolver layers.
 *
 * `cache` is the store per-file rows are memoized in; omit it and every
 * closure parses from scratch. `tsconfig` overrides the workspace-relative
 * tsconfig; the default honours a root `tsconfig.json` when present.
 *
 * @category models
 * @since 0.1.0
 */
export interface LiveOptions {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly tsconfig?: string | undefined
  readonly cache?: CacheStore | undefined
}

/**
 * Loads the resolver configuration, expands anchored entry sources, and
 * computes the closure — the one-call surface the package executor binds.
 *
 * @category closure
 * @since 0.1.0
 */
export const closureOfEntries = async (
  options: LiveOptions,
  entries: ReadonlyArray<Compose.AnchoredSource>
): Promise<Compose.ClosureResult> => {
  const config = await loadResolverConfig({
    workspaceRoot: options.workspaceRoot,
    tsconfig: options.tsconfig
  })
  const files = await expandAnchoredSources({
    workspaceRoot: options.workspaceRoot,
    cacheDirectory: options.cacheDirectory,
    sources: entries,
    requireFiles: true
  })
  const outcome = await computeClosure({ config, entries: files, cache: options.cache })
  return outcome.result
}

/**
 * Implements the `smithers-build/import-closure` action with the resolver.
 *
 * @category layers
 * @since 0.1.0
 */
export const ImportClosureLive = (
  options: LiveOptions
): Layer.Layer<Action.Requirement<"smithers-build/import-closure">, never, FlowRuntime.FlowRuntime> =>
  Compose.ResolveImportClosure.toLayer((payload) =>
    Effect.tryPromise({
      try: () => closureOfEntries(options, payload.entries),
      catch: (cause) =>
        cause instanceof Compose.ImportClosureError
          ? cause
          : new Compose.ImportClosureError({ message: failureMessage(cause) })
    })
  )

const issueLimit = 200

const cappedIssues = (issues: ReadonlyArray<Compose.ClosureIssue>): ReadonlyArray<Compose.ClosureIssue> =>
  issues.slice(0, issueLimit)

/**
 * Reduces one file-algebra operand to its path set. A closure operand with
 * unresolved or dynamic rows fails closed with a typed `FilesTestError`.
 *
 * @category expansion
 * @since 0.1.0
 */
export const operandPaths = async (
  options: LiveOptions,
  operand: Compose.FilesCheckOperand,
  side: "left" | "right"
): Promise<ReadonlyArray<string>> => {
  if (operand._tag === "SourceSet") {
    return expandAnchoredSources({
      workspaceRoot: options.workspaceRoot,
      cacheDirectory: options.cacheDirectory,
      sources: operand.sources,
      requireFiles: false
    })
  }
  const closure = await closureOfEntries(options, operand.entries)
  if (closure.unresolved.length > 0 || closure.dynamic.length > 0) {
    throw new Compose.FilesTestError({
      message: `the ${side} closure is incomplete (${closure.unresolved.length} unresolved, ` +
        `${closure.dynamic.length} dynamic import(s)); the check fails closed rather than ` +
        `reasoning from an incomplete file set`,
      leftover: [],
      unresolved: cappedIssues(closure.unresolved),
      dynamic: cappedIssues(closure.dynamic)
    })
  }
  return closure.files.map((file) => file.path)
}

/**
 * Implements the `smithers-build/files-difference` action: expands both
 * operands, subtracts right from left by path, and requires emptiness.
 *
 * @category layers
 * @since 0.1.0
 */
export const CheckFilesDifferenceLive = (
  options: LiveOptions
): Layer.Layer<Action.Requirement<"smithers-build/files-difference">, never, FlowRuntime.FlowRuntime> =>
  Compose.CheckFilesDifference.toLayer((payload) =>
    Effect.tryPromise({
      try: async () => {
        const left = await operandPaths(options, payload.left, "left")
        const right = new Set(await operandPaths(options, payload.right, "right"))
        const leftover = left.filter((path) => !right.has(path))
        if (leftover.length > 0) {
          throw new Compose.FilesTestError({
            message: `expected the file-set difference to be empty, but ${leftover.length} file(s) ` +
              `in the left set are missing from the right set`,
            leftover: leftover.slice(0, issueLimit),
            unresolved: [],
            dynamic: []
          })
        }
        return undefined
      },
      catch: (cause) =>
        cause instanceof Compose.FilesTestError
          ? cause
          : new Compose.FilesTestError({
            message: failureMessage(cause),
            leftover: [],
            unresolved: [],
            dynamic: []
          })
    })
  )
