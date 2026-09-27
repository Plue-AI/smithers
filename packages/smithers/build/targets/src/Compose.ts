/**
 * PACKAGE.ts composition flavors: `S.Generate`, `S.Suite`, `S.Alias`,
 * `S.Test`, `S.Materialize`, `S.ImportClosure`, `S.Clean`, and the
 * `S.Files` algebra.
 *
 * Phase W1 is construct-only: constructors validate attrs by schema, record
 * dependency edges and declared inputs through {@link Target.make}'s attr
 * walk, and install {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import { constants as NodeFsConstants } from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Filegroup from "./Filegroup.ts"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/** The actions a Generate plan-time body may plan. */
type GenerateRequires =
  | Action.Requirement<"smithers-build/not-implemented">
  | Action.Requirement<"smithers-build/exec">
  | Action.Requirement<"smithers-build/generate-check">

/**
 * Schema for a reference to the file rows a resolver-style target produces,
 * `importGraph.files`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetFiles = Schema.TaggedStruct("TargetFiles", {
  target: Target.Target
})

/**
 * A reference to the file rows a target produces.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetFiles = typeof TargetFiles.Type

/**
 * Schema for one operand of the file algebra: a file-producing target or a
 * `.files` reference to one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FileSet = Schema.Union([Target.Target, TargetFiles])

/**
 * One operand of the file algebra.
 *
 * @category models
 * @since 0.1.0
 */
export type FileSet = typeof FileSet.Type

/**
 * Schema for `S.Files.difference(left, right)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilesDifference = Schema.TaggedStruct("FilesDifference", {
  left: FileSet,
  right: FileSet
})

/**
 * A declared file-set difference.
 *
 * @category models
 * @since 0.1.0
 */
export type FilesDifference = typeof FilesDifference.Type

/** Schema for `S.Files.digest(target)`, a deterministic path→digest table.
 *
 * @category targets
 * @since 0.1.0
 */
export const FilesDigest = Schema.TaggedStruct("FilesDigest", {
  target: Target.Target
})

/** A declared digest projection of a file-producing target.
 *
 * @category targets
 * @since 0.1.0
 */
export type FilesDigest = typeof FilesDigest.Type

const isFileSet = (value: unknown): value is FileSet =>
  Target.isTarget(value) ||
  (typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "TargetFiles" &&
    Target.isTarget((value as { readonly target?: unknown }).target))

/**
 * The declared file-set algebra, `S.Files`.
 *
 * `difference(left, right)` is an inert declaration: the sets subtract when
 * the consuming target executes, and the operand targets become ordinary
 * dependency edges through the attr walk.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Files = Object.freeze({
  difference: (left: FileSet, right: FileSet): FilesDifference => {
    if (!isFileSet(left) || !isFileSet(right)) {
      throw new TypeError("Files.difference operands must be targets or target .files references")
    }
    return Object.freeze({ _tag: "FilesDifference", left, right })
  },
  digest: (target: Target.AnyTarget): FilesDigest => {
    if (!Target.isTarget(target)) throw new TypeError("Files.digest requires a target")
    return Object.freeze({ _tag: "FilesDigest", target })
  }
})

/**
 * Attaches the non-enumerable `.files` reference resolver-style targets
 * expose, so `graphTarget.files` is an inert declaration naming the target's
 * file rows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const attachFiles = <T extends Target.AnyTarget>(target: T): T & { readonly files: TargetFiles } => {
  Object.defineProperty(target, "files", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ _tag: "TargetFiles", target }),
    writable: false
  })
  return target as T & { readonly files: TargetFiles }
}

/**
 * Attrs for {@link Generate}. Three observed forms share the schema: a
 * literal `emit` map, a `script` writing inside `changes`, and a `bin`
 * printing to `stdout` — exactly one of the three selectors is present.
 *
 * `mode` is the write/check pair every generated-file target carries. It
 * defaults to `write`, and the `lint` verb maps it to `check`, so a declaration
 * states what the generator produces and the verb decides whether the run
 * applies it or reports drift.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GenerateAttrs = Schema.Struct({
  emit: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Reference.Symlink]))),
  script: Schema.optional(Input.File),
  bin: Schema.optional(Attr.Executable),
  command: Schema.optional(Schema.NonEmptyString),
  args: Schema.optional(Attr.Args),
  env: Schema.optional(Attr.Env),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  stdout: Schema.optional(Schema.NonEmptyString),
  deps: Schema.optional(Schema.Array(Target.Dependency)),
  data: Schema.optional(Attr.Data),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  mode: GeneratedFile.Mode
})

/**
 * Payload for one generator drift check: the process the write form spawns,
 * and the declared outputs the check compares and restores.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GenerateCheckPayload = Schema.Struct({
  run: Exec.Payload,
  changes: Schema.Array(Schema.NonEmptyString)
})

/**
 * Payload for one generator drift check.
 *
 * @category models
 * @since 0.1.0
 */
export type GenerateCheckPayload = typeof GenerateCheckPayload.Type

/**
 * Runs a generator and reports whether its declared outputs were already
 * current.
 *
 * @category actions
 * @since 0.1.0
 */
export const GenerateCheck = Action.make("smithers-build/generate-check", {
  payload: GenerateCheckPayload,
  error: Schema.Union([Exec.ExecError, GeneratedFile.DriftError]),
  tier: "sealed"
})

/**
 * What one declared output is, beyond its bytes.
 *
 * A restore that knows only bytes cannot tell a regular file from a symlink
 * standing where one belongs, and would write through that symlink into a file
 * outside the declared tree.
 */
type OutputKind = "absent" | "directory" | "file" | "symlink" | "other"

/** One declared output exactly as it stood before the generator ran. */
interface OutputState {
  readonly kind: OutputKind
  /** Link target, or a bounded file preview used only for the first drift. */
  readonly bytes: Buffer | undefined
  /** Permission bits, so a chmod-only change is drift and is undone. */
  readonly mode: number | undefined
  readonly digest?: string | undefined
}

/** One declared output as it stood before the generator ran. */
interface OutputSnapshot extends OutputState {
  readonly path: string
}

