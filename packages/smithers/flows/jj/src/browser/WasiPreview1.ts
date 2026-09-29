/**
 * A WASI preview 1 host shim over a {@link WasiFs.SyncFsLike} slice.
 *
 * This is the syscall layer under the wasm build of jj: the `flows_jj.wasm`
 * reactor imports `wasi_snapshot_preview1`, and this module answers those
 * imports from a synchronous filesystem slice — ZenFS's sync surface in a
 * browser page, `node:fs` in tests. It is written by hand in this repository
 * (the codebase pattern is structural slices passed as arguments, not an npm
 * runtime dependency); `@bjorn3/browser_wasi_shim` is prior art it mirrors in
 * shape, not a dependency.
 *
 * The shim is deliberately testable without any wasm module: {@link make}
 * returns plain functions over `(memory, fs, fd table)` state, so a test can
 * construct a `WebAssembly.Memory`, call the syscalls directly, and assert
 * errno values and memory layouts.
 *
 * One preopen is exposed: fd 3 names `"/"`, mapped to `root` in the slice —
 * exactly what wasi-libc's preopen scan expects, so every absolute path the
 * module opens resolves inside the slice, subject to the namespace ownership
 * requirement below.
 *
 * This shim is not a security sandbox for a concurrently mutated native
 * filesystem. `SyncFsLike` has only path-based calls: no retained directory
 * handles, atomic confined resolution, or no-follow open flags. Checks and
 * subsequent reads or mutations are separate backend calls. The host must
 * prevent other writers (including backend callbacks) from replacing path
 * components during a syscall, including `root` and its host ancestors, or
 * supply a backend that independently confines every operation. Synchronous
 * guest execution alone does not exclude native processes or other workers.
 *
 * The namespace is POSIX: `/` is the only separator, in guest paths and in
 * symlink targets alike, and `root` is expected to be a path the slice joins
 * the same way. A backend that also treats `\` as a separator would read a
 * segment this shim considers an ordinary filename as a traversal, so the
 * confinement below assumes it does not. rc.0 supports no such host: Windows is
 * not a supported runtime, and the slices this ships against are ZenFS and
 * `node:fs` under a POSIX root.
 *
 * **Honest divergences** from a kernel WASI host, in the `BrowserFileSystem`
 * tradition of documenting rather than hiding them:
 *
 * - `fd_sync`/`fd_datasync` only validate the descriptor and report success.
 *   The slice has no flush operation and provides no durability barrier.
 *   The host must await its mount's `sync` for changes that must survive reload.
 * - `poll_oneoff` reports every subscription complete immediately: clock waits
 *   (jj's lock backoff sleeps) become yields, and a synchronous filesystem is
 *   always ready. Nothing can be genuinely waited on in a single thread.
 * - `path_link` is `notsup`: the slice has no `linkSync`, and the jj code paths
 *   this package exercises never hard-link (the contract suite proves it).
 * - `path_filestat_set_times` always follows symlinks: the slice has no
 *   `lutimesSync`.
 * - `fd_readdir` lists the directory once per enumeration: a call at cookie
 *   zero takes a snapshot on the fd, later pages index it by cookie, and it is
 *   released when a page past the end yields nothing or the fd closes. Entries
 *   added or removed during an enumeration appear on the next cookie-zero
 *   enumeration; a cookie that arrives with no snapshot held lists afresh and
 *   indexes that listing, so a shorter directory ends the iteration early
 *   rather than failing.
 * - A directory fd names a PATH, not an inode. The slice has no `openat` and no
 *   directory handle to hold, so every use of an open directory fd re-resolves
 *   its namespace path. Rename the directory an fd was opened on and the fd
 *   follows the name, where POSIX would keep naming the moved directory. The
 *   alternative — remembering the host path at open time — is worse than a
 *   divergence: it is an escape, because a symlink left at the old name is then
 *   followed by the backend out of the preopen.
 * - `sock_*` and `proc_raise` are `notsup`; there are no sockets or signals in
 *   a tab.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import type { SyncDirentLike, SyncFsLike, SyncStatsLike } from "./WasiFs.ts"

/**
 * WASI preview 1 errno values, by their spec names. Exported so tests assert
 * numbers against names rather than magic literals.
 *
 * @category constants
 * @since 0.1.0
 */
export const Errno = {
  success: 0,
  acces: 2,
  again: 6,
  badf: 8,
  busy: 10,
  exist: 20,
  fault: 21,
  fbig: 22,
  inval: 28,
  io: 29,
  isdir: 31,
  loop: 32,
  mfile: 33,
  nametoolong: 37,
  nfile: 41,
  noent: 44,
  nolck: 46,
  nospc: 51,
  nosys: 52,
  notdir: 54,
  notempty: 55,
  notsup: 58,
  perm: 63,
  pipe: 64,
  range: 68,
  rofs: 69,
  spipe: 70,
  xdev: 75
} as const

/**
 * The wasm module called `proc_exit`. A reactor module must not exit, so the
 * shim turns the call into a thrown error that traps the calling export;
 * `BrowserJj` reports it as a failed operation.
 *
 * @category errors
 * @since 0.1.0
 */
export class WasiExitError extends Schema.TaggedError<WasiExitError>()("@smthrs/jj/WasiExitError", {
  /** The unsigned exit code the module passed to `proc_exit`. */
  exitCode: Schema.Number
}) {
  override get message(): string {
    return `wasm module called proc_exit(${this.exitCode})`
  }
}

