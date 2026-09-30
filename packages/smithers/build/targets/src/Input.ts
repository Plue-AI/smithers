/**
 * Declared filesystem and repository inputs for build targets.
 *
 * Constructors in this module only create values, so declaration evaluation
 * remains pure. The planner calls {@link expandGlob}, {@link digestFile}, and
 * {@link digestFiles} during discovery to turn declarations into content
 * digests.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import createIgnore from "ignore"
import { Minimatch, minimatch } from "minimatch"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Yaml from "yaml"
import * as Config from "./Config.ts"
import * as SafeFs from "./SafeFs.ts"

/**
 * Schema for a lazily expanded glob.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Glob = Schema.TaggedStruct("Glob", {
  pattern: Schema.NonEmptyString,
  exclude: Schema.Array(Schema.String)
})

/**
 * A lazily expanded glob.
 *
 * @category models
 * @since 0.1.0
 */
export type Glob = typeof Glob.Type

/**
 * Schema for one declared file input.
 *
 * @category schemas
 * @since 0.1.0
 */
export const File = Schema.TaggedStruct("File", {
  path: Schema.NonEmptyString
})

/**
 * One declared file input.
 *
 * @category models
 * @since 0.1.0
 */
export type File = typeof File.Type

/**
 * Schema for a git diff treated as a content-digested declared input.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GitDiff = Schema.TaggedStruct("GitDiff", {
  base: Schema.NonEmptyString,
  /** Glob patterns the diff is narrowed to before it becomes key material. */
  paths: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Glob patterns restricting the diff to added files. */
  added: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** A regular expression source; only added lines matching it count. */
  addedLines: Schema.optional(Schema.NonEmptyString)
})

/**
 * A git diff treated as a content-digested declared input.
 *
 * @category models
 * @since 0.1.0
 */
export type GitDiff = typeof GitDiff.Type

/**
 * Schema for a pnpm workspace definition whose members are planner inputs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PnpmWorkspace = Schema.TaggedStruct("PnpmWorkspace", {
  path: Schema.NonEmptyString
})

/**
 * A pnpm workspace file expanded to its root and member manifests.
 *
 * @category models
 * @since 0.1.0
 */
export type PnpmWorkspace = typeof PnpmWorkspace.Type

/**
 * Schema for every declared input value the planner understands.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declared = Schema.Union([Glob, File, GitDiff, PnpmWorkspace])

/**
 * Every declared input value the planner understands.
 *
 * @category models
 * @since 0.1.0
 */
export type Declared = typeof Declared.Type

/**
 * A workspace-relative file path and the sha256 digest of its content.
 *
 * `digest` is undefined when the file does not exist.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileDigest {
  readonly path: string
  readonly digest: string | undefined
}

/**
 * Creates a declared glob without reading the filesystem.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const sources = Smithers.glob("src/*", { exclude: ["src/*.test.ts"] })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function glob(pattern: string, options?: { readonly exclude?: ReadonlyArray<string> }): Glob
export function glob(patterns: ReadonlyArray<string>): ReadonlyArray<Glob>
export function glob(
  pattern: string | ReadonlyArray<string>,
  options: { readonly exclude?: ReadonlyArray<string> } = {}
): Glob | ReadonlyArray<Glob> {
  if (typeof pattern === "string") {
    return Glob.make({ pattern, exclude: [...(options.exclude ?? [])] })
  }
  // The array form is the PACKAGE.ts spelling: positive patterns plus
  // `!`-prefixed excludes shared by every positive pattern. It returns one
  // declared glob per positive pattern so the existing single-pattern
  // expansion applies unchanged.
  const positives: Array<string> = []
  const excludes: Array<string> = []
  for (const entry of pattern) {
    if (typeof entry !== "string") throw new TypeError("glob patterns must be strings")
    if (entry.startsWith("!")) excludes.push(entry.slice(1))
    else positives.push(entry)
  }
  if (positives.length === 0) throw new Error("glob requires at least one positive pattern")
  return positives.map((positive) => Glob.make({ pattern: positive, exclude: [...excludes] }))
}

/**
 * Creates a declared file input without reading it.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const packageJson = Smithers.file("package.json")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const file = (path: string): File => File.make({ path })

/**
 * Creates a declared git diff input without invoking git.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const changes = Smithers.gitDiff("origin/main")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const gitDiff = (
  options?: string | {
    readonly base?: string
    readonly paths?: ReadonlyArray<string>
    readonly added?: ReadonlyArray<string>
    readonly addedLines?: string
  }
): GitDiff => {
  if (options === undefined) return GitDiff.make({ base: "HEAD" })
  if (typeof options === "string") return GitDiff.make({ base: validateGitBase(options) })
  return GitDiff.make({
    base: validateGitBase(options.base ?? "HEAD"),
    ...(options.paths === undefined ? {} : { paths: [...options.paths] }),
    ...(options.added === undefined ? {} : { added: [...options.added] }),
    ...(options.addedLines === undefined ? {} : { addedLines: options.addedLines })
  })
}

/**
 * Payload input declarations, `S.Input.String`, `S.Input.Optional`, and
 * `S.Input.Literals`. Defined in `Reference.ts`; re-exported here so the
 * `Smithers.Input` namespace carries the PACKAGE.ts spellings.
 *
 * @category constructors
 * @since 0.1.0
 */
export {
  inputLiterals as Literals,
  inputOptional as Optional,
  InputSpec as Spec,
  inputString as String
} from "./Reference.ts"