/** A snapshot and the canonical root it is safe to restore beneath. */
interface OutputTreeSnapshot {
  readonly root: string
  readonly entries: ReadonlyArray<OutputSnapshot>
  readonly backup: string
  restoreAttempted: boolean
  restored: boolean
}

interface SnapshotLimits {
  readonly fileBytes?: number | undefined
  readonly totalBytes?: number | undefined
}

const maximumSnapshotFileBytes = 256 * 1024 * 1024
const maximumSnapshotTotalBytes = 1024 * 1024 * 1024
const snapshotConcurrency = 8
const outputChunkBytes = 64 * 1024

interface SnapshotBudget {
  readonly fileBytes: number
  readonly totalBytes: number
  bytes: number
}

const snapshotBudget = (limits: SnapshotLimits): SnapshotBudget => {
  const fileBytes = limits.fileBytes ?? maximumSnapshotFileBytes
  const totalBytes = limits.totalBytes ?? maximumSnapshotTotalBytes
  for (
    const [name, value, maximum] of [
      ["fileBytes", fileBytes, maximumSnapshotFileBytes],
      ["totalBytes", totalBytes, maximumSnapshotTotalBytes]
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error(`snapshot ${name} must be an integer from 0 to ${maximum}`)
    }
  }
  return { fileBytes, totalBytes, bytes: 0 }
}

/** Maximum code units one excerpted line contributes to a drift message. */
const maximumDriftExcerptCodeUnits = 200

const excerpt = (line: string | undefined): string =>
  line === undefined
    ? "(end of file)"
    : JSON.stringify(
      line.length > maximumDriftExcerptCodeUnits ? `${line.slice(0, maximumDriftExcerptCodeUnits)}...` : line
    )

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])

/**
 * Renders the first line at which a regenerated output differs.
 *
 * The path leads the message because a failure is reported by its message
 * alone, and an operator's next move is to open the file the generator would
 * have rewritten.
 */
const driftMessage = (path: string, previous: OutputState, current: OutputState): string => {
  if (previous.kind === "absent") return `${path} is written by the generator and the checkout does not carry it`
  if (current.kind === "absent") return `${path} is carried by the checkout and the generator removes it`
  if (previous.kind !== current.kind) {
    return `${path} is a ${previous.kind} in the checkout and the generator leaves a ${current.kind}`
  }
  if (previous.kind === "file" && previous.digest === current.digest) {
    return `${path} kept its contents and the generator changed its permissions`
  }
  if (previous.kind === "file" && (previous.bytes === undefined || current.bytes === undefined)) {
    return `${path} changed its contents (text preview limited to ${outputChunkBytes} bytes)`
  }
  if (previous.bytes === undefined || current.bytes === undefined) {
    return `${path} changed and the change is not readable as text`
  }
  if (equalBytes(previous.bytes, current.bytes)) {
    return `${path} kept its contents and the generator changed its permissions`
  }
  const checkedIn = decodeUtf8(previous.bytes).split("\n")
  const regenerated = decodeUtf8(current.bytes).split("\n")
  const differing = checkedIn.findIndex((line, position) => line !== regenerated[position])
  const line = differing === -1 ? Math.min(checkedIn.length, regenerated.length) : differing
  return `${path} drifted from its generated form: ` +
    `${checkedIn.length} line(s) checked in, ${regenerated.length} regenerated; ` +
    `first difference at line ${line + 1}: ${excerpt(checkedIn[line])} became ${excerpt(regenerated[line])}`
}

const absent: OutputState = { kind: "absent", bytes: undefined, mode: undefined }

/**
 * Reads one declared output without following a symlink in its path.
 *
 * Each ancestor must still be a real directory under the canonical root. The
 * final file is opened with `O_NOFOLLOW`, so a link swapped in after `lstat`
 * fails instead of exposing its target. Only ENOENT means absent.
 */
const checkedOutputPath = async (
  root: string,
  path: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> => {
  const absolute = NodePath.resolve(root, path)
  if (!SafeFs.inside(root, absolute)) throw new Error(`declared output escapes the workspace: ${path}`)
  const rootStats = await Fs.lstat(root)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`canonical workspace root was replaced while outputs were checked: ${root}`)
  }
  const relative = NodePath.relative(root, absolute)
  const segments = relative === "" ? [] : relative.split(NodePath.sep)
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    signal?.throwIfAborted()
    parent = NodePath.join(parent, segment)
    let stats
    try {
      stats = await Fs.lstat(parent)
    } catch (cause) {
      if (SafeFs.errorCode(cause) === "ENOENT") return undefined
      throw cause
    }
    const ancestor = NodePath.relative(root, parent).split(NodePath.sep).join("/")
    if (stats.isSymbolicLink()) {
      throw new Error(`declared output ${path} has a symbolic link ancestor: ${ancestor}`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`declared output ${path} has a non-directory ancestor: ${ancestor}`)
    }
  }
  return absolute
}

