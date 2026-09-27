/**
 * Filesystem reads that hold the workspace trust boundary.
 *
 * Discovery reads files a workspace owns, and only files a workspace owns. A
 * path is a name, not an object: between the moment discovery decides a name
 * is admissible and the moment it reads through that name, the name can be
 * pointed at something else. This module reads through descriptors instead,
 * and re-checks every decision against the descriptor it actually holds.
 *
 * Three targets apply to everything here.
 *
 * 1. **Confinement.** A read is confined to a canonical workspace root. The
 *    directory holding the entry is resolved with `realpath` before the entry
 *    is touched, so a symbolic link anywhere in the path — including one
 *    swapped in above the entry — cannot move the read outside the root.
 * 2. **Regular files only.** A FIFO blocks the reader forever, a device is not
 *    repository content, and a directory is not a file. Each is refused rather
 *    than read. `O_NOFOLLOW` and `O_NONBLOCK` are added where the platform has
 *    them so the kernel refuses a link or a FIFO swapped in after the `lstat`,
 *    and `fstat` on the descriptor decides the question again regardless.
 * 3. **Only ENOENT means absent.** A permission error, a corrupt directory, or
 *    an unsupported entry type is reported. Converting one into "the file is
 *    not there" turns a broken workspace into a green one.
 *
 * @since 0.1.0
 */

import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"

/**
 * The size of the reusable buffer content streams through.
 *
 * File contents are deliberately not capped for digests: a declared input may
 * be any size. Only the buffer that hashes it is bounded, so a one-gigabyte
 * input costs this many bytes of heap rather than a gigabyte.
 *
 * @category models
 * @since 0.1.0
 */
export const chunkBytes = 256 * 1024

/**
 * The default size limit for a file read into memory as text.
 *
 * Text reads — a `.gitignore`, for instance — are bounded, because the whole
 * decoded string is held at once. A file over the limit fails the read rather
 * than being silently truncated into a matcher that ignores the wrong paths.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultTextBytes = 1024 * 1024

/**
 * Hard ceiling for any text file materialized by this boundary.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTextBytes = 16 * 1024 * 1024

/**
 * Maximum entries one directory listing may return.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumDirectoryEntries = 100_000

/**
 * Filesystem metadata with lossless bigint fields in production.
 *
 * @category models
 * @since 0.1.0
 */
export type Stats = NodeFs.Stats | NodeFs.BigIntStats

/**
 * One open file, reduced to the three operations a confined read performs on
 * it.
 *
 * `stat` must describe the open description itself, not the path it was opened
 * through, so a swap after the open cannot change the answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface OpenFile {
  readonly stat: () => Promise<Stats>
  readonly read: (into: Uint8Array) => Promise<number>
  readonly close: () => Promise<void>
}

/**
 * The filesystem seam confined reads go through.
 *
 * Nothing in this module calls `node:fs` directly; it calls this. Production
 * supplies {@link defaultIo}, and a test supplies a wrapper that swaps a path
 * between two named calls. A traversal race is therefore reproduced by
 * choosing when the swap happens rather than by racing a timer, so the
 * regression is deterministic on every host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Io {
  readonly realpath: (path: string) => Promise<string>
  readonly lstat: (path: string) => Promise<Stats>
  readonly readdir: (path: string, limit?: number) => Promise<ReadonlyArray<NodeFs.Dirent>>
  readonly open: (path: string) => Promise<OpenFile>
}

/**
 * Flags every confined read opens with.
 *
 * `O_NOFOLLOW` fails the open when the final component is a symbolic link, so
 * a link swapped in after the `lstat` is refused by the kernel rather than
 * followed. `O_NONBLOCK` keeps the open from blocking forever on a FIFO or a
 * slow device swapped in the same way; the descriptor is then rejected by its
 * own `fstat`. Neither constant exists on Windows, where both degrade to zero
 * and the `fstat` check remains the guard.
 */
const openFlags = NodeFs.constants.O_RDONLY |
  (NodeFs.constants.O_NOFOLLOW ?? 0) |
  (NodeFs.constants.O_NONBLOCK ?? 0)

