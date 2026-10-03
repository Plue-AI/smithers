/**
 * Escape-hatch builds for non-TypeScript toolchains, plus the output-capture
 * vocabulary shared by every build target that produces files.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Exec from "./Exec.ts"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link ToolBuild}.
 *
 * `cwd` is the workspace-relative directory the command runs in and defaults
 * to the workspace root. `inputs` contains typed file declarations;
 * `outputs` stays a string list because it declares paths the action produces
 * rather than references to files it reads.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  tool: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  /** Explicit deadline for a long-running build; omitted targets retain Exec's ten-minute default. */
  timeout: Schema.optional(Shell.Duration),
  args: Schema.Array(Schema.String),
  inputs: Schema.Array(Input.Declared),
  /** Declared output paths, not input references. */
  outputs: Schema.Array(Schema.NonEmptyString),
  deps: Schema.Array(Target.Target),
  env: Schema.Record(Schema.String, Schema.String),
  cache: Schema.Boolean,
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link ToolBuild}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * One produced output: its declared path, how many files exist under it, and
 * the sha256 digest of its sorted paths and file contents.
 *
 * `path` is the declared value, relative to the target's `cwd`. A directory
 * contributes every file and nested directory beneath it; a plain file
 * contributes itself. File manifest entries include their executable bit, so
 * changing a tool into inert data changes the digest. An empty root directory
 * is a valid output and contributes zero files and the digest of an empty
 * list. A missing path is never an output: it fails the action.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  path: Schema.NonEmptyString,
  fileCount: Schema.Number,
  contentDigest: Schema.String
})

/**
 * One produced output.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type

/**
 * Success payload shared by build targets: every declared output with its
 * content digest.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Outputs = Schema.Struct({
  outputs: Schema.Array(Output)
})

/**
 * Success payload shared by build targets.
 *
 * @category models
 * @since 0.1.0
 */
export type Outputs = typeof Outputs.Type

/**
 * Digesting one declared output failed.
 *
 * `path` is the declared value, exactly as the target wrote it, so a diagnostic
 * names the declaration rather than a host path.
 *
 * @category errors
 * @since 0.1.0
 */
export class OutputError extends Schema.TaggedError<OutputError>()(
  "smithers-build/OutputError",
  {
    path: Schema.String,
    message: Schema.NonEmptyString
  }
) {}

/**
 * The failure channel of every target that captures declared outputs: the tool
 * run can fail, and so can the capture of what it was supposed to produce.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildError = Schema.Union([Exec.ExecError, OutputError])

/**
 * The failure channel of every target that captures declared outputs.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildError = typeof BuildError.Type

/**
 * Payload for one output capture: the target's working directory and the
 * declared output paths that resolve against it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CapturePayload = Schema.Struct({
  cwd: Schema.NonEmptyString,
  paths: Schema.Array(Schema.NonEmptyString)
})

/**
 * Payload for one output capture.
 *
 * @category models
 * @since 0.1.0
 */
export type CapturePayload = typeof CapturePayload.Type

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

/**
 * The explicit ceilings one declared output's metadata must stay under.
 *
 * The manifest an output produces is held in memory as one array before it is
 * digested, so the shape of the tree, not only the size of its files, needs a
 * bound. File contents are deliberately unbounded: an artifact may be any
 * size, and it streams through a fixed buffer. What is bounded is everything
 * that would otherwise grow the capture heap with the tree.
 *
 * `entries` is how many files and directories one output may contain, while
 * `files` separately bounds the files whose contents must be opened. Empty
 * directories count as entries: otherwise an output made only of directories
 * could grow without limit. `pathBytes` is the UTF-8 length of one path
 * relative to the declared root. `treeBytes` is the total over every such
 * path. `depth` is how far directories may nest below the root, which also
 * bounds the recursion that walks them.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaptureLimits {
  readonly entries: number
  readonly files: number
  readonly pathBytes: number
  readonly treeBytes: number
  readonly depth: number
}

/**
 * The ceilings capture applies when a caller names none.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCaptureLimits: CaptureLimits = Object.freeze({
  entries: 400_000,
  files: 200_000,
  pathBytes: 4096,
  treeBytes: 8 * 1024 * 1024,
  depth: 64
})

/** Hard ceilings keep caller-supplied limits from defeating bounded capture. */
const maximumCaptureLimits: CaptureLimits = Object.freeze({
  entries: 1_000_000,
  files: 1_000_000,
  pathBytes: 1024 * 1024,
  treeBytes: 256 * 1024 * 1024,
  depth: 1024
})

/**
 * Size of the read buffer each hashing worker streams file contents through.
 *
 * File contents are deliberately not capped: an output artifact may be any
 * size. Only the buffer that hashes it is bounded, so a one-gigabyte artifact
 * costs this many bytes of heap rather than a gigabyte. One buffer is
 * allocated per worker, not per file, so peak heap is this many bytes times
 * {@link digestConcurrency}.
 */