const readOutput = async (
  root: string,
  path: string,
  signal: AbortSignal | undefined,
  options: {
    readonly metadataOnly?: boolean
    readonly backup?: string
    readonly budget?: SnapshotBudget
    readonly preview?: boolean
  } = {}
): Promise<OutputState> => {
  signal?.throwIfAborted()
  const absolute = await checkedOutputPath(root, path, signal)
  if (absolute === undefined) return absent
  let stats
  try {
    stats = await Fs.lstat(absolute)
  } catch (cause) {
    if (SafeFs.errorCode(cause) === "ENOENT") return absent
    throw cause
  }
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", bytes: Buffer.from(await Fs.readlink(absolute), "utf8"), mode: undefined }
  }
  if (stats.isDirectory()) return { kind: "directory", bytes: undefined, mode: stats.mode & 0o7777 }
  if (!stats.isFile()) return { kind: "other", bytes: undefined, mode: stats.mode & 0o7777 }
  if (options.metadataOnly) return { kind: "file", bytes: undefined, mode: stats.mode & 0o7777 }
  const handle = await Fs.open(
    absolute,
    NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW | NodeFsConstants.O_NONBLOCK
  )
  let destination: Fs.FileHandle | undefined
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error(`declared output changed while it was being read: ${path}`)
    const fileLimit = options.budget?.fileBytes ?? maximumSnapshotFileBytes
    if (opened.size > fileLimit) throw new Error(`declared output exceeds its file byte limit of ${fileLimit}: ${path}`)
    if (options.backup !== undefined) {
      const target = NodePath.join(options.backup, "files", path)
      await Fs.mkdir(NodePath.dirname(target), { recursive: true })
      destination = await Fs.open(
        target,
        NodeFsConstants.O_WRONLY | NodeFsConstants.O_CREAT | NodeFsConstants.O_EXCL,
        0o600
      )
    }
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(outputChunkBytes)
    const preview = options.preview && opened.size <= outputChunkBytes ? Buffer.alloc(opened.size) : undefined
    let total = 0
    while (true) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      if (preview !== undefined && total < preview.length) {
        preview.set(chunk.subarray(0, preview.length - total), total)
      }
      total += bytesRead
      if (total > fileLimit) throw new Error(`declared output exceeds its file byte limit of ${fileLimit}: ${path}`)
      if (options.budget !== undefined) {
        options.budget.bytes += bytesRead
        if (options.budget.bytes > options.budget.totalBytes) {
          throw new Error(`declared output snapshot exceeds its aggregate byte limit of ${options.budget.totalBytes}`)
        }
      }
      hash.update(chunk)
      await destination?.writeFile(chunk)
    }
    const after = await handle.stat()
    if (
      total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`declared output changed while it was being read: ${path}`)
    }
    return { kind: "file", bytes: preview, digest: hash.digest("hex"), mode: opened.mode & 0o7777 }
  } finally {
    try {
      await destination?.close()
    } finally {
      await handle.close()
    }
  }
}

interface OutputWalk {
  readonly paths: Set<string>
  readonly visited: Set<string>
  directories: number
  entries: number
  files: number
}

type OutputWalkLimit = "directories" | "entries" | "files"

const withinOutputLimit = (key: OutputWalkLimit, value: number): void => {
  const limit = Input.defaultScanLimits[key]
  if (value > limit) throw new Error(`declared output scan exceeds its ${key} limit of ${limit}`)
}

const walkOutputDirectory = async (
  root: string,
  path: string,
  walk: OutputWalk,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (walk.visited.has(path)) return
  signal?.throwIfAborted()
  const depth = path === "." ? 0 : path.split("/").length
  if (depth > Input.defaultScanLimits.depth) {
    throw new Error(`declared output scan exceeds its depth limit of ${Input.defaultScanLimits.depth}`)
  }
  const absolute = await checkedOutputPath(root, path, signal)
  if (absolute === undefined) throw new Error(`declared output directory disappeared while it was being read: ${path}`)
  const directory = await SafeFs.resolveDirectory(absolute, {
    root,
    signal,
    what: "declared output directory"
  })
  if (directory === undefined) {
    throw new Error(`declared output directory was replaced while it was being read: ${path}`)
  }
  walk.visited.add(path)
  walk.directories += 1
  withinOutputLimit("directories", walk.directories)
  const remaining = Input.defaultScanLimits.entries - walk.entries
  const children = await SafeFs.listDirectory(absolute, directory, {
    root,
    signal,
    what: "declared output directory",
    directoryEntries: Math.min(SafeFs.maximumDirectoryEntries, remaining)
  })
  walk.entries += children.length
  withinOutputLimit("entries", walk.entries)
  for (const child of [...children].sort((left, right) => left.name.localeCompare(right.name))) {
    signal?.throwIfAborted()
    const childPath = path === "." ? child.name : `${path}/${child.name}`
    walk.paths.add(childPath)
    if (child.isDirectory()) {
      await walkOutputDirectory(root, childPath, walk, signal)
    } else {
      walk.files += 1
      withinOutputLimit("files", walk.files)
    }
  }
}

/**
 * Expands the declared `changes` patterns against the real tree.
 *
 * The expansion is not package scoped. `changes` is a write set, not an input
 * glob: a root declaration that names `packages/smithers/generated.ts` owns that
 * path even though `packages/smithers/PACKAGE.ts` makes the directory its own
 * package. Scoping it would expand to nothing, so the check would snapshot
 * nothing, compare nothing, and leave the generator's rewrite in the tree
 * while reporting success.
 */