/**
 * Reads the real filesystem through `node:fs`.
 *
 * @category execution
 * @since 0.1.0
 */
export const defaultIo: Io = {
  realpath: (path) => Fs.realpath(path),
  lstat: (path) => Fs.lstat(path, { bigint: true }),
  readdir: async (path, limit = maximumDirectoryEntries) => {
    const directory = await Fs.opendir(path)
    const entries: Array<NodeFs.Dirent> = []
    let primary: unknown
    try {
      while (true) {
        const entry = await directory.read()
        if (entry === null) break
        if (entries.length >= limit) {
          throw new Error(`directory contains more than ${limit} entries: ${path}`)
        }
        entries.push(entry)
      }
    } catch (cause) {
      primary = cause
    }
    try {
      await directory.close()
    } catch (cause) {
      primary ??= cause
    }
    if (primary !== undefined) throw primary
    return entries
  },
  open: async (path) => {
    const handle = await Fs.open(path, openFlags)
    return {
      stat: () => handle.stat({ bigint: true }),
      read: async (into) => (await handle.read(into, 0, into.byteLength, null)).bytesRead,
      close: () => handle.close()
    }
  }
}

/**
 * The `code` of a rejected filesystem call, when it has one.
 *
 * @category guards
 * @since 0.1.0
 */
export const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || NodeUtil.isProxy(cause)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "code")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

const failureMessage = (cause: unknown): string => {
  if (typeof cause === "string") return cause === "" ? "unknown failure" : cause
  if (typeof cause !== "object" || cause === null || NodeUtil.isProxy(cause)) return "unknown failure"
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" &&
        descriptor.value !== ""
      ? descriptor.value
      : "unknown failure"
  } catch {
    return "unknown failure"
  }
}

/** Reports whether the entry named by a path is simply not there. */
const absent = (cause: unknown): boolean => {
  const code = errorCode(cause)
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * Reports whether `candidate` is `root` or below it, lexically.
 *
 * Both arguments must already be canonical: this decides containment, it does
 * not resolve links.
 *
 * @category guards
 * @since 0.1.0
 */
export const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/**
 * Resolves a workspace root to the canonical path every confinement check is
 * made against.
 *
 * Hosts rewrite paths: macOS resolves `/var` to `/private/var`, and a
 * workspace reached through a symlinked parent has two equally valid
 * spellings. Comparing an unresolved root against a resolved candidate reports
 * a false escape, so the root resolves once and every check uses that answer.
 *
 * @category constructors
 * @since 0.1.0
 */
export const canonicalRoot = (root: string, io: Io = defaultIo): Promise<string> => io.realpath(NodePath.resolve(root))

/**
 * Identifies one filesystem object across two observations of it.
 *
 * On hosts where `ino` is meaningful — Linux and macOS — this distinguishes two
 * files that shared a name. Some Windows filesystems report zero for every
 * inode, and the comparison degrades to a tautology there. The checks that
 * surround it do not: the descriptor is still required to be a regular file,
 * the sizes and modification time still have to agree across the read, and the
 * canonical-path confinement is unaffected.
 */
const identity = (stats: Stats): string => `${stats.dev}:${stats.ino}`

/** Lossless non-negative size reported by one stat result. */
const sizeOf = (stats: Stats): bigint => {
  if (typeof stats.size === "bigint") return stats.size
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`filesystem reported an invalid file size: ${String(stats.size)}`)
  }
  return BigInt(stats.size)
}

/** Lossless timestamp where the host exposes nanoseconds, with a safe fallback. */
const timestamp = (stats: Stats, kind: "mtime" | "ctime"): string => {
  if ("mtimeNs" in stats && "ctimeNs" in stats) {
    return String(kind === "mtime" ? stats.mtimeNs : stats.ctimeNs)
  }
  const value = kind === "mtime" ? stats.mtimeMs : stats.ctimeMs
  return Number.isFinite(value) ? String(value) : "invalid"
}