const readChunkBytes = 256 * 1024

/**
 * Orders strings by UTF-16 code unit. `localeCompare` answers differently
 * under different host locales and ICU versions, which would let one output
 * tree digest differently on different machines; code-unit order is the same
 * everywhere.
 */
const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Reports whether `candidate` is `root` or below it, lexically. */
const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/**
 * One open output file, reduced to the three operations capture performs on
 * it.
 *
 * `stat` must describe the open description itself, not the path it was opened
 * through, so a swap after the open cannot change the answer.
 *
 * @category models
 * @since 0.1.0
 */
export type CaptureStats = NodeFs.Stats | NodeFs.BigIntStats

/**
 * One descriptor used while capturing a declared output file.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaptureFile {
  readonly stat: () => Promise<CaptureStats>
  readonly read: (into: Uint8Array) => Promise<number>
  readonly close: () => Promise<void>
}

/**
 * The filesystem seam output capture reads the workspace through.
 *
 * Capture never calls `node:fs` directly; it calls this. Production supplies
 * {@link defaultCaptureIo}, and a test supplies a wrapper that swaps a path
 * between two named calls. A capture race is therefore reproduced by choosing
 * when the swap happens rather than by racing a timer, so the regression is
 * deterministic on every host.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaptureIo {
  readonly realpath: (path: string) => Promise<string>
  readonly lstat: (path: string) => Promise<CaptureStats>
  readonly readdir: (path: string, remaining?: number) => Promise<ReadonlyArray<NodeFs.Dirent>>
  readonly openFile: (path: string) => Promise<CaptureFile>
}

/**
 * Flags every output file is opened with.
 *
 * `O_NOFOLLOW` fails the open when the final component is a symbolic link, so
 * a link swapped in after the directory listing is refused by the kernel
 * rather than followed. `O_NONBLOCK` keeps the open from blocking forever on a
 * FIFO or a slow device swapped in the same way; the descriptor is then
 * rejected by its own `fstat`. Neither constant exists on Windows, where both
 * degrade to zero and the `fstat` check remains the guard.
 */
const openFlags = NodeFs.constants.O_RDONLY |
  (NodeFs.constants.O_NOFOLLOW ?? 0) |
  (NodeFs.constants.O_NONBLOCK ?? 0)

/**
 * Reads the real workspace through `node:fs`.
 *
 * @category execution
 * @since 0.1.0
 */
export const defaultCaptureIo: CaptureIo = {
  realpath: (path) => Fs.realpath(path),
  lstat: (path) => Fs.lstat(path, { bigint: true }),
  readdir: async (path, remaining = defaultCaptureLimits.entries) => {
    const directory = await Fs.opendir(path)
    const entries: Array<NodeFs.Dirent> = []
    let failure: unknown
    try {
      while (entries.length <= remaining) {
        const entry = await directory.read()
        if (entry === null) break
        entries.push(entry)
      }
    } catch (cause) {
      failure = cause
    }
    try {
      await directory.close()
    } catch (cause) {
      if (failure === undefined) failure = cause
    }
    if (failure !== undefined) throw failure
    return entries
  },
  openFile: async (path) => {
    const handle = await Fs.open(path, openFlags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async (into) => (await handle.read(into, 0, into.byteLength, null)).bytesRead,
      close: () => handle.close()
    }
  }
}

/** Identifies one filesystem object across two observations of it. */
const identity = (stats: CaptureStats): string => `${stats.dev}:${stats.ino}`

const integer = (value: number | bigint): bigint | undefined => {
  if (typeof value === "bigint") return value >= 0n ? value : undefined
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
}

const nanoseconds = (stats: CaptureStats, kind: "mtime" | "ctime"): bigint | undefined => {
  const exact = kind === "mtime" ? (stats as NodeFs.BigIntStats).mtimeNs : (stats as NodeFs.BigIntStats).ctimeNs
  if (typeof exact === "bigint") return exact >= 0n ? exact : undefined
  const milliseconds = kind === "mtime" ? stats.mtimeMs : stats.ctimeMs
  return typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0
    ? BigInt(Math.trunc(milliseconds * 1_000_000))
    : undefined
}

const executable = (stats: CaptureStats): boolean =>
  typeof stats.mode === "bigint" ? (stats.mode & 0o111n) !== 0n : (stats.mode & 0o111) !== 0

/**
 * Overrides for one capture.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaptureOptions {
  readonly io?: CaptureIo | undefined
  readonly limits?: CaptureLimits | undefined
  readonly cacheDirectory?: string | undefined
  readonly signal?: AbortSignal | undefined
}

type ManifestEntry =
  | readonly [kind: "directory", path: string]
  | readonly [kind: "file", path: string, executable: boolean, digest: string]

/** One file the walk reserved a manifest slot for but has not hashed yet. */
interface PendingFile {
  /** The slot in `found` this file's entry replaces. */
  readonly index: number
  readonly path: string
  readonly expected: string
  readonly relative: string
}