const outputPaths = async (
  root: string,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<string>> => {
  const paths = new Set<string>()
  const walk: OutputWalk = { paths, visited: new Set(), directories: 0, entries: 0, files: 0 }
  for (const pattern of changes) {
    signal?.throwIfAborted()
    const expanded = await Input.expandGlob(root, "", pattern, { packageScoped: false, signal })
    for (const path of expanded) paths.add(path)
    const declared = Input.resolvePath("", pattern)
    paths.add(declared)
    if ((await readOutput(root, declared, signal, { metadataOnly: true })).kind === "directory") {
      await walkOutputDirectory(root, declared, walk, signal)
    }
  }
  return [...paths].sort()
}

const snapshotOutputs = async (
  workspaceRoot: string,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined,
  limits: SnapshotLimits = {}
): Promise<OutputTreeSnapshot> => {
  const budget = snapshotBudget(limits)
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  const backup = await Fs.mkdtemp(NodePath.join(await Fs.realpath(Os.tmpdir()), "smithers-generator-backup-"))
  try {
    if (SafeFs.inside(root, backup)) throw new Error(`generator backup must be outside the workspace: ${backup}`)
    const paths = await outputPaths(root, changes, signal)
    const entries = new Array<OutputSnapshot>(paths.length)
    let cursor = 0
    let failure: unknown
    const worker = async (): Promise<void> => {
      while (failure === undefined) {
        const index = cursor++
        if (index >= paths.length) return
        const path = paths[index]!
        try {
          entries[index] = { path, ...await readOutput(root, path, signal, { backup, budget }) }
          if (entries[index].kind === "other") throw new Error(`declared output is not recoverable: ${path}`)
        } catch (cause) {
          failure = cause
        }
      }
    }
    // Drain every active copy before cleanup, including when one worker fails.
    await Promise.all(Array.from({ length: Math.min(snapshotConcurrency, paths.length) }, worker))
    if (failure !== undefined) throw failure
    await Fs.writeFile(
      NodePath.join(backup, "manifest.json"),
      JSON.stringify({
        root,
        entries: entries.map(({ bytes, ...entry }) => ({ ...entry, link: bytes?.toString("utf8") }))
      }),
      { mode: 0o600 }
    )
    return { root, entries, backup, restoreAttempted: false, restored: false }
  } catch (cause) {
    await Fs.rm(backup, { recursive: true, force: true })
    throw cause
  }
}

const unchanged = (previous: OutputState, current: OutputState): boolean => {
  if (previous.kind !== current.kind || previous.mode !== current.mode || previous.digest !== current.digest) {
    return false
  }
  if (previous.bytes === undefined) return current.bytes === undefined
  return current.bytes !== undefined && equalBytes(previous.bytes, current.bytes)
}

/**
 * Puts one declared output back exactly as it was.
 *
 * Removal unlinks a final symlink instead of following it. Replacement files
 * use `O_NOFOLLOW`, so a link recreated between removal and open fails loudly.
 * Directories use a temporary owner-writable mode until their children return;
 * the restore applies recorded directory modes only after the whole tree exists.
 */
const sameContents = (previous: OutputState, current: OutputState): boolean => {
  if (previous.kind !== current.kind || previous.digest !== current.digest) return false
  if (previous.bytes === undefined) return current.bytes === undefined
  return current.bytes !== undefined && equalBytes(previous.bytes, current.bytes)
}

const needsReplacement = (previous: OutputState, current: OutputState): boolean =>
  previous.kind !== current.kind || !sameContents(previous, current)

const removeOutput = async (
  root: string,
  path: string,
  signal: AbortSignal | undefined
): Promise<void> => {
  signal?.throwIfAborted()
  const absolute = await checkedOutputPath(root, path, signal)
  if (absolute === undefined) return
  if (absolute === root) throw new Error("the workspace root cannot be replaced as a declared output")
  await Fs.rm(absolute, { force: true, recursive: true })
}

const restoreMode = async (
  root: string,
  path: string,
  previous: OutputState,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (previous.mode === undefined || (previous.kind !== "directory" && previous.kind !== "file")) return
  signal?.throwIfAborted()
  const absolute = await checkedOutputPath(root, path, signal)
  if (absolute === undefined) throw new Error(`declared output parent is missing during restore: ${path}`)
  const handle = await Fs.open(
    absolute,
    NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW | NodeFsConstants.O_NONBLOCK
  )
  try {
    const stats = await handle.stat()
    if (
      (previous.kind === "directory" && !stats.isDirectory()) ||
      (previous.kind === "file" && !stats.isFile())
    ) throw new Error(`declared output changed while its mode was being restored: ${path}`)
    await handle.chmod(previous.mode)
  } finally {
    await handle.close()
  }
}

const restoreOutput = async (
  root: string,
  path: string,
  previous: OutputState,
  replace: boolean,
  backup: string,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (previous.kind === "absent" || previous.kind === "other") return
  if (!replace) {
    if (previous.kind === "file") await restoreMode(root, path, previous, signal)
    return
  }
  signal?.throwIfAborted()
  const absolute = await checkedOutputPath(root, path, signal)
  if (absolute === undefined) throw new Error(`declared output parent is missing during restore: ${path}`)
  if (previous.kind === "directory") {
    await Fs.mkdir(absolute, { mode: (previous.mode ?? 0o755) | 0o700 })
    return
  }
  if (previous.kind === "symlink") {
    await Fs.symlink(previous.bytes === undefined ? "" : decodeUtf8(previous.bytes), absolute)
    return
  }
  const handle = await Fs.open(
    absolute,
    NodeFsConstants.O_WRONLY | NodeFsConstants.O_CREAT | NodeFsConstants.O_EXCL | NodeFsConstants.O_NOFOLLOW,
    previous.mode ?? 0o644
  )
  try {
    const source = await Fs.open(
      NodePath.join(backup, "files", path),
      NodeFsConstants.O_RDONLY | NodeFsConstants.O_NOFOLLOW
    )
    try {
      const buffer = Buffer.alloc(outputChunkBytes)
      while (true) {
        signal?.throwIfAborted()
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        await handle.writeFile(buffer.subarray(0, bytesRead))
      }
    } finally {
      await source.close()
    }
    if (previous.mode !== undefined) await handle.chmod(previous.mode)
  } finally {
    await handle.close()
  }
}

const byDepthThenPath = (left: { readonly path: string }, right: { readonly path: string }): number => {
  const leftDepth = left.path === "." ? 0 : left.path.split("/").length
  const rightDepth = right.path === "." ? 0 : right.path.split("/").length
  return leftDepth - rightDepth || left.path.localeCompare(right.path)
}

/**
 * Restores every declared output and reports the first one the generator
 * rewrote.
 */
const restoreOutputs = async (
  before: OutputTreeSnapshot,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined
): Promise<GeneratedFile.DriftError | undefined> => {
  const repaired = new Map<string, OutputState>()
  // Only snapshotted directories are ours to repair. Undeclared ancestors
  // still fail the no-follow check and leave the recovery tree intact.
  for (const entry of before.entries.filter((entry) => entry.kind === "directory").sort(byDepthThenPath)) {
    const current = await readOutput(before.root, entry.path, signal, { metadataOnly: true })
    if (current.kind !== "directory") {
      repaired.set(entry.path, current)
      await removeOutput(before.root, entry.path, signal)
      await restoreOutput(before.root, entry.path, entry, true, before.backup, signal)
    }
  }
  const previousByPath = new Map(before.entries.map((entry) => [entry.path, entry]))
  const paths = new Set(previousByPath.keys())
  for (const path of await outputPaths(before.root, changes, signal)) paths.add(path)
  const currentByPath = new Map<string, OutputState>()
  for (const path of [...paths].sort()) {
    currentByPath.set(path, await readOutput(before.root, path, signal))
  }
  const changed = [...paths]
    .map((path) => ({
      path,
      previous: previousByPath.get(path) ?? absent,
      current: repaired.get(path) ?? currentByPath.get(path) ?? absent
    }))
    .filter((entry) => !unchanged(entry.previous, entry.current))
  const first = [...changed].sort((left, right) => left.path.localeCompare(right.path))[0]
  if (first === undefined) return undefined
  const message = driftMessage(
    first.path,
    first.previous.kind === "file" && first.current.kind === "file"
      ? await readOutput(NodePath.join(before.backup, "files"), first.path, signal, { preview: true })
      : first.previous,
    first.previous.kind === "file" && first.current.kind === "file"
      ? await readOutput(before.root, first.path, signal, { preview: true })
      : first.current
  )
  for (const entry of [...changed].sort((left, right) => -byDepthThenPath(left, right))) {
    if (!repaired.has(entry.path) && needsReplacement(entry.previous, entry.current)) {
      await removeOutput(before.root, entry.path, signal)
    }
  }
  for (const entry of [...changed].sort(byDepthThenPath)) {
    await restoreOutput(
      before.root,
      entry.path,
      entry.previous,
      !repaired.has(entry.path) && needsReplacement(entry.previous, entry.current),
      before.backup,
      signal
    )
  }
  for (
    const entry of [...changed]
      .filter((candidate) => candidate.previous.kind === "directory")
      .sort((left, right) => -byDepthThenPath(left, right))
  ) {
    await restoreMode(before.root, entry.path, entry.previous, signal)
  }
  const drift = GeneratedFile.driftError(
    first.path,
    message,
    first.previous.kind === "absent" ? "missing" : "drifted"
  )
  return drift
}

/**
 * Runs a generator and fails when it rewrote a declared output.
 *
 * A generator writes into the real tree, which is the only tree it knows how
 * to write; the check snapshots every declared output first — its bytes, its
 * file type, and its permission bits, copied to a scoped scratch tree without
 * following a symlink — and restores each one before it settles, so a `lint`
 * run leaves the working tree
 * as it found it, whether the generator succeeded, drifted, or failed. A
 * generator that writes outside its declared `changes` is outside the
 * contract, exactly as it is under the build system's enforced write set.
 * Failed restoration retains the scratch tree and reports its recovery path.
 * `snapshotLimits` can lower the 256 MiB per-file and 1 GiB aggregate ceilings;
 * acquisition rejects an oversized snapshot before running the generator.
 *
 * @category effects
 * @since 0.1.0
 */
export const checkGenerator = (
  options: {
    readonly workspaceRoot: string
    readonly snapshotLimits?: SnapshotLimits | undefined
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnv?: ReadonlyArray<string> | undefined
    readonly environment?: Exec.ToolEnvironment | undefined
  },
  payload: GenerateCheckPayload
): Effect.Effect<void, Exec.ExecError | GeneratedFile.DriftError> => {
  const failed = (path: string) => (cause: unknown): GeneratedFile.DriftError =>
    GeneratedFile.driftError(path, GeneratedFile.failureMessage(cause), "unreadable")
  const declared = payload.changes[0] ?? "generated output"
  const recoveryFailure = (before: OutputTreeSnapshot) => (cause: unknown): GeneratedFile.DriftError =>
    failed(declared)(new Error(`${GeneratedFile.failureMessage(cause)}; generator backup retained at ${before.backup}`))
  const restore = (before: OutputTreeSnapshot) =>
    Effect.uninterruptible(Effect.tryPromise({
      try: async (signal) => {
        before.restoreAttempted = true
        const drift = await restoreOutputs(before, payload.changes, signal)
        before.restored = true
        return drift
      },
      catch: recoveryFailure(before)
    }))
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: (signal) => snapshotOutputs(options.workspaceRoot, payload.changes, signal, options.snapshotLimits),
      catch: failed(declared)
    }),
    (before) =>
      Effect.flatMap(
        Effect.exit(Exec.run(options, payload.run)),
        (ran) =>
          Effect.flatMap(
            restore(before),
            (drift): Effect.Effect<void, Exec.ExecError | GeneratedFile.DriftError> =>
              Exit.isFailure(ran)
                ? Effect.failCause(ran.cause)
                : drift === undefined
                ? Effect.void
                : Effect.fail(drift)
          )
      ),
    // An interrupted generator also returns its borrowed outputs. Failed
    // restoration keeps the only recoverable copy and names it in the error.
    (before) =>
      Effect.andThen(
        before.restoreAttempted ? Effect.void : Effect.orDie(restore(before)),
        Effect.orDie(Effect.tryPromise({
          try: async () => {
            if (before.restored) await Fs.rm(before.backup, { recursive: true, force: true })
          },
          catch: recoveryFailure(before)
        }))
      )
  )
}