/**
 * One filesystem object, named by the canonical path it was found at and
 * described by the `lstat` that admitted it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Entry {
  readonly path: string
  readonly stats: Stats
}

/**
 * How one confined read is performed.
 *
 * `root` is a canonical workspace root from {@link canonicalRoot}. Leaving it
 * undefined disables confinement, which is only correct for a path the caller
 * has already confined. `what` is the noun that appears in diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly root?: string | undefined
  readonly io?: Io | undefined
  readonly what?: string | undefined
  readonly directoryEntries?: number | undefined
  /** Optional byte ceiling for a streamed digest; omitted means no content-size ceiling. */
  readonly maximumBytes?: number | undefined
  readonly signal?: AbortSignal | undefined
  /** Whether a symbolic link in the final path component may be followed. */
  readonly symlinks?: "follow" | "reject" | undefined
}

/** Throws the caller's interruption before another filesystem operation starts. */
const checkCancelled = (options: Options): void => options.signal?.throwIfAborted()

/**
 * Resolves one path to the regular file it names, inside the workspace.
 *
 * Returns undefined when nothing is there, including when a symbolic link
 * dangles: a link with no target names no file. Every other failure throws.
 *
 * ## Symbolic link policy
 *
 * A symbolic link is followed only when its whole resolution stays inside the
 * canonical root and ends at a regular file. A link that leaves the root is
 * refused by name, so a link planted in a workspace can never decide that
 * something outside it is repository content. This is the one policy every
 * caller shares: a declared file input, a `.gitignore`, and a `PACKAGE.ts` probe
 * all admit exactly the same set of files.
 *
 * The returned path is the resolved one. Reads happen through it, so the
 * descriptor identity check compares like with like.
 *
 * @category discovery
 * @since 0.1.0
 */
export const resolveFile = async (
  path: string,
  options: Options = {}
): Promise<Entry | undefined> => {
  checkCancelled(options)
  const io = options.io ?? defaultIo
  const what = options.what ?? "file"
  const root = options.root
  let candidate = path
  if (root !== undefined) {
    const parent = NodePath.dirname(path)
    let real: string
    try {
      real = await io.realpath(parent)
    } catch (cause) {
      if (absent(cause)) return undefined
      throw cause
    }
    checkCancelled(options)
    if (!inside(root, real)) {
      throw new Error(`${what} resolves outside the workspace: ${path}`)
    }
    candidate = NodePath.join(real, NodePath.basename(path))
  }
  let stats: Stats
  try {
    stats = await io.lstat(candidate)
  } catch (cause) {
    if (absent(cause)) return undefined
    throw cause
  }
  checkCancelled(options)
  if (!stats.isSymbolicLink()) {
    if (!stats.isFile()) throw new Error(`${what} is not a regular file: ${path}`)
    return { path: candidate, stats }
  }
  if (options.symlinks === "reject") {
    throw new Error(`${what} is a symbolic link: ${path}`)
  }
  let target: string
  try {
    target = await io.realpath(candidate)
  } catch (cause) {
    if (absent(cause)) return undefined
    throw cause
  }
  checkCancelled(options)
  if (root !== undefined && !inside(root, target)) {
    throw new Error(`${what} is a symbolic link leaving the workspace: ${path}`)
  }
  let resolved: Stats
  try {
    resolved = await io.lstat(target)
  } catch (cause) {
    if (absent(cause)) return undefined
    throw cause
  }
  checkCancelled(options)
  if (resolved.isSymbolicLink()) {
    throw new Error(`${what} changed while its symbolic link was being resolved: ${path}`)
  }
  if (!resolved.isFile()) throw new Error(`${what} is not a regular file: ${path}`)
  return { path: target, stats: resolved }
}

/**
 * Resolves one path to the real directory it names, inside the workspace.
 *
 * Returns undefined when nothing is there and when the entry is not a real
 * directory, which includes a symbolic link to one: a walk that followed a
 * directory link could leave the workspace or loop forever, so a link is not a
 * directory as far as traversal is concerned. A directory whose canonical path
 * is outside the root is refused, which is how a link above the entry is
 * caught.
 *
 * @category discovery
 * @since 0.1.0
 */