interface CaptureState {
  readonly io: CaptureIo
  readonly limits: CaptureLimits
  readonly root: string
  readonly base: string
  readonly declared: string
  readonly found: Array<ManifestEntry>
  readonly pending: Array<PendingFile>
  readonly keys: Set<string>
  readonly signal: AbortSignal | undefined
  entries: number
  files: number
  treeBytes: number
}

const fail = (state: CaptureState, message: string): OutputError => new OutputError({ path: state.declared, message })

const checkCancelled = (state: CaptureState): void => {
  if (state.signal?.aborted === true) throw fail(state, "declared output capture was cancelled")
}

const validatedLimits = (declared: string, value: CaptureLimits | undefined): CaptureLimits => {
  if (value === undefined) return defaultCaptureLimits
  const result = {} as { -readonly [Key in keyof CaptureLimits]: number }
  for (const key of ["entries", "files", "pathBytes", "treeBytes", "depth"] as const) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      throw new OutputError({ path: declared, message: "declared output capture limits could not be read" })
    }
    const limit = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
      throw new OutputError({ path: declared, message: `declared output capture limit ${key} is not usable` })
    }
    if (limit > maximumCaptureLimits[key]) {
      throw new OutputError({
        path: declared,
        message: `declared output capture limit ${key} exceeds ${maximumCaptureLimits[key]}`
      })
    }
    result[key] = limit
  }
  return result
}

const cachePath = (root: string, declared: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (value === "" || NodePath.isAbsolute(value)) {
    throw new OutputError({ path: declared, message: "configured cache directory is not workspace-relative" })
  }
  const absolute = NodePath.resolve(root, value)
  if (!inside(root, absolute) || absolute === root) {
    throw new OutputError({ path: declared, message: "configured cache directory leaves the workspace" })
  }
  return absolute
}

const refuseCacheOverlap = (
  declared: string,
  output: string,
  cache: string | undefined,
  canonicalOutput?: string | undefined,
  canonicalCache?: string | undefined
): void => {
  if (
    cache !== undefined && (inside(cache, output) || inside(output, cache)) ||
    canonicalOutput !== undefined && canonicalCache !== undefined &&
      (inside(canonicalCache, canonicalOutput) || inside(canonicalOutput, canonicalCache))
  ) {
    throw new OutputError({
      path: declared,
      message: `declared output overlaps the configured cache directory: ${declared}`
    })
  }
}

/**
 * Streams one file's SHA-256 through a caller-owned read buffer.
 *
 * The descriptor, not the path, is the unit of trust after the open: `fstat`
 * on it decides the file is regular and is still the object the parent listing
 * saw, and a second `fstat` after the last read decides nothing changed while
 * it was read. A partial read caused by concurrent truncation is caught by
 * comparing the byte count to the recorded size.
 *
 * Close runs whatever happened. A failure inside the read wins over a failure
 * to close, because it explains more; a failure to close a file that read
 * cleanly is still a failure, because an error reported by `close` can be the
 * report of a write-back that never landed.
 */
const hashFile = async (
  state: CaptureState,
  path: string,
  expected: string,
  buffer: Uint8Array
): Promise<{ readonly digest: string; readonly executable: boolean }> => {
  checkCancelled(state)
  const confineParent = async (): Promise<void> => {
    try {
      await confine(state, NodePath.dirname(path))
    } catch {
      throw fail(state, `declared output file was replaced while it was being captured: ${path}`)
    }
  }
  await confineParent()
  let handle: CaptureFile
  try {
    handle = await state.io.openFile(path)
  } catch (cause) {
    throw fail(state, `declared output file could not be opened: ${path}: ${failureMessage(cause)}`)
  }
  let failure: unknown
  let result: { readonly digest: string; readonly executable: boolean } | undefined
  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw fail(state, `declared output contains an entry that is not a file or a directory: ${path}`)
    }
    if (identity(before) !== expected) {
      throw fail(state, `declared output file was replaced while it was being captured: ${path}`)
    }
    const size = integer(before.size)
    const links = integer(before.nlink)
    const modified = nanoseconds(before, "mtime")
    const changed = nanoseconds(before, "ctime")
    if (size === undefined || links === undefined || modified === undefined || changed === undefined) {
      throw fail(state, `declared output file reports unusable metadata: ${path}`)
    }
    if (links !== 1n) {
      throw fail(state, `declared output contains a hard-linked file: ${path}`)
    }
    await confineParent()
    const opened = await state.io.lstat(path).catch(() => undefined)
    if (opened === undefined || opened.isSymbolicLink() || !opened.isFile() || identity(opened) !== expected) {
      throw fail(state, `declared output file was replaced while it was being captured: ${path}`)
    }
    const hash = createHash("sha256")
    let total = 0n
    while (true) {
      checkCancelled(state)
      const bytesRead = await handle.read(buffer)
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
        throw fail(state, `declared output file returned an invalid read length: ${path}`)
      }
      if (bytesRead === 0) break
      total += BigInt(bytesRead)
      hash.update(buffer.subarray(0, bytesRead))
    }
    await confineParent()
    const readPath = await state.io.lstat(path).catch(() => undefined)
    const after = await handle.stat()
    if (
      readPath === undefined || readPath.isSymbolicLink() || !readPath.isFile() || identity(readPath) !== expected ||
      identity(after) !== identity(before) || integer(after.size) !== size ||
      nanoseconds(after, "mtime") !== modified || nanoseconds(after, "ctime") !== changed ||
      integer(after.nlink) !== links ||
      executable(after) !== executable(before) || total !== size
    ) {
      throw fail(state, `declared output file changed while it was being read: ${path}`)
    }
    result = { digest: hash.digest("hex"), executable: executable(before) }
  } catch (cause) {
    failure = cause
  }
  try {
    await handle.close()
  } catch (cause) {
    if (failure === undefined) {
      failure = fail(state, `declared output file could not be closed: ${path}: ${failureMessage(cause)}`)
    }
  }
  if (failure !== undefined) throw failure
  if (result === undefined) throw fail(state, `declared output file could not be digested: ${path}`)
  return result
}