/**
 * Implements {@link GenerateCheck} by running the generator against the real
 * tree and restoring its declared outputs.
 *
 * @category layers
 * @since 0.1.0
 */
export const GenerateCheckLive = (options: {
  readonly snapshotLimits?: SnapshotLimits | undefined
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly sensitiveEnv?: ReadonlyArray<string> | undefined
  readonly environment?: Exec.ToolEnvironment | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/generate-check">, never, FlowRuntime.FlowRuntime> =>
  GenerateCheck.toLayer((payload) => checkGenerator(options, payload))

/** Builds the exec payload one Generate declaration's process form spawns. */
const generatePayload = (attrs: typeof GenerateAttrs.Type): Exec.CallPayload | undefined => {
  if (attrs.script !== undefined) {
    return {
      cwd: ".",
      argv: [Shell.scriptInterpreterToken(attrs.script.path), Shell.scriptToken(attrs.script.path)],
      env: attrs.env ?? {},
      secrets: attrs.secrets ?? [],
      timeoutMs: Shell.packageExecTimeoutMs
    }
  }
  if (attrs.bin !== undefined) {
    return Shell.execPayload({
      bin: attrs.bin,
      args: attrs.args,
      env: attrs.env,
      secrets: attrs.secrets
    })
  }
  if (attrs.command !== undefined) {
    return Shell.execPayload({
      shell: attrs.command,
      env: attrs.env,
      secrets: attrs.secrets
    })
  }
  return undefined
}

const generateDefinition = Target.make("Generate", {
  attrs: GenerateAttrs,
  kinds: ["run", "lint"],
  // The three failures this target reports: the generator exited non-zero, a
  // declared output drifted, or the declaration is one no PACKAGE.ts workspace
  // can run. Declaring them keeps a drift report a target failure rather than
  // a flow body failing outside its schema.
  error: Schema.Union([Exec.ExecError, GeneratedFile.DriftError, Target.NotImplemented]),
  // The script and bin forms plan the shared exec node: the generator runs
  // under the workspace runtime (script) or the referenced tool (bin), and
  // the package executor brackets the spawn with write-set enforcement in
  // write mode or a scratch-copy drift check in check mode. A PACKAGE.ts
  // workspace has no package executor to bracket it, so `check` plans
  // {@link GenerateCheck} instead: the same spawn, with the declared outputs
  // compared and restored around it. The emit form plans no process at all —
  // the package executor writes or checks the declared file bytes and symlinks
  // natively — so its node stays the typed refusal for any path that is not
  // the package executor.
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<
    void | Exec.Result,
    Exec.ExecError | GeneratedFile.DriftError | Target.NotImplemented,
    GenerateRequires
  > => {
    const payload = generatePayload(attrs)
    if (payload === undefined) return Target.notImplemented("Generate")
    // A declaration with no `changes` is the stdout form, whose output only
    // the package executor captures. Both verbs are refused rather than run
    // against nothing: `run` would spawn the generator and report success
    // without writing the declared file, and `check` would snapshot nothing,
    // so the generator's rewrite would stay in the real tree behind an ok
    // verdict.
    const changes = attrs.changes ?? []
    if (attrs.mode !== "check") {
      return changes.length === 0
        ? Target.notImplemented("Generate stdout form in a PACKAGE.ts workspace")
        : Exec.runTool(payload)
    }
    return changes.length === 0
      ? Target.notImplemented("Generate check without declared changes")
      : GenerateCheck.call({ run: payload, changes })
  }
})

/**
 * Refuses a process form that names none of the paths it writes.
 *
 * `changes` and `stdout` are the write set: the build system confines the spawn to
 * it and reverts everything else, and a PACKAGE.ts workspace compares and
 * restores exactly the `changes` paths under the `lint` verb. A script, bin,
 * or command form that declares neither is confined by nothing, so it is
 * rejected where it is written rather than checked against an empty set. The
 * emit form names its outputs as the map keys and needs no separate write set.
 */
const requireWriteSet = (attrs: Record<string, unknown>): void => {
  if (attrs["emit"] !== undefined) return
  const changes = attrs["changes"]
  if ((Array.isArray(changes) && changes.length > 0) || attrs["stdout"] !== undefined) return
  throw new Error(
    "Generate requires changes or stdout: a script, bin, or command form declares the paths it writes"
  )
}

/**
 * A generated-output target: check by default, `--write` applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Generate = Target.guard(generateDefinition, (attrs) => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError("Generate attrs must be an object")
  Attr.requireOneExecutable("Generate", attrs, ["emit", "script", "bin", "command"])
  requireWriteSet(attrs)
})

/**
 * Attrs for {@link Suite}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SuiteAttrs = Schema.Struct({
  tests: Schema.Array(Target.Target)
})

const suiteDefinition = Target.make("Suite", {
  attrs: SuiteAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Suite")
})

/**
 * A named group of check-capable targets that run together.
 *
 * @category targets
 * @since 0.1.0
 */
export const Suite = suiteDefinition

/**
 * Attrs for {@link Alias}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AliasAttrs = Schema.Struct({
  target: Target.Target
})

/**
 * A second name for one target: a distinct target node whose kinds mirror
 * the aliased target and whose only dependency is it.
 *
 * A distinct node is what keeps the one-value-one-label law intact: the
 * alias has its own label, and the aliased target keeps its own.
 *
 * @category targets
 * @since 0.1.0
 */
export const Alias = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Alias requires a target")
  const kinds = Target.metadata(target).kinds
  const definition = Target.make("Alias", {
    attrs: AliasAttrs,
    kinds,
    implementation: () => Target.notImplemented("Alias")
  })
  return definition({ target })
}

/**
 * One declared source together with the directory its paths resolve from.
 *
 * `base` is the absolute directory of the PACKAGE.ts that declared the
 * source, or `""` when the source is already workspace anchored (a `//`
 * pattern, an explicit workspace-relative cwd, or a target constructed
 * outside a PACKAGE.ts module, as tests do). The executing layer maps a
 * non-empty `base` onto its workspace-relative package path; it is carried
 * as context for that mapping and is never cache-key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AnchoredSource = Schema.Struct({
  base: Schema.String,
  source: Filegroup.Source
})

/**
 * One declared source together with the directory its paths resolve from.
 *
 * @category models
 * @since 0.1.0
 */
export type AnchoredSource = typeof AnchoredSource.Type

/**
 * One file of a resolved import closure: a workspace-relative path and its
 * content digest.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureFile = Schema.Struct({
  path: Schema.String,
  digest: Schema.String
})

/**
 * One file of a resolved import closure.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureFile = typeof ClosureFile.Type

/**
 * One import a closure could not settle: the file that declared it and the
 * specifier as written (for a dynamic expression, its bounded source text).
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureIssue = Schema.Struct({
  file: Schema.String,
  specifier: Schema.String
})

/**
 * One import a closure could not settle.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureIssue = typeof ClosureIssue.Type

/**
 * A resolved import closure: the sorted reachable file set with digests, the
 * sorted set of node_modules packages the closure imports, and the explicit
 * unresolved and dynamic rows. Unresolved and dynamic outcomes are carried on
 * the result, never dropped: consumers that need a complete file set fail
 * closed on them.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureResult = Schema.Struct({
  files: Schema.Array(ClosureFile),
  packages: Schema.Array(Schema.String),
  unresolved: Schema.Array(ClosureIssue),
  dynamic: Schema.Array(ClosureIssue)
})

/**
 * A resolved import closure.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureResult = typeof ClosureResult.Type

/**
 * Resolving an import closure failed: an entry does not exist, a file could
 * not be read, the resolver configuration is invalid, or a bound was hit.
 *
 * @category errors
 * @since 0.1.0
 */
export class ImportClosureError extends Schema.TaggedError<ImportClosureError>()(
  "smithers-build/ImportClosureError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * A file-algebra assertion failed, or could not be answered completely.
 *
 * `leftover` lists files in the left set missing from the right set.
 * `unresolved` and `dynamic` carry closure rows the check refused to reason
 * past: a dead-code style consumer fails closed on an incomplete closure
 * rather than reporting live files as dead. Lists are bounded; the message
 * states the full counts.
 *
 * @category errors
 * @since 0.1.0
 */
export class FilesTestError extends Schema.TaggedError<FilesTestError>()(
  "smithers-build/FilesTestError",
  {
    message: Schema.NonEmptyString,
    leftover: Schema.Array(Schema.String),
    unresolved: Schema.Array(ClosureIssue),
    dynamic: Schema.Array(ClosureIssue)
  }
) {}

/**
 * Resolves the transitive import closure of the payload's entry sources.
 *
 * Executing a plan that contains this action requires the resolver layer,
 * `Resolver.ImportClosureLive` in `@smthrs/build-cli`.
 *
 * @category actions
 * @since 0.1.0
 */
export const ResolveImportClosure = Action.make("smithers-build/import-closure", {
  payload: Schema.Struct({ entries: Schema.Array(AnchoredSource) }),
  success: ClosureResult,
  error: ImportClosureError,
  tier: "sealed"
})

/**
 * One side of a declared file-set difference, reduced to an executable
 * description: a declared source set expanded as files, or the import
 * closure of declared entry sources.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilesCheckOperand = Schema.Union([
  Schema.TaggedStruct("SourceSet", { sources: Schema.Array(AnchoredSource) }),
  Schema.TaggedStruct("Closure", { entries: Schema.Array(AnchoredSource) })
])

/**
 * One side of a declared file-set difference.
 *
 * @category models
 * @since 0.1.0
 */
export type FilesCheckOperand = typeof FilesCheckOperand.Type

/**
 * Expands both operands, subtracts right from left by path, and requires the
 * remainder to match `toBe`. A closure operand with unresolved or dynamic
 * rows fails the check instead of answering from an incomplete set.
 *
 * Executing a plan that contains this action requires the resolver layer,
 * `Resolver.CheckFilesDifferenceLive` in `@smthrs/build-cli`.
 *
 * @category actions
 * @since 0.1.0
 */
export const CheckFilesDifference = Action.make("smithers-build/files-difference", {
  payload: Schema.Struct({
    left: FilesCheckOperand,
    right: FilesCheckOperand,
    toBe: Schema.Literal("empty")
  }),
  success: Schema.Void,
  error: FilesTestError,
  tier: "sealed"
})

/**
 * The target id every {@link ImportClosure} target reports as
 * `Target.Metadata.target`.
 *
 * @category constants
 * @since 0.1.0
 */
export const importClosureRuleId = "ImportClosure"

/**
 * Checks whether a value is an {@link ImportClosure} target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isImportClosure = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === importClosureRuleId

/** The entries union {@link ImportClosureAttrs} decodes to. */
type ImportClosureEntries =
  | Target.AnyTarget
  | Filegroup.Source
  | ReadonlyArray<Filegroup.Source | Target.AnyTarget>

/** Rewrites one declared source so its paths resolve from a workspace-relative cwd. */
const sourceAgainstCwd = (cwd: string, source: Filegroup.Source): Filegroup.Source =>
  source._tag === "File"
    ? { _tag: "File", path: Input.resolvePath(cwd, source.path) }
    : {
      _tag: "Glob",
      pattern: Input.resolvePath(cwd, source.pattern),
      exclude: source.exclude.map((entry) => Input.resolvePath(cwd, entry))
    }

/**
 * Walks one file group depth first, keeping each nested group's own anchor.
 *
 * A group whose `cwd` is the default `.` contributes package-relative sources
 * anchored at its declaring PACKAGE.ts directory; a group with an explicit
 * cwd contributes workspace-anchored sources, matching how the planner
 * expands group declarations. Nested groups are entered once each, targets
 * that are not groups contribute nothing, exactly as `Filegroup.sources`.
 */
const filegroupAnchoredSources = (
  group: Target.AnyTarget,
  into: Array<AnchoredSource>,
  seen: Set<Target.AnyTarget>
): void => {
  const metadata = Target.metadata(group)
  const attrs = metadata.attrs as Filegroup.Attrs
  const packageRelative = attrs.cwd === "."
  const base = packageRelative && metadata.sourceFile !== undefined
    ? NodePath.dirname(metadata.sourceFile)
    : ""
  for (const member of attrs.srcs) {
    if (Target.isTarget(member)) {
      if (!Filegroup.isFilegroup(member) || seen.has(member)) continue
      seen.add(member)
      filegroupAnchoredSources(member, into, seen)
      continue
    }
    into.push({ base, source: packageRelative ? member : sourceAgainstCwd(attrs.cwd, member) })
  }
}

/**
 * Reduces declared closure entries to anchored sources, or names the reason
 * they cannot be reduced yet.
 *
 * Plain globs anchor at the declaring PACKAGE.ts directory. File groups
 * flatten with each nested group's own anchor. Any other target — a bundler
 * resolve, a build output — cannot provide entry files until its lane lands,
 * and the returned reason becomes a loud typed refusal, never an empty set.
 *
 * @category expansion
 * @since 0.1.0
 */
export const closureEntrySources = (
  entries: ImportClosureEntries,
  context: Target.ImplementationContext
): ReadonlyArray<AnchoredSource> | string => {
  const list = Array.isArray(entries) ? entries : [entries as Filegroup.Source | Target.AnyTarget]
  const anchored: Array<AnchoredSource> = []
  for (const entry of list) {
    if (Target.isTarget(entry)) {
      if (!Filegroup.isFilegroup(entry)) {
        return `target ${Target.metadata(entry).target} cannot provide entry files yet`
      }
      filegroupAnchoredSources(entry, anchored, new Set([entry]))
      continue
    }
    anchored.push({ base: context.packageDirectory ?? "", source: entry })
  }
  return anchored
}

/**
 * Reduces one file-algebra operand to an executable description, or names
 * the reason it cannot be reduced yet.
 *
 * A file group becomes its anchored source set. An import-closure target, or
 * a `.files` reference to one, becomes a closure description over its entry
 * sources. Every other target is refused by name until its lane lands.
 *
 * @category expansion
 * @since 0.1.0
 */
export const checkOperand = (value: FileSet): FilesCheckOperand | string => {
  const target = Target.isTarget(value) ? value : value.target
  if (Filegroup.isFilegroup(target)) {
    const sources: Array<AnchoredSource> = []
    filegroupAnchoredSources(target, sources, new Set([target]))
    return { _tag: "SourceSet", sources }
  }
  if (isImportClosure(target)) {
    const metadata = Target.metadata(target)
    const entries = closureEntrySources(
      (metadata.attrs as { readonly entries: ImportClosureEntries }).entries,
      {
        sourceFile: metadata.sourceFile,
        packageDirectory: metadata.sourceFile === undefined ? undefined : NodePath.dirname(metadata.sourceFile)
      }
    )
    return typeof entries === "string" ? entries : { _tag: "Closure", entries: [...entries] }
  }
  return `target ${Target.metadata(target).target} does not expose a resolvable file set yet`
}

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  expect: Schema.Union([FilesDifference, FilesDigest]),
  toBe: Schema.Union([Schema.Literal("empty"), Input.File])
})