export const resolveDirectory = async (
  path: string,
  options: Options = {}
): Promise<Entry | undefined> => {
  checkCancelled(options)
  const io = options.io ?? defaultIo
  const what = options.what ?? "directory"
  let stats: Stats
  try {
    stats = await io.lstat(path)
  } catch (cause) {
    if (absent(cause)) return undefined
    throw cause
  }
  if (!stats.isDirectory()) return undefined
  checkCancelled(options)
  if (options.root !== undefined) {
    const real = await io.realpath(path)
    if (!inside(options.root, real)) {
      throw new Error(`${what} resolves outside the workspace: ${path}`)
    }
  }
  return { path, stats }
}

/**
 * Re-checks that `path` still names the directory `expected` recorded.
 *
 * The happy path is one `lstat`: `expected` was confined when it was
 * resolved, and the same device and inode is the same directory, so an
 * unchanged identity needs no second `realpath`. Only a changed identity pays
 * for the full re-resolution, which names a directory that now resolves
 * outside the workspace as exactly that.
 */
const unchangedDirectory = async (path: string, expected: Entry, options: Options, what: string): Promise<void> => {
  const io = options.io ?? defaultIo
  let stats: Stats | undefined
  try {
    stats = await io.lstat(path)
  } catch (cause) {
    if (!absent(cause)) throw cause
  }
  if (stats !== undefined && stats.isDirectory() && identity(stats) === identity(expected.stats)) return
  await resolveDirectory(path, options)
  throw new Error(`${what} was replaced while it was being read: ${path}`)
}

/**
 * Lists one confined directory, refusing an entry that was replaced while it
 * was being read.
 *
 * `expected` is the identity a previous observation recorded for the
 * directory. It is re-checked before and after the listing, so a directory
 * swapped for another between the decision to walk it and the walk itself
 * fails rather than contributing another tree's entries under this one's name.
 *
 * @category discovery
 * @since 0.1.0
 */
export const listDirectory = async (
  path: string,
  expected: Entry,
  options: Options = {}
): Promise<ReadonlyArray<NodeFs.Dirent>> => {
  checkCancelled(options)
  const io = options.io ?? defaultIo
  const what = options.what ?? "directory"
  const limit = options.directoryEntries ?? maximumDirectoryEntries
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximumDirectoryEntries) {
    throw new TypeError(
      `directory entry limit must be an integer from 0 to ${maximumDirectoryEntries}, received ${
        typeof limit === "number" ? String(limit) : typeof limit
      }`
    )
  }
  await unchangedDirectory(path, expected, options, what)
  checkCancelled(options)
  const entries = await io.readdir(path, limit)
  checkCancelled(options)
  await unchangedDirectory(path, expected, options, what)
  checkCancelled(options)
  if (entries.length > limit) {
    throw new Error(`${what} contains more than ${limit} entries: ${path}`)
  }
  return entries
}

/**
 * Opens an admitted entry, re-checks it through its own descriptor, and hands
 * the descriptor to `use`.
 *
 * Close runs whatever happened. A failure inside `use` wins over a failure to
 * close, because it explains more; a failure to close a file that read cleanly
 * is still a failure, because an error reported by `close` can be the report
 * of an I/O error the reads never saw.
 */