/** Names that cannot appear in a portable, unambiguous manifest path. */
const unusableName = (name: string): string | undefined => {
  if (name === "" || name === "." || name === "..") return "a reserved name"
  if (name.includes("/")) return "a path separator"
  if (name.includes("\\")) return "a backslash, which is a path separator on some hosts"
  if (name.includes("\0")) return "a null byte"
  if (name.includes("\uFFFD")) return "an invalid UTF-8 byte sequence"
  if (!name.isWellFormed()) return "an unpaired UTF-16 surrogate"
  return undefined
}

/**
 * Claims one manifest slot for a file, enforcing the tree's metadata limits.
 *
 * Reserving happens before the file is opened, so an output over a limit fails
 * without reading the contents it would then have thrown away. Every limit
 * fails the whole output: capture never returns a truncated manifest.
 */
const reserve = (state: CaptureState, path: string, file: boolean): string => {
  checkCancelled(state)
  const relative = NodePath.relative(state.base, path).split(NodePath.sep).join("/")
  const bytes = Buffer.byteLength(relative, "utf8")
  if (bytes > state.limits.pathBytes) {
    throw fail(state, `declared output contains a path longer than ${state.limits.pathBytes} bytes: ${relative}`)
  }
  if (state.entries >= state.limits.entries) {
    throw fail(state, `declared output contains more than ${state.limits.entries} entries`)
  }
  if (file && state.files >= state.limits.files) {
    throw fail(state, `declared output contains more than ${state.limits.files} files`)
  }
  state.treeBytes += bytes
  if (state.treeBytes > state.limits.treeBytes) {
    throw fail(state, `declared output path names total more than ${state.limits.treeBytes} bytes`)
  }
  // Two names that differ only by Unicode normal form or letter case address
  // the same file on a normalizing, case-insensitive filesystem (the macOS and
  // Windows defaults) and different files elsewhere. Either way the manifest
  // cannot say which, so the ambiguity is refused instead of digested.
  const key = relative.normalize("NFC").toLowerCase()
  if (state.keys.has(key)) {
    throw fail(state, `declared output contains two paths that normalize alike: ${relative}`)
  }
  state.keys.add(key)
  state.entries += 1
  if (file) state.files += 1
  return relative
}

/** Refuses a traversed path that resolves outside the canonical workspace. */
const confine = async (state: CaptureState, path: string): Promise<void> => {
  checkCancelled(state)
  const real = await state.io.realpath(path).catch(() => undefined)
  if (real === undefined || !inside(state.root, real)) {
    throw fail(state, `declared output resolves outside the workspace: ${state.declared}`)
  }
}

/**
 * Collects one output directory's files as posix-relative path and content
 * digest pairs.
 *
 * A symbolic link is refused rather than followed. Following one would let a
 * link planted inside an output decide what the digest covers, and could hash
 * content the workspace does not own; a build that needs to publish a link has
 * to declare what it points at instead.
 *
 * `expected` is the identity the parent listing observed for this directory.
 * The directory is re-checked against it before its entries are read and again
 * after, and re-confined to the canonical workspace root, so a directory
 * renamed or replaced mid-capture fails the whole output rather than
 * contributing half of one tree and half of another to a published manifest.
 */