/** Node-style error `code` strings mapped onto WASI errno values. */
const errnoByCode: Record<string, number> = {
  EACCES: Errno.acces,
  EAGAIN: Errno.again,
  EBADF: Errno.badf,
  EBUSY: Errno.busy,
  EEXIST: Errno.exist,
  EFBIG: Errno.fbig,
  EINVAL: Errno.inval,
  EIO: Errno.io,
  EISDIR: Errno.isdir,
  ELOOP: Errno.loop,
  EMFILE: Errno.mfile,
  ENAMETOOLONG: Errno.nametoolong,
  ENFILE: Errno.nfile,
  ENOENT: Errno.noent,
  ENOLCK: Errno.nolck,
  ENOSPC: Errno.nospc,
  ENOSYS: Errno.nosys,
  ENOTDIR: Errno.notdir,
  ENOTEMPTY: Errno.notempty,
  ENOTSUP: Errno.notsup,
  EOPNOTSUPP: Errno.notsup,
  EPERM: Errno.perm,
  EPIPE: Errno.pipe,
  ERANGE: Errno.range,
  EROFS: Errno.rofs,
  ESPIPE: Errno.spipe,
  EXDEV: Errno.xdev
}

const FILETYPE = { unknown: 0, characterDevice: 2, directory: 3, regularFile: 4, symbolicLink: 7 } as const
const OFLAGS = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const
const FDFLAGS = { append: 1 } as const
const FSTFLAGS = { atim: 1, atimNow: 2, mtim: 4, mtimNow: 8 } as const
const LOOKUPFLAGS = { symlinkFollow: 1 } as const
const RIGHTS = { fdRead: 1n << 1n, fdWrite: 1n << 6n } as const
/** Rights are an obsolete capability mask most hosts ignore; grant everything. */
const ALL_RIGHTS = 0xFFFF_FFFF_FFFF_FFFFn

/** Internal control flow: thrown by syscall bodies, returned as an errno. */
class ErrnoError {
  readonly errno: number
  constructor(errno: number) {
    this.errno = errno
  }
}

const fail = (errno: number): never => {
  throw new ErrnoError(errno)
}

/**
 * A WASI `u64` narrowed to a JavaScript number. Above
 * `Number.MAX_SAFE_INTEGER` the conversion is lossy, so the syscall refuses
 * instead of silently addressing a different byte: sizes and offsets are
 * EFBIG, and a directory cookie is EINVAL.
 *
 * WebAssembly hands an imported `i64` to JavaScript as a SIGNED bigint, so a
 * guest's `u64::MAX` arrives as `-1n`. Reinterpreting first is what makes the
 * bound apply to the value the guest actually passed rather than to the
 * negative number JavaScript sees.
 */
const checked = (value: bigint, errno: number): number => {
  const unsigned = BigInt.asUintN(64, value)
  if (unsigned > BigInt(Number.MAX_SAFE_INTEGER)) return fail(errno)
  return Number(unsigned)
}

/**
 * A WASI `u64` nanosecond stamp converted to the seconds `utimesSync` accepts.
 *
 * Timestamps cannot use {@link checked}: an ordinary wall-clock stamp already
 * exceeds `Number.MAX_SAFE_INTEGER`. Reinterpret the imported `i64` as unsigned,
 * then narrow only the seconds and subsecond remainder, which both fit safely in
 * a JavaScript number.
 */
const secondsOfNanoseconds = (value: bigint): number => {
  const unsigned = BigInt.asUintN(64, value)
  return Number(unsigned / 1_000_000_000n) + Number(unsigned % 1_000_000_000n) / 1e9
}

/** The Node-style string `code` of a thrown backend error, if it has one. */
const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined

/**
 * Milliseconds (with a fractional part carrying microseconds) to WASI
 * nanoseconds. Split at the millisecond so the multiplication never leaves
 * float-exact range: epoch milliseconds fit in 2^53 with room to spare, and
 * the fraction contributes less than 10^6.
 */