/**
 * Creates a workspace-membership input without reading the filesystem.
 *
 * The planner parses the named pnpm workspace file, validates its `packages`
 * list, and expands the root and member `package.json` files. The workspace
 * file and every resolved manifest then contribute content to the target key.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const pnpmWorkspace = (path: string): PnpmWorkspace => PnpmWorkspace.make({ path })

/** Reports whether UTF-8 encoding can preserve a string without replacement. */
const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/**
 * Validates a revision passed to `git diff` as an operand rather than an
 * option. The argv boundary also uses `--end-of-options`; this validation
 * keeps diagnostics deterministic on older Git versions and rejects text the
 * host cannot encode without replacement.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateGitBase = (base: string): string => {
  if (base === "" || base.startsWith("-") || base.includes("\0") || !isWellFormed(base)) {
    throw new Error(`git diff base is not a usable revision: ${JSON.stringify(base)}`)
  }
  return base
}

/** Applies the public schema only after the inspected fields are inert. */
const isDeclaredSchema = Schema.is(Declared)

/** The scalar and string-array fields the declared-input schemas may read. */
const declaredFields: Readonly<Record<string, ReadonlyArray<string>>> = {
  File: ["_tag", "path"],
  Glob: ["_tag", "pattern", "exclude"],
  GitDiff: ["_tag", "base", "paths", "added", "addedLines"],
  PnpmWorkspace: ["_tag", "path"]
}

/**
 * Checks a descriptor-only copy so schema recognition cannot invoke author
 * getters or proxy traps before the target construction boundary sees them.
 *
 * @category guards
 * @since 0.1.0
 */
export const isDeclared = <I>(value: I): value is I & Declared => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const tag = Object.getOwnPropertyDescriptor(value, "_tag")
  if (
    tag === undefined || !("value" in tag) || typeof tag.value !== "string" ||
    !Object.hasOwn(declaredFields, tag.value)
  ) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return false
  const copy: Record<string, unknown> = Object.create(null)
  for (const field of declaredFields[tag.value]!) {
    const descriptor = descriptors[field]
    if (descriptor === undefined) continue
    const member: unknown = descriptor.value
    if (typeof member !== "object" || member === null) {
      copy[field] = member
      continue
    }
    if (NodeUtil.isProxy(member) || !Array.isArray(member) || Object.getPrototypeOf(member) !== Array.prototype) {
      return false
    }
    const items: Array<unknown> = []
    for (let index = 0; index < member.length; index++) {
      const item = Object.getOwnPropertyDescriptor(member, String(index))
      if (item === undefined || !("value" in item)) return false
      items.push(item.value)
    }
    copy[field] = items
  }
  return isDeclaredSchema(copy)
}

const posix = (value: string): string => value.split(NodePath.sep).join("/")

const fixedStoreDirectory = `${Config.defaultCacheDirectory}/store`

const isWorkspaceStatePath = (cacheDirectory: string, path: string): boolean =>
  path === cacheDirectory ||
  path.startsWith(`${cacheDirectory}/`) ||
  path === fixedStoreDirectory ||
  path.startsWith(`${fixedStoreDirectory}/`)

/**
 * Resolves a declared input path or pattern against its package directory.
 *
 * Values starting with `//` resolve from the workspace root. A value starting
 * with a single `/` is refused rather than read as package-relative. Everything
 * else resolves from `packageDir`, the workspace-relative package path. The result
 * is a normalized workspace-relative posix path. Paths that escape the
 * workspace are refused.
 *
 * @category expansion
 * @since 0.1.0
 */