const collect = async (
  state: CaptureState,
  directory: string,
  expected: string,
  depth: number
): Promise<void> => {
  checkCancelled(state)
  if (depth > state.limits.depth) {
    throw fail(state, `declared output nests more than ${state.limits.depth} directories deep: ${directory}`)
  }
  const before = await state.io.lstat(directory).catch((cause: unknown) => {
    throw fail(state, `declared output directory could not be read: ${directory}: ${failureMessage(cause)}`)
  })
  if (!before.isDirectory() || identity(before) !== expected) {
    throw fail(state, `declared output directory was replaced while it was being captured: ${directory}`)
  }
  await confine(state, directory)
  // The one I/O step between the two identity checks. A directory replaced by
  // a file in this window makes the listing itself fail with ENOTDIR, and an
  // unreadable directory fails with EACCES; both are this output's failure,
  // not a raw error the caller has to attribute to a path itself.
  const entries = [
    ...await state.io.readdir(directory, state.limits.entries - state.entries).catch((cause: unknown) => {
      throw fail(state, `declared output directory could not be listed: ${directory}: ${failureMessage(cause)}`)
    })
  ]
  if (entries.length > state.limits.entries - state.entries) {
    throw fail(state, `declared output contains more than ${state.limits.entries} entries`)
  }
  entries.sort((left, right) => byCodeUnit(left.name, right.name))
  for (const entry of entries) {
    checkCancelled(state)
    const unusable = unusableName(entry.name)
    if (unusable !== undefined) {
      throw fail(state, `declared output contains a name with ${unusable}: ${JSON.stringify(entry.name)}`)
    }
    const child = NodePath.join(directory, entry.name)
    const stats = await state.io.lstat(child).catch((cause: unknown) => {
      throw fail(
        state,
        `declared output entry was replaced while it was being captured: ${child}: ${failureMessage(cause)}`
      )
    })
    // The listing's own answer counts as well as the fresh one: an entry that
    // was a link when it was listed is refused even if it is a plain file now.
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw fail(state, `declared output contains a symbolic link: ${child}`)
    }
    if (stats.isDirectory()) {
      const relative = reserve(state, child, false)
      state.found.push(["directory", relative])
      await collect(state, child, identity(stats), depth + 1)
    } else if (stats.isFile()) {
      // Reserving stays in traversal order, so every limit and every
      // normalization clash still fails exactly where it fails today. Only
      // the read is deferred, and it lands back in this reserved slot.
      const relative = reserve(state, child, true)
      state.pending.push({ index: state.found.length, path: child, expected: identity(stats), relative })
      state.found.push(["file", relative, false, ""])
    } else {
      throw fail(state, `declared output contains an entry that is not a file or a directory: ${child}`)
    }
  }
  const after = await state.io.lstat(directory).catch(() => undefined)
  if (after === undefined || !after.isDirectory() || identity(after) !== identity(before)) {
    throw fail(state, `declared output directory was replaced while it was being captured: ${directory}`)
  }
}

/** Workers that hash deferred files concurrently, each with its own buffer. */
const digestConcurrency = 32

/**
 * Hashes every file the walk deferred, bounded to {@link digestConcurrency}
 * workers.
 *
 * Capture is latency-bound on per-file open/stat/read round trips, not on
 * SHA-256 throughput, so a serial pass costs seconds on an output tree with
 * thousands of small files. Each worker owns one read buffer, which is what
 * made the serial pass necessary in the first place.
 *
 * Concurrency cannot reach the digest: every slot was reserved during the
 * ordered walk, results land back in their own slot, and the manifest is
 * sorted by path before it is hashed. When several files fail, the one lowest
 * in traversal order is reported, which is the failure a serial pass would
 * have raised.
 */
