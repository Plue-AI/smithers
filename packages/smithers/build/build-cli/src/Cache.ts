/**
 * Read-through result cache: a content-addressed local file store fronting an
 * optional HTTP remote.
 *
 * The local store answers reads first. A remote lookup runs only on a local
 * miss, and a remote hit hydrates the local file so the next read stays on
 * disk. A put writes both stores. Any remote failure prints one warning line
 * and degrades the store to local-only for the rest of the process. A `429`
 * is not a failure: it costs only the request it answered.
 *
 * Every read on both sides is an untrusted read. A local entry file may have
 * been replaced by a symbolic link, a FIFO, or four gigabytes of noise; a
 * remote body may never end. Both are bounded and type-checked before anything
 * is parsed, and both degrade to a miss rather than to a hazard.
 *
 * @since 0.1.0
 */

import * as Config from "@smthrs/targets/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { createHash, randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import { errorCode, failureMessage, optionalOpenFlag } from "./internal/Fs.ts"

/**
 * One stored target execution result.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CachedResult {
  readonly key: string
  readonly target: string
  readonly label: string
  readonly exitOk: boolean
  readonly output: unknown
  readonly storedAt: string
}

/**
 * The cache handle the engine reads and writes through.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CacheStore {
  get(key: string): Promise<CachedResult | null>
  /**
   * Stores a result. `shared: false` keeps it in the local tier only: a
   * result produced by an unconfined run is evidence for this machine and
   * nothing more, so it never reaches a store other machines read.
   */
  put(key: string, r: CachedResult, options?: { readonly shared?: boolean | undefined }): Promise<void>
  close(): Promise<void>
}

/**
 * The largest entry either store will read.
 *
 * An entry is one action's success value. Sixteen mebibytes is far above any
 * legitimate one and far below a size that threatens the process, so a store
 * that has been filled with a huge file answers a miss instead of turning a
 * cache lookup into an out-of-memory failure.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const entryLimit = 16 * 1024 * 1024

/**
 * The action-cache publication ceiling shared by both remote backends.
 *
 * Local entries retain the larger {@link entryLimit}; a remote tier stores
 * entries in a database row and deliberately accepts no more than one MiB.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const remoteEntryLimit = 1024 * 1024

/**
 * Bounds CPU and bookkeeping for adversarial response streams of tiny chunks.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumRemoteBodyChunks = 16_384

/**
 * The default deadline for one remote request, including its whole body.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const remoteTimeouts = { get: 3_000, put: 8_000 } as const

/**
 * The stored entry shape both stores decode through.
 *
 * `key`, `target`, and `label` are required to be non-empty: an entry that
 * cannot name the action it came from cannot be trusted to answer for one.
 * `exitOk` must be a real boolean, so a truthy-looking value never admits a
 * failed run as a hit.
 */
const StoredResult = Schema.Struct({
  key: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  exitOk: Schema.Boolean,
  output: Schema.Unknown,
  storedAt: Schema.NonEmptyString
})

const decodeStored = Schema.decodeUnknownOption(StoredResult)

/**
 * Decodes one candidate entry and requires it to answer for `key`.
 *
 * Both stores share this boundary. A well-formed entry filed under the wrong
 * key is a corrupt store, not a hit: returning it would answer one action with
 * another action's result, which is the one failure mode a content-addressed
 * cache must never have. The executor checks the entry's target and label on top
 * of this, so a store that reuses one key for two actions is caught there too.
 */
const decodeFor = (key: string, candidate: unknown): CachedResult | null => {
  const decoded = decodeStored(candidate)
  if (Option.isNone(decoded) || decoded.value.key !== key) return null
  try {
    return normalizeCachedResult(key, decoded.value)
  } catch {
    return null
  }
}

const wellFormedKey = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const maximumCacheKeyCodeUnits = 4_096

/**
 * Maps a cache key onto a name that is safe as a single path segment.
 *
 * A key that starts with a letter or digit, uses only letters, digits, dots,
 * underscores, and dashes, and is at most 200 characters long passes through
 * unchanged. Every other key becomes the lowercase hex SHA-256 of its UTF-16
 * code units. UTF-16 is deliberate: UTF-8 encoding replaces an unpaired
 * surrogate, which let two distinct JavaScript strings map to one file name.
 * Hashing the code units is injective up to SHA-256 and keeps the file name
 * inside the cache directory.
 *
 * @category utilities
 * @since 0.1.0
 * @slop
 */
export const sanitizeKey = (key: string): string => {
  if (typeof key !== "string" || key.length === 0 || key.length > maximumCacheKeyCodeUnits) {
    throw new TypeError(`cache key must contain 1 to ${maximumCacheKeyCodeUnits} UTF-16 code units`)
  }
  return wellFormedKey.test(key) ? key : createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex")
}

const combinedFailure = (primary: unknown, secondary: unknown, secondaryLabel: string): Error => {
  const combined = new Error(
    `${failureMessage(primary)}; ${secondaryLabel}: ${failureMessage(secondary)}`,
    { cause: new AggregateError([primary, secondary]) }
  ) as Error & { code?: string }
  const code = errorCode(primary)
  if (code !== undefined) combined.code = code
  return combined
}

const plainDataRecord = (value: unknown, what: string): Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) {
    throw new TypeError(`${what} must be a plain object`)
  }
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${what} must be a plain object`)
  }
  return value as Record<PropertyKey, unknown>
}

const exactDataKeys = (
  value: Record<PropertyKey, unknown>,
  allowed: ReadonlySet<string>,
  what: string
): void => {
  let keys: Array<string | symbol>
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${what} contains an unknown property: ${String(key)}`)
    }
  }
}