export const resolvePath = (packageDir: string, value: string): string => {
  if (value.includes("\0") || value.includes("\\") || !isWellFormed(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`declared input is not a portable workspace path: ${JSON.stringify(value)}`)
  }
  const rooted = value.startsWith("//")
  if (!rooted && value.startsWith("/")) {
    throw new Error(
      `declared input starts with a single "/": ${JSON.stringify(value)}; ` +
        `spell a workspace-root path with a leading "//"`
    )
  }
  const relative = rooted ? value.slice(2) : posix(NodePath.join(packageDir, value))
  const normalized = posix(NodePath.normalize(relative))
  if (normalized === ".." || normalized.startsWith("../") || NodePath.isAbsolute(normalized)) {
    throw new Error(`declared input escapes the workspace: ${value}`)
  }
  return normalized.replace(/^\.\//, "")
}

/**
 * Renders one declared path the way an argv running from `cwd` needs it.
 *
 * A `//` path is workspace-rooted, and a child runs under the target's `cwd`.
 * Stripping the `//` and handing the remainder to the child resolves it
 * against `cwd` instead of the root, so `//scripts/check.mjs` under cwd
 * `packages/foo` silently means `packages/foo/scripts/check.mjs`. This walks
 * back out to the root first. A package-relative path is already what the
 * child needs and passes through unchanged.
 *
 * @category expansion
 * @since 0.1.0
 */
export const rootRelative = (cwd: string, value: string): string => {
  if (!value.startsWith("//")) return value
  const from = posix(NodePath.normalize(cwd === "" ? "." : cwd))
  const rendered = posix(NodePath.relative(from === "." ? "." : from, value.slice(2)))
  return rendered === "" ? "." : rendered
}

/**
 * Resolves the directory of one declared file for a rule that runs there.
 *
 * A `//` path is workspace-rooted and yields the workspace-relative posix
 * directory: `//packages/x/package.json` is `packages/x` and `//package.json`
 * is `.`. A package-relative path resolves from the declaring package's
 * absolute `packageDirectory`; outside a PACKAGE.ts that base is the process
 * working directory. Exec resolves either shape against the workspace root
 * and refuses a directory that leaves it.
 *
 * @category expansion
 * @since 0.1.0
 */
export const declaredDirectory = (
  path: string,
  context: { readonly packageDirectory: string | undefined }
): string =>
  path.startsWith("//")
    ? posix(NodePath.dirname(path.slice(2)))
    : NodePath.resolve(context.packageDirectory ?? ".", NodePath.dirname(path))

interface IgnoreScope {
  readonly base: string
  readonly matcher: ReturnType<typeof createIgnore>
}

/**
 * Resource limits for one workspace traversal.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScanLimits {
  readonly entries: number
  readonly files: number
  readonly directories: number
  readonly depth: number
  readonly ignoreBytes: number
}

/**
 * Default and hard traversal ceilings. Smaller overrides are useful to hosts and tests.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumScanLimits: ScanLimits = Object.freeze({
  entries: 1_000_000,
  files: 500_000,
  directories: 100_000,
  depth: 256,
  ignoreBytes: 16 * 1024 * 1024
})

/**
 * Default traversal ceilings used when a caller supplies no override.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultScanLimits: ScanLimits = maximumScanLimits

const maximumGlobPatterns = 4096
const maximumPatternLength = 16 * 1024

const validatedScanLimits = (value: Partial<ScanLimits> | undefined): ScanLimits => {
  if (value === undefined) return defaultScanLimits
  const output = {} as { -readonly [Key in keyof ScanLimits]: number }
  for (const key of ["entries", "files", "directories", "depth", "ignoreBytes"] as const) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new TypeError("input scan limits could not be inspected")
    }
    const declared = descriptor === undefined ? defaultScanLimits[key] : "value" in descriptor
      ? descriptor.value
      : undefined
    if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 0) {
      throw new TypeError(`input scan limit ${key} must be a non-negative safe integer`)
    }
    if (declared > maximumScanLimits[key]) {
      throw new TypeError(`input scan limit ${key} exceeds ${maximumScanLimits[key]}`)
    }
    output[key] = declared
  }
  return output
}

const globMagic = /[*?[\]{}!()|@+]/

const staticPrefix = (pattern: string): string => {
  const segments: Array<string> = []
  for (const segment of pattern.split("/")) {
    if (globMagic.test(segment)) break
    segments.push(segment)
  }
  if (segments.length === pattern.split("/").length) segments.pop()
  return segments.join("/")
}

/**
 * Nouns that name the thing a confined read refused, so a diagnostic says what
 * the workspace was doing rather than only which syscall failed.
 */
const inputNoun = "declared input"
const ignoreNoun = ".gitignore"
const directoryNoun = "declared input directory"
const declarationFileNames = ["PACKAGE.ts"] as const

const insideEnteredRepository = (scan: Scan, relative: string): boolean => {
  for (const boundary of scan.enteredRepositories) {
    if (relative === boundary || relative.startsWith(`${boundary}/`)) return true
  }
  return false
}
const submoduleNoun = ".gitmodules"

/**
 * How many filesystem reads one walk keeps in flight at once.
 *
 * The walk fans out across siblings, so an unbounded descent holds one open
 * directory handle per directory at every level of the tree at the same time.
 * Every other stage of the pipeline caps its descriptor use at
 * {@link defaultDigestConcurrency}; this is the walk's share of the same
 * budget, so a wide workspace costs a fixed number of descriptors rather than
 * its own width.
 */
const walkConcurrency = 32

/** A fixed pool of permits handed out first come, first served. */
interface Permits {
  readonly acquire: () => Promise<void>
  readonly release: () => void
}

const makePermits = (count: number): Permits => {
  let available = count
  const waiting: Array<() => void> = []
  return {
    acquire: () => {
      if (available > 0) {
        available -= 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
    },
    release: () => {
      const next = waiting.shift()
      if (next === undefined) available += 1
      else next()
    }
  }
}

/**
 * Runs one of the walk's filesystem reads while holding a permit.
 *
 * The permit covers the read alone. A caller that descends into what it just
 * opened releases first, so a permit measures work in flight rather than depth
 * reached, and a deep tree cannot deadlock by holding a permit per level.
 *
 * A branch that starts after another has already failed re-reports that
 * failure instead of opening anything: once an expansion is going to reject,
 * more reads only add descriptor pressure to a result nobody will use.
 */
const permitted = async <A>(scan: Scan, read: () => Promise<A>): Promise<A> => {
  if (scan.failure !== undefined) throw scan.failure
  await scan.permits.acquire()
  try {
    return await read()
  } finally {
    scan.permits.release()
  }
}

/**
 * Runs one directory's sibling branches and waits for all of them.
 *
 * `Promise.all` hands the first rejection to its caller while the siblings are
 * still reading, which is exactly when a failing expansion would otherwise
 * keep opening directories nobody will look at. Settling every branch means a
 * rejected walk leaves no traversal read in flight.
 */
const branches = async (
  scan: Scan,
  operations: ReadonlyArray<() => Promise<void>>
): Promise<void> => {
  const settled = await Promise.all(operations.map(async (operation) => {
    try {
      await operation()
      return undefined
    } catch (cause) {
      scan.failure ??= cause
      return { cause }
    }
  }))
  const failed = settled.find((result) => result !== undefined)
  if (failed !== undefined) throw failed.cause
}

/**
 * Everything one glob expansion reads the filesystem through.
 *
 * `root` is canonical. Every path the walk touches is built from it, and every
 * directory it enters is re-confined to it, so no link inside the workspace
 * can move the expansion outside.
 */
interface Scan {
  readonly root: string
  readonly io: SafeFs.Io
  readonly cacheDirectory: string
  readonly packageScoped: boolean
  /** Apply source ignore rules, host-directory exclusions, and repository boundaries. */
  readonly sourceFilters: boolean
  readonly repositoryBoundaries: ReadonlyArray<string>
  readonly enteredRepositories: ReadonlySet<string>
  readonly found: Array<string>
  readonly limits: ScanLimits
  readonly signal: AbortSignal | undefined
  /** The permits every filesystem read the walk fans out through must hold. */
  readonly permits: Permits
  directories: number
  entries: number
  files: number
  ignoreBytes: number
  /** The first failure any branch of the walk reported, once one has. */
  failure: unknown
}

/** One directory the walk has opened, listed, and confined. */
interface Opened {
  readonly relative: string
  readonly entry: SafeFs.Entry
  readonly entries: ReadonlyArray<Dirent>
}

const scanOptions = (scan: Scan, what: string): SafeFs.Options => ({
  root: scan.root,
  io: scan.io,
  what,
  signal: scan.signal
})

const checkCancelled = (scan: Scan): void => scan.signal?.throwIfAborted()

const within = (scan: Scan, key: keyof ScanLimits, value: number): void => {
  if (value > scan.limits[key]) {
    throw new Error(`declared input scan exceeds its ${key} limit of ${scan.limits[key]}`)
  }
}

const addFile = (scan: Scan, path: string): void => {
  scan.files += 1
  within(scan, "files", scan.files)
  scan.found.push(path)
}

/**
 * Reads one directory's `.gitignore`, or nothing when there is none.
 *
 * Only a missing file means "no targets here". A `.gitignore` this process
 * cannot read, one that is a FIFO, one that is not valid UTF-8, and one over
 * the size limit all fail the expansion: a matcher built from a file that was
 * silently read as empty ignores nothing, which quietly pulls ignored paths
 * into a target's key material.
 */
const readIgnore = async (
  scan: Scan,
  relative: string
): Promise<ReturnType<typeof createIgnore> | undefined> => {
  checkCancelled(scan)
  if (!scan.sourceFilters) return undefined
  const text = await SafeFs.readText(
    NodePath.join(scan.root, relative, ".gitignore"),
    scanOptions(scan, ignoreNoun)
  )
  if (text !== undefined) {
    scan.ignoreBytes += Buffer.byteLength(text, "utf8")
    within(scan, "ignoreBytes", scan.ignoreBytes)
  }
  return text === undefined || text === "" ? undefined : createIgnore().add(text)
}

/**
 * Reports whether a directory listing makes the directory its own package,
 * meaning it holds a declaration module.
 *
 * The name is compared exactly, so a case-insensitive filesystem never
 * mistakes a `build.ts` source file for a package marker.
 *
 * A declaration that is a symbolic link counts exactly when the workspace index
 * would be willing to import it: when it resolves, inside the workspace, to a
 * regular file. Deciding otherwise would let a link either invent a package
 * boundary the index does not know about, or erase one the index does — and
 * the second is a package-scope bypass, because a glob would then walk into
 * files that belong to another package's targets.
 */
const isPackage = async (
  scan: Scan,
  relative: string,
  entries: ReadonlyArray<Dirent>
): Promise<boolean> => {
  if (insideEnteredRepository(scan, relative)) return false
  for (const name of declarationFileNames) {
    const marker = entries.find((entry) => entry.name === name)
    if (marker === undefined) continue
    if (marker.isFile()) return true
    if (!marker.isSymbolicLink()) continue
    const resolved = await SafeFs.resolveFile(
      NodePath.join(scan.root, relative, name),
      scanOptions(scan, name)
    )
    if (resolved !== undefined) return true
  }
  return false
}

/**
 * Reports whether a directory listing makes the directory a repository of its
 * own, meaning it holds a `.git` entry.
 *
 * An initialized submodule carries `.git` as a gitfile and a vendored clone
 * carries it as a directory; either way the files below it belong to that
 * repository, not to this workspace. The walk therefore treats the directory
 * as a boundary, the same answer {@link Scan.repositoryBoundaries} gives for a
 * repository the workspace declares. Without it a workspace listing would
 * change with the host's submodule state, so a generated registry would only
 * be reproducible in a checkout that never ran `git submodule update`.
 */
const isRepository = (entries: ReadonlyArray<Dirent>): boolean => entries.some((entry) => entry.name === ".git")

/**
 * Reads the repository paths a workspace's `.gitmodules` declares.
 *
 * A declared submodule is a boundary whether or not it is initialized, so the
 * declaration answers for the directory that is still empty and
 * {@link isRepository} answers for a clone the workspace never declared. A
 * workspace without the file declares none.
 */
const declaredSubmodules = async (
  root: string,
  io: SafeFs.Io,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<string>> => {
  const text = await SafeFs.readText(NodePath.join(root, ".gitmodules"), {
    root,
    io,
    what: submoduleNoun,
    signal
  })
  if (text === undefined) return []
  const declared: Array<string> = []
  for (const line of text.split("\n")) {
    const match = /^\s*path\s*=\s*(\S.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined) declared.push(resolvePath("", match[1]))
  }
  return declared
}

/**
 * Opens, confines, and lists one workspace-relative directory.
 *
 * Returns undefined when the directory is absent or is not a real directory,
 * which includes a symbolic link to one.
 */
const openDirectory = async (scan: Scan, relative: string): Promise<Opened | undefined> => {
  checkCancelled(scan)
  const depth = relative === "" ? 0 : relative.split("/").length
  within(scan, "depth", depth)
  const absolute = NodePath.join(scan.root, relative)
  const options = scanOptions(scan, directoryNoun)
  const entry = await SafeFs.resolveDirectory(absolute, options)
  if (entry === undefined) return undefined
  scan.directories += 1
  within(scan, "directories", scan.directories)
  const remaining = scan.limits.entries - scan.entries
  const entries = await SafeFs.listDirectory(absolute, entry, {
    ...options,
    directoryEntries: Math.min(SafeFs.maximumDirectoryEntries, remaining)
  })
  scan.entries += entries.length
  within(scan, "entries", scan.entries)
  return { relative, entry, entries }
}

/**
 * Opens every real directory from the workspace root down to the glob's static
 * prefix, or returns undefined when the prefix is not reachable through real,
 * confined directories.
 *
 * Resolving the whole chain is what closes the escape. The prefix used to be
 * admitted by a single `stat`, which follows symbolic links: a `src` link
 * pointing at another repository made the walk list that repository's files
 * and digest each one under a fabricated workspace-relative name. Now every
 * segment must itself be a directory the workspace really contains.
 */
const openChain = async (scan: Scan, start: string): Promise<ReadonlyArray<Opened> | undefined> => {
  const segments = start === "" ? [] : start.split("/")
  const chain: Array<Opened> = []
  let relative = ""
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) {
      const segment = segments[index - 1]!
      relative = relative === "" ? segment : `${relative}/${segment}`
    }
    const opened = await openDirectory(scan, relative)
    if (opened === undefined) return undefined
    chain.push(opened)
  }
  return chain
}

/**
 * Reports whether reaching a static-prefix directory would cross a package
 * boundary below the glob's declaring package.
 */
const crossesPackageBoundary = async (
  scan: Scan,
  packageDir: string,
  start: string,
  chain: ReadonlyArray<Opened>
): Promise<boolean> => {
  const packageSegments = packageDir === "" ? [] : packageDir.split("/")
  const startSegments = start === "" ? [] : start.split("/")
  if (
    packageSegments.length > startSegments.length ||
    packageSegments.some((segment, index) => startSegments[index] !== segment)
  ) return true
  for (let length = packageSegments.length + 1; length <= startSegments.length; length += 1) {
    const opened = chain[length]!
    if (await isPackage(scan, opened.relative, opened.entries)) return true
  }
  return false
}

const isIgnored = (
  scopes: ReadonlyArray<IgnoreScope>,
  path: string,
  isDirectory: boolean
): boolean => {
  let ignored = false
  for (const scope of scopes) {
    const relative = scope.base === "" ? path : path.slice(scope.base.length + 1)
    if (relative.length === 0) continue
    // A deeper rule overrides an ancestor only when it makes a decision.
    const result = scope.matcher.test(isDirectory ? `${relative}/` : relative)
    if (result.ignored || result.unignored) ignored = result.ignored
  }
  return ignored
}

/**
 * Reports whether a symbolic link found during a walk names workspace content.
 *
 * A link is a file input when it resolves, inside the canonical root, to a
 * regular file — the same target {@link digestFile} applies to a `file()`
 * declaration, so the two never disagree about what a target's inputs are. A
 * link that leaves the workspace, dangles, loops, or ends at a directory or a
 * device is not workspace content and is skipped, because a walk surveys a
 * tree rather than asserting anything about one named path. A declaration that
 * names such a link is a different matter and fails.
 *
 * A genuine I/O failure still propagates: "this link could not be read" is not
 * the same answer as "this link is not an input".
 */
const admitsLink = async (scan: Scan, child: string): Promise<boolean> => {
  const absolute = NodePath.join(scan.root, child)
  let target: string
  try {
    target = await scan.io.realpath(absolute)
  } catch (cause) {
    const code = SafeFs.errorCode(cause)
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false
    throw cause
  }
  if (!SafeFs.inside(scan.root, target)) return false
  return (await scan.io.lstat(target)).isFile()
}

const walk = async (
  scan: Scan,
  opened: Opened,
  scopes: ReadonlyArray<IgnoreScope>,
  bounded: boolean
): Promise<void> => {
  checkCancelled(scan)
  const relative = opened.relative
  if (bounded && scan.packageScoped && await isPackage(scan, relative, opened.entries)) return
  if (bounded && scan.sourceFilters && isRepository(opened.entries)) return
  const matcher = await permitted(scan, () => readIgnore(scan, relative))
  const next = matcher === undefined ? scopes : [...scopes, { base: relative, matcher }]
  // Classify this listing without I/O first, then open the children that need
  // it through the scan's permits. The walk is latency-bound on per-directory
  // opens and per-link stats rather than CPU-bound, so a serial descent costs
  // seconds on a package with thousands of directories, while an unbounded one
  // holds a descriptor per directory in the whole tree. Discovery order cannot
  // escape: callers sort `scan.found` before returning it.
  const directories: Array<string> = []
  const links: Array<string> = []
  for (const entry of opened.entries) {
    checkCancelled(scan)
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`
    const directory = entry.isDirectory()
    if (scan.sourceFilters) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      if (isWorkspaceStatePath(scan.cacheDirectory, child)) continue
      const repository = scan.repositoryBoundaries.find((boundary) => child === boundary)
      if (directory && repository !== undefined && !scan.enteredRepositories.has(repository)) continue
      if (
        scan.repositoryBoundaries.some((boundary) =>
          child === `${boundary}/.flows` || child.startsWith(`${boundary}/.flows/`)
        )
      ) continue
    }
    if (isIgnored(next, child, directory)) continue
    if (directory) directories.push(child)
    else if (entry.isFile()) addFile(scan, child)
    else if (entry.isSymbolicLink()) links.push(child)
  }
  await branches(scan, [
    ...links.map((child) => async () => {
      if (await permitted(scan, () => admitsLink(scan, child))) addFile(scan, child)
    }),
    ...directories.map((child) => async () => {
      const below = await permitted(scan, () => openDirectory(scan, child))
      if (below !== undefined) await walk(scan, below, next, true)
    })
  ])
}

/**
 * Expands one declared glob against the real filesystem.
 *
 * The walk starts at the pattern's static prefix, honors every `.gitignore`
 * from the workspace root down, and skips `.git`, `node_modules`, and the
 * configured cache directory, and the fixed `.flows/store` directory.
 * Skipping host state is unconditional: replayable cache, scratch, and store
 * data must never reach a content digest even when it is not ignored. The
 * result is a sorted list of workspace-relative posix file paths, so repeated
 * expansion of an unchanged tree is deterministic.
 *
 * Globs are package scoped, as they are in Bazel. The walk never descends
 * into a subdirectory that holds a PACKAGE.ts file, so a pattern declared in
 * `packages/smithers/flows/flow` matches `packages/smithers/flows/flow/src/index.ts` but not
 * `packages/smithers/flows/flow/examples/index.ts` once `packages/smithers/flows/flow/examples/PACKAGE.ts`
 * exists. The boundary applies even when a pattern's static prefix starts at
 * or below the subpackage: glob expansion cannot bypass Bazel package scope
 * by avoiding the filesystem walk through the marker directory. A `//` prefix
 * anchors pattern resolution at the workspace root but does not change the
 * declaring package's scope. Files in another package belong to that
 * package's own targets, and a target that wants them depends on its label
 * instead. The target applies to every glob in every target, not only to
 * `Filegroup`. The `packageScoped` option turns the boundary off for a caller
 * that is not expanding a declared input, such as the generated-output check
 * resolving the write set a generator declared.
 *
 * ## Confinement
 *
 * The walk stays inside the canonical workspace root. Every directory from the
 * root down to the static prefix, and every directory below it, must be a real
 * directory whose resolved path is still inside the root; a directory that
 * resolves outside fails the expansion rather than contributing files under
 * fabricated workspace-relative names. Symbolic links to directories are never
 * descended, so a link can neither leave the workspace nor make the walk loop.
 * A symbolic link to a file counts as an input on exactly the terms
 * {@link digestFile} applies to a declared file.
 *
 * A pattern whose static prefix does not exist, is not a real directory, or is
 * unreachable through real directories expands to an empty list, as does one
 * containing a `node_modules` segment or landing inside host state.
 *
 * @category expansion
 * @since 0.1.0
 */
export const expandGlob = async (
  workspaceRoot: string,
  packageDir: string,
  pattern: string | Glob,
  options: {
    readonly exclude?: ReadonlyArray<string>
    readonly cacheDirectory?: string | undefined
    readonly io?: SafeFs.Io | undefined
    readonly limits?: Partial<ScanLimits> | undefined
    /** Opaque child repositories that broad globs must not descend into. */
    readonly repositoryBoundaries?: ReadonlyArray<string> | undefined
    /**
     * Whether a nested `PACKAGE.ts` bounds the expansion. Defaults to `true`,
     * which is what a declared input glob means. A declared write set is not
     * a glob over the declaring package, so the generated-output check passes
     * `false`: the paths a generator names are its own wherever they live.
     */
    readonly packageScoped?: boolean | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<ReadonlyArray<string>> => {
  const patternText = typeof pattern === "string" ? pattern : pattern.pattern
  const excludeTexts = typeof pattern === "string" ? options.exclude ?? [] : pattern.exclude
  if (excludeTexts.length > maximumGlobPatterns) {
    throw new Error(`declared input glob has more than ${maximumGlobPatterns} exclusions`)
  }
  if ([patternText, ...excludeTexts].some((entry) => entry.length > maximumPatternLength)) {
    throw new Error(`declared input glob pattern exceeds ${maximumPatternLength} UTF-16 code units`)
  }
  const resolved = resolvePath(packageDir, patternText)
  const excludes = excludeTexts.map((entry) => resolvePath(packageDir, entry))
  const cacheDirectory = Config.normalizeCacheDirectory(
    options.cacheDirectory ?? Config.defaultCacheDirectory
  )
  const start = staticPrefix(resolved)
  if (start.split("/").includes("node_modules")) return []
  if (isWorkspaceStatePath(cacheDirectory, start)) return []
  const io = options.io ?? SafeFs.defaultIo
  const repositoryBoundaries = [...new Set((options.repositoryBoundaries ?? []).map((path) => resolvePath("", path)))]
    .sort()
  const enteredRepositories = new Set(
    repositoryBoundaries.filter((boundary) => start === boundary || start.startsWith(`${boundary}/`))
  )
  const scan: Scan = {
    root: await SafeFs.canonicalRoot(workspaceRoot, io),
    io,
    cacheDirectory,
    packageScoped: options.packageScoped ?? true,
    sourceFilters: true,
    repositoryBoundaries,
    enteredRepositories,
    found: [],
    limits: validatedScanLimits(options.limits),
    signal: options.signal,
    permits: makePermits(walkConcurrency),
    directories: 0,
    entries: 0,
    files: 0,
    ignoreBytes: 0,
    failure: undefined
  }
  const chain = await openChain(scan, start)
  if (chain === undefined) return []
  const resolvedPackage = resolvePath("", packageDir)
  const packageRoot = resolvedPackage === "." ? "" : resolvedPackage
  if (scan.packageScoped && await crossesPackageBoundary(scan, packageRoot, start, chain)) return []
  const scopes: Array<IgnoreScope> = []
  for (const ancestor of chain.slice(0, -1)) {
    // Git never reads rules below an excluded directory, even for a static prefix.
    if (isIgnored(scopes, ancestor.relative, true)) return []
    const matcher = await readIgnore(scan, ancestor.relative)
    if (matcher !== undefined) scopes.push({ base: ancestor.relative, matcher })
  }
  if (isIgnored(scopes, start, true)) return []
  await walk(scan, chain[chain.length - 1]!, scopes, false)
  // One matcher per pattern, not one per discovered path: these strings are
  // constant across the expansion, so compiling them inside the filter repeats
  // the same parse for every file a broad glob reached.
  const included = new Minimatch(resolved, { dot: true })
  const excluded = excludes.map((exclude) => new Minimatch(exclude, { dot: true }))
  return scan.found
    .filter((path) => included.match(path) && !excluded.some((exclude) => exclude.match(path)))
    .sort()
}

/**
 * Lists every file a workspace owns, without consulting git.
 *
 * This is the same walk {@link expandGlob} performs, with the package boundary
 * removed: workspace discovery has to see every `PACKAGE.ts`, so it cannot stop
 * at the first one. Everything else is identical, which is the point — the
 * fallback listing and a glob agree on which `.gitignore` files apply, which
 * symbolic links name workspace content, which directories are confined to the
 * root, and which host-state paths are never listed at all.
 *
 * Nested repositories are a boundary here as they are for a glob: a directory
 * holding a `.git` gitfile or directory is skipped, and so is every path the
 * root `.gitmodules` declares. A workspace listing is therefore the same
 * whether or not the host has run `git submodule update`.
 *
 * `.gitignore` files apply from the workspace root down, not only at the root,
 * so the listing matches what git would have reported. The result is sorted by
 * UTF-16 code unit.
 *
 * @category discovery
 * @since 0.1.0
 */
export const discoverFiles = async (
  workspaceRoot: string,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly io?: SafeFs.Io | undefined
    readonly limits?: Partial<ScanLimits> | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<ReadonlyArray<string>> => {
  const io = options.io ?? SafeFs.defaultIo
  const root = await SafeFs.canonicalRoot(workspaceRoot, io)
  const scan: Scan = {
    root,
    io,
    cacheDirectory: Config.normalizeCacheDirectory(
      options.cacheDirectory ?? Config.defaultCacheDirectory
    ),
    packageScoped: false,
    sourceFilters: true,
    repositoryBoundaries: await declaredSubmodules(root, io, options.signal),
    enteredRepositories: new Set(),
    found: [],
    limits: validatedScanLimits(options.limits),
    signal: options.signal,
    permits: makePermits(walkConcurrency),
    directories: 0,
    entries: 0,
    files: 0,
    ignoreBytes: 0,
    failure: undefined
  }
  const opened = await openDirectory(scan, "")
  if (opened === undefined) throw new Error(`workspace is not a directory: ${workspaceRoot}`)
  await walk(scan, opened, [], false)
  return scan.found.sort()
}

/**
 * Lists the files of a declared output directory without source-input filters.
 *
 * The directory is literal. Ignore rules, package and repository markers, and
 * host-directory names do not remove produced files. Workspace confinement,
 * scan limits, cancellation, and file-link admission match declared input scans.
 * Directory links are never followed.
 *
 * @category expansion
 * @since 0.1.0
 */
export const listOutputFiles = async (
  workspaceRoot: string,
  directory: string,
  options: {
    readonly io?: SafeFs.Io | undefined
    readonly limits?: Partial<ScanLimits> | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<ReadonlyArray<string>> => {
  const io = options.io ?? SafeFs.defaultIo
  const scan: Scan = {
    root: await SafeFs.canonicalRoot(workspaceRoot, io),
    io,
    cacheDirectory: Config.defaultCacheDirectory,
    packageScoped: false,
    sourceFilters: false,
    // Source-only cache and repository settings are inert for output inventories.
    repositoryBoundaries: [],
    enteredRepositories: new Set(),
    found: [],
    limits: validatedScanLimits(options.limits),
    signal: options.signal,
    permits: makePermits(walkConcurrency),
    directories: 0,
    entries: 0,
    files: 0,
    ignoreBytes: 0,
    failure: undefined
  }
  const relative = resolvePath("", directory)
  const chain = await openChain(scan, relative === "." ? "" : relative)
  if (chain === undefined) throw new Error(`declared output directory is unavailable: ${directory}`)
  await walk(scan, chain[chain.length - 1]!, [], false)
  return scan.found.sort()
}

const PnpmWorkspaceContents = Schema.Struct({
  packages: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.NonEmptyString))
})

const yamlFailure = (path: string, action: string, cause: unknown): Error =>
  new Error(`could not ${action} pnpm workspace ${path}`, { cause })

/**
 * Expands a pnpm workspace declaration to the files resolution reads.
 *
 * Workspace package patterns are relative to the workspace file, including
 * pnpm's leading-`!` exclusions. The result includes the workspace file, its
 * adjacent root manifest, every matching member manifest, and every patch file
 * its `patchedDependencies` names (also relative to the workspace file). This
 * makes one declaration both the membership source and the complete lockfile
 * input: pnpm records each patch's hash in the lockfile and applies it on
 * install, so a patch edit re-keys the install without a hand-kept list.
 *
 * @category expansion
 * @since 0.1.0
 */
export const expandPnpmWorkspace = async (
  workspaceRoot: string,
  packageDir: string,
  declaration: PnpmWorkspace,
  options: {
    readonly cacheDirectory?: string | undefined
    readonly io?: SafeFs.Io | undefined
    readonly limits?: Partial<ScanLimits> | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<ReadonlyArray<string>> => {
  const io = options.io ?? SafeFs.defaultIo
  const root = await SafeFs.canonicalRoot(workspaceRoot, io)
  const path = resolvePath(packageDir, declaration.path)
  const source = await SafeFs.readText(NodePath.join(root, path), {
    root,
    io,
    signal: options.signal,
    what: "pnpm workspace"
  })
  if (source === undefined) throw new Error(`pnpm workspace does not exist: ${path}`)
  let parsed: unknown
  try {
    parsed = Yaml.parse(source) as unknown
  } catch (cause) {
    throw yamlFailure(path, "parse", cause)
  }
  let contents: typeof PnpmWorkspaceContents.Type
  try {
    contents = Schema.decodeUnknownSync(PnpmWorkspaceContents)(parsed)
  } catch (cause) {
    throw yamlFailure(path, "validate", cause)
  }
  const directoryName = posix(NodePath.dirname(path))
  const directory = directoryName === "." ? "" : directoryName
  const patterns = contents.packages.map((entry) => {
    const excluded = entry.startsWith("!")
    const value = excluded ? entry.slice(1) : entry
    if (value === "") throw new Error(`pnpm workspace ${path} contains an empty exclusion`)
    return { excluded, pattern: resolvePath(directory, value) }
  })
  if (!patterns.some((pattern) => !pattern.excluded)) {
    throw new Error(`pnpm workspace ${path} contains no package inclusion`)
  }
  const files = await discoverFiles(root, {
    cacheDirectory: options.cacheDirectory,
    io,
    limits: options.limits,
    signal: options.signal
  })
  const members = files.filter((file) => {
    if (NodePath.posix.basename(file) !== "package.json") return false
    const member = NodePath.posix.dirname(file)
    return patterns.some(({ excluded, pattern }) => !excluded && minimatch(member, pattern, { dot: true })) &&
      !patterns.some(({ excluded, pattern }) => excluded && minimatch(member, pattern, { dot: true }))
  })
  const rootManifest = directory === "" ? "package.json" : `${directory}/package.json`
  const patches = Object.values(contents.patchedDependencies ?? {}).map((patch) => resolvePath(directory, patch))
  return [...new Set([path, rootManifest, ...members, ...patches])].sort()
}

/**
 * Computes the sha256 hex digest of a string.
 *
 * @category digests
 * @since 0.1.0
 */
export const digestText = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * Computes the sha256 hex digest of one file's content.
 *
 * Returns undefined when the file does not exist, so a declared-but-missing
 * file still contributes deterministic key material. Only a missing file is
 * missing: a permission error, an unreadable directory, and every other
 * failure is reported instead of being digested as absence.
 *
 * The content streams through a bounded buffer, so a large input costs a fixed
 * amount of heap rather than its own size. The file is read through a
 * descriptor that is checked to be the same regular file the path named, and
 * checked again after the last byte, so a file replaced or rewritten while it
 * was being digested fails rather than producing a digest of a file that never
 * existed. An entry that is not a regular file — a FIFO, a socket, a device, a
 * directory — is refused rather than read; a FIFO would otherwise block
 * planning forever.
 *
 * `options.workspaceRoot` confines the read. With it, the directory holding
 * the file is resolved before the file is touched, so no symbolic link, at the
 * entry or above it, can move the read outside the workspace; a symbolic link
 * is followed only when it resolves, inside that root, to a regular file, and
 * one that leaves the workspace is refused by name. Callers that already hold
 * a workspace pass it. It is optional only because a caller may have confined
 * the path itself.
 *
 * @category digests
 * @since 0.1.0
 */
export const digestFile = async (
  absolutePath: string,
  options: {
    readonly workspaceRoot?: string | undefined
    readonly io?: SafeFs.Io | undefined
    readonly signal?: AbortSignal | undefined
  } = {}
): Promise<string | undefined> => {
  const io = options.io ?? SafeFs.defaultIo
  const root = options.workspaceRoot === undefined
    ? undefined
    : await SafeFs.canonicalRoot(options.workspaceRoot, io)
  return SafeFs.digestFile(absolutePath, { root, io, signal: options.signal, what: inputNoun })
}

/**
 * Maximum files admitted to one digest batch.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumDigestFiles = 500_000
/**
 * Default number of file descriptors used by one digest batch.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultDigestConcurrency = 32

/**
 * Digests a set of workspace-relative files in sorted order.
 *
 * Every path is read under the canonical workspace root, so a path that
 * resolves outside it fails rather than contributing another tree's content to
 * this workspace's key material. Ordering is by UTF-16 code unit, which is the
 * same on every host.
 *
 * @category digests
 * @since 0.1.0
 */
export const digestFiles = async (
  workspaceRoot: string,
  paths: ReadonlyArray<string>,
  options: {
    readonly io?: SafeFs.Io | undefined
    readonly signal?: AbortSignal | undefined
    readonly concurrency?: number | undefined
    readonly maximumFiles?: number | undefined
  } = {}
): Promise<ReadonlyArray<FileDigest>> => {
  const concurrency = options.concurrency ?? defaultDigestConcurrency
  const maximumFiles = options.maximumFiles ?? maximumDigestFiles
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > defaultDigestConcurrency) {
    throw new TypeError(
      `digest concurrency must be an integer from 1 to ${defaultDigestConcurrency}, received ${
        typeof concurrency === "number" ? String(concurrency) : typeof concurrency
      }`
    )
  }
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles < 0 || maximumFiles > maximumDigestFiles) {
    throw new TypeError(
      `digest file limit must be an integer from 0 to ${maximumDigestFiles}, received ${
        typeof maximumFiles === "number" ? String(maximumFiles) : typeof maximumFiles
      }`
    )
  }
  if (paths.length > maximumFiles) {
    throw new Error(`declared input digest has ${paths.length} files, exceeding its limit of ${maximumFiles}`)
  }
  const io = options.io ?? SafeFs.defaultIo
  const root = await SafeFs.canonicalRoot(workspaceRoot, io)
  const ordered = [...paths].sort()
  const output = new Array<FileDigest>(ordered.length)
  let cursor = 0
  let failure: unknown
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      try {
        options.signal?.throwIfAborted()
        const index = cursor
        if (index >= ordered.length) return
        cursor += 1
        const path = ordered[index]!
        output[index] = {
          path,
          digest: await SafeFs.digestFile(NodePath.join(root, path), {
            root,
            io,
            signal: options.signal,
            what: inputNoun
          })
        }
      } catch (cause) {
        failure ??= cause
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ordered.length) }, () => worker())
  )
  if (failure !== undefined) throw failure
  return output
}