const drainPending = async (state: CaptureState): Promise<void> => {
  const jobs = state.pending
  if (jobs.length === 0) return
  let cursor = 0
  let failureIndex = Number.POSITIVE_INFINITY
  let failure: unknown
  const worker = async (): Promise<void> => {
    const buffer = Buffer.allocUnsafe(readChunkBytes)
    while (failure === undefined) {
      const position = cursor
      if (position >= jobs.length) return
      cursor += 1
      const job = jobs[position]!
      try {
        const measured = await hashFile(state, job.path, job.expected, buffer)
        state.found[job.index] = ["file", job.relative, measured.executable, measured.digest]
      } catch (cause) {
        if (position < failureIndex) {
          failureIndex = position
          failure = cause
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(digestConcurrency, jobs.length) }, () => worker()))
  if (failure !== undefined) throw failure
}

/**
 * Measures one declared output, or fails with an {@link OutputError}.
 *
 * Every declared output is required, which is Bazel's target for an action that
 * does not create one: a missing path, an unreadable path, and a path that is
 * neither a plain file nor a directory each fail the target instead of
 * digesting as empty. An empty directory is a real result and digests to zero
 * files.
 *
 * `declared` resolves against `cwd`, which resolves against the workspace
 * root, and the result must stay inside the workspace both lexically and after
 * symbolic links resolve. Capture therefore cannot read or hash a target
 * outside the workspace, whether a declaration or a link planted during the
 * build points there. The declaration itself is re-checked here even though
 * target metadata already checked it, because this function is also reached from
 * an action payload and from a cache entry.
 *
 * The digest covers the sorted list of posix-relative paths and their content
 * digests, so an unchanged tree digests identically on every host and
 * regardless of directory order. File contents stream through one bounded
 * buffer, so an artifact of any size costs a fixed amount of heap; the tree's
 * metadata is what carries the explicit ceilings in {@link CaptureLimits}. Any
 * limit fails the whole output: capture never returns a truncated manifest.
 *
 * ## Boundary
 *
 * Node exposes no `openat`, no `O_PATH`, and no way to read a directory
 * through a descriptor already proven to be the right one, so a traversal
 * capability cannot be held across syscalls the way a `*at` API would let it
 * be. What is done instead is to observe an identity for every directory and
 * file when its parent lists it, and to re-check that identity, the entry
 * type, and the canonical workspace root at every later step: before a
 * directory's entries are read, after they are read, on the descriptor a file
 * is opened through, and again after that file has been read. A path replaced
 * inside any of those windows is refused, and the whole output fails rather
 * than publishing a manifest assembled from two different trees. The one
 * window that cannot be closed is between the last check and the syscall it
 * guards: `O_NOFOLLOW` and the descriptor's own `fstat` close it for the file
 * being hashed, and for an intermediate directory it stays open. This is not
 * race freedom, and no portable Node API can provide it.
 *
 * @category execution
 * @since 0.1.0
 */
export const measureOutput = async (
  workspaceRoot: string,
  cwd: string,
  declared: string,
  options: CaptureOptions = {}
): Promise<Output> => {
  const io = options.io ?? defaultCaptureIo
  if (options.signal?.aborted === true) {
    throw new OutputError({ path: declared, message: "declared output capture was cancelled" })
  }
  const root = await io.realpath(workspaceRoot).catch((cause: unknown) => {
    throw new OutputError({
      path: declared,
      message: `workspace root could not be resolved: ${failureMessage(cause)}`
    })
  })
  const unusable = Target.declaredOutputFailure(cwd, declared)
  if (unusable !== undefined) throw new OutputError({ path: declared, message: unusable })
  const absolute = NodePath.resolve(root, cwd, declared)
  if (!inside(root, absolute)) {
    throw new OutputError({ path: declared, message: `declared output leaves the workspace: ${declared}` })
  }
  const cache = cachePath(root, declared, options.cacheDirectory)
  refuseCacheOverlap(declared, absolute, cache)
  let stats
  try {
    stats = await io.lstat(absolute)
  } catch (cause) {
    const code = SafeFs.errorCode(cause)
    throw new OutputError({
      path: declared,
      message: code === "ENOENT"
        ? `declared output was not created: ${declared}`
        : `declared output could not be read: ${declared}: ${failureMessage(cause)}`
    })
  }
  if (stats.isSymbolicLink()) {
    throw new OutputError({ path: declared, message: `declared output is a symbolic link: ${declared}` })
  }
  const canonicalOutput = await io.realpath(absolute).catch(() => undefined)
  if (canonicalOutput === undefined || !inside(root, canonicalOutput)) {
    throw new OutputError({ path: declared, message: `declared output resolves outside the workspace: ${declared}` })
  }
  const canonicalCache = cache === undefined ? undefined : await io.realpath(cache).catch(() => undefined)
  if (canonicalCache !== undefined && !inside(root, canonicalCache)) {
    throw new OutputError({
      path: declared,
      message: "configured cache directory resolves outside the workspace"
    })
  }
  refuseCacheOverlap(declared, absolute, cache, canonicalOutput, canonicalCache)
  const state: CaptureState = {
    io,
    limits: validatedLimits(declared, options.limits),
    root,
    // A directory output names its files relative to itself; a file output
    // contributes exactly its own basename. Both manifest shapes are documented
    // on {@link Output} and neither changes here.
    base: stats.isDirectory() ? absolute : NodePath.dirname(absolute),
    declared,
    found: [],
    pending: [],
    keys: new Set(),
    signal: options.signal,
    entries: 0,
    files: 0,
    treeBytes: 0
  }
  // A path that vanished between the two calls, or one reached through a
  // symbolic link ancestor pointing out of the workspace, is refused here.
  await confine(state, absolute)
  if (stats.isDirectory()) await collect(state, absolute, identity(stats), 0)
  else if (stats.isFile()) {
    const relative = reserve(state, absolute, true)
    const measured = await hashFile(state, absolute, identity(stats), Buffer.allocUnsafe(readChunkBytes))
    state.found.push(["file", relative, measured.executable, measured.digest])
  } else {
    throw new OutputError({
      path: declared,
      message: `declared output is not a file or a directory: ${declared}`
    })
  }
  await drainPending(state)
  state.found.sort((left, right) => byCodeUnit(left[1], right[1]))
  return { path: declared, fileCount: state.files, contentDigest: digest(JSON.stringify(state.found)) }
}

/**
 * Measures every declared output in declaration order.
 *
 * The set is validated before anything is measured, so a payload that names
 * one file twice, names one output below another, or names the workspace root
 * fails before it can read a byte.
 *
 * @category execution
 * @since 0.1.0
 */
export const measureOutputs = async (
  workspaceRoot: string,
  cwd: string,
  paths: ReadonlyArray<string>,
  options: CaptureOptions = {}
): Promise<Outputs> => {
  const unusable = Target.declaredOutputsFailure({ cwd, paths })
  if (unusable !== undefined) throw new OutputError({ path: paths[0] ?? "", message: unusable })
  const outputs: Array<Output> = []
  for (const declared of paths) {
    if (options.signal?.aborted === true) {
      throw new OutputError({ path: declared, message: "declared output capture was cancelled" })
    }
    outputs.push(await measureOutput(workspaceRoot, cwd, declared, options))
  }
  return { outputs }
}

const hexDigest = /^[0-9a-f]{64}$/

const dataRecord = (
  value: unknown,
  names: ReadonlyArray<string>
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key))) {
    return undefined
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined || !("value" in descriptor)) return undefined
    result[name] = descriptor.value
  }
  return result
}