const testDefinition = Target.make("Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  success: Schema.Void,
  // NotImplemented is in the union so an operand kind whose lane has not
  // landed refuses with the typed error instead of failing the error-channel
  // schema decode.
  error: Schema.Union([FilesTestError, Target.NotImplemented]),
  implementation: (
    attrs
  ): Node.Node<
    void,
    FilesTestError | Target.NotImplemented,
    Action.Requirement<"smithers-build/not-implemented"> | Action.Requirement<"smithers-build/files-difference">
  > => {
    if (attrs.expect._tag === "FilesDigest") {
      return Target.notImplemented("Test: Files.digest comparison is executed by the build system")
    }
    if (attrs.toBe !== "empty") {
      return Target.notImplemented("Test: a file-set difference can only compare to empty")
    }
    const left = checkOperand(attrs.expect.left)
    if (typeof left === "string") return Target.notImplemented(`Test: ${left}`)
    const right = checkOperand(attrs.expect.right)
    if (typeof right === "string") return Target.notImplemented(`Test: ${right}`)
    return CheckFilesDifference.call({ left, right, toBe: attrs.toBe })
  }
})

/**
 * A declarative assertion over the file algebra.
 *
 * `expect` subtracts the right file set from the left at execution time and
 * `toBe: "empty"` requires no remainder. A closure operand that contains
 * unresolved or dynamic rows fails the assertion — dead-code style checks
 * fail closed on incomplete closures. Operand kinds no lane has implemented
 * yet refuse with a typed NotImplemented error.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = testDefinition

/**
 * Attrs for {@link Materialize}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MaterializeAttrs = Schema.Struct({
  target: Target.Target
})

const materializeDefinition = Target.make("Materialize", {
  attrs: MaterializeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Materialize")
})

/**
 * Places a build target's cached output tree into the working tree.
 *
 * @category targets
 * @since 0.1.0
 */