const dataMember = (value: Record<PropertyKey, unknown>, name: string, what: string): unknown => {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, name)
  } catch {
    throw new TypeError(`${what}.${name} could not be inspected safely`)
  }
  if (descriptor === undefined) return undefined
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${what}.${name} must be an enumerable data property`)
  }
  return descriptor.value
}

const jsonStringBytes = (value: string): number => {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (
      unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c ||
      unit === 0x0d
    ) {
      bytes += 2
    } else if (unit < 0x20 || (unit >= 0xd800 && unit <= 0xdfff)) {
      if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4
          index += 1
          continue
        }
      }
      bytes += 6
    } else if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else {
      bytes += 3
    }
    if (!Number.isSafeInteger(bytes) || bytes > entryLimit) return bytes
  }
  return bytes
}

const snapshotJson = (value: unknown): unknown => {
  const ancestors = new Set<object>()
  let members = 0
  let bytes = 0
  const addBytes = (count: number): void => {
    bytes += count
    if (!Number.isSafeInteger(bytes) || bytes > entryLimit) {
      throw new RangeError(`cached JSON exceeds its ${entryLimit}-byte limit`)
    }
  }
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 64) throw new TypeError("cached JSON is nested too deeply")
    if (current === null) {
      addBytes(4)
      return null
    }
    if (typeof current === "string") {
      addBytes(jsonStringBytes(current))
      return current
    }
    if (typeof current === "boolean") {
      addBytes(current ? 4 : 5)
      return current
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError("cached JSON contains a lossy number")
      }
      addBytes(String(current).length)
      return current
    }
    if (typeof current !== "object" || current === null) {
      throw new TypeError("cached output must be an inert JSON value")
    }
    if (ancestors.has(current)) throw new TypeError("cached JSON contains a cycle")
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length")
        if (
          lengthDescriptor === undefined ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) throw new TypeError("cached output contains an invalid array")
        const length = lengthDescriptor.value as number
        if (length > 100_000 - members) throw new TypeError("cached JSON has too many members")
        const keys = Reflect.ownKeys(current).filter((key) => key !== "length")
        if (keys.length !== length) throw new TypeError("cached output contains a sparse or extended array")
        members += length
        addBytes(2 + Math.max(0, length - 1))
        const output: Array<unknown> = []
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
            throw new TypeError("cached output arrays must contain only data entries")
          }
          output.push(visit(descriptor.value, depth + 1))
        }
        return Object.freeze(output)
      }
      const record = plainDataRecord(current, "cached output object")
      const keys = Reflect.ownKeys(record)
      if (!keys.every((key) => typeof key === "string")) {
        throw new TypeError("cached output objects must not contain symbol properties")
      }
      if (keys.length > 100_000 - members) throw new TypeError("cached JSON has too many members")
      members += keys.length
      addBytes(2 + Math.max(0, keys.length - 1) + keys.length)
      const entries: Array<readonly [string, unknown]> = []
      for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError("cached output objects must contain only data properties")
        }
        addBytes(jsonStringBytes(key))
        entries.push([key, visit(descriptor.value, depth + 1)])
      }
      return Object.freeze(Object.fromEntries(entries))
    } finally {
      ancestors.delete(current)
    }
  }
  return visit(value, 0)
}

const isWellFormedText = (value: string): boolean => {
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

const remoteKeySupported = (key: string): boolean =>
  isWellFormedText(key) &&
  Buffer.byteLength(key, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(key)

const normalizeCachedResult = (key: string, value: unknown): CachedResult => {
  const record = plainDataRecord(value, "cached result")
  exactDataKeys(record, new Set(["key", "target", "label", "exitOk", "output", "storedAt"]), "cached result")
  const storedKey = dataMember(record, "key", "cached result")
  const target = dataMember(record, "target", "cached result")
  const label = dataMember(record, "label", "cached result")
  const exitOk = dataMember(record, "exitOk", "cached result")
  const output = dataMember(record, "output", "cached result")
  const storedAt = dataMember(record, "storedAt", "cached result")
  if (!Object.hasOwn(record, "output")) throw new TypeError("cached result output is required")
  if (typeof storedKey !== "string" || storedKey.length === 0 || storedKey !== key) {
    throw new TypeError("cached result key does not match")
  }
  for (const [name, member] of [["target", target], ["label", label], ["storedAt", storedAt]] as const) {
    if (
      typeof member !== "string" ||
      member.length === 0 ||
      member.length > 8 * 1024 ||
      !isWellFormedText(member) ||
      Buffer.byteLength(member, "utf8") > 8 * 1024
    ) throw new TypeError(`cached result ${name} must be bounded non-empty usable text`)
  }
  if (typeof exitOk !== "boolean") throw new TypeError("cached result exitOk must be a boolean")
  const storedAtMs = typeof storedAt === "string" ? Date.parse(storedAt) : Number.NaN
  if (
    typeof storedAt !== "string" ||
    !Number.isFinite(storedAtMs) ||
    new Date(storedAtMs).toISOString() !== storedAt
  ) {
    throw new TypeError("cached result storedAt must be a canonical ISO timestamp")
  }
  return Object.freeze({
    key: storedKey,
    target: target as string,
    label: label as string,
    exitOk,
    output: snapshotJson(output === undefined ? null : output),
    storedAt
  })
}

/** Reports whether `candidate` is `root` or below it, lexically. */
const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/**
 * Resolves a directory that must stay inside the workspace once symbolic links
 * are followed, or throws.
 *
 * `Config.normalizeCacheDirectory` already refuses an absolute path and any
 * `..` segment, which settles the lexical question. It cannot settle the
 * filesystem question: `.flows` may itself be a symbolic link to somewhere
 * else entirely, and every entry the cache published would then land outside
 * the workspace, writing files wherever the link points. A missing directory
 * is fine — it is created and validated again — but an existing one that
 * resolves out of the workspace fails the command.
 *
 * ## Boundary
 *
 * Validation resolves the path that exists at the moment it runs. Node has no
 * portable descriptor-relative open (`openat` with `RESOLVE_BENEATH`), so an
 * ancestor directory replaced by an outside-pointing symbolic link between
 * this check and a later write is not detected. Closing that window needs
 * platform-specific syscalls Node does not expose; what is closed here is the
 * durable case, a workspace whose cache directory is a link.
 */
const confineDirectory = async (
  boundary: string,
  directory: string,
  what = "cache directory"
): Promise<void> => {
  const resolved = await Fs.realpath(directory).catch((cause: unknown) => {
    if (errorCode(cause) === "ENOENT") return undefined
    throw cause
  })
  if (resolved !== undefined && !inside(boundary, resolved)) {
    throw new Error(
      what === "cache directory"
        ? `cache directory leaves the workspace: ${directory} resolves to ${resolved}`
        : `${what} leaves its allowed root: ${directory} resolves to ${resolved}`
    )
  }
}

/**
 * Creates the cache directory and refuses one that escapes the workspace.
 *
 * The check runs before the directory is created, so an existing link is
 * caught, and again afterwards, so a link created concurrently with the
 * `mkdir` is caught too.
 *
 * @category validation
 * @since 0.1.0
 * @slop
 */
export const ensureCacheDirectory = async (
  workspaceRoot: string,
  cacheDirectory: string
): Promise<string> => {
  const root = await Fs.realpath(workspaceRoot)
  const segments = [...Config.normalizeCacheDirectory(cacheDirectory).split("/"), "cache"]
  // Every ancestor is checked, and checked before anything is created: a
  // `.flows` that already points outside must fail the command rather than
  // have a `cache` directory created out there first.
  let directory = root
  for (const segment of segments) {
    directory = NodePath.join(directory, segment)
    await confineDirectory(root, directory)
  }
  await Fs.mkdir(directory, { recursive: true })
  await confineDirectory(root, directory)
  return Fs.realpath(directory)
}

const localPath = (cacheRoot: string, key: string): string => {
  const safe = sanitizeKey(key)
  return NodePath.join(cacheRoot, safe.slice(0, 2), `${safe}.json`)
}

/**
 * Reads one entry file as JSON, or null when it is absent, not a plain file,
 * too large, or not JSON.
 *
 * The whole read is defensive, because the file is untrusted input even in a
 * private workspace: a shared cache directory, a restored backup, or a hand
 * edit can put anything at the path.
 *
 * - `lstat` refuses a symbolic link, a FIFO, a device, a socket, and a
 *   directory before anything is opened, so a link planted at an entry path
 *   cannot make the cache read a file elsewhere.
 * - The open adds `O_NOFOLLOW` (never follow a link swapped in after the
 *   `lstat`) and `O_NONBLOCK` (a FIFO cannot block the open) where the platform
 *   provides them, so a hostile entry cannot stall the run.
 * - The descriptor is `fstat`-checked to be the same regular file the `lstat`
 *   saw, comparing device and inode, before a byte is read.
 * - The size is checked against {@link entryLimit} on the descriptor, so the
 *   bytes are never materialized before the limit is applied.
 *
 * Every failure is a miss. A cache is an optimization; it never gets to fail a
 * run, and it never gets to consume unbounded memory.
 */
const readEntryFile = async (path: string): Promise<unknown> => {
  let text: string | undefined
  // A concurrent writer publishes by renaming a new file onto this path, which
  // loses the identity check against a file that no longer exists. That is a
  // race, not a refusal, and retrying reads the newly published entry. Every
  // writer of one key writes the same bytes, so a retry cannot widen what is
  // accepted. A genuine refusal — a link, a FIFO, a directory, an oversize
  // file — returns immediately without retrying.
  for (let attempt = 0; attempt < 3 && text === undefined; attempt += 1) {
    let expected: NodeFs.BigIntStats
    try {
      expected = await Fs.lstat(path, { bigint: true })
    } catch {
      return null
    }
    if (!expected.isFile() || expected.size > BigInt(entryLimit) || expected.nlink !== 1n) return null
    let handle: Fs.FileHandle
    try {
      handle = await Fs.open(
        path,
        NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
      )
    } catch {
      return null
    }
    let candidate: string | undefined
    try {
      const opened = await handle.stat({ bigint: true })
      if (
        opened.isFile() &&
        opened.dev === expected.dev &&
        opened.ino === expected.ino &&
        opened.nlink === 1n &&
        opened.size === expected.size &&
        opened.size <= BigInt(entryLimit) &&
        opened.mtimeNs === expected.mtimeNs &&
        opened.ctimeNs === expected.ctimeNs
      ) {
        // One byte of slack detects growth after the descriptor stat without
        // ever allocating more than the advertised entry ceiling.
        const buffer = Buffer.allocUnsafe(Number(opened.size) + 1)
        let total = 0
        while (total < buffer.length) {
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
          if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - total) {
            throw new Error(
              `cache entry returned an invalid read length: ${
                typeof bytesRead === "number" ? String(bytesRead) : typeof bytesRead
              }`
            )
          }
          if (bytesRead === 0) break
          total += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (
          after.isFile() &&
          after.dev === opened.dev &&
          after.ino === opened.ino &&
          after.nlink === opened.nlink &&
          after.size === opened.size &&
          after.mtimeNs === opened.mtimeNs &&
          after.ctimeNs === opened.ctimeNs &&
          BigInt(total) === opened.size
        ) {
          candidate = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))
        }
      }
    } catch {
      candidate = undefined
    }
    try {
      await handle.close()
    } catch {
      candidate = undefined
    }
    text = candidate
  }
  if (text === undefined) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const readLocal = async (cacheRoot: string, key: string): Promise<CachedResult | null> => {
  const path = localPath(cacheRoot, key)
  await confineDirectory(cacheRoot, NodePath.dirname(path), "cache shard directory")
  return decodeFor(key, await readEntryFile(path))
}

/**
 * Fault-injection seams for the local store. Production callers omit this and
 * get the real filesystem. Tests substitute individual operations to reproduce
 * failures a real filesystem cannot produce deterministically — a directory
 * that refuses fsync, a close that fails, a temp file that cannot be removed.
 * Injection replaces which operation runs, never what the store does with its
 * result, so the tested policy is the production policy.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CacheIo {
  readonly rename?: (from: string, to: string) => Promise<void>
  readonly writeContents?: (handle: Fs.FileHandle, contents: string) => Promise<void>
  readonly openDirectory?: (directory: string) => Promise<Fs.FileHandle>
  readonly syncHandle?: (handle: Fs.FileHandle) => Promise<void>
  readonly closeHandle?: (handle: Fs.FileHandle) => Promise<void>
  readonly removeTemp?: (temp: string) => Promise<void>
}

const writeContentsLive = (handle: Fs.FileHandle, contents: string): Promise<void> => handle.writeFile(contents, "utf8")
const openDirectoryLive = (directory: string): Promise<Fs.FileHandle> => Fs.open(directory, "r")
const syncHandleLive = (handle: Fs.FileHandle): Promise<void> => handle.sync()
const closeHandleLive = (handle: Fs.FileHandle): Promise<void> => handle.close()
const removeTempLive = (temp: string): Promise<void> => Fs.rm(temp, { force: true })

/**
 * Creates a sibling temporary file nobody else can be holding.
 *
 * The name is unique by construction and the handle is opened with exclusive
 * create, so two writers of the same entry can never share a temp file and a
 * stale temp left by a crashed process is never adopted. Bazel's
 * `DiskCacheClient.saveFile` takes the same position with a per-write UUID.
 *
 * The mode is left to the default so the published entry keeps the permissions
 * the umask asks for. A cache directory shared between accounts stays readable.
 */
const createTemp = async (
  directory: string,
  base: string
): Promise<{ readonly handle: Fs.FileHandle; readonly temp: string }> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const temp = NodePath.join(directory, `.${base}.${process.pid.toString(36)}.${randomUUID()}.tmp`)
    try {
      return { handle: await Fs.open(temp, "wx"), temp }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  throw new Error(`could not create a unique temporary file in ${directory}`)
}

/**
 * Error codes that mean the filesystem refuses fsync on a directory descriptor
 * it did hand out. Permission errors, bad descriptors, and anything unknown are
 * real I/O failures and propagate.
 */
const directorySyncUnsupported = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])

/**
 * Flushes the directory entry created by the rename.
 *
 * POSIX needs this for the rename itself to survive a machine crash. Windows
 * exposes no portable directory descriptor through Node, so the barrier is
 * skipped there deliberately rather than attempted and swallowed.
 *
 * Everything else is real I/O. Opening the directory is an ordinary open and
 * its failures propagate; only the narrow fsync codes that mean "this
 * filesystem does not implement directory sync" are tolerated. The handle is
 * closed exactly once and a close failure propagates unless a sync failure is
 * already propagating, in which case the sync failure is the one reported.
 */
const syncDirectory = async (
  directory: string,
  openDirectory: (directory: string) => Promise<Fs.FileHandle>,
  syncHandle: (handle: Fs.FileHandle) => Promise<void>,
  closeHandle: (handle: Fs.FileHandle) => Promise<void>
): Promise<void> => {
  if (process.platform === "win32") return
  const handle = await openDirectory(directory)
  let primary: { readonly cause: unknown } | undefined
  try {
    await syncHandle(handle)
  } catch (cause) {
    if (!directorySyncUnsupported.has(errorCode(cause) ?? "")) primary = { cause }
  }
  try {
    await closeHandle(handle)
  } catch (cause) {
    primary ??= { cause }
  }
  if (primary !== undefined) throw primary.cause
}

/**
 * Renames the finished temp onto the entry path, tolerating a concurrent
 * writer that already published the same entry.
 *
 * POSIX rename is atomic and replaces the destination, so a concurrent
 * complete writer is invisible. Windows refuses a rename onto a destination
 * another process has open; entries are content addressed and every writer of
 * one key writes the same bytes, so an existing destination that decodes for
 * the key is an acceptable outcome rather than a failure. This mirrors Bazel's
 * `renameToleratingConcurrentCreation` and the Windows branch of
 * `VirtualActionInput.atomicallyWriteTo`.
 *
 * Returns true when the rename consumed the temp file.
 */
const renameTolerantly = async (
  temp: string,
  path: string,
  key: string,
  rename: (from: string, to: string) => Promise<void>
): Promise<boolean> => {
  try {
    await rename(temp, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (
      process.platform === "win32" &&
      (code === "EPERM" || code === "EACCES" || code === "EBUSY") &&
      decodeFor(key, await readEntryFile(path)) !== null
    ) return false
    throw error
  }
}

/**
 * Publishes one entry atomically.
 *
 * The bytes go to an exclusively created sibling temp file that is written,
 * fsynced, and closed before it is renamed onto the entry path, so a reader
 * observes either no entry or the whole entry. Failure discipline mirrors the
 * generated-file writer:
 *
 * - A close failure never publishes as success. When an earlier failure exists
 *   the diagnostic reports both while retaining the earlier error code.
 * - Temp removal is attempted on every path that did not consume the temp, and
 *   never masks a primary failure. Every removal failure is reported as a
 *   secondary cause, because the alternative is silently leaking one file per
 *   failed or concurrent writer.
 * - The containing directory is fsynced last, and its failures are real.
 */
const writeLocal = async (
  cacheRoot: string,
  key: string,
  result: CachedResult,
  io: CacheIo
): Promise<void> => {
  if (result.key !== key) {
    throw new TypeError(`refusing to store an entry keyed ${result.key} under ${key}`)
  }
  const rename = io.rename ?? Fs.rename
  const writeContents = io.writeContents ?? writeContentsLive
  const openDirectory = io.openDirectory ?? openDirectoryLive
  const syncHandle = io.syncHandle ?? syncHandleLive
  const closeHandle = io.closeHandle ?? closeHandleLive
  const removeTemp = io.removeTemp ?? removeTempLive
  const path = localPath(cacheRoot, key)
  const directory = NodePath.dirname(path)
  const text = JSON.stringify(result)
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > entryLimit) {
    throw new RangeError(`cache entry is ${bytes} bytes, exceeding its limit of ${entryLimit}`)
  }
  await Fs.mkdir(directory, { recursive: true })
  // The shard directory is created here, so it is validated here: a cache
  // directory swapped for an outside link between open and put must not
  // publish outside the workspace.
  await confineDirectory(cacheRoot, directory, "cache shard directory")
  const { handle, temp } = await createTemp(directory, NodePath.basename(path))
  let tempConsumed = false
  let primary: { readonly cause: unknown } | undefined
  try {
    await writeContents(handle, text)
    await syncHandle(handle)
  } catch (cause) {
    primary = { cause }
  }
  try {
    await closeHandle(handle)
  } catch (cause) {
    primary = primary === undefined
      ? { cause }
      : { cause: combinedFailure(primary.cause, cause, "temporary file close also failed") }
  }
  if (primary === undefined) {
    try {
      tempConsumed = await renameTolerantly(temp, path, key, rename)
    } catch (cause) {
      primary = { cause }
    }
  }
  if (!tempConsumed) {
    try {
      await removeTemp(temp)
    } catch (cause) {
      primary = primary === undefined
        ? {
          cause: new Error(
            `the entry was published but the temporary file ${temp} could not be removed: ${failureMessage(cause)}`
          )
        }
        : {
          cause: combinedFailure(
            primary.cause,
            cause,
            `temporary file ${temp} cleanup also failed`
          )
        }
    }
  }
  if (primary !== undefined) throw primary.cause
  await syncDirectory(directory, openDirectory, syncHandle, closeHandle)
}

/**
 * Bounds one asynchronous operation with a real deadline.
 *
 * Aborting the signal is a request, not a guarantee: a custom `fetch`, a
 * polyfill, or a body that never ends is free to ignore it, and the previous
 * implementation then waited forever with a timer that had already fired. The
 * deadline is therefore a race the timer can win on its own. The signal is
 * still aborted so a cooperating implementation releases its socket, and the
 * losing promise's rejection is absorbed so an abort that arrives after the
 * race never surfaces as an unhandled rejection.
 */
const withDeadline = async <A>(
  operation: "get" | "put",
  milliseconds: number,
  run: (signal: AbortSignal) => Promise<A>
): Promise<A> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const cause = new Error(`remote cache ${operation} timed out after ${milliseconds}ms`)
      controller.abort(cause)
      reject(cause)
    }, milliseconds)
  })
  const running = Promise.resolve().then(() => run(controller.signal))
  running.catch(() => undefined)
  try {
    return await Promise.race([running, expiry])
  } finally {
    clearTimeout(timer)
  }
}

const cancelBody = (body: ReadableStream<Uint8Array> | null): void => {
  if (body === null) return
  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // Cancellation is best effort and must not replace the cache outcome.
  }
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * `Content-Length` is checked first when the server declares one, so an
 * oversize body is refused before a byte is transferred. It is only a hint,
 * and a chunked or streaming body declares nothing at all, so the stream is
 * also read incrementally and abandoned the moment the accumulated length
 * passes the limit. `response.text()` and `response.json()` have neither
 * property: both buffer whatever arrives.
 */
const readBoundedBody = async (response: Response, limit: number): Promise<string | undefined> => {
  const declared = response.headers.get("content-length")
  let declaredLength: number | undefined
  if (declared !== null) {
    const length = Number(declared)
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(length) || length > limit) {
      cancelBody(response.body)
      return undefined
    }
    declaredLength = length
  }
  const body = response.body
  if (body === null) return declaredLength === undefined || declaredLength === 0 ? "" : undefined
  const reader = body.getReader()
  let bytes = Buffer.allocUnsafe(Math.min(limit, Math.max(1024, declaredLength ?? 64 * 1024)))
  let total = 0
  let chunks = 0
  let releaseFailed = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks += 1
      if (chunks > maximumRemoteBodyChunks || !(value instanceof Uint8Array)) {
        try {
          void reader.cancel().catch(() => undefined)
        } catch {
          // The refusal remains a refusal when cancellation itself fails.
        }
        return undefined
      }
      if (value.byteLength === 0) continue
      total += value.byteLength
      if (total > limit) {
        try {
          void reader.cancel().catch(() => undefined)
        } catch {
          // The refusal remains a refusal when cancellation itself fails.
        }
        return undefined
      }
      if (total > bytes.byteLength) {
        let capacity = bytes.byteLength
        while (capacity < total) capacity = Math.min(limit, Math.max(capacity * 2, total))
        const grown = Buffer.allocUnsafe(capacity)
        bytes.copy(grown, 0, 0, total - value.byteLength)
        bytes = grown
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(bytes, total - value.byteLength)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      releaseFailed = true
    }
  }
  if (releaseFailed) return undefined
  if (declaredLength !== undefined && total !== declaredLength) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))
  } catch {
    return undefined
  }
}

const maximumRemoteTimeoutMs = 5 * 60 * 1000

/** Validates programmatic deadline overrides before a timer or filesystem mutation. */
const validateTimeouts = (
  value: unknown
): { readonly get: number; readonly put: number } => {
  if (value === undefined) return remoteTimeouts
  const record = plainDataRecord(value, "remote cache timeouts")
  exactDataKeys(record, new Set(["get", "put"]), "remote cache timeouts")
  const timeouts = {
    get: dataMember(record, "get", "remote cache timeouts"),
    put: dataMember(record, "put", "remote cache timeouts")
  }
  for (const operation of ["get", "put"] as const) {
    const milliseconds = timeouts[operation]
    if (
      typeof milliseconds !== "number" ||
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 1 ||
      milliseconds > maximumRemoteTimeoutMs
    ) {
      throw new TypeError(
        `remote cache ${operation} timeout must be an integer from 1 to ${maximumRemoteTimeoutMs}, ` +
          `received ${typeof milliseconds === "number" ? String(milliseconds) : typeof milliseconds}`
      )
    }
  }
  return { get: timeouts.get as number, put: timeouts.put as number }
}

/**
 * Options for {@link openCache}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface OpenCacheOptions {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly endpoint?: string | undefined
  /** Reads the bearer token at the instant an outbound request is built. */
  readonly readToken?: (() => string | undefined) | undefined
  /**
   * Reads the bearer token publications authenticate with. Omitted means the
   * deployment has one credential, and `readToken` serves both directions,
   * which is what every caller did before the credential split existed.
   */
  readonly writeToken?: (() => string | undefined) | undefined
  /**
   * The trust domain this process publishes into. Omitted means the trusted
   * one, whose keys are exactly the content keys the planner computes.
   */
  readonly publishNamespace?: string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly warn?: ((line: string) => void) | undefined
  readonly timeouts?: { readonly get: number; readonly put: number } | undefined
  readonly io?: CacheIo | undefined
}

interface NormalizedOpenCacheOptions {
  readonly workspaceRoot: string
  readonly cacheDirectory: string
  readonly endpoint: string | undefined
  readonly readToken: () => string | undefined
  readonly writeToken: () => string | undefined
  readonly publishNamespace: string | undefined
  readonly fetch: typeof globalThis.fetch
  readonly warn: (line: string) => void
  readonly timeouts: { readonly get: number; readonly put: number }
  readonly io: CacheIo
}

const normalizeEndpoint = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError("remote cache endpoint must be a string")
  if (value.length > 8 * 1024) throw new TypeError("remote cache endpoint must be bounded well-formed text")
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (trimmed.length > 8 * 1024 || !isWellFormedText(trimmed)) {
    throw new TypeError("remote cache endpoint must be bounded well-formed text")
  }
  let endpoint: URL
  try {
    endpoint = new URL(trimmed)
  } catch {
    throw new TypeError("remote cache endpoint must be an absolute URL")
  }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "[::1]"
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new TypeError("remote cache endpoint must use HTTPS (HTTP is allowed only on loopback)")
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new TypeError("remote cache endpoint must not contain credentials")
  }
  if (endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError("remote cache endpoint must not contain a query or fragment")
  }
  return endpoint.href.replace(/\/+$/, "")
}

const normalizeCacheIo = (value: unknown): CacheIo => {
  if (value === undefined) return Object.freeze({})
  const record = plainDataRecord(value, "cache I/O overrides")
  const names = [
    "rename",
    "writeContents",
    "openDirectory",
    "syncHandle",
    "closeHandle",
    "removeTemp"
  ] as const
  exactDataKeys(record, new Set(names), "cache I/O overrides")
  const methods = Object.fromEntries(names.map((name) => [name, dataMember(record, name, "cache I/O overrides")]))
  for (const name of names) {
    const method = methods[name]
    if (method !== undefined && typeof method !== "function") {
      throw new TypeError(`cache I/O override ${name} must be a function`)
    }
  }
  return Object.freeze({
    ...(methods["rename"] === undefined ? {} : { rename: methods["rename"] as NonNullable<CacheIo["rename"]> }),
    ...(methods["writeContents"] === undefined
      ? {}
      : { writeContents: methods["writeContents"] as NonNullable<CacheIo["writeContents"]> }),
    ...(methods["openDirectory"] === undefined
      ? {}
      : { openDirectory: methods["openDirectory"] as NonNullable<CacheIo["openDirectory"]> }),
    ...(methods["syncHandle"] === undefined
      ? {}
      : { syncHandle: methods["syncHandle"] as NonNullable<CacheIo["syncHandle"]> }),
    ...(methods["closeHandle"] === undefined
      ? {}
      : { closeHandle: methods["closeHandle"] as NonNullable<CacheIo["closeHandle"]> }),
    ...(methods["removeTemp"] === undefined
      ? {}
      : { removeTemp: methods["removeTemp"] as NonNullable<CacheIo["removeTemp"]> })
  })
}

const namespaceName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Validates the trust domain a process publishes into.
 *
 * The published key is `<namespace>/<key>` and a content key is bare hex, so a
 * namespace that cannot contain a separator cannot name a key any trusted
 * build computes. An unusable value fails the command: a job that meant to
 * publish somewhere untrusted must not silently publish to trunk instead.
 *
 * @category validation
 * @since 0.1.0
 * @slop
 */
export const normalizePublishNamespace = (
  value: unknown,
  what = "remote cache publishNamespace"
): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !namespaceName.test(value)) {
    throw new TypeError(
      `${what} must be 1 to 64 characters of letters, digits, dots, underscores, and dashes, ` +
        "starting with a letter or digit"
    )
  }
  return value
}

/**
 * The trust domain a `SMITHERS_CACHE_NAMESPACE` value names.
 *
 * Unset or blank is the trusted keyspace: a post-merge publisher leaves the
 * variable out, and a CI job on `main` renders it empty, so both publish and
 * read the bare content key. Any other value must be a usable namespace.
 *
 * @category validation
 * @since 0.1.0
 */
export const publishNamespaceFromEnvironment = (value: string | undefined): string | undefined => {
  const declared = value?.trim()
  return declared === undefined || declared === ""
    ? undefined
    : normalizePublishNamespace(declared, "SMITHERS_CACHE_NAMESPACE")
}

const normalizeOpenCacheOptions = (value: OpenCacheOptions): NormalizedOpenCacheOptions => {
  const record = plainDataRecord(value, "cache options")
  exactDataKeys(
    record,
    new Set([
      "workspaceRoot",
      "cacheDirectory",
      "endpoint",
      "readToken",
      "writeToken",
      "publishNamespace",
      "fetch",
      "warn",
      "timeouts",
      "io"
    ]),
    "cache options"
  )
  const workspaceRoot = dataMember(record, "workspaceRoot", "cache options")
  const cacheDirectory = dataMember(record, "cacheDirectory", "cache options")
  const readToken = dataMember(record, "readToken", "cache options") ?? (() => undefined)
  // One declared credential keeps serving both directions, so a deployment
  // that has not split its secrets behaves exactly as it did before.
  const writeToken = dataMember(record, "writeToken", "cache options") ?? readToken
  const fetch = dataMember(record, "fetch", "cache options") ?? globalThis.fetch
  const warn = dataMember(record, "warn", "cache options") ?? ((line: string) => process.stderr.write(`${line}\n`))
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    workspaceRoot.length > 32 * 1024 ||
    !isWellFormedText(workspaceRoot) ||
    workspaceRoot.includes("\0") ||
    Buffer.byteLength(workspaceRoot, "utf8") > 32 * 1024
  ) throw new TypeError("cache workspaceRoot must be bounded non-empty usable text")
  if (cacheDirectory !== undefined && typeof cacheDirectory !== "string") {
    throw new TypeError("cache cacheDirectory must be a string")
  }
  if (
    typeof cacheDirectory === "string" &&
    (cacheDirectory.length > 32 * 1024 || !isWellFormedText(cacheDirectory) || cacheDirectory.includes("\0"))
  ) throw new TypeError("cache cacheDirectory must be bounded usable text")
  if (typeof readToken !== "function") throw new TypeError("remote cache readToken must be a function")
  if (typeof writeToken !== "function") throw new TypeError("remote cache writeToken must be a function")
  if (typeof fetch !== "function") throw new TypeError("remote cache fetch must be a function")
  if (typeof warn !== "function") throw new TypeError("remote cache warn must be a function")
  return Object.freeze({
    workspaceRoot,
    cacheDirectory: Config.normalizeCacheDirectory(cacheDirectory ?? Config.defaultCacheDirectory),
    endpoint: normalizeEndpoint(dataMember(record, "endpoint", "cache options")),
    readToken: readToken as () => string | undefined,
    writeToken: writeToken as () => string | undefined,
    publishNamespace: normalizePublishNamespace(dataMember(record, "publishNamespace", "cache options")),
    fetch: fetch as typeof globalThis.fetch,
    warn: warn as (line: string) => void,
    timeouts: validateTimeouts(dataMember(record, "timeouts", "cache options")),
    io: normalizeCacheIo(dataMember(record, "io", "cache options"))
  })
}

/** What one bounded remote GET settled on, inside its deadline. */
type Fetched =
  | { readonly _tag: "miss" }
  | { readonly _tag: "busy" }
  | { readonly _tag: "degrade"; readonly status?: number | undefined }
  | { readonly _tag: "entry"; readonly result: CachedResult }

class RemoteStore {
  private readonly endpoint: string
  private readonly readToken: () => string | undefined
  private readonly writeToken: () => string | undefined
  private readonly publishNamespace: string | undefined
  private readonly fetch: typeof globalThis.fetch
  private readonly warn: (line: string) => void
  private readonly timeouts: { readonly get: number; readonly put: number }
  private degraded = false
  private publishDenied = false
  private conflictWarned = false
  private busyWarned = false

  constructor(options: {
    readonly endpoint: string
    readonly readToken: () => string | undefined
    readonly writeToken: () => string | undefined
    readonly publishNamespace: string | undefined
    readonly fetch: typeof globalThis.fetch
    readonly warn: (line: string) => void
    readonly timeouts: { readonly get: number; readonly put: number }
  }) {
    this.endpoint = options.endpoint.replace(/\/+$/, "")
    this.readToken = options.readToken
    this.writeToken = options.writeToken
    this.publishNamespace = options.publishNamespace
    this.fetch = options.fetch
    this.warn = options.warn
    this.timeouts = options.timeouts
  }

  /**
   * The key one result is published under.
   *
   * Reads always use the bare content key, so an untrusted job still gets
   * every trusted hit. Only publication is namespaced, because publication is
   * the direction that can put a wrong answer where a trusted build will read
   * it. A job that names an untrusted domain therefore publishes into a
   * keyspace nothing trusted ever looks in, which holds even where the
   * credential split does not: a shared credential, or one that leaked.
   */
  private publishedKey(key: string): string {
    return this.publishNamespace === undefined ? key : `${this.publishNamespace}/${key}`
  }

  /**
   * Disables the remote for the rest of the process, naming why.
   *
   * The reason is the HTTP status, or a bounded description of the thrown
   * failure (a timeout, `ENOTFOUND host`, an invalid token) with every
   * credential value redacted, so an operator can tell a misconfigured token
   * from a network outage.
   */
  private degrade(operation: "GET" | "PUT", failure?: { readonly status: number } | { readonly cause: unknown }): void {
    if (this.degraded) return
    this.degraded = true
    this.warn(
      `smthrs: remote cache disabled after a failure: ${operation}` +
        (failure === undefined
          ? " request failed"
          : "status" in failure
          ? ` returned HTTP ${failure.status}`
          : ` request failed: ${this.describe(failure.cause)}`)
    )
  }

  /** A bounded, credential-free description of one thrown remote failure. */
  private describe(cause: unknown): string {
    const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined
    let message = cause instanceof Error ? cause.message : String(cause)
    const inner = cause instanceof Error ? cause.cause : undefined
    if (typeof inner === "object" && inner !== null) {
      const code = text((inner as { code?: unknown }).code)
      const host = text((inner as { hostname?: unknown }).hostname)
      if (code !== undefined) message += ` (${code}${host === undefined ? "" : ` ${host}`})`
    }
    for (const read of [this.readToken, this.writeToken]) {
      let token: string | undefined
      try {
        token = read()
      } catch {
        token = undefined
      }
      if (typeof token === "string" && token.length >= 4) message = message.split(token).join("[redacted]")
    }
    message = message.replace(/[\u0000-\u001f\u007f]+/g, " ")
    return message.length > 300 ? `${message.slice(0, 300)}...` : message
  }

  /**
   * Records that this credential may read but not publish.
   *
   * A refused publication is the read-only posture working, not a broken
   * remote: an untrusted job is meant to pull everything and publish nothing.
   * Degrading the whole store on it would cost that job every later cache hit
   * in the run, so only publication stops.
   */
  private denyPublication(): void {
    if (this.publishDenied) return
    this.publishDenied = true
    this.warn("smthrs: remote cache publication refused; this credential may only read")
  }

  /**
   * Records that the remote refused one request because it was busy.
   *
   * A `429` is the server's admission control or a credential budget doing
   * its job, not a broken remote. Only the request it answered is lost: a GET
   * becomes a miss and a PUT drops that one publication. Degrading the store
   * instead would let one busy isolate switch the cache off for the whole run.
   */
  private skipBusy(): void {
    if (this.busyWarned) return
    this.busyWarned = true
    this.warn("smthrs: remote cache busy (HTTP 429); skipped one request")
  }

  private url(key: string): string {
    return `${this.endpoint}/ac/${encodeURIComponent(key)}`
  }

  private headers(direction: "read" | "write"): Headers {
    const headers = new Headers({ "content-type": "application/json" })
    const token = direction === "write" ? this.writeToken() : this.readToken()
    if (
      token !== undefined &&
      (typeof token !== "string" || token.length > 4_096 || !isWellFormedText(token) ||
        /[\u0000-\u001f\u007f]/.test(token) || Buffer.byteLength(token, "utf8") > 4_096)
    ) {
      throw new TypeError("remote cache token must be bounded control-free text")
    }
    if (token !== undefined && token !== "") {
      headers.set("authorization", `Bearer ${token}`)
    }
    return headers
  }

  async get(key: string): Promise<CachedResult | null> {
    if (this.degraded || !remoteKeySupported(key)) return null
    let fetched: Fetched
    try {
      // The whole exchange runs inside one deadline: the request, the body,
      // and the parse. Reading the body outside it left a hung response able
      // to stall the run after the request itself had already come back.
      fetched = await withDeadline(
        "get",
        this.timeouts.get,
        async (signal): Promise<Fetched> => {
          const response = await this.fetch(this.url(key), {
            method: "GET",
            headers: this.headers("read"),
            redirect: "error",
            signal
          })
          if (response.status === 404) {
            cancelBody(response.body)
            return { _tag: "miss" }
          }
          if (response.status === 429) {
            cancelBody(response.body)
            return { _tag: "busy" }
          }
          if (response.status !== 200) {
            cancelBody(response.body)
            return { _tag: "degrade", status: response.status }
          }
          const text = await readBoundedBody(response, remoteEntryLimit)
          if (text === undefined) return { _tag: "degrade" }
          let value: unknown
          try {
            value = JSON.parse(text) as unknown
          } catch {
            return { _tag: "degrade" }
          }
          const envelope = typeof value === "object" && value !== null && !Array.isArray(value) &&
            Object.hasOwn(value, "keyDigest") && Object.hasOwn(value, "result")
          if (envelope && (value as Record<string, unknown>)["keyDigest"] !== key) {
            return { _tag: "degrade" }
          }
          const candidate = envelope ? (value as Record<string, unknown>)["result"] : value
          const decoded = decodeFor(key, candidate)
          return decoded === null ? { _tag: "degrade" } : { _tag: "entry", result: decoded }
        }
      )
    } catch (cause) {
      this.degrade("GET", { cause })
      return null
    }
    if (fetched._tag === "entry") return fetched.result
    if (fetched._tag === "busy") this.skipBusy()
    if (fetched._tag === "degrade") {
      this.degrade("GET", fetched.status === undefined ? undefined : { status: fetched.status })
    }
    return null
  }

  async put(key: string, result: CachedResult): Promise<void> {
    const published = this.publishedKey(key)
    if (this.degraded || this.publishDenied || !remoteKeySupported(published)) return
    try {
      // The envelope names the key it is filed under, which is the namespaced
      // one. The result inside keeps the content key it was produced for, so
      // the entry a trusted build reads is byte-identical whoever publishes it.
      const body = JSON.stringify({
        keyDigest: published,
        result,
        meta: { target: result.target, label: result.label, exitOk: result.exitOk },
        createdAtMs: Date.parse(result.storedAt)
      })
      if (Buffer.byteLength(body, "utf8") > remoteEntryLimit) {
        throw new RangeError(`remote cache request exceeds its ${remoteEntryLimit}-byte limit`)
      }
      const status = await withDeadline("put", this.timeouts.put, async (signal) => {
        const response = await this.fetch(this.url(published), {
          method: "PUT",
          headers: this.headers("write"),
          body,
          redirect: "error",
          signal
        })
        // Draining inside the deadline keeps a server that answers and then
        // holds the connection open from stalling the run.
        cancelBody(response.body)
        return response.status
      })
      if (status === 200 || status === 201) return
      if (status === 401 || status === 403) return this.denyPublication()
      if (status === 429) return this.skipBusy()
      if (status === 409) {
        if (!this.conflictWarned) {
          this.conflictWarned = true
          this.warn("smthrs: remote cache conflict; keeping the first published result")
        }
        return
      }
      this.degrade("PUT", { status })
    } catch (cause) {
      this.degrade("PUT", { cause })
    }
  }

  async close(): Promise<void> {}
}

/**
 * Opens the workspace cache.
 *
 * Local entries live under `<workspaceRoot>/<cacheDirectory>/cache` as JSON
 * files addressed by sanitized key and published atomically: an exclusively
 * created sibling temporary file is written, synced, and closed before it is
 * renamed onto the entry path, so a reader sees either no entry or the whole
 * entry. The cache directory must stay inside the workspace once symbolic
 * links resolve, checked when it is opened and again when an entry is written.
 * Every entry read from either store is bounded, type-checked, and must name
 * the requested key, so a truncated, oversize, forged, or misfiled entry is a
 * miss rather than another action's result. `cacheDirectory` is the
 * workspace-relative directory the CLI resolved and defaults to `.flows`. When
 * `endpoint` names an HTTP cache, the store also reads through its `/ac`
 * route: a local hit never touches the remote, a remote hit hydrates the local
 * file, and a put writes both sides.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const openCache = async (opts: OpenCacheOptions): Promise<CacheStore> => {
  const options = normalizeOpenCacheOptions(opts)
  const workspaceRoot = await Fs.realpath(NodePath.resolve(options.workspaceRoot))
  const cacheRoot = await ensureCacheDirectory(
    workspaceRoot,
    options.cacheDirectory
  )
  const remote = options.endpoint === undefined
    ? null
    : new RemoteStore({
      endpoint: options.endpoint,
      readToken: options.readToken,
      writeToken: options.writeToken,
      publishNamespace: options.publishNamespace,
      fetch: options.fetch,
      warn: options.warn,
      timeouts: options.timeouts
    })
  return {
    async get(key: string): Promise<CachedResult | null> {
      const local = await readLocal(cacheRoot, key)
      if (local !== null) return local
      if (remote === null) return null
      const fetched = await remote.get(key)
      if (fetched === null) return null
      await writeLocal(cacheRoot, key, fetched, options.io).catch(() => undefined)
      return fetched
    },
    async put(key: string, r: CachedResult, putOptions?: { readonly shared?: boolean | undefined }): Promise<void> {
      sanitizeKey(key)
      const result = normalizeCachedResult(key, r)
      await writeLocal(cacheRoot, key, result, options.io)
      if (remote !== null && putOptions?.shared !== false) await remote.put(key, result)
    },
    async close(): Promise<void> {
      if (remote !== null) await remote.close()
    }
  }
}