const withOpen = async <A>(
  entry: Entry,
  options: Options,
  use: (handle: OpenFile, before: Stats) => Promise<A>
): Promise<A> => {
  checkCancelled(options)
  const io = options.io ?? defaultIo
  const what = options.what ?? "file"
  let handle: OpenFile
  try {
    handle = await io.open(entry.path)
  } catch (cause) {
    if (errorCode(cause) === "ELOOP") {
      throw new Error(`${what} became a symbolic link while it was being opened: ${entry.path}`)
    }
    throw cause
  }
  let failure: unknown
  let result: A | undefined
  let produced = false
  try {
    checkCancelled(options)
    const before = await handle.stat()
    checkCancelled(options)
    if (!before.isFile()) throw new Error(`${what} is not a regular file: ${entry.path}`)
    if (identity(before) !== identity(entry.stats)) {
      throw new Error(`${what} was replaced while it was being opened: ${entry.path}`)
    }
    if (
      sizeOf(before) !== sizeOf(entry.stats) ||
      timestamp(before, "mtime") !== timestamp(entry.stats, "mtime") ||
      timestamp(before, "ctime") !== timestamp(entry.stats, "ctime")
    ) {
      throw new Error(`${what} changed while it was being opened: ${entry.path}`)
    }
    if (options.root !== undefined) {
      const resolved = await io.realpath(entry.path)
      if (!inside(options.root, resolved)) {
        throw new Error(`${what} left the workspace while it was being opened: ${entry.path}`)
      }
      const current = await io.lstat(resolved)
      if (identity(current) !== identity(before)) {
        throw new Error(`${what} was replaced while its open descriptor was being confined: ${entry.path}`)
      }
    }
    result = await use(handle, before)
    checkCancelled(options)
    produced = true
  } catch (cause) {
    failure = cause
  }
  try {
    await handle.close()
  } catch (cause) {
    failure ??= new Error(`${what} could not be closed: ${entry.path}: ${failureMessage(cause)}`)
  }
  if (failure !== undefined) throw failure
  if (!produced) throw new Error(`${what} could not be read: ${entry.path}`)
  return result as A
}

/**
 * Rejects a file that changed under the descriptor while it was being read.
 *
 * Three observations have to agree: the size the descriptor reported before
 * the first read, the size it reports after the last one, and the number of
 * bytes that actually arrived. A concurrent truncation shows up as a short
 * read, a concurrent append as a long one, and a rewrite in place as a
 * different modification time. None of this makes a racing writer impossible;
 * it makes an observed race a failure rather than a digest of a file that
 * never existed.
 */
const stable = (before: Stats, after: Stats, total: bigint): boolean =>
  identity(after) === identity(before) &&
  sizeOf(after) === sizeOf(before) &&
  timestamp(after, "mtime") === timestamp(before, "mtime") &&
  timestamp(after, "ctime") === timestamp(before, "ctime") &&
  total === sizeOf(before)

/** Validates one implementation's read result before it reaches a slice or counter. */
const checkedRead = async (handle: OpenFile, buffer: Uint8Array, what: string): Promise<number> => {
  const bytesRead = await handle.read(buffer)
  if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
    throw new Error(
      `${what} returned an invalid read length: ${typeof bytesRead === "number" ? String(bytesRead) : typeof bytesRead}`
    )
  }
  return bytesRead
}

/**
 * Streams one file's SHA-256 through a bounded, reusable buffer.
 *
 * Returns undefined when the file does not exist, so a declared-but-missing
 * input still contributes deterministic key material. Every other failure —
 * a permission error, a FIFO, a device, a link out of the workspace, a file
 * that changed while it was read — is reported.
 *
 * @category digests
 * @since 0.1.0
 */
export const digestEntry = async (
  entry: Entry,
  options: Options = {}
): Promise<string | undefined> => {
  const maximumBytes = options.maximumBytes
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
  ) {
    throw new TypeError(
      `digest byte limit must be a non-negative safe integer, received ${
        typeof maximumBytes === "number" ? String(maximumBytes) : typeof maximumBytes
      }`
    )
  }
  const what = options.what ?? "file"
  if (maximumBytes !== undefined && sizeOf(entry.stats) > BigInt(maximumBytes)) {
    throw new Error(`${what} is larger than ${maximumBytes} bytes: ${entry.path}`)
  }
  return withOpen(entry, options, async (handle, before) => {
    if (maximumBytes !== undefined && sizeOf(before) > BigInt(maximumBytes)) {
      throw new Error(`${what} is larger than ${maximumBytes} bytes: ${entry.path}`)
    }
    const hash = createHash("sha256")
    const buffer = new Uint8Array(chunkBytes)
    let total = 0n
    while (true) {
      checkCancelled(options)
      const bytesRead = await checkedRead(handle, buffer, what)
      if (bytesRead === 0) break
      total += BigInt(bytesRead)
      if (maximumBytes !== undefined && total > BigInt(maximumBytes)) {
        throw new Error(`${what} is larger than ${maximumBytes} bytes: ${entry.path}`)
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (!stable(before, after, total)) {
      throw new Error(`${what} changed while it was being digested: ${entry.path}`)
    }
    return hash.digest("hex")
  })
}

/**
 * Streams one confined file's SHA-256 through a bounded, reusable buffer.
 *
 * Returns undefined when the file does not exist, so a declared-but-missing
 * input still contributes deterministic key material. Callers that previously
 * admitted an {@link Entry} can use {@link digestEntry} to bind that admission
 * to the exact object eventually hashed.
 *
 * @category digests
 * @since 0.1.0
 */
export const digestFile = async (
  path: string,
  options: Options = {}
): Promise<string | undefined> => {
  const maximumBytes = options.maximumBytes
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
  ) {
    throw new TypeError(
      `digest byte limit must be a non-negative safe integer, received ${
        typeof maximumBytes === "number" ? String(maximumBytes) : typeof maximumBytes
      }`
    )
  }
  const entry = await resolveFile(path, options)
  if (entry === undefined) return undefined
  return digestEntry(entry, options)
}