export const Materialize = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Materialize requires a target")
  return materializeDefinition({ target })
}

/**
 * Attrs for {@link ImportClosure}. `entries` is a file-producing target or a
 * declared glob list.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ImportClosureAttrs = Schema.Struct({
  entries: Schema.Union([
    Target.Target,
    Filegroup.Source,
    Schema.Array(Schema.Union([Filegroup.Source, Target.Target]))
  ])
})

const importClosureDefinition = Target.make(importClosureRuleId, {
  attrs: ImportClosureAttrs,
  kinds: ["build"],
  success: ClosureResult,
  // NotImplemented is in the union so an entry kind whose lane has not
  // landed refuses with the typed error instead of failing the error-channel
  // schema decode.
  error: Schema.Union([ImportClosureError, Target.NotImplemented]),
  implementation: (
    attrs,
    context
  ): Node.Node<
    ClosureResult,
    ImportClosureError | Target.NotImplemented,
    Action.Requirement<"smithers-build/not-implemented"> | Action.Requirement<"smithers-build/import-closure">
  > => {
    const entries = closureEntrySources(attrs.entries, context)
    return typeof entries === "string"
      ? Target.notImplemented(`ImportClosure: ${entries}`)
      : ResolveImportClosure.call({ entries: [...entries] })
  }
})

/**
 * The transitive import closure of the entry files, as per-file rows.
 *
 * The constructed target exposes `.files` like a bundler resolve target.
 * Execution resolves entries to files, parses each reachable module for its
 * import, export-from, require, and dynamic-import specifiers, and follows
 * resolved file edges to a fixed point. The result is the sorted reachable
 * file set with digests, the imported node_modules packages as package-level
 * names, and explicit unresolved and dynamic rows. The target itself is not
 * marked cacheable: its complete input set is the closure it computes, which
 * declared inputs alone do not identify; per-file resolver rows are cached
 * by the executing layer instead, keyed on file digest and resolver
 * configuration.
 *
 * @category targets
 * @since 0.1.0
 */
export const ImportClosure = Target.rule(
  importClosureDefinition,
  (
    attrs: (typeof ImportClosureAttrs)["~type.make.in"] & Target.Presentation
  ): Target.AnyTarget & { readonly files: TargetFiles } =>
    attachFiles(importClosureDefinition(attrs) as unknown as Target.AnyTarget)
)

/**
 * Attrs for {@link Clean}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CleanAttrs = Schema.Struct({
  targets: Schema.optional(Schema.Array(Target.Target)),
  paths: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const cleanDefinition = Target.make("Clean", {
  attrs: CleanAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Clean")
})

/**
 * Removes the declared targets' outputs and the named scratch paths, and
 * nothing else.
 *
 * @category targets
 * @since 0.1.0
 */
export const Clean = cleanDefinition