const nsOfMs = (ms: number): bigint => {
  const whole = Math.floor(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface FileFd {
  readonly kind: "file"
  readonly osFd: number
  offset: bigint
  append: boolean
}
interface DirFd {
  readonly kind: "dir"
  /**
   * The NAMESPACE path this fd names. The host path is deliberately NOT kept:
   * a guest can rename the directory an fd was opened on and put a symlink at
   * the old name, and a host path remembered at open time is then a name the
   * backend follows wherever the replacement points. Every use re-resolves.
   */
  readonly nsPath: string
  readonly preopen?: string
  /**
   * The listing an in-flight `fd_readdir` enumeration pages through. Taken
   * when a call starts at cookie zero, indexed directly by the cookie, and
   * released when a page yields nothing or the fd closes. Without it every page
   * re-lists and rescans the whole directory: quadratic over a large flat one.
   */
  enumeration?: ReadonlyArray<SyncDirentLike> | undefined
}
interface StdioFd {
  readonly kind: "stdio"
  readonly input: boolean
  readonly sink: ((text: string) => void) | undefined
}
type FdEntry = FileFd | DirFd | StdioFd
type Resolved = { readonly nsPath: string; readonly hostPath: string }

/** The meaningful segments of a path: `.` and empty drop, everything else stays. */
const partsOf = (raw: string): Array<string> => raw.split("/").filter((segment) => segment !== "" && segment !== ".")

const zeroStats = { size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 }

/**
 * What the shim serves the module: a synchronous filesystem, the slice of it
 * preopened as the WASI root, and where the module's stdout and stderr go.
 *
 * The filesystem must be *synchronous* because WASI preview 1 syscalls return
 * a value rather than a promise — there is nowhere to await inside an import.
 *
 * @category models
 * @since 0.1.0
 */
export interface WasiPreview1Options {
  /**
   * The synchronous filesystem the module's WASI namespace is served from.
   * The host must exclude concurrent namespace mutation during each syscall,
   * or the backend must independently confine every path operation. `root`
   * alone does not sandbox `node:fs` against a concurrent native writer.
   */
  readonly fs: SyncFsLike
  /**
   * The slice path preopened as the WASI namespace root `"/"`. Defaults to
   * `"/"` — the namespace *is* the slice — which is what a ZenFS mount wants;
   * tests over `node:fs` pass a temp directory here instead.
   */
  readonly root?: string
  /** Receives text the module writes to fd 1. Unset means the text is dropped. */
  readonly onStdout?: (text: string) => void
  /** Receives text the module writes to fd 2 — Rust panic messages arrive here. */
  readonly onStderr?: (text: string) => void
}

/**
 * A WASI preview 1 host: the `imports` object to instantiate a module with,
 * and the {@link WasiPreview1.initialize} call that binds its memory.
 *
 * The two are separate because the shim cannot read the module's memory until
 * the module exists, and the module cannot be instantiated without the
 * imports — so the binding necessarily happens after instantiation.
 *
 * @category models
 * @since 0.1.0
 */
export interface WasiPreview1 {
  /**
   * The `wasi_snapshot_preview1` import namespace: instantiate the module with
   * `{ wasi_snapshot_preview1: shim.imports }`. Every function returns a WASI
   * errno; backend errors are mapped by their Node-style `code`, and anything
   * without one (a genuine bug) is rethrown into the calling export rather
   * than laundered into an errno.
   */
  readonly imports: { readonly [name: string]: (...args: Array<any>) => number }
  /**
   * Binds the instantiated module's exported memory. Must be called after
   * instantiation and before the module's `_initialize` runs, because
   * `_initialize` may already issue syscalls (environ probing).
   */
  readonly initialize: (memory: WebAssembly.Memory) => void
  /**
   * Releases every host descriptor the guest still holds and empties the fd
   * table, so a guest that trapped (a Rust panic, `proc_exit`, a thrown host
   * callback) before its own `fd_close` calls leaks nothing into the backend.
   * Idempotent: a second call finds nothing to close. After it, every
   * descriptor answers `badf`, and the preopen is gone too, so the host must
   * not reuse the instance.
   *
   * A backend that refuses to close a descriptor does not stop the sweep: the
   * remaining descriptors are still closed, the table is still emptied, and
   * the first failure is rethrown afterwards.
   */
  readonly dispose: () => void
}

/**
 * Creates a WASI preview 1 host over a synchronous filesystem slice.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: WasiPreview1Options): WasiPreview1 => {
  const fs = options.fs
  const hostRoot = options.root ?? "/"
  const hostPrefix = hostRoot === "/" ? "" : hostRoot.replace(/\/+$/, "")

  let memory: WebAssembly.Memory | undefined

  const buffer = (): ArrayBuffer => {
    if (memory === undefined) {
      throw new Error("WasiPreview1: initialize(memory) must be called before the module issues syscalls")
    }
    return memory.buffer
  }
  const view = (): DataView => new DataView(buffer())
  /** A view into wasm memory; the constructor bounds-checks `ptr + len`. */
  const bytes = (ptr: number, len: number): Uint8Array<ArrayBuffer> => new Uint8Array(buffer(), ptr >>> 0, len >>> 0)

  // == fd table

  const fds = new Map<number, FdEntry>()
  fds.set(0, { kind: "stdio", input: true, sink: undefined })
  fds.set(1, { kind: "stdio", input: false, sink: options.onStdout })
  fds.set(2, { kind: "stdio", input: false, sink: options.onStderr })
  fds.set(3, { kind: "dir", nsPath: "/", preopen: "/" })
  let nextFd = 4

  const entryOf = (fd: number): FdEntry => {
    const entry = fds.get(fd >>> 0)
    if (entry === undefined) return fail(Errno.badf)
    return entry
  }
  const fileOf = (fd: number): FileFd => {
    const entry = entryOf(fd)
    if (entry.kind !== "file") return fail(entry.kind === "stdio" ? Errno.spipe : Errno.badf)
    return entry
  }
  const dirOf = (fd: number): DirFd => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir") return fail(Errno.notdir)
    return entry
  }
  const newFd = (entry: FdEntry): number => {
    const fd = nextFd++
    fds.set(fd, entry)
    return fd
  }

  // == path resolution

  const hostPathOf = (segments: Array<string>): string =>
    segments.length === 0
      ? (hostPrefix === "" ? "/" : hostPrefix)
      : `${hostPrefix}/${segments.join("/")}`

  /**
   * Resolves a path in NAMESPACE coordinates under the namespace ownership
   * requirement above. `.` and empty segments drop; every traversed ancestor
   * must exist and be a directory after symlink expansion, even if a following
   * `..` consumes it. `..` of the namespace root remains the root.
   *
   * Every component EXCEPT the last is followed through symlinks here, and each
   * hop is re-rooted the same way, so a link naming a directory cannot smuggle
   * the rest of the path out of the slice. That matters because the backend
   * follows every symlink component of whatever host path it is handed: without
   * this walk, `/gate/file` with `/gate` a link to `/etc` reaches `/etc/file`
   * even though the lexical clamp never saw an escape.
   *
   * The last component is left as it lies. Whether it is followed belongs to
   * the caller: `path_symlink` and `path_readlink` address the link itself, and
   * `path_open` follows only when `symlinkFollow` is set.
   */
  const walk = (base: ReadonlyArray<string>, raw: string): Resolved => {
    let resolved: Array<string> = []
    const pending = (raw.startsWith("/") ? partsOf(raw) : [...base, ...partsOf(raw)]).reverse()
    let hops = 0
    for (let segment = pending.pop(); segment !== undefined; segment = pending.pop()) {
      if (segment === "..") {
        resolved.pop()
        continue
      }
      const candidate = [...resolved, segment]
      if (pending.length > 0) {
        const stats = fs.lstatSync(hostPathOf(candidate))
        if (stats.isSymbolicLink()) {
          if (hops++ >= 40) return fail(Errno.loop)
          const link = fs.readlinkSync(hostPathOf(candidate))
          if (link.startsWith("/")) resolved = []
          pending.push(...partsOf(link).reverse())
          continue
        }
        if (!stats.isDirectory()) return fail(Errno.notdir)
      }
      resolved = candidate
    }
    return { nsPath: `/${resolved.join("/")}`, hostPath: hostPathOf(resolved) }
  }

  /**
   * The host path a directory fd names RIGHT NOW, resolved from the namespace
   * root every time rather than remembered at open time.
   */
  const dirTarget = (dir: DirFd): Resolved =>
    dir.preopen === undefined
      ? resolveLinkTarget(walk([], dir.nsPath))
      // The preopen is the namespace root. Nothing inside can rename or replace
      // it (`notRoot` refuses), so its host path is fixed by construction and
      // re-resolving it would only cost every syscall an extra `lstat`.
      : { nsPath: "/", hostPath: hostPathOf([]) }

  const resolvePath = (dirFd: number, ptr: number, len: number): Resolved => {
    const dir = dirOf(dirFd)
    const raw = decoder.decode(bytes(ptr, len))
    if (raw.length === 0) return fail(Errno.noent)
    return walk(partsOf(dirTarget(dir).nsPath), raw)
  }

  /**
   * Refuses a mutation addressed at the namespace root itself. Removing or
   * replacing `/` would put the preopen's own name under the guest's control,
   * and a symlink created there is followed by the backend on every later call.
   */
  const notRoot = (target: Resolved): Resolved => target.nsPath === "/" ? fail(Errno.busy) : target

  // == stat plumbing

  const filetypeOf = (stats: SyncStatsLike | SyncDirentLike): number =>
    stats.isFile()
      ? FILETYPE.regularFile
      : stats.isDirectory()
      ? FILETYPE.directory
      : stats.isSymbolicLink()
      ? FILETYPE.symbolicLink
      : FILETYPE.unknown

  const writeFilestat = (
    ptr: number,
    filetype: number,
    stats: {
      readonly size: number
      readonly atimeMs: number
      readonly mtimeMs: number
      readonly ctimeMs: number
      readonly ino?: number
    }
  ): void => {
    const v = view()
    const at = ptr >>> 0
    v.setBigUint64(at, 0n, true) // dev
    v.setBigUint64(at + 8, BigInt(Math.trunc(stats.ino ?? 0)), true)
    v.setBigUint64(at + 16, BigInt(filetype), true) // u8 filetype + 7 pad bytes
    v.setBigUint64(at + 24, 1n, true) // nlink
    v.setBigUint64(at + 32, BigInt(stats.size), true)
    v.setBigUint64(at + 40, nsOfMs(stats.atimeMs), true)
    v.setBigUint64(at + 48, nsOfMs(stats.mtimeMs), true)
    v.setBigUint64(at + 56, nsOfMs(stats.ctimeMs), true)
  }

  const statOrUndefined = (path: string): SyncStatsLike | undefined => {
    try {
      return fs.statSync(path)
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") return undefined
      throw cause
    }
  }

  const isSymlink = (path: string): boolean => {
    try {
      return fs.lstatSync(path).isSymbolicLink()
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") return false
      throw cause
    }
  }

  /**
   * Walks a symlink chain in namespace coordinates, so every hop goes through
   * the same lexical clamp `resolvePath` applies: an absolute target is
   * namespace-absolute (re-rooted at the preopen), a relative one resolves
   * against the link's own directory, and `..` can never climb past the root.
   * A chain longer than the depth cap is ELOOP.
   */
  const resolveLinkTarget = (target: Resolved): Resolved => {
    let current = target
    for (let depth = 0; depth < 40; depth++) {
      if (!isSymlink(current.hostPath)) return current
      const parent = current.nsPath.split("/").filter((segment) => segment.length > 0).slice(0, -1)
      current = walk(parent, fs.readlinkSync(current.hostPath))
    }
    return fail(Errno.loop)
  }

  /**
   * `fst_flags` decoded: an explicit nanosecond stamp, "now", or — when a side
   * is unset — the side's current value, read (through `statsOf`, so the fd
   * and path flavours each read their own addressee) before the write.
   */
  const resolveTimes = (
    statsOf: () => SyncStatsLike,
    atim: bigint,
    mtim: bigint,
    flags: number
  ): { readonly atimeSec: number; readonly mtimeSec: number } => {
    if ((flags & (FSTFLAGS.atim | FSTFLAGS.atimNow)) === (FSTFLAGS.atim | FSTFLAGS.atimNow)) fail(Errno.inval)
    if ((flags & (FSTFLAGS.mtim | FSTFLAGS.mtimNow)) === (FSTFLAGS.mtim | FSTFLAGS.mtimNow)) fail(Errno.inval)
    const stats = statsOf()
    // Deliberately ambient `Date.now`, not Effect's `Clock`: this is the
    // guest's own `clock_realtime`, read inside a synchronous WASI import
    // callback that the wasm module calls directly. There is no Effect fiber
    // on this stack to read a service from, and a guest whose wall clock came
    // from a swapped test clock would be lied to about the world it runs in.
    const nowSec = Date.now() / 1e3
    const atimeSec = (flags & FSTFLAGS.atim) !== 0
      ? secondsOfNanoseconds(atim)
      : (flags & FSTFLAGS.atimNow) !== 0
      ? nowSec
      : stats.atimeMs / 1e3
    const mtimeSec = (flags & FSTFLAGS.mtim) !== 0
      ? secondsOfNanoseconds(mtim)
      : (flags & FSTFLAGS.mtimNow) !== 0
      ? nowSec
      : stats.mtimeMs / 1e3
    return { atimeSec, mtimeSec }
  }

  // == iovecs

  const iovecs = (ptr: number, count: number): Array<{ readonly ptr: number; readonly len: number }> => {
    const v = view()
    const base = ptr >>> 0
    const out: Array<{ readonly ptr: number; readonly len: number }> = []
    for (let i = 0; i < (count >>> 0); i++) {
      out.push({ ptr: v.getUint32(base + i * 8, true), len: v.getUint32(base + i * 8 + 4, true) })
    }
    return out
  }

  // == syscalls

  const argsGet = (_argvPtr: number, _argvBufPtr: number): number => Errno.success

  const argsSizesGet = (argcPtr: number, argvBufSizePtr: number): number => {
    const v = view()
    v.setUint32(argcPtr >>> 0, 0, true)
    v.setUint32(argvBufSizePtr >>> 0, 0, true)
    return Errno.success
  }

  const clockResGet = (id: number, retPtr: number): number => {
    const resolution = id === 0 ? 1_000_000n : id === 1 || id === 2 || id === 3 ? 1_000n : fail(Errno.inval)
    view().setBigUint64(retPtr >>> 0, resolution, true)
    return Errno.success
  }

  const clockTimeGet = (id: number, _precision: bigint, retPtr: number): number => {
    // Same exemption as `resolveTimes` above: `clock_time_get` IS the WASI
    // clock shim, called synchronously by the guest, so it reads the host
    // clock directly rather than routing through Effect's `Clock`.
    const now = id === 0
      ? BigInt(Date.now()) * 1_000_000n
      : id === 1 || id === 2 || id === 3
      ? nsOfMs(performance.now())
      : fail(Errno.inval)
    view().setBigUint64(retPtr >>> 0, now, true)
    return Errno.success
  }

  const environGet = (_environPtr: number, _environBufPtr: number): number => Errno.success

  const environSizesGet = (countPtr: number, bufSizePtr: number): number => {
    const v = view()
    v.setUint32(countPtr >>> 0, 0, true)
    v.setUint32(bufSizePtr >>> 0, 0, true)
    return Errno.success
  }

  const fdAdvise = (fd: number, _offset: bigint, _len: bigint, _advice: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdAllocate = (fd: number, _offset: bigint, _len: bigint): number => {
    fileOf(fd)
    return Errno.notsup
  }

  const fdClose = (fd: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "file") fs.closeSync(entry.osFd)
    else if (entry.kind === "dir") entry.enumeration = undefined
    fds.delete(fd >>> 0)
    return Errno.success
  }

  const fdDatasync = (fd: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdFdstatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    const filetype = entry.kind === "stdio"
      ? FILETYPE.characterDevice
      : entry.kind === "dir"
      ? FILETYPE.directory
      : FILETYPE.regularFile
    const flags = entry.kind === "file" && entry.append ? FDFLAGS.append : 0
    const v = view()
    const at = retPtr >>> 0
    v.setUint8(at, filetype)
    v.setUint8(at + 1, 0)
    v.setUint16(at + 2, flags, true)
    v.setUint32(at + 4, 0, true)
    v.setBigUint64(at + 8, ALL_RIGHTS, true)
    v.setBigUint64(at + 16, ALL_RIGHTS, true)
    return Errno.success
  }

  const fdFdstatSetFlags = (fd: number, flags: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "file") entry.append = (flags & FDFLAGS.append) !== 0
    return Errno.success
  }

  const fdFdstatSetRights = (fd: number, _base: bigint, _inheriting: bigint): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdFilestatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      writeFilestat(retPtr, FILETYPE.characterDevice, zeroStats)
      return Errno.success
    }
    const stats = entry.kind === "file" ? fs.fstatSync(entry.osFd) : fs.statSync(dirTarget(entry).hostPath)
    writeFilestat(retPtr, filetypeOf(stats), stats)
    return Errno.success
  }

  // The fd-addressed mutations go through the open os fd, never a path
  // remembered at open time: after a `path_rename` (jj's tempfile persist:
  // open → rename → mutate) the remembered path would name a different — or
  // freshly created, unrelated — file.
  const fdFilestatSetSize = (fd: number, size: bigint): number => {
    const entry = fileOf(fd)
    fs.ftruncateSync(entry.osFd, checked(size, Errno.fbig))
    return Errno.success
  }

  const fdFilestatSetTimes = (fd: number, atim: bigint, mtim: bigint, flags: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") return fail(Errno.badf)
    if (entry.kind === "file") {
      const times = resolveTimes(() => fs.fstatSync(entry.osFd), atim, mtim, flags)
      fs.futimesSync(entry.osFd, times.atimeSec, times.mtimeSec)
      return Errno.success
    }
    const directory = dirTarget(entry).hostPath
    const times = resolveTimes(() => fs.statSync(directory), atim, mtim, flags)
    fs.utimesSync(directory, times.atimeSec, times.mtimeSec)
    return Errno.success
  }

  const fdPread = (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number => {
    const entry = fileOf(fd)
    let position = offset
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.readSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, checked(position, Errno.fbig))
      position += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nreadPtr >>> 0, total, true)
    return Errno.success
  }

  const fdPrestatGet = (fd: number, retPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir" || entry.preopen === undefined) return fail(Errno.badf)
    const v = view()
    v.setUint32(retPtr >>> 0, 0, true) // tag: preopened directory, plus 3 pad bytes
    v.setUint32((retPtr >>> 0) + 4, encoder.encode(entry.preopen).length, true)
    return Errno.success
  }

  const fdPrestatDirName = (fd: number, ptr: number, len: number): number => {
    const entry = entryOf(fd)
    if (entry.kind !== "dir" || entry.preopen === undefined) return fail(Errno.badf)
    const name = encoder.encode(entry.preopen)
    if ((len >>> 0) < name.length) return fail(Errno.nametoolong)
    bytes(ptr, name.length).set(name)
    return Errno.success
  }

  const fdPwrite = (fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number => {
    const entry = fileOf(fd)
    let position = offset
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.writeSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, checked(position, Errno.fbig))
      position += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nwrittenPtr >>> 0, total, true)
    return Errno.success
  }

  const fdRead = (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      if (!entry.input) return fail(Errno.badf)
      view().setUint32(nreadPtr >>> 0, 0, true) // stdin is empty: immediate EOF
      return Errno.success
    }
    if (entry.kind === "dir") return fail(Errno.isdir)
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      const n = fs.readSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, checked(entry.offset, Errno.fbig))
      entry.offset += BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nreadPtr >>> 0, total, true)
    return Errno.success
  }

  const fdReaddir = (fd: number, bufPtr: number, bufLen: number, cookie: bigint, retPtr: number): number => {
    const dir = dirOf(fd)
    const start = checked(cookie, Errno.inval)
    // Cookie zero starts a new enumeration; any other cookie continues the one
    // this fd holds, or, when none is held, indexes a fresh listing.
    const entries = start === 0 || dir.enumeration === undefined
      ? fs.readdirSync(dirTarget(dir).hostPath, { withFileTypes: true })
      : dir.enumeration
    dir.enumeration = entries
    const len = bufLen >>> 0
    const buf = bytes(bufPtr, len)
    let used = 0
    let index = start
    for (; index < entries.length; index++) {
      if (used >= len) break
      const dirent = entries[index]!
      const name = encoder.encode(dirent.name)
      const record = new Uint8Array(24 + name.length)
      const rv = new DataView(record.buffer)
      rv.setBigUint64(0, BigInt(index + 1), true) // d_next: the cookie that resumes after this entry
      rv.setBigUint64(8, 0n, true) // d_ino
      rv.setUint32(16, name.length, true)
      rv.setUint32(20, filetypeOf(dirent), true) // u8 d_type + 3 pad bytes
      record.set(name, 24)
      const n = Math.min(record.length, len - used) // the spec truncates the final entry to fit
      buf.set(record.subarray(0, n), used)
      used += n
    }
    // EOF is the page that yields nothing: guests read until an empty page, so
    // releasing on the last populated one would re-list for that final call.
    if (start >= entries.length) dir.enumeration = undefined
    view().setUint32(retPtr >>> 0, used, true)
    return Errno.success
  }

  const fdRenumber = (from: number, to: number): number => {
    const entry = entryOf(from)
    if ((from >>> 0) === (to >>> 0)) return Errno.success
    const previous = fds.get(to >>> 0)
    if (previous !== undefined && previous.kind === "file") fs.closeSync(previous.osFd)
    fds.set(to >>> 0, entry)
    fds.delete(from >>> 0)
    // The allocator must never revisit the target number: a later path_open
    // reusing it would silently overwrite the live renumbered entry.
    if ((to >>> 0) >= nextFd) nextFd = (to >>> 0) + 1
    return Errno.success
  }

  const fdSeek = (fd: number, offset: bigint, whence: number, retPtr: number): number => {
    const entry = fileOf(fd)
    const target = whence === 0
      ? offset
      : whence === 1
      ? entry.offset + offset
      : whence === 2
      ? BigInt(fs.fstatSync(entry.osFd).size) + offset
      : fail(Errno.inval)
    if (target < 0n) return fail(Errno.inval)
    entry.offset = target
    view().setBigUint64(retPtr >>> 0, target, true)
    return Errno.success
  }

  const fdSync = (fd: number): number => {
    entryOf(fd)
    return Errno.success
  }

  const fdTell = (fd: number, retPtr: number): number => {
    const entry = fileOf(fd)
    view().setBigUint64(retPtr >>> 0, entry.offset, true)
    return Errno.success
  }

  const fdWrite = (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
    const entry = entryOf(fd)
    if (entry.kind === "stdio") {
      if (entry.input) return fail(Errno.badf)
      const list = iovecs(iovsPtr, iovsLen)
      const total = list.reduce((sum, iov) => sum + iov.len, 0)
      const joined = new Uint8Array(total)
      let at = 0
      for (const iov of list) {
        joined.set(bytes(iov.ptr, iov.len), at)
        at += iov.len
      }
      if (entry.sink !== undefined) entry.sink(decoder.decode(joined))
      view().setUint32(nwrittenPtr >>> 0, total, true)
      return Errno.success
    }
    if (entry.kind === "dir") return fail(Errno.badf)
    let total = 0
    for (const iov of iovecs(iovsPtr, iovsLen)) {
      if (iov.len === 0) continue
      // Append targets the current end of file explicitly, so the semantics do
      // not depend on the backing fd carrying an OS-level O_APPEND — an fd can
      // acquire the flag later through fd_fdstat_set_flags.
      const position = entry.append ? fs.fstatSync(entry.osFd).size : checked(entry.offset, Errno.fbig)
      const n = fs.writeSync(entry.osFd, bytes(iov.ptr, iov.len), 0, iov.len, position)
      entry.offset = entry.append ? BigInt(position + n) : entry.offset + BigInt(n)
      total += n
      if (n < iov.len) break
    }
    view().setUint32(nwrittenPtr >>> 0, total, true)
    return Errno.success
  }

  const pathCreateDirectory = (fd: number, ptr: number, len: number): number => {
    const target = notRoot(resolvePath(fd, ptr, len))
    fs.mkdirSync(target.hostPath)
    return Errno.success
  }

  const pathFilestatGet = (fd: number, lookupflags: number, ptr: number, len: number, retPtr: number): number => {
    const requested = resolvePath(fd, ptr, len)
    const stats = (lookupflags & LOOKUPFLAGS.symlinkFollow) !== 0
      ? fs.statSync(resolveLinkTarget(requested).hostPath)
      : fs.lstatSync(requested.hostPath)
    writeFilestat(retPtr, filetypeOf(stats), stats)
    return Errno.success
  }

  const pathFilestatSetTimes = (
    fd: number,
    _lookupflags: number,
    ptr: number,
    len: number,
    atim: bigint,
    mtim: bigint,
    fstflags: number
  ): number => {
    // The slice has no `lutimesSync`, so this always follows the last component
    // (the documented divergence). It follows it through the namespace resolver,
    // subject to the same exclusive-namespace requirement as other path calls.
    const target = resolveLinkTarget(resolvePath(fd, ptr, len))
    const times = resolveTimes(() => fs.statSync(target.hostPath), atim, mtim, fstflags)
    fs.utimesSync(target.hostPath, times.atimeSec, times.mtimeSec)
    return Errno.success
  }

  const pathLink = (
    _oldFd: number,
    _oldFlags: number,
    _oldPtr: number,
    _oldLen: number,
    _newFd: number,
    _newPtr: number,
    _newLen: number
  ): number => Errno.notsup

  /**
   * WASI `oflags`/`fdflags`/rights composed onto Node **string** open flags.
   * The one combination string flags cannot express directly — `O_CREAT`
   * without `O_TRUNC` on a missing file — opens `"wx"`-family instead, which
   * is equivalent because the file does not exist; and `O_CREAT` with
   * read-only rights creates via `"wx"` then reopens `"r"`.
   */
  const openFile = (
    path: string,
    o: {
      readonly existing: boolean
      readonly creat: boolean
      readonly excl: boolean
      readonly trunc: boolean
      readonly read: boolean
      readonly write: boolean
      readonly append: boolean
    }
  ): number => {
    if (!o.write) {
      if (o.creat && !o.existing) fs.closeSync(fs.openSync(path, "wx"))
      return fs.openSync(path, "r")
    }
    let flags: string
    if (o.append) {
      // The earlier existence probe cannot make O_EXCL atomic. Keeping the
      // exclusive append flag here makes the backend reject a file created in
      // that gap instead of opening the concurrent writer's file.
      flags = o.creat && o.excl ? (o.read ? "ax+" : "ax") : o.read ? "a+" : "a"
    } else if (o.creat) {
      // `O_CREAT|O_EXCL` keeps an exclusive flag even with `O_TRUNC`. The
      // caller's existence check happened one syscall ago, and O_EXCL exists
      // precisely so that gap cannot be used: without `wx` a file created in
      // between is TRUNCATED instead of answering EEXIST.
      if (o.trunc) {
        flags = o.excl ? (o.read ? "wx+" : "wx") : o.read ? "w+" : "w"
      } else {
        flags = o.existing ? "r+" : o.read ? "wx+" : "wx"
      }
    } else {
      flags = "r+"
    }
    const osFd = fs.openSync(path, flags)
    try {
      // Append flags preserve existing bytes; only the non-append create
      // flags already perform truncation as part of openSync.
      if (o.trunc && (o.append || !o.creat)) fs.ftruncateSync(osFd, 0)
      return osFd
    } catch (cause) {
      try {
        fs.closeSync(osFd)
      } catch {
        // Preserve the initialization error even when cleanup fails.
      }
      throw cause
    }
  }

  const pathOpen = (
    dirFd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    rightsBase: bigint,
    _rightsInheriting: bigint,
    fdflags: number,
    retPtr: number
  ): number => {
    // Validate the entire result before opening a host fd or allocating a
    // guest fd (including directories), so EFAULT cannot strand either one.
    bytes(retPtr, 4)
    // These checks are not atomic with openFile. In particular, no-follow
    // rejects a stable final link; it cannot stop an external writer replacing
    // that file or any ancestor before the backend's string-path open.
    const requested = resolvePath(dirFd, pathPtr, pathLen)
    const follow = (dirflags & LOOKUPFLAGS.symlinkFollow) !== 0
    const linked = isSymlink(requested.hostPath)
    const creat = (oflags & OFLAGS.creat) !== 0
    const excl = (oflags & OFLAGS.excl) !== 0
    // POSIX: O_CREAT|O_EXCL is EEXIST on a symlink, dangling or not, and it is
    // decided BEFORE O_NOFOLLOW, which would otherwise answer ELOOP for the
    // same open.
    if (linked && creat && excl) return fail(Errno.exist)
    if (linked && !follow) return fail(Errno.loop)
    const target = linked ? resolveLinkTarget(requested) : requested
    const trunc = (oflags & OFLAGS.trunc) !== 0
    const wantDir = (oflags & OFLAGS.directory) !== 0
    const read = (rightsBase & RIGHTS.fdRead) !== 0n
    const write = (rightsBase & RIGHTS.fdWrite) !== 0n
    const append = (fdflags & FDFLAGS.append) !== 0
    const existing = statOrUndefined(target.hostPath)

    if (creat && excl && existing !== undefined) return fail(Errno.exist)
    if (existing !== undefined && existing.isDirectory()) {
      if (write || trunc) return fail(Errno.isdir)
      view().setUint32(retPtr >>> 0, newFd({ kind: "dir", nsPath: target.nsPath }), true)
      return Errno.success
    }
    if (wantDir) return fail(existing === undefined ? Errno.noent : Errno.notdir)
    if (existing === undefined && !creat) return fail(Errno.noent)
    if (trunc && !write) return fail(Errno.inval)

    const osFd = openFile(target.hostPath, {
      existing: existing !== undefined,
      creat,
      excl,
      trunc,
      read,
      write,
      append
    })
    view().setUint32(retPtr >>> 0, newFd({ kind: "file", osFd, offset: 0n, append }), true)
    return Errno.success
  }

  const pathReadlink = (
    fd: number,
    ptr: number,
    len: number,
    bufPtr: number,
    bufLen: number,
    retPtr: number
  ): number => {
    const target = resolvePath(fd, ptr, len)
    const linkTarget = encoder.encode(fs.readlinkSync(target.hostPath))
    const n = Math.min(linkTarget.length, bufLen >>> 0)
    bytes(bufPtr, n).set(linkTarget.subarray(0, n))
    view().setUint32(retPtr >>> 0, n, true)
    return Errno.success
  }

  const pathRemoveDirectory = (fd: number, ptr: number, len: number): number => {
    const target = notRoot(resolvePath(fd, ptr, len))
    fs.rmdirSync(target.hostPath)
    return Errno.success
  }

  const pathRename = (
    fd: number,
    oldPtr: number,
    oldLen: number,
    newFd: number,
    newPtr: number,
    newLen: number
  ): number => {
    const from = notRoot(resolvePath(fd, oldPtr, oldLen))
    const to = notRoot(resolvePath(newFd, newPtr, newLen))
    fs.renameSync(from.hostPath, to.hostPath)
    return Errno.success
  }

  const pathSymlink = (oldPtr: number, oldLen: number, fd: number, newPtr: number, newLen: number): number => {
    const linkTarget = decoder.decode(bytes(oldPtr, oldLen))
    if (linkTarget.length === 0) return fail(Errno.noent)
    const at = notRoot(resolvePath(fd, newPtr, newLen))
    fs.symlinkSync(linkTarget, at.hostPath)
    return Errno.success
  }

  const pathUnlinkFile = (fd: number, ptr: number, len: number): number => {
    const target = notRoot(resolvePath(fd, ptr, len))
    fs.unlinkSync(target.hostPath)
    return Errno.success
  }

  const pollOneoff = (inPtr: number, outPtr: number, nsubscriptions: number, retPtr: number): number => {
    const count = nsubscriptions >>> 0
    if (count === 0) return fail(Errno.inval)
    const v = view()
    for (let i = 0; i < count; i++) {
      const sub = (inPtr >>> 0) + i * 48
      const event = (outPtr >>> 0) + i * 32
      v.setBigUint64(event, v.getBigUint64(sub, true), true) // userdata
      v.setUint16(event + 8, Errno.success, true)
      v.setUint32(event + 10, v.getUint8(sub + 8), true) // u8 event type + pad
      v.setBigUint64(event + 16, 0n, true)
      v.setBigUint64(event + 24, 0n, true)
    }
    v.setUint32(retPtr >>> 0, count, true)
    return Errno.success
  }

  const procExit = (code: number): number => {
    throw new WasiExitError({ exitCode: code >>> 0 })
  }

  const procRaise = (_signal: number): number => Errno.notsup

  const randomGet = (ptr: number, len: number): number => {
    const target = bytes(ptr, len)
    for (let at = 0; at < target.length; at += 65536) {
      crypto.getRandomValues(target.subarray(at, Math.min(at + 65536, target.length)))
    }
    return Errno.success
  }

  const schedYield = (): number => Errno.success

  const sockAccept = (_fd: number, _flags: number, _retPtr: number): number => Errno.notsup
  const sockRecv = (
    _fd: number,
    _iovsPtr: number,
    _iovsLen: number,
    _riFlags: number,
    _nreadPtr: number,
    _roFlagsPtr: number
  ): number => Errno.notsup
  const sockSend = (_fd: number, _iovsPtr: number, _iovsLen: number, _siFlags: number, _nwrittenPtr: number): number =>
    Errno.notsup
  const sockShutdown = (_fd: number, _how: number): number => Errno.notsup

  // == the import namespace

  /** Backend and internal errors surfaced as errno; real bugs rethrown. */
  const errnoOf = (cause: unknown): number => {
    if (cause instanceof ErrnoError) return cause.errno
    if (cause instanceof RangeError) return Errno.fault // out-of-bounds wasm memory access
    const code = codeOf(cause)
    if (code !== undefined) return errnoByCode[code] ?? Errno.io
    throw cause
  }

  const syscall = <Args extends Array<number | bigint>>(body: (...args: Args) => number) => (...args: Args): number => {
    try {
      return body(...args)
    } catch (cause) {
      return errnoOf(cause)
    }
  }

  const imports = {
    args_get: syscall(argsGet),
    args_sizes_get: syscall(argsSizesGet),
    clock_res_get: syscall(clockResGet),
    clock_time_get: syscall(clockTimeGet),
    environ_get: syscall(environGet),
    environ_sizes_get: syscall(environSizesGet),
    fd_advise: syscall(fdAdvise),
    fd_allocate: syscall(fdAllocate),
    fd_close: syscall(fdClose),
    fd_datasync: syscall(fdDatasync),
    fd_fdstat_get: syscall(fdFdstatGet),
    fd_fdstat_set_flags: syscall(fdFdstatSetFlags),
    fd_fdstat_set_rights: syscall(fdFdstatSetRights),
    fd_filestat_get: syscall(fdFilestatGet),
    fd_filestat_set_size: syscall(fdFilestatSetSize),
    fd_filestat_set_times: syscall(fdFilestatSetTimes),
    fd_pread: syscall(fdPread),
    fd_prestat_get: syscall(fdPrestatGet),
    fd_prestat_dir_name: syscall(fdPrestatDirName),
    fd_pwrite: syscall(fdPwrite),
    fd_read: syscall(fdRead),
    fd_readdir: syscall(fdReaddir),
    fd_renumber: syscall(fdRenumber),
    fd_seek: syscall(fdSeek),
    fd_sync: syscall(fdSync),
    fd_tell: syscall(fdTell),
    fd_write: syscall(fdWrite),
    path_create_directory: syscall(pathCreateDirectory),
    path_filestat_get: syscall(pathFilestatGet),
    path_filestat_set_times: syscall(pathFilestatSetTimes),
    path_link: syscall(pathLink),
    path_open: syscall(pathOpen),
    path_readlink: syscall(pathReadlink),
    path_remove_directory: syscall(pathRemoveDirectory),
    path_rename: syscall(pathRename),
    path_symlink: syscall(pathSymlink),
    path_unlink_file: syscall(pathUnlinkFile),
    poll_oneoff: syscall(pollOneoff),
    proc_exit: syscall(procExit),
    proc_raise: syscall(procRaise),
    random_get: syscall(randomGet),
    sched_yield: syscall(schedYield),
    sock_accept: syscall(sockAccept),
    sock_recv: syscall(sockRecv),
    sock_send: syscall(sockSend),
    sock_shutdown: syscall(sockShutdown)
  }

  const dispose = (): void => {
    let first: { readonly cause: unknown } | undefined
    for (const [fd, entry] of fds) {
      fds.delete(fd)
      if (entry.kind !== "file") continue
      try {
        fs.closeSync(entry.osFd)
      } catch (cause) {
        first ??= { cause }
      }
    }
    if (first !== undefined) throw first.cause
  }

  return {
    imports,
    initialize: (exported) => {
      memory = exported
    },
    dispose
  }
}