/**
 * Reads one bounded regular file as UTF-8 text.
 *
 * Returns undefined when the file does not exist. A file larger than `limit`,
 * a file that is not valid UTF-8, and a file that changed while it was read
 * all fail: a truncated or lossily decoded `.gitignore` is a matcher that
 * ignores the wrong paths, which is worse than no answer at all.
 *
 * @category discovery
 * @since 0.1.0
 */
export const readText = async (
  path: string,
  options: Options & { readonly limit?: number | undefined } = {}
): Promise<string | undefined> => {
  const limit = options.limit ?? defaultTextBytes
  const what = options.what ?? "file"
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximumTextBytes) {
    throw new TypeError(
      `text read limit must be an integer from 0 to ${maximumTextBytes}, received ${
        typeof limit === "number" ? String(limit) : typeof limit
      }`
    )
  }
  const entry = await resolveFile(path, options)
  if (entry === undefined) return undefined
  const oversize = (): Error => new Error(`${what} is larger than ${limit} bytes: ${path}`)
  if (sizeOf(entry.stats) > BigInt(limit)) throw oversize()
  return withOpen(entry, options, async (handle, before) => {
    const size = sizeOf(before)
    if (size > BigInt(limit)) throw oversize()
    // One byte over the recorded size distinguishes a file that grew during
    // the read from one that was measured correctly, without allocating the
    // whole limit for a small file.
    const buffer = new Uint8Array(Number(size) + 1)
    let total = 0
    while (total < buffer.length) {
      checkCancelled(options)
      const bytesRead = await checkedRead(handle, buffer.subarray(total), what)
      if (bytesRead === 0) break
      total += bytesRead
    }
    const after = await handle.stat()
    if (!stable(before, after, BigInt(total))) {
      throw new Error(`${what} changed while it was being read: ${path}`)
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, total))
    } catch {
      throw new Error(`${what} is not valid UTF-8: ${path}`)
    }
  })
}

const directorySyncUnsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

/**
 * Flushes one directory entry so a rename inside it survives power loss.
 *
 * Windows exposes no directory descriptor to sync, and a filesystem that
 * reports directory sync as unsupported has nothing to flush; both count as
 * done. Any other sync failure, and a close failure after the sync, is
 * reported, because the entry the caller just published may not be durable.
 * Every durable publication in the workspace, generated files, scaffolded
 * packages, and redacted deployment state, ends with this call.
 *
 * @category publication
 * @since 0.1.0
 */
export const syncDirectory = async (directory: string): Promise<void> => {
  if (process.platform === "win32") return
  const handle = await Fs.open(directory, "r")
  let primary: unknown
  try {
    await handle.sync()
  } catch (cause) {
    if (!directorySyncUnsupported.has(errorCode(cause) ?? "")) primary = cause
  }
  try {
    await handle.close()
  } catch (cause) {
    primary ??= cause
  }
  if (primary !== undefined) throw primary
}