const denseArray = (value: unknown, expectedLength: number): ReadonlyArray<unknown> | undefined => {
  if (!Array.isArray(value) || NodeUtil.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return undefined
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")
  if (length === undefined || !("value" in length) || length.value !== expectedLength) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expectedLength + 1 || !keys.includes("length")) return undefined
  const result: Array<unknown> = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor)) return undefined
    result.push(descriptor.value)
  }
  return result
}

/**
 * Reads an untrusted value as the exact output manifest `declared` promises.
 *
 * Returns the manifest, or a diagnostic naming the first thing wrong with it.
 * The value comes either from a target implementation's success payload or from a
 * cache entry that may have been written by another machine, a shared store, or
 * a hand edit, so nothing about it is assumed:
 *
 * - The manifest must be an object carrying an `outputs` array.
 * - Its entries must match the declared paths one for one, in declaration
 *   order. An omission, an extra, a reorder, a duplicate, and a forged path are
 *   all refused. Positional comparison is what makes a forgery detectable: a
 *   manifest cannot drop the output it failed to produce and substitute one it
 *   knows is present.
 * - `fileCount` must be a non-negative safe integer and `contentDigest` a
 *   lowercase 64-character hex digest, so a manifest cannot smuggle a
 *   `-0`, a `NaN`, a float, or a non-digest string past the comparison.
 *
 * @category validation
 * @since 0.1.0
 */
export const readOutputManifest = (
  declared: Target.DeclaredOutputs,
  value: unknown
): Outputs | string => {
  // A target that declares zero output paths has nothing to verify, so a void
  // success value is the exact manifest. Anything else is still inspected:
  // an empty declaration does not license a made-up result.
  if (declared.paths.length === 0 && value === undefined) return { outputs: [] }
  try {
    const root = dataRecord(value, ["outputs"])
    if (root === undefined) return "the result carries no output manifest (an exact object is required)"
    const outputs = denseArray(root.outputs, declared.paths.length)
    if (outputs === undefined) return "the output manifest is not an exact dense list"
    const entries: Array<Output> = []
    const seen = new Set<string>()
    for (let index = 0; index < outputs.length; index += 1) {
      const expected = declared.paths[index]!
      const entry = dataRecord(outputs[index], ["contentDigest", "fileCount", "path"])
      if (entry === undefined) return `output ${expected} is not recorded as an exact object`
      const { contentDigest, fileCount, path } = entry
      if (path !== expected) {
        return `the output manifest records ${JSON.stringify(path)} where the target declares ${
          JSON.stringify(expected)
        }`
      }
      if (seen.has(expected)) return `the output manifest records ${expected} twice`
      seen.add(expected)
      if (
        typeof fileCount !== "number" || !Number.isSafeInteger(fileCount) ||
        fileCount < 0 || Object.is(fileCount, -0)
      ) {
        return `output ${expected} records an unusable file count`
      }
      if (typeof contentDigest !== "string" || !hexDigest.test(contentDigest)) {
        return `output ${expected} records an unusable content digest`
      }
      entries.push({ path: expected, fileCount, contentDigest })
    }
    return { outputs: entries }
  } catch {
    return "the output manifest could not be inspected safely"
  }
}

/**
 * Re-measures every declared output and compares it to a manifest.
 *
 * Returns undefined when the tree on disk still holds exactly what the
 * manifest records, and a diagnostic otherwise. Both a fresh success and a
 * cache admission run this: measurement is the only evidence that a producing
 * action actually produced what it promised, and a manifest that measurement
 * disagrees with is never trusted, whichever side wrote it.
 *
 * @category validation
 * @since 0.1.0
 */
export const verifyOutputs = async (
  workspaceRoot: string,
  declared: Target.DeclaredOutputs,
  value: unknown,
  options: CaptureOptions = {}
): Promise<string | undefined> => {
  const unusable = Target.declaredOutputsFailure(declared)
  if (unusable !== undefined) return unusable
  const manifest = readOutputManifest(declared, value)
  if (typeof manifest === "string") return manifest
  for (const recorded of manifest.outputs) {
    let measured: Output
    try {
      measured = await measureOutput(workspaceRoot, declared.cwd, recorded.path, options)
    } catch (cause) {
      return `output ${recorded.path} could not be measured: ${failureMessage(cause)}`
    }
    if (measured.fileCount !== recorded.fileCount || measured.contentDigest !== recorded.contentDigest) {
      return `output ${recorded.path} no longer matches the recorded digest`
    }
  }
  return undefined
}

/**
 * Digests the declared outputs of a build target.
 *
 * @category actions
 * @since 0.1.0
 */
export const CaptureOutputs = Action.make("smithers-build/capture-outputs", {
  payload: CapturePayload,
  success: Outputs,
  error: OutputError,
  tier: "sealed"
})

/**
 * Implements {@link CaptureOutputs} with {@link measureOutputs}, resolving
 * declared paths against `workspaceRoot`.
 *
 * @category layers
 * @since 0.1.0
 */
export const CaptureOutputsLive = (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/capture-outputs">, never, FlowRuntime.FlowRuntime> =>
  CaptureOutputs.toLayer((payload) =>
    Effect.tryPromise({
      try: (signal) =>
        measureOutputs(options.workspaceRoot, payload.cwd, payload.paths, {
          cacheDirectory: options.cacheDirectory,
          signal
        }),
      catch: (cause) =>
        !NodeUtil.isProxy(cause) && cause instanceof OutputError
          ? cause
          : new OutputError({ path: "", message: failureMessage(cause) })
    })
  )

/**
 * Plans the output-capture step every producing build target ends with: one
 * {@link CaptureOutputs} call that digests each declared output path into the
 * {@link Outputs} success payload.
 *
 * `paths` resolve against `cwd`, the directory the producing tool ran in, and
 * every one of them is required: a tool that exits zero without creating a
 * declared output fails its target rather than reporting an empty output.
 *
 * `produced` is the producing step, and capture is sequenced after it with the
 * node form of `Node.andThen`. Two properties of the surrounding machinery
 * decide that shape, and both were learned by watching every execution of this
 * target fail before its tool ran:
 *
 * - The builder form of `andThen`, and `Node.map`, keep their plan-time
 *   function in a side table the AST loses on its way to the engine. A target
 *   built from either refuses with `incomplete_graph` or `missing_operation`
 *   at execution. Capture is therefore one action whose own success type is
 *   the payload the target declares, with nothing to map afterwards.
 * - The ordering edge is recorded against exactly the node `andThen` is given.
 *   The capture call has to be that node, not a node wrapped around it, or the
 *   interpreter settles the wrapper's children concurrently and digests the
 *   outputs while the tool is still producing them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const captureOutputs = <R>(
  produced: Node.Node<Exec.Result, Exec.ExecError, R>,
  cwd: string,
  paths: ReadonlyArray<string>
): Node.Node<Outputs, BuildError, R | Action.Requirement<"smithers-build/capture-outputs">> =>
  produced.pipe(Node.andThen(CaptureOutputs.call({ cwd, paths })))

/**
 * Runs one arbitrary command for Rust, Zig, native addons, or another
 * toolchain through the shared {@link Exec.Exec} action.
 *
 * The plan records `command` plus `args` executed in `cwd` with `env` merged
 * over the host environment, then the shared output-capture step that digests
 * every declared output into the {@link Outputs} success payload. A tool that
 * exits zero without creating a declared output fails the target, as it does
 * in Bazel. Declared `inputs` contribute content digests to key material and
 * `deps` contribute dependency edges. This is the deliberate escape hatch for
 * tevm's Rust build targets and follows Bazel genrule prior art.
 *
 * Executing the plan requires {@link Exec.ExecLive} and
 * {@link CaptureOutputsLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const ToolBuild = Target.make("ToolBuild", {
  attrs: Attrs,
  kinds: ["build"],
  success: Outputs,
  error: BuildError,
  cache: (attrs) => attrs.cache,
  outputs: (attrs) => ({ cwd: attrs.cwd, paths: attrs.outputs }),
  implementation: (attrs) =>
    captureOutputs(
      Exec.runTool({
        cwd: attrs.cwd,
        argv: [attrs.command, ...attrs.args],
        env: attrs.env,
        ...(attrs.timeout === undefined ? {} : { timeoutMs: Shell.durationMs(attrs.timeout) })
      }),
      attrs.cwd,
      attrs.outputs
    )
})
