/**
 * The WASI preview 1 shim, exercised two ways — the same split the
 * `BrowserFileSystem` suite uses. Operations run against **`node:fs` in temp
 * directories**: it satisfies `SyncFsLike` structurally, which is the whole
 * point of the slice, so the syscall semantics are checked against a real
 * filesystem. Errno mapping runs against stub slices, because a real backend
 * cannot be made to throw `ENOLCK` on demand.
 *
 * No wasm module appears anywhere: the syscalls are plain functions over a
 * `WebAssembly.Memory` the tests construct and inspect directly.
 */
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SyncDirentLike, SyncFsLike } from "../src/browser/WasiFs.ts"
import { Errno as E, make, WasiExitError } from "../src/browser/WasiPreview1.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** The slice contract, held structurally by `node:fs` itself. */
const nodeFs: SyncFsLike = fsModule

// Scratch memory map for the tests (distinct regions, 3 pages total).
const PATH_A = 0x100
const PATH_B = 0x200
const IOV = 0x300
const RET = 0x340
const RET_B = 0x348
const STAT = 0x600
const FDSTAT = 0x680
const SUB = 0x700
const EVENT = 0x800
const BUF = 0x1000
const DATA = 0x2000

const R = 1n << 1n
const W = 1n << 6n
const RW = R | W
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER)
const TOO_LARGE_U64 = MAX_SAFE_U64 + 1n
const U64_MAX = (1n << 64n) - 1n
/**
 * The value a real guest delivers for `u64::MAX`: WebAssembly hands an imported
 * `i64` to JavaScript as a SIGNED bigint, so the bit pattern arrives negative
 * and a bound that only tests the upper end never sees it.
 */
const U64_MAX_AS_WASM_PASSES_IT = -1n

// These fixtures assert POSIX symlink semantics against node:fs. Windows
// symlink creation depends on external privilege/developer-mode policy, so
// native symlink fixtures are explicitly unsupported on that host.
const supportsNativeSymlinks = process.platform !== "win32"

const OFLAG = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const

interface Host {
  readonly memory: WebAssembly.Memory
  readonly sys: { readonly [name: string]: (...args: Array<any>) => number }
  readonly view: () => DataView
  readonly str: (at: number, text: string) => { readonly ptr: number; readonly len: number }
  readonly iovs: (list: Array<{ readonly ptr: number; readonly len: number }>) => number
  readonly put: (at: number, data: Uint8Array) => void
  readonly get: (at: number, len: number) => Uint8Array
  readonly u32: (at: number) => number
  readonly u64: (at: number) => bigint
}

const host = (
  options: {
    readonly fs?: SyncFsLike
    readonly root?: string
    readonly onStdout?: (text: string) => void
    readonly onStderr?: (text: string) => void
  } = {}
): Host => {
  const memory = new WebAssembly.Memory({ initial: 3 })
  const wasi = make({
    fs: options.fs ?? nodeFs,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr })
  })
  wasi.initialize(memory)
  const view = () => new DataView(memory.buffer)
  return {
    memory,
    sys: wasi.imports,
    view,
    str: (at, text) => {
      const bytes = encoder.encode(text)
      new Uint8Array(memory.buffer, at, bytes.length).set(bytes)
      return { ptr: at, len: bytes.length }
    },
    iovs: (list) => {
      list.forEach((iov, index) => {
        view().setUint32(IOV + index * 8, iov.ptr, true)
        view().setUint32(IOV + index * 8 + 4, iov.len, true)
      })
      return IOV
    },
    put: (at, data) => new Uint8Array(memory.buffer, at, data.length).set(data),
    get: (at, len) => new Uint8Array(memory.buffer, at, len).slice(),
    u32: (at) => view().getUint32(at, true),
    u64: (at) => view().getBigUint64(at, true)
  }
}

/** `path_open` through the preopen, asserting success and returning the fd. */
const open = (
  h: Host,
  path: string,
  options: {
    readonly oflags?: number
    readonly rights?: bigint
    readonly fdflags?: number
    readonly dirflags?: number
  } = {}
): number => {
  const p = h.str(PATH_A, path)
  const errno = h.sys.path_open!(
    3,
    options.dirflags ?? 1,
    p.ptr,
    p.len,
    options.oflags ?? 0,
    options.rights ?? R,
    0n,
    options.fdflags ?? 0,
    RET
  )
  expect(errno).toBe(E.success)
  return h.u32(RET)
}

const openErrno = (
  h: Host,
  path: string,
  options: {
    readonly oflags?: number
    readonly rights?: bigint
    readonly fdflags?: number
    readonly dirflags?: number
  } = {}
): number => {
  const p = h.str(PATH_A, path)
  return h.sys.path_open!(
    3,
    options.dirflags ?? 1,
    p.ptr,
    p.len,
    options.oflags ?? 0,
    options.rights ?? R,
    0n,
    options.fdflags ?? 0,
    RET
  )
}

const writeAll = (h: Host, fd: number, text: string): number => {
  const data = h.str(DATA, text)
  return h.sys.fd_write!(fd, h.iovs([data]), 1, RET)
}

const readAll = (h: Host, fd: number, len: number): string => {
  h.view().setUint32(IOV, BUF, true)
  h.view().setUint32(IOV + 4, len, true)
  expect(h.sys.fd_read!(fd, IOV, 1, RET)).toBe(E.success)
  return decoder.decode(h.get(BUF, h.u32(RET)))
}

const codeError = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code })

const boomFs = (cause: unknown): SyncFsLike => {
  const boom = (): never => {
    throw cause
  }
  return {
    openSync: boom,
    closeSync: boom,
    readSync: boom,
    writeSync: boom,
    fstatSync: boom,
    ftruncateSync: boom,
    futimesSync: boom,
    statSync: boom,
    lstatSync: boom,
    mkdirSync: boom,
    readdirSync: boom,
    renameSync: boom,
    unlinkSync: boom,
    rmdirSync: boom,
    readlinkSync: boom,
    symlinkSync: boom,
    utimesSync: boom
  }
}

const stubFs = (overrides: Partial<SyncFsLike>): SyncFsLike => ({
  ...boomFs(new Error("unexpected slice call")),
  ...overrides
})

interface ParsedDirent {
  readonly next: bigint
  readonly ino: bigint
  readonly type: number
  readonly name: string
}

const parseDirents = (data: Uint8Array): Array<ParsedDirent> => {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: Array<ParsedDirent> = []
  let at = 0
  while (at + 24 <= data.length) {
    const namlen = v.getUint32(at + 16, true)
    if (at + 24 + namlen > data.length) break
    out.push({
      next: v.getBigUint64(at, true),
      ino: v.getBigUint64(at + 8, true),
      type: v.getUint8(at + 20),
      name: decoder.decode(data.subarray(at + 24, at + 24 + namlen))
    })
    at += 24 + namlen
  }
  return out
}

const nsOfMs = (ms: number): bigint => {
  const whole = Math.floor(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))
}

/** utimes round-trips through platform µs/ns conversions; allow 1ms of slack. */
const expectNsClose = (actual: bigint, expected: bigint): void => {
  const delta = actual > expected ? actual - expected : expected - actual
  expect(delta, `${actual} !~ ${expected}`).toBeLessThan(1_000_000n)
}

let base = ""
let caseId = 0
/** A fresh, empty directory per call so tests never share filesystem state. */
const freshDir = (): string => {
  const dir = join(base, `case-${caseId++}`)
  fsModule.mkdirSync(dir)
  return dir
}

beforeAll(() => {
  base = fsModule.mkdtempSync(join(tmpdir(), "flows-wasi-"))
})

afterAll(() => {
  fsModule.rmSync(base, { recursive: true, force: true })
})

describe("WasiPreview1 unsupported native concurrent namespace mutation", () => {
  // Characterization of UNSUPPORTED use, not a confinement guarantee. The
  // slice has no atomic confined path operation. These interleavings explain
  // why the documented exclusive-namespace requirement is necessary, even
  // though the guest and all slice calls are synchronous.
  it.skipIf(!supportsNativeSymlinks).each(["file", "ancestor"] as const)(
    "characterizes unsupported use when a checked %s becomes a host-absolute link",
    (component) => {
      const root = freshDir()
      const outside = freshDir()
      const gate = join(root, "gate")
      fsModule.mkdirSync(gate)
      const target = join(gate, "secret")
      const secret = join(outside, "secret")
      fsModule.writeFileSync(target, "inside")
      fsModule.writeFileSync(secret, "SYNTHETIC_OUTSIDE_SECRET")
      const checkedPath = component === "file" ? target : gate
      let raced = false
      const h = host({
        root,
        fs: {
          ...nodeFs,
          lstatSync: (path) => {
            const stats = nodeFs.lstatSync(path)
            if (path === checkedPath && !raced) {
              raced = true
              fsModule.renameSync(checkedPath, `${checkedPath}-held`)
              fsModule.symlinkSync(component === "file" ? secret : outside, checkedPath)
            }
            return stats
          }
        }
      })
      const fd = open(h, "/gate/secret", { dirflags: 0 })
      expect(raced).toBe(true)
      expect(h.sys.fd_close!(fd)).toBe(E.success)
    }
  )
})

describe("WasiPreview1 bookkeeping", () => {
  it("requires initialize(memory) before the first memory-touching syscall", () => {
    const wasi = make({ fs: nodeFs })
    expect(() => wasi.imports.fd_prestat_get!(3, RET)).toThrow(/initialize/)
  })

  it("reports an empty argv and environment", () => {
    const h = host()
    expect(h.sys.args_sizes_get!(RET, RET_B)).toBe(E.success)
    expect([h.u32(RET), h.u32(RET_B)]).toEqual([0, 0])
    expect(h.sys.args_get!(BUF, BUF)).toBe(E.success)
    expect(h.sys.environ_sizes_get!(RET, RET_B)).toBe(E.success)
    expect([h.u32(RET), h.u32(RET_B)]).toEqual([0, 0])
    expect(h.sys.environ_get!(BUF, BUF)).toBe(E.success)
  })

  it("serves realtime and monotonic clocks in nanoseconds and rejects unknown ids", () => {
    const h = host()
    expect(h.sys.clock_time_get!(0, 0n, RET)).toBe(E.success)
    const realtime = h.u64(RET)
    const delta = realtime - BigInt(Date.now()) * 1_000_000n
    expect(delta < 5_000_000_000n && delta > -5_000_000_000n).toBe(true)
    expect(h.sys.clock_time_get!(1, 0n, RET)).toBe(E.success)
    const first = h.u64(RET)
    expect(h.sys.clock_time_get!(1, 0n, RET)).toBe(E.success)
    expect(h.u64(RET) >= first).toBe(true)
    expect(h.sys.clock_time_get!(2, 0n, RET)).toBe(E.success)
    expect(h.sys.clock_time_get!(3, 0n, RET)).toBe(E.success)
    expect(h.sys.clock_time_get!(9, 0n, RET)).toBe(E.inval)
    expect(h.sys.clock_res_get!(0, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(1_000_000n)
    expect(h.sys.clock_res_get!(1, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(1_000n)
    expect(h.sys.clock_res_get!(2, RET)).toBe(E.success)
    expect(h.sys.clock_res_get!(3, RET)).toBe(E.success)
    expect(h.sys.clock_res_get!(9, RET)).toBe(E.inval)
  })

  it("fills random_get buffers, chunking past the 65536-byte getRandomValues cap", () => {
    const h = host()
    expect(h.sys.random_get!(DATA, 16)).toBe(E.success)
    expect(h.get(DATA, 16).some((byte) => byte !== 0)).toBe(true)
    const big = 70_000
    expect(h.sys.random_get!(DATA, big)).toBe(E.success)
    expect(h.get(DATA + big - 16, 16).some((byte) => byte !== 0)).toBe(true)
  })

  it("answers sched_yield and refuses signals and sockets", () => {
    const h = host()
    expect(h.sys.sched_yield!()).toBe(E.success)
    expect(h.sys.proc_raise!(9)).toBe(E.notsup)
    expect(h.sys.sock_accept!(9, 0, RET)).toBe(E.notsup)
    expect(h.sys.sock_recv!(9, IOV, 1, 0, RET, RET_B)).toBe(E.notsup)
    expect(h.sys.sock_send!(9, IOV, 1, 0, RET)).toBe(E.notsup)
    expect(h.sys.sock_shutdown!(9, 0)).toBe(E.notsup)
  })

  it("turns proc_exit into a thrown WasiExitError", () => {
    const h = host()
    try {
      h.sys.proc_exit!(-1)
      expect.unreachable("proc_exit returned")
    } catch (cause) {
      expect(cause).toBeInstanceOf(WasiExitError)
      // The i32 argument is read as the unsigned WASI exit code.
      expect(cause).toMatchObject({
        _tag: "@smthrs/jj/WasiExitError",
        exitCode: 4294967295,
        message: "wasm module called proc_exit(4294967295)"
      })
    }
  })

  it("reports every poll_oneoff subscription complete immediately", () => {
    const h = host()
    expect(h.sys.poll_oneoff!(SUB, EVENT, 0, RET)).toBe(E.inval)
    // two subscriptions: a clock (tag 0) and an fd_read (tag 1)
    h.view().setBigUint64(SUB, 111n, true)
    h.view().setUint8(SUB + 8, 0)
    h.view().setBigUint64(SUB + 48, 222n, true)
    h.view().setUint8(SUB + 48 + 8, 1)
    expect(h.sys.poll_oneoff!(SUB, EVENT, 2, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(2)
    expect(h.u64(EVENT)).toBe(111n)
    expect(h.view().getUint16(EVENT + 8, true)).toBe(E.success)
    expect(h.view().getUint8(EVENT + 10)).toBe(0)
    expect(h.u64(EVENT + 32)).toBe(222n)
    expect(h.view().getUint8(EVENT + 32 + 10)).toBe(1)
  })

  it("keeps unrelated fd bookkeeping honest", () => {
    const h = host({ root: freshDir() })
    expect(h.sys.fd_close!(99)).toBe(E.badf)
    expect(h.sys.fd_sync!(99)).toBe(E.badf)
    expect(h.sys.fd_advise!(99, 0n, 0n, 0)).toBe(E.badf)
    expect(h.sys.fd_sync!(3)).toBe(E.success)
    expect(h.sys.fd_datasync!(3)).toBe(E.success)
    expect(h.sys.fd_advise!(3, 0n, 0n, 0)).toBe(E.success)
    expect(h.sys.fd_fdstat_set_rights!(3, 0n, 0n)).toBe(E.success)
    expect(h.sys.fd_renumber!(99, 100)).toBe(E.badf)
  })
})

describe("WasiPreview1 dispose", () => {
  it("closes every open host file once, empties the table, and is idempotent", () => {
    const closed: Array<number> = []
    const dir = freshDir()
    fsModule.writeFileSync(join(dir, "a"), "a")
    fsModule.writeFileSync(join(dir, "b"), "b")
    const counting: SyncFsLike = {
      ...nodeFs,
      closeSync: (fd) => {
        closed.push(fd)
        nodeFs.closeSync(fd)
      }
    }
    const wasi = make({ fs: counting, root: dir })
    const memory = new WebAssembly.Memory({ initial: 1 })
    wasi.initialize(memory)
    const sys = wasi.imports
    const open = (name: string, at: number) => {
      const bytes = encoder.encode(name)
      new Uint8Array(memory.buffer, at, bytes.length).set(bytes)
      expect(sys.path_open!(3, 0, at, bytes.length, 0, 2n, 0n, 0, 4)).toBe(E.success)
      return new DataView(memory.buffer).getUint32(4, true)
    }
    const a = open("a", 64)
    const b = open("b", 80)
    // A directory fd holds no host descriptor and must not be closed as one.
    expect(sys.path_open!(3, 0, 64, 0, 0, 0n, 0n, 0, 4)).not.toBe(E.success)
    wasi.dispose()
    expect(closed).toHaveLength(2)
    expect(sys.fd_close!(a)).toBe(E.badf)
    expect(sys.fd_close!(b)).toBe(E.badf)
    expect(sys.fd_prestat_get!(3, 4)).toBe(E.badf)
    wasi.dispose()
    expect(closed).toHaveLength(2)
  })

  it("keeps sweeping when the backend refuses one close, then rethrows the first refusal", () => {
    const closed: Array<number> = []
    const refusing: SyncFsLike = {
      ...nodeFs,
      openSync: () => 100 + closed.length + openedCount++,
      closeSync: (fd) => {
        closed.push(fd)
        if (fd === 100) throw Object.assign(new Error("EIO"), { code: "EIO" })
      }
    }
    let openedCount = 0
    const dir = freshDir()
    fsModule.writeFileSync(join(dir, "a"), "a")
    const wasi = make({ fs: refusing, root: dir })
    const memory = new WebAssembly.Memory({ initial: 1 })
    wasi.initialize(memory)
    new Uint8Array(memory.buffer, 64, 1).set(encoder.encode("a"))
    expect(wasi.imports.path_open!(3, 0, 64, 1, 0, 2n, 0n, 0, 4)).toBe(E.success)
    expect(wasi.imports.path_open!(3, 0, 64, 1, 0, 2n, 0n, 0, 8)).toBe(E.success)
    expect(() => wasi.dispose()).toThrow("EIO")
    expect(closed).toEqual([100, 101])
    // The table was emptied despite the refusal: a second sweep closes nothing.
    wasi.dispose()
    expect(closed).toEqual([100, 101])
  })
})

describe("WasiPreview1 preopen protocol", () => {
  it("announces exactly one preopen: '/' at fd 3", () => {
    const h = host({ root: freshDir() })
    expect(h.sys.fd_prestat_get!(3, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0) // tag: dir
    expect(h.u32(RET + 4)).toBe(1) // name length of "/"
    expect(h.sys.fd_prestat_dir_name!(3, BUF, 1)).toBe(E.success)
    expect(decoder.decode(h.get(BUF, 1))).toBe("/")
    expect(h.sys.fd_prestat_get!(4, RET)).toBe(E.badf) // ends the libc scan
    expect(h.sys.fd_prestat_get!(0, RET)).toBe(E.badf)
    expect(h.sys.fd_prestat_dir_name!(0, BUF, 8)).toBe(E.badf)
    expect(h.sys.fd_prestat_dir_name!(3, BUF, 0)).toBe(E.nametoolong)
  })

  it("does not announce directories opened later as preopens", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "sub"))
    const h = host({ root })
    const fd = open(h, "/sub", { oflags: OFLAG.directory })
    expect(h.sys.fd_prestat_get!(fd, RET)).toBe(E.badf)
    expect(h.sys.fd_prestat_dir_name!(fd, BUF, 8)).toBe(E.badf)
  })

  it("defaults the namespace root to the slice root '/'", () => {
    const h = host() // no root: the slice namespace is the WASI namespace
    const p = h.str(PATH_A, "/")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(3) // directory
  })
})

describe("WasiPreview1 stdio", () => {
  it("gives stdin an immediate EOF and refuses reading the output fds", () => {
    const h = host()
    h.view().setUint32(IOV, BUF, true)
    h.view().setUint32(IOV + 4, 8, true)
    expect(h.sys.fd_read!(0, IOV, 1, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0)
    expect(h.sys.fd_read!(1, IOV, 1, RET)).toBe(E.badf)
    expect(h.sys.fd_write!(0, IOV, 1, RET)).toBe(E.badf)
  })

  it("gathers iovecs into the stdout and stderr sinks", () => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const h = host({ onStdout: (text) => stdout.push(text), onStderr: (text) => stderr.push(text) })
    const hello = h.str(DATA, "hello ")
    const world = h.str(DATA + 32, "world")
    expect(h.sys.fd_write!(1, h.iovs([hello, world]), 2, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(11)
    expect(stdout).toEqual(["hello world"])
    expect(h.sys.fd_write!(2, h.iovs([world]), 1, RET)).toBe(E.success)
    expect(stderr).toEqual(["world"])
  })

  it("accepts stdout writes even when no sink is listening", () => {
    const h = host()
    expect(writeAll(h, 1, "dropped")).toBe(E.success)
    expect(h.u32(RET)).toBe(7)
  })

  it("describes stdio as character devices that cannot seek", () => {
    const h = host()
    expect(h.sys.fd_fdstat_get!(1, FDSTAT)).toBe(E.success)
    expect(h.view().getUint8(FDSTAT)).toBe(2) // character device
    expect(h.sys.fd_filestat_get!(1, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(2)
    expect(h.u64(STAT + 32)).toBe(0n)
    expect(h.sys.fd_seek!(1, 0n, 0, RET)).toBe(E.spipe)
    expect(h.sys.fd_tell!(0, RET)).toBe(E.spipe)
    expect(h.sys.fd_filestat_set_times!(2, 0n, 0n, 0)).toBe(E.badf)
    expect(h.sys.fd_fdstat_set_flags!(1, 1)).toBe(E.success) // no-op off files
    expect(h.sys.fd_close!(0)).toBe(E.success)
    expect(h.sys.fd_read!(0, IOV, 1, RET)).toBe(E.badf)
  })
})

describe("WasiPreview1 path_open", () => {
  it("opens existing files for reading and reports missing ones", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "file.txt"), "content")
    const h = host({ root })
    const fd = open(h, "/file.txt")
    expect(readAll(h, fd, 32)).toBe("content")
    expect(h.sys.fd_close!(fd)).toBe(E.success)
    expect(openErrno(h, "/missing.txt")).toBe(E.noent)
  })

  it("resolves paths relative to a directory fd, through '.', '..', and '//'", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "sub"))
    fsModule.writeFileSync(join(root, "sub", "inner.txt"), "inner")
    const h = host({ root: `${root}/` }) // trailing slash: the root is normalized
    const sub = open(h, "/sub", { oflags: OFLAG.directory })
    const p = h.str(PATH_A, "inner.txt")
    expect(h.sys.path_open!(sub, 1, p.ptr, p.len, 0, R, 0n, 0, RET)).toBe(E.success)
    const fd = h.u32(RET)
    expect(readAll(h, fd, 32)).toBe("inner")
    const dotted = open(h, "/sub/.//../sub/inner.txt")
    expect(readAll(h, dotted, 32)).toBe("inner")
  })

  it("clamps '..' at the namespace root instead of escaping the slice", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "top.txt"), "top")
    const h = host({ root })
    const fd = open(h, "/../../top.txt")
    expect(readAll(h, fd, 16)).toBe("top")
    const p = h.str(PATH_A, "..")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(3)
  })

  it.each([
    ["/file/../victim", E.notdir],
    ["/missing/../victim", E.noent]
  ])("validates ancestors before consuming '..' in %s", (path, errno) => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "file"), "not a directory")
    fsModule.writeFileSync(join(root, "victim"), "keep")
    const h = host({ root })
    expect(openErrno(h, path)).toBe(errno)
    const p = h.str(PATH_A, path)
    expect(h.sys.path_unlink_file!(3, p.ptr, p.len)).toBe(errno)
    expect(fsModule.readFileSync(join(root, "victim"), "utf8")).toBe("keep")
  })

  it.skipIf(!supportsNativeSymlinks)("validates expanded link ancestors before consuming '..'", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "file"), "not a directory")
    fsModule.writeFileSync(join(root, "victim"), "keep")
    fsModule.symlinkSync("file", join(root, "link"))
    fsModule.symlinkSync("missing", join(root, "dangling"))
    fsModule.symlinkSync("/file/../victim", join(root, "invalid-target"))
    const h = host({ root })
    expect(openErrno(h, "/link/../victim")).toBe(E.notdir)
    expect(openErrno(h, "/dangling/../victim")).toBe(E.noent)
    expect(openErrno(h, "/invalid-target")).toBe(E.notdir)
    const p = h.str(PATH_A, "/link/../victim")
    expect(h.sys.path_unlink_file!(3, p.ptr, p.len)).toBe(E.notdir)
    expect(fsModule.readFileSync(join(root, "victim"), "utf8")).toBe("keep")
  })

  it("rejects the empty path and non-directory dirfds", () => {
    const h = host({ root: freshDir() })
    expect(h.sys.path_open!(3, 1, PATH_A, 0, 0, R, 0n, 0, RET)).toBe(E.noent)
    const p = h.str(PATH_A, "x")
    expect(h.sys.path_open!(1, 1, p.ptr, p.len, 0, R, 0n, 0, RET)).toBe(E.notdir)
  })

  it("creates with O_CREAT|O_TRUNC and truncates existing content", () => {
    const root = freshDir()
    const h = host({ root })
    const fd = open(h, "/new.txt", { oflags: OFLAG.creat | OFLAG.trunc, rights: W })
    expect(writeAll(h, fd, "first")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "new.txt"), "utf8")).toBe("first")
    const again = open(h, "/new.txt", { oflags: OFLAG.creat | OFLAG.trunc, rights: RW })
    expect(readAll(h, again, 16)).toBe("") // truncated
    expect(writeAll(h, again, "second")).toBe(E.success)
    h.sys.fd_close!(again)
    expect(fsModule.readFileSync(join(root, "new.txt"), "utf8")).toBe("second")
  })

  it("honours O_EXCL against existing files and directories", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "taken.txt"), "x")
    fsModule.mkdirSync(join(root, "dir"))
    const h = host({ root })
    expect(openErrno(h, "/taken.txt", { oflags: OFLAG.creat | OFLAG.excl, rights: W })).toBe(E.exist)
    expect(openErrno(h, "/dir", { oflags: OFLAG.creat | OFLAG.excl, rights: W })).toBe(E.exist)
    const fd = open(h, "/fresh.txt", { oflags: OFLAG.creat | OFLAG.excl, rights: W })
    expect(writeAll(h, fd, "made")).toBe(E.success)
    h.sys.fd_close!(fd)
    const rw = open(h, "/fresh2.txt", { oflags: OFLAG.creat | OFLAG.excl | OFLAG.trunc, rights: RW })
    expect(writeAll(h, rw, "rw")).toBe(E.success)
    h.sys.fd_close!(rw)
    expect(fsModule.readFileSync(join(root, "fresh2.txt"), "utf8")).toBe("rw")
    const wo = open(h, "/fresh3.txt", { oflags: OFLAG.creat | OFLAG.excl | OFLAG.trunc, rights: W })
    expect(writeAll(h, wo, "wo")).toBe(E.success)
    h.sys.fd_close!(wo)
    expect(fsModule.readFileSync(join(root, "fresh3.txt"), "utf8")).toBe("wo")
  })

  it("keeps O_CREAT|O_EXCL exclusive when the file appears after the existence probe", () => {
    // O_EXCL is what makes create-if-absent atomic, and the shim decides
    // "absent" one syscall before it opens. A file that appears in that gap
    // must still answer EEXIST: opening it `w` because the probe said missing
    // would truncate a file the guest never asked to touch.
    const root = freshDir()
    const raced = join(root, "raced.txt")
    fsModule.writeFileSync(raced, "not mine to truncate")
    const absent = (): never => {
      const error: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory")
      error.code = "ENOENT"
      throw error
    }
    const h = host({
      root,
      fs: {
        ...nodeFs,
        statSync: (path: string) => path === raced ? absent() : fsModule.statSync(path),
        lstatSync: (path: string) => path === raced ? absent() : fsModule.lstatSync(path)
      }
    })

    expect(openErrno(h, "/raced.txt", { oflags: OFLAG.creat | OFLAG.excl | OFLAG.trunc, rights: RW })).toBe(E.exist)
    expect(openErrno(h, "/raced.txt", { oflags: OFLAG.creat | OFLAG.excl | OFLAG.trunc, rights: W })).toBe(E.exist)
    expect(fsModule.readFileSync(raced, "utf8")).toBe("not mine to truncate")
  })

  it("keeps O_CREAT|O_EXCL exclusive for append opens across the existence race", () => {
    const root = freshDir()
    const racedWrite = join(root, "raced-write.txt")
    const racedReadWrite = join(root, "raced-read-write.txt")
    fsModule.writeFileSync(racedWrite, "writer won")
    fsModule.writeFileSync(racedReadWrite, "writer won")
    const hidden = new Set([racedWrite, racedReadWrite])
    const h = host({
      root,
      fs: stubFs({
        ...nodeFs,
        statSync: (path: string) => {
          if (hidden.delete(path)) throw codeError("ENOENT")
          return fsModule.statSync(path)
        }
      })
    })

    const options = { oflags: OFLAG.creat | OFLAG.excl, fdflags: 1 }
    expect(openErrno(h, "/raced-write.txt", { ...options, rights: W })).toBe(E.exist)
    expect(openErrno(h, "/raced-read-write.txt", { ...options, rights: RW })).toBe(E.exist)
    expect(fsModule.readFileSync(racedWrite, "utf8")).toBe("writer won")
    expect(fsModule.readFileSync(racedReadWrite, "utf8")).toBe("writer won")
  })

  it("creates and appends with O_CREAT|O_EXCL|O_APPEND when the path is absent", () => {
    const root = freshDir()
    const h = host({ root })
    const flags = { oflags: OFLAG.creat | OFLAG.excl, fdflags: 1 }
    const writeOnly = open(h, "/append-write.txt", { ...flags, rights: W })
    expect(writeAll(h, writeOnly, "one")).toBe(E.success)
    expect(writeAll(h, writeOnly, "-two")).toBe(E.success)
    h.sys.fd_close!(writeOnly)
    expect(fsModule.readFileSync(join(root, "append-write.txt"), "utf8")).toBe("one-two")

    const readWrite = open(h, "/append-read-write.txt", { ...flags, rights: RW })
    expect(writeAll(h, readWrite, "readable")).toBe(E.success)
    h.sys.fd_close!(readWrite)
    expect(fsModule.readFileSync(join(root, "append-read-write.txt"), "utf8")).toBe("readable")
  })

  it("opens O_CREAT without O_TRUNC preserving existing bytes", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "keep.txt"), "keepers")
    const h = host({ root })
    const fd = open(h, "/keep.txt", { oflags: OFLAG.creat, rights: RW })
    expect(readAll(h, fd, 32)).toBe("keepers")
    h.sys.fd_close!(fd)
    const created = open(h, "/born.txt", { oflags: OFLAG.creat, rights: RW })
    expect(writeAll(h, created, "hi")).toBe(E.success)
    h.sys.fd_close!(created)
    const wo = open(h, "/born2.txt", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, wo, "wo")).toBe(E.success)
    h.sys.fd_close!(wo)
  })

  it("creates readably when O_CREAT arrives with read-only rights", () => {
    const root = freshDir()
    const h = host({ root })
    const fd = open(h, "/readonly-create.txt", { oflags: OFLAG.creat, rights: R })
    expect(readAll(h, fd, 16)).toBe("")
    h.sys.fd_close!(fd)
    expect(fsModule.existsSync(join(root, "readonly-create.txt"))).toBe(true)
  })

  it("truncates without O_CREAT via r+ and rejects O_TRUNC without write rights", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "trunc.txt"), "to-be-emptied")
    const h = host({ root })
    expect(openErrno(h, "/trunc.txt", { oflags: OFLAG.trunc, rights: R })).toBe(E.inval)
    const fd = open(h, "/trunc.txt", { oflags: OFLAG.trunc, rights: RW })
    expect(readAll(h, fd, 16)).toBe("")
    expect(writeAll(h, fd, "refilled")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "trunc.txt"), "utf8")).toBe("refilled")
  })

  it.each([
    { creat: false, rights: W },
    { creat: false, rights: RW },
    { creat: true, rights: W },
    { creat: true, rights: RW }
  ])("truncates before appending with creat=$creat and rights=$rights", ({ creat, rights }) => {
    const root = freshDir()
    const path = join(root, "append-trunc.txt")
    fsModule.writeFileSync(path, "OLD")
    let opened = 0
    let closed = 0
    const h = host({
      root,
      fs: {
        ...nodeFs,
        openSync: (path, flags) => {
          const fd = nodeFs.openSync(path, flags)
          opened++
          return fd
        },
        closeSync: (fd) => {
          nodeFs.closeSync(fd)
          closed++
        }
      }
    })
    const fd = open(h, "/append-trunc.txt", {
      oflags: OFLAG.trunc | (creat ? OFLAG.creat : 0),
      rights,
      fdflags: 1
    })
    try {
      expect(fsModule.statSync(path).size).toBe(0)
      expect(writeAll(h, fd, "NEW")).toBe(E.success)
      expect(h.sys.fd_seek!(fd, 0n, 0, RET)).toBe(E.success)
      expect(writeAll(h, fd, "!")).toBe(E.success)
      expect(fsModule.readFileSync(path, "utf8")).toBe("NEW!")
    } finally {
      expect(h.sys.fd_close!(fd)).toBe(E.success)
    }
    expect({ opened, closed }).toEqual({ opened: 1, closed: 1 })
  })

  it.each([
    { append: false, creat: false, closeThrows: false },
    { append: false, creat: false, closeThrows: true },
    { append: true, creat: false, closeThrows: false },
    { append: true, creat: false, closeThrows: true },
    { append: true, creat: true, closeThrows: false },
    { append: true, creat: true, closeThrows: true }
  ])("closes failed truncating opens with $append/$creat/$closeThrows", ({ append, creat, closeThrows }) => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "trunc-error.txt"), "OLD")
    const opened: Array<number> = []
    const closed: Array<number> = []
    const truncated: Array<number> = []
    const h = host({
      root,
      fs: {
        ...nodeFs,
        openSync: () => {
          const fd = 100 + opened.length
          opened.push(fd)
          return fd
        },
        ftruncateSync: (fd, size) => {
          expect(size).toBe(0)
          truncated.push(fd)
          throw codeError("EIO")
        },
        closeSync: (fd) => {
          closed.push(fd)
          if (closeThrows) throw codeError("EBADF")
        }
      }
    })
    const errnos = Array.from({ length: 3 }, () =>
      openErrno(h, "/trunc-error.txt", {
        oflags: OFLAG.trunc | (creat ? OFLAG.creat : 0),
        rights: RW,
        fdflags: append ? 1 : 0
      }))
    expect(errnos).toEqual([E.io, E.io, E.io])
    expect(opened).toEqual([100, 101, 102])
    expect(truncated).toEqual(opened)
    expect(closed).toEqual(opened)
    expect(h.sys.fd_close!(4)).toBe(E.badf)
  })

  it.each([false, true])("rejects invalid open result pointers before allocating (directory=%s)", (directory) => {
    const root = freshDir()
    const path = join(root, "target")
    if (directory) fsModule.mkdirSync(path)
    else fsModule.writeFileSync(path, "OLD")
    let opened = 0
    let closed = 0
    const h = host({
      root,
      fs: {
        ...nodeFs,
        openSync: () => ++opened + 100,
        closeSync: () => {
          closed++
        }
      }
    })
    const p = h.str(PATH_A, "/target")
    for (const retPtr of [h.memory.buffer.byteLength - 3, h.memory.buffer.byteLength, -1]) {
      expect(h.sys.path_open!(3, 1, p.ptr, p.len, 0, R, 0n, 0, retPtr)).toBe(E.fault)
    }
    expect({ opened, closed }).toEqual({ opened: 0, closed: 0 })
    const fd = open(h, "/target")
    expect(fd).toBe(4)
    expect(h.sys.fd_close!(fd)).toBe(E.success)
    expect({ opened, closed }).toEqual(directory ? { opened: 0, closed: 0 } : { opened: 1, closed: 1 })
  })

  it("opens plain write fds against existing files without truncating", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "patch.txt"), "abcdef")
    const h = host({ root })
    const fd = open(h, "/patch.txt", { rights: W })
    expect(writeAll(h, fd, "AB")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "patch.txt"), "utf8")).toBe("ABcdef")
  })

  it("appends with O_APPEND, including append+read fds", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "log.txt"), "one")
    const h = host({ root })
    const fd = open(h, "/log.txt", { oflags: OFLAG.creat, rights: W, fdflags: 1 })
    expect(writeAll(h, fd, "-two")).toBe(E.success)
    expect(writeAll(h, fd, "-three")).toBe(E.success)
    expect(h.sys.fd_tell!(fd, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(13n)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "log.txt"), "utf8")).toBe("one-two-three")
    const ar = open(h, "/log.txt", { rights: RW, fdflags: 1 })
    expect(readAll(h, ar, 32)).toBe("one-two-three") // reads start at 0 despite append
    expect(writeAll(h, ar, "!")).toBe(E.success)
    h.sys.fd_close!(ar)
    expect(fsModule.readFileSync(join(root, "log.txt"), "utf8")).toBe("one-two-three!")
  })

  it("opens directories, with and without O_DIRECTORY, and refuses writing them", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "d"))
    fsModule.writeFileSync(join(root, "f.txt"), "x")
    const h = host({ root })
    const explicit = open(h, "/d", { oflags: OFLAG.directory })
    expect(h.sys.fd_fdstat_get!(explicit, FDSTAT)).toBe(E.success)
    expect(h.view().getUint8(FDSTAT)).toBe(3)
    const implicit = open(h, "/d") // no O_DIRECTORY, read rights
    expect(h.sys.fd_readdir!(implicit, BUF, 512, 0n, RET)).toBe(E.success)
    expect(openErrno(h, "/d", { rights: W })).toBe(E.isdir)
    expect(openErrno(h, "/d", { oflags: OFLAG.trunc, rights: RW })).toBe(E.isdir)
    expect(openErrno(h, "/f.txt", { oflags: OFLAG.directory })).toBe(E.notdir)
    expect(openErrno(h, "/gone", { oflags: OFLAG.directory })).toBe(E.noent)
    expect(h.sys.fd_read!(explicit, h.iovs([{ ptr: BUF, len: 4 }]), 1, RET)).toBe(E.isdir)
    expect(h.sys.fd_write!(explicit, h.iovs([{ ptr: BUF, len: 4 }]), 1, RET)).toBe(E.badf)
    expect(h.sys.fd_seek!(explicit, 0n, 0, RET)).toBe(E.badf)
  })

  it.skipIf(!supportsNativeSymlinks)("refuses symlinks when lookupflags say nofollow, follows them otherwise", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "real.txt"), "real")
    fsModule.symlinkSync("real.txt", join(root, "link.txt"))
    const h = host({ root })
    expect(openErrno(h, "/link.txt", { dirflags: 0 })).toBe(E.loop)
    const followed = open(h, "/link.txt", { dirflags: 1 })
    expect(readAll(h, followed, 16)).toBe("real")
    const direct = open(h, "/real.txt", { dirflags: 0 }) // nofollow on a regular file is fine
    expect(readAll(h, direct, 16)).toBe("real")
    const created = open(h, "/made.txt", { oflags: OFLAG.creat, rights: W, dirflags: 0 })
    expect(h.sys.fd_close!(created)).toBe(E.success)
  })

  it.skipIf(!supportsNativeSymlinks)("creates the target of a dangling symlink with O_CREAT, like open(2)", () => {
    const root = freshDir()
    fsModule.symlinkSync("created-by-open.txt", join(root, "dangling"))
    const h = host({ root })
    const fd = open(h, "/dangling", { oflags: OFLAG.creat, rights: RW })
    expect(writeAll(h, fd, "through the link")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "created-by-open.txt"), "utf8")).toBe("through the link")
    expect(fsModule.lstatSync(join(root, "dangling")).isSymbolicLink()).toBe(true) // the link survives
    // O_CREAT|O_EXCL through any symlink stays EEXIST, as POSIX mandates.
    fsModule.unlinkSync(join(root, "created-by-open.txt"))
    expect(openErrno(h, "/dangling", { oflags: OFLAG.creat | OFLAG.excl, rights: W })).toBe(E.exist)
    // Without O_CREAT a dangling link is simply a missing file.
    expect(openErrno(h, "/dangling")).toBe(E.noent)
  })

  it.skipIf(!supportsNativeSymlinks)("answers EEXIST for O_CREAT|O_EXCL on a symlink even without follow", () => {
    // POSIX decides O_EXCL on the link before O_NOFOLLOW does: open(2) with
    // O_CREAT|O_EXCL|O_NOFOLLOW on a symlink is EEXIST, not ELOOP.
    const root = freshDir()
    fsModule.symlinkSync("nowhere.txt", join(root, "excl-link"))
    const h = host({ root })

    expect(openErrno(h, "/excl-link", { oflags: OFLAG.creat | OFLAG.excl, rights: W, dirflags: 0 })).toBe(E.exist)
    // Without O_CREAT the nofollow refusal still stands.
    expect(openErrno(h, "/excl-link", { dirflags: 0 })).toBe(E.loop)
  })

  it.skipIf(!supportsNativeSymlinks)("creates through a chain of dangling links and reports cycles as ELOOP", () => {
    const root = freshDir()
    fsModule.symlinkSync("two", join(root, "one"))
    fsModule.symlinkSync("final.txt", join(root, "two"))
    const h = host({ root })
    const fd = open(h, "/one", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "chained")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "final.txt"), "utf8")).toBe("chained")
    fsModule.symlinkSync("loop-b", join(root, "loop-a"))
    fsModule.symlinkSync("loop-a", join(root, "loop-b"))
    expect(openErrno(h, "/loop-a", { oflags: OFLAG.creat, rights: W })).toBe(E.loop)
  })

  it.skipIf(!supportsNativeSymlinks)("creates through a dangling link with an absolute target", () => {
    const root = freshDir()
    fsModule.symlinkSync("/abs-target.txt", join(root, "abs-link"))
    const h = host({ root })
    const fd = open(h, "/abs-link", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "absolute")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "abs-target.txt"), "utf8")).toBe("absolute")
  })

  it.skipIf(!supportsNativeSymlinks)("re-roots namespace-absolute link targets inside the preopen", () => {
    const root = freshDir()
    const outside = freshDir()
    const outsideTarget = join(outside, "escape.txt")
    const confinedParent = join(root, outside.slice(1))
    const confinedTarget = join(confinedParent, "escape.txt")
    fsModule.mkdirSync(confinedParent, { recursive: true })
    fsModule.symlinkSync(outsideTarget, join(root, "escape-link"))
    const h = host({ root })
    const fd = open(h, "/escape-link", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "confined absolute")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(confinedTarget, "utf8")).toBe("confined absolute")
    expect(fsModule.existsSync(outsideTarget)).toBe(false)
  })

  it.skipIf(!supportsNativeSymlinks)("clamps parent traversal in relative link targets", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "a", "b"), { recursive: true })
    fsModule.symlinkSync("../../../outside.txt", join(root, "a", "b", "climb"))
    const h = host({ root })
    const fd = open(h, "/a/b/climb", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "confined relative")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "outside.txt"), "utf8")).toBe("confined relative")
    expect(fsModule.existsSync(join(root, "..", "outside.txt"))).toBe(false)
  })

  it.skipIf(!supportsNativeSymlinks)("refuses to open an existing file outside the preopen through a link", () => {
    const root = freshDir()
    const outside = freshDir()
    const outsideFile = join(outside, "secret.txt")
    fsModule.writeFileSync(outsideFile, "outside")
    fsModule.symlinkSync(outsideFile, join(root, "peek"))
    const h = host({ root })
    expect(openErrno(h, "/peek")).toBe(E.noent)
    expect(fsModule.readFileSync(outsideFile, "utf8")).toBe("outside")
  })

  it.skipIf(!supportsNativeSymlinks)("re-roots an INTERMEDIATE absolute link component inside the preopen", () => {
    // The lexical clamp never sees an escape here: `/gate/through.txt` is a
    // perfectly confined namespace path. The escape is that the BACKEND follows
    // every symlink component of whatever host path it is handed, so a link
    // naming a directory used to smuggle the rest of the path out of the slice.
    const root = freshDir()
    const outside = freshDir()
    const confined = join(root, outside.slice(1))
    fsModule.mkdirSync(confined, { recursive: true })
    fsModule.symlinkSync(outside, join(root, "gate"))
    const h = host({ root })

    const fd = open(h, "/gate/through.txt", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "confined")).toBe(E.success)
    h.sys.fd_close!(fd)

    expect(fsModule.readFileSync(join(confined, "through.txt"), "utf8")).toBe("confined")
    expect(fsModule.existsSync(join(outside, "through.txt"))).toBe(false)
  })

  it.skipIf(!supportsNativeSymlinks)("clamps a relative intermediate link that climbs past the root", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "a"))
    fsModule.symlinkSync("../../..", join(root, "a", "up"))
    const h = host({ root })

    const fd = open(h, "/a/up/landed.txt", { oflags: OFLAG.creat, rights: W })
    expect(writeAll(h, fd, "clamped")).toBe(E.success)
    h.sys.fd_close!(fd)

    expect(fsModule.readFileSync(join(root, "landed.txt"), "utf8")).toBe("clamped")
    expect(fsModule.existsSync(join(root, "..", "landed.txt"))).toBe(false)
  })

  it.skipIf(!supportsNativeSymlinks)("reports a cycle among intermediate link components as ELOOP", () => {
    const root = freshDir()
    fsModule.symlinkSync("b", join(root, "a"))
    fsModule.symlinkSync("a", join(root, "b"))
    const h = host({ root })

    expect(openErrno(h, "/a/leaf.txt", { oflags: OFLAG.creat, rights: W })).toBe(E.loop)
  })

  it.skipIf(!supportsNativeSymlinks)(
    "re-resolves a held directory fd instead of trusting the path it was opened on",
    () => {
      // The escape a remembered host path allows: open a directory fd, move the
      // directory away, and leave a symlink at the name the fd was opened on. A
      // host path recorded at open time is then a name the BACKEND follows
      // wherever the replacement points, with no syscall ever naming an escape.
      const root = freshDir()
      const outside = freshDir()
      fsModule.writeFileSync(join(outside, "secret.txt"), "outside")
      fsModule.mkdirSync(join(root, "held"))
      fsModule.writeFileSync(join(root, "held", "own.txt"), "inside")
      const h = host({ root })
      const dirFd = open(h, "/held", { oflags: OFLAG.directory, dirflags: 0 })

      fsModule.renameSync(join(root, "held"), join(root, "moved"))
      fsModule.symlinkSync(outside, join(root, "held"))

      // `/held` now resolves to the re-rooted target inside the slice, which
      // does not exist, so nothing outside is reachable through the held fd.
      //
      // ENOENT is the DIVERGENCE the module header records, not the POSIX
      // answer: a kernel fd would still name the moved directory and read
      // `own.txt` from it. Naming the inode needs an `openat` the slice does
      // not have, and the only other option — remembering the host path — is
      // the escape this case exists to close.
      const own = h.str(PATH_A, "own.txt")
      expect(h.sys.path_open!(dirFd, 1, own.ptr, own.len, 0, R, 0n, 0, RET)).toBe(E.noent)
      const secret = h.str(PATH_B, "secret.txt")
      expect(h.sys.path_open!(dirFd, 1, secret.ptr, secret.len, 0, R, 0n, 0, RET)).toBe(E.noent)
      expect(h.sys.fd_readdir!(dirFd, BUF, 512, 0n, RET)).toBe(E.noent)
      expect(h.sys.fd_filestat_get!(dirFd, STAT)).toBe(E.noent)
      expect(fsModule.readFileSync(join(outside, "secret.txt"), "utf8")).toBe("outside")
    }
  )

  it("refuses to remove or replace the preopen root itself", () => {
    // A symlink created AT the namespace root would put the preopen's own name
    // under the guest's control, and the backend follows it on every later call.
    const root = freshDir()
    const h = host({ root })
    const slash = h.str(PATH_A, "/")
    const elsewhere = h.str(PATH_B, "/elsewhere")

    expect(h.sys.path_remove_directory!(3, slash.ptr, slash.len)).toBe(E.busy)
    expect(h.sys.path_unlink_file!(3, slash.ptr, slash.len)).toBe(E.busy)
    expect(h.sys.path_create_directory!(3, slash.ptr, slash.len)).toBe(E.busy)
    expect(h.sys.path_symlink!(elsewhere.ptr, elsewhere.len, 3, slash.ptr, slash.len)).toBe(E.busy)
    expect(h.sys.path_rename!(3, slash.ptr, slash.len, 3, elsewhere.ptr, elsewhere.len)).toBe(E.busy)
    expect(h.sys.path_rename!(3, elsewhere.ptr, elsewhere.len, 3, slash.ptr, slash.len)).toBe(E.busy)
    expect(fsModule.existsSync(root)).toBe(true)
  })

  it("caps dangling-link chain resolution instead of spinning forever", () => {
    // A backend whose links never terminate (each readlink names another
    // link) — the OS's own SYMLOOP limit cannot be relied on here because the
    // chain is resolved lexically, so the shim carries its own depth cap.
    const link = {
      size: 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => true
    }
    const h = host({
      fs: stubFs({
        statSync: () => {
          throw codeError("ENOENT")
        },
        lstatSync: () => link,
        readlinkSync: () => "next",
        openSync: () => {
          throw codeError("EEXIST")
        }
      })
    })
    expect(openErrno(h, "/first", { oflags: OFLAG.creat, rights: W })).toBe(E.loop)
  })
})

describe("WasiPreview1 read/write/seek", () => {
  it("advances the tracked offset across reads and scatters into iovecs", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "seq.txt"), "abcdefghij")
    const h = host({ root })
    const fd = open(h, "/seq.txt")
    h.view().setUint32(IOV, BUF, true)
    h.view().setUint32(IOV + 4, 3, true)
    h.view().setUint32(IOV + 8, BUF + 16, true)
    h.view().setUint32(IOV + 12, 0, true) // zero-length iov is skipped
    h.view().setUint32(IOV + 16, BUF + 32, true)
    h.view().setUint32(IOV + 20, 4, true)
    expect(h.sys.fd_read!(fd, IOV, 3, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(7)
    expect(decoder.decode(h.get(BUF, 3))).toBe("abc")
    expect(decoder.decode(h.get(BUF + 32, 4))).toBe("defg")
    expect(readAll(h, fd, 16)).toBe("hij")
    expect(readAll(h, fd, 16)).toBe("") // EOF
    expect(h.sys.fd_tell!(fd, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(10n)
  })

  it("stops the iovec loop at a short read", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "short.txt"), "abcde")
    const h = host({ root })
    const fd = open(h, "/short.txt")
    h.view().setUint32(IOV, BUF, true)
    h.view().setUint32(IOV + 4, 8, true)
    h.view().setUint32(IOV + 8, BUF + 16, true)
    h.view().setUint32(IOV + 12, 8, true)
    expect(h.sys.fd_read!(fd, IOV, 2, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(5)
  })

  it("seeks from set, current, and end, rejecting bad whence and negative targets", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "seek.txt"), "0123456789")
    const h = host({ root })
    const fd = open(h, "/seek.txt")
    expect(h.sys.fd_seek!(fd, 4n, 0, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(4n)
    expect(readAll(h, fd, 2)).toBe("45")
    expect(h.sys.fd_seek!(fd, -2n, 1, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(4n)
    expect(h.sys.fd_seek!(fd, -3n, 2, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(7n)
    expect(readAll(h, fd, 8)).toBe("789")
    expect(h.sys.fd_seek!(fd, 0n, 9, RET)).toBe(E.inval)
    expect(h.sys.fd_seek!(fd, -99n, 0, RET)).toBe(E.inval)
    expect(h.sys.fd_seek!(99, 0n, 0, RET)).toBe(E.badf)
  })

  it("pread and pwrite address explicit offsets without moving the cursor", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "p.txt"), "0123456789")
    const h = host({ root })
    const fd = open(h, "/p.txt", { rights: RW })
    h.iovs([{ ptr: BUF, len: 3 }, { ptr: BUF + 8, len: 0 }]) // zero-length iov is skipped
    expect(h.sys.fd_pread!(fd, IOV, 2, 4n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(3)
    expect(decoder.decode(h.get(BUF, 3))).toBe("456")
    h.view().setUint32(IOV, BUF, true)
    h.view().setUint32(IOV + 4, 16, true)
    expect(h.sys.fd_pread!(fd, IOV, 1, 8n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(2) // short pread at EOF
    const patch = h.str(DATA, "XY")
    expect(h.sys.fd_pwrite!(fd, h.iovs([patch, { ptr: DATA, len: 0 }]), 2, 2n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(2)
    expect(h.sys.fd_tell!(fd, RET)).toBe(E.success)
    expect(h.u64(RET)).toBe(0n) // cursor untouched
    expect(readAll(h, fd, 16)).toBe("01XY456789")
  })

  it("refuses lossy explicit offsets and file sizes above MAX_SAFE_INTEGER", () => {
    const regular = {
      size: 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }
    const readPositions: Array<number | null> = []
    const writePositions: Array<number | null> = []
    const sizes: Array<number> = []
    const h = host({
      fs: stubFs({
        openSync: () => 7,
        statSync: () => regular,
        lstatSync: () => regular,
        readSync: (_fd, _buffer, _offset, _length, position) => {
          readPositions.push(position)
          return 0
        },
        writeSync: (_fd, _buffer, _offset, _length, position) => {
          writePositions.push(position)
          return 0
        },
        ftruncateSync: (_fd, size) => {
          sizes.push(size)
        }
      })
    })
    const fd = open(h, "/large", { rights: RW })
    const byte = h.str(DATA, "x")
    h.iovs([byte])

    expect(h.sys.fd_pread!(fd, IOV, 1, MAX_SAFE_U64, RET)).toBe(E.success)
    expect(h.sys.fd_pwrite!(fd, IOV, 1, MAX_SAFE_U64, RET)).toBe(E.success)
    expect(h.sys.fd_filestat_set_size!(fd, MAX_SAFE_U64)).toBe(E.success)
    expect(readPositions).toEqual([Number.MAX_SAFE_INTEGER])
    expect(writePositions).toEqual([Number.MAX_SAFE_INTEGER])
    expect(sizes).toEqual([Number.MAX_SAFE_INTEGER])

    for (const unsafe of [TOO_LARGE_U64, U64_MAX, U64_MAX_AS_WASM_PASSES_IT]) {
      expect(h.sys.fd_pread!(fd, IOV, 1, unsafe, RET)).toBe(E.fbig)
      expect(h.sys.fd_pwrite!(fd, IOV, 1, unsafe, RET)).toBe(E.fbig)
      expect(h.sys.fd_filestat_set_size!(fd, unsafe)).toBe(E.fbig)
    }
    expect(readPositions).toHaveLength(1)
    expect(writePositions).toHaveLength(1)
    expect(sizes).toHaveLength(1)
  })

  it("enforces the backend's fd access mode", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "ro.txt"), "read only")
    const h = host({ root })
    const ro = open(h, "/ro.txt")
    expect(writeAll(h, ro, "nope")).toBe(E.badf)
    const wo = open(h, "/wo.txt", { oflags: OFLAG.creat, rights: W })
    h.view().setUint32(IOV, BUF, true)
    h.view().setUint32(IOV + 4, 4, true)
    expect(h.sys.fd_read!(wo, IOV, 1, RET)).toBe(E.badf)
  })

  it("flips a plain fd into append mode through fd_fdstat_set_flags", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "flip.txt"), "base")
    const h = host({ root })
    const fd = open(h, "/flip.txt", { rights: RW })
    expect(h.sys.fd_fdstat_get!(fd, FDSTAT)).toBe(E.success)
    expect(h.view().getUint16(FDSTAT + 2, true)).toBe(0)
    expect(h.sys.fd_fdstat_set_flags!(fd, 1)).toBe(E.success)
    expect(h.sys.fd_fdstat_get!(fd, FDSTAT)).toBe(E.success)
    expect(h.view().getUint16(FDSTAT + 2, true)).toBe(1)
    expect(writeAll(h, fd, "+tail")).toBe(E.success)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "flip.txt"), "utf8")).toBe("base+tail")
  })

  it("renumbers fds, closing whatever occupied the target", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "a.txt"), "aaa")
    fsModule.writeFileSync(join(root, "b.txt"), "bbb")
    fsModule.mkdirSync(join(root, "d"))
    const h = host({ root })
    const a = open(h, "/a.txt")
    const b = open(h, "/b.txt")
    expect(h.sys.fd_renumber!(a, a)).toBe(E.success)
    expect(readAll(h, a, 3)).toBe("aaa")
    expect(h.sys.fd_renumber!(a, b)).toBe(E.success) // closes b's file
    expect(readAll(h, b, 3)).toBe("") // the moved entry kept a's cursor, already at EOF
    expect(h.sys.fd_close!(a)).toBe(E.badf)
    const c = open(h, "/a.txt")
    const d = open(h, "/d", { oflags: OFLAG.directory })
    expect(h.sys.fd_renumber!(c, d)).toBe(E.success) // target was a dir entry: nothing to close
    expect(h.sys.fd_renumber!(d, 200)).toBe(E.success) // target vacant
    expect(readAll(h, 200, 3)).toBe("aaa")
  })

  it("never re-allocates a renumber target for a later open", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "a.txt"), "AAAA")
    fsModule.writeFileSync(join(root, "b.txt"), "BBBB")
    fsModule.writeFileSync(join(root, "c.txt"), "CCCC")
    const h = host({ root })
    const a = open(h, "/a.txt")
    expect(h.sys.fd_renumber!(a, a + 2)).toBe(E.success) // renumber ahead of the allocator
    const b = open(h, "/b.txt")
    const c = open(h, "/c.txt")
    // The allocator skipped past the renumber target: all three fds are live
    // and distinct, and the renumbered handle still addresses its own file.
    expect(new Set([a + 2, b, c]).size).toBe(3)
    expect(readAll(h, a + 2, 8)).toBe("AAAA")
    expect(readAll(h, b, 8)).toBe("BBBB")
    expect(readAll(h, c, 8)).toBe("CCCC")
  })

  it("truncates through fd_filestat_set_size", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "t.txt"), "0123456789")
    const h = host({ root })
    const fd = open(h, "/t.txt", { rights: RW })
    expect(h.sys.fd_filestat_set_size!(fd, 4n)).toBe(E.success)
    expect(fsModule.readFileSync(join(root, "t.txt"), "utf8")).toBe("0123")
    expect(h.sys.fd_filestat_set_size!(fd, 8n)).toBe(E.success)
    expect(fsModule.statSync(join(root, "t.txt")).size).toBe(8)
    expect(h.sys.fd_filestat_set_size!(1, 0n)).toBe(E.spipe)
    expect(h.sys.fd_allocate!(fd, 0n, 16n)).toBe(E.notsup)
  })

  it("truncates and stamps the open fd, not the path it was opened at", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "sized.txt"), "0123456789")
    const h = host({ root })
    const fd = open(h, "/sized.txt", { rights: RW })
    // jj's tempfile persist shape: open → rename → mutate through the fd.
    const from = h.str(PATH_A, "/sized.txt")
    const to = h.str(PATH_B, "/renamed.txt")
    expect(h.sys.path_rename!(3, from.ptr, from.len, 3, to.ptr, to.len)).toBe(E.success)
    // An unrelated file now occupies the old name; it must stay untouched.
    fsModule.writeFileSync(join(root, "sized.txt"), "UNRELATED CONTENT")
    expect(h.sys.fd_filestat_set_size!(fd, 4n)).toBe(E.success)
    expect(fsModule.readFileSync(join(root, "renamed.txt"), "utf8")).toBe("0123")
    expect(fsModule.readFileSync(join(root, "sized.txt"), "utf8")).toBe("UNRELATED CONTENT")
    const mtim = 1_600_000_111_500_000_000n // 2020: distinguishable from "now"
    expect(h.sys.fd_filestat_set_times!(fd, 0n, mtim, 4)).toBe(E.success)
    expectNsClose(nsOfMs(fsModule.statSync(join(root, "renamed.txt")).mtimeMs), mtim)
    expect(fsModule.statSync(join(root, "sized.txt")).mtimeMs).toBeGreaterThan(1_700_000_000_000)
    h.sys.fd_close!(fd)
  })

  it("stamps times on a directory fd through its tracked path", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "stamped"))
    const h = host({ root })
    const fd = open(h, "/stamped", { oflags: OFLAG.directory })
    const mtim = 1_600_000_111_500_000_000n
    expect(h.sys.fd_filestat_set_times!(fd, 0n, mtim, 4)).toBe(E.success)
    expectNsClose(nsOfMs(fsModule.statSync(join(root, "stamped")).mtimeMs), mtim)
  })

  it("stops the write loop when the backend reports a short write", () => {
    const short = stubFs({
      openSync: () => 7,
      statSync: () => {
        throw codeError("ENOENT")
      },
      lstatSync: () => {
        throw codeError("ENOENT")
      },
      writeSync: () => 1
    })
    const h = host({ fs: short })
    const fd = open(h, "/x", { oflags: OFLAG.creat | OFLAG.trunc, rights: W })
    const data = h.str(DATA, "abc")
    expect(h.sys.fd_write!(fd, h.iovs([data]), 1, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(1)
    expect(h.sys.fd_pwrite!(fd, h.iovs([data]), 1, 0n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(1) // pwrite stops at the same short write
  })

  it("skips zero-length iovecs in the file write path", () => {
    const root = freshDir()
    const h = host({ root })
    const fd = open(h, "/z.txt", { oflags: OFLAG.creat | OFLAG.trunc, rights: W })
    const data = h.str(DATA, "zz")
    expect(h.sys.fd_write!(fd, h.iovs([{ ptr: DATA, len: 0 }, data]), 2, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(2)
    h.sys.fd_close!(fd)
    expect(fsModule.readFileSync(join(root, "z.txt"), "utf8")).toBe("zz")
  })
})

describe("WasiPreview1 directories", () => {
  it("creates, renames, and removes directory entries with faithful errno", () => {
    const root = freshDir()
    const h = host({ root })
    const p = (text: string) => h.str(PATH_A, text)
    const q = (text: string) => h.str(PATH_B, text)
    let a = p("/made")
    expect(h.sys.path_create_directory!(3, a.ptr, a.len)).toBe(E.success)
    expect(fsModule.statSync(join(root, "made")).isDirectory()).toBe(true)
    expect(h.sys.path_create_directory!(3, a.ptr, a.len)).toBe(E.exist)
    a = p("/missing/deep")
    expect(h.sys.path_create_directory!(3, a.ptr, a.len)).toBe(E.noent)

    fsModule.writeFileSync(join(root, "made", "f.txt"), "x")
    a = p("/made")
    expect(h.sys.path_remove_directory!(3, a.ptr, a.len)).toBe(E.notempty)
    a = p("/made/f.txt")
    expect(h.sys.path_remove_directory!(3, a.ptr, a.len)).toBe(E.notdir)

    a = p("/made/f.txt")
    let b = q("/renamed.txt")
    expect(h.sys.path_rename!(3, a.ptr, a.len, 3, b.ptr, b.len)).toBe(E.success)
    expect(fsModule.readFileSync(join(root, "renamed.txt"), "utf8")).toBe("x")
    fsModule.writeFileSync(join(root, "other.txt"), "y")
    a = p("/renamed.txt")
    b = q("/other.txt")
    expect(h.sys.path_rename!(3, a.ptr, a.len, 3, b.ptr, b.len)).toBe(E.success) // rename overwrites
    expect(fsModule.readFileSync(join(root, "other.txt"), "utf8")).toBe("x")
    a = p("/gone.txt")
    b = q("/nowhere.txt")
    expect(h.sys.path_rename!(3, a.ptr, a.len, 3, b.ptr, b.len)).toBe(E.noent)

    a = p("/other.txt")
    expect(h.sys.path_unlink_file!(3, a.ptr, a.len)).toBe(E.success)
    expect(h.sys.path_unlink_file!(3, a.ptr, a.len)).toBe(E.noent)
    a = p("/made")
    expect([E.perm, E.isdir]).toContain(h.sys.path_unlink_file!(3, a.ptr, a.len)) // platform-dependent
    expect(h.sys.path_remove_directory!(3, a.ptr, a.len)).toBe(E.success)
  })

  it.skipIf(!supportsNativeSymlinks)("lists directories with d_type, index cookies, and spec truncation", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "file.txt"), "x")
    fsModule.mkdirSync(join(root, "subdir"))
    fsModule.symlinkSync("file.txt", join(root, "link"))
    const h = host({ root })
    expect(h.sys.fd_readdir!(3, BUF, 1024, 0n, RET)).toBe(E.success)
    const full = parseDirents(h.get(BUF, h.u32(RET)))
    expect(full).toHaveLength(3)
    const byName = new Map(full.map((entry) => [entry.name, entry]))
    expect(byName.get("file.txt")?.type).toBe(4)
    expect(byName.get("subdir")?.type).toBe(3)
    expect(byName.get("link")?.type).toBe(7)
    expect(full.map((entry) => entry.next)).toEqual([1n, 2n, 3n])

    // page one entry at a time, resuming from each d_next cookie
    const paged: Array<string> = []
    let cookie = 0n
    for (;;) {
      expect(h.sys.fd_readdir!(3, BUF, 1024, cookie, RET)).toBe(E.success)
      const used = h.u32(RET)
      if (used === 0) break
      const [head] = parseDirents(h.get(BUF, used))
      expect(head).toBeDefined()
      paged.push(head!.name)
      cookie = head!.next
      if (paged.length > 4) break
    }
    expect(paged.sort()).toEqual(["file.txt", "link", "subdir"])

    expect(h.sys.fd_readdir!(3, BUF, 10, 0n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(10) // truncated final (first) entry still fills the buffer
    expect(h.sys.fd_readdir!(3, BUF, 1024, 99n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0) // cookie beyond the end
  })

  it("resumes fd_readdir from the last complete record across truncated pages", () => {
    const root = freshDir()
    const expected = Array.from({ length: 40 }, (_, index) => `entry-${String(index).padStart(2, "0")}.txt`)
    for (const name of expected) fsModule.writeFileSync(join(root, name), name)
    const h = host({ root })
    const seen: Array<string> = []
    let cookie = 0n
    let drained = false

    for (let page = 0; page <= expected.length; page++) {
      expect(h.sys.fd_readdir!(3, BUF, 64, cookie, RET)).toBe(E.success)
      const used = h.u32(RET)
      if (used === 0) {
        drained = true
        break
      }
      const complete = parseDirents(h.get(BUF, used))
      expect(complete).not.toHaveLength(0)
      for (const entry of complete) {
        expect(seen).not.toContain(entry.name)
        seen.push(entry.name)
      }
      cookie = complete[complete.length - 1]!.next
    }

    expect(drained).toBe(true)
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual([...expected].sort())
  })

  it("tolerates a directory becoming shorter between fd_readdir calls", () => {
    const dirent = (name: string): SyncDirentLike => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    })
    let calls = 0
    const h = host({
      fs: stubFs({
        readdirSync: () => ++calls === 1 ? [dirent("one"), dirent("two"), dirent("three")] : [dirent("one")]
      })
    })
    expect(h.sys.fd_readdir!(3, BUF, 512, 0n, RET)).toBe(E.success)
    const first = parseDirents(h.get(BUF, h.u32(RET)))
    const cookie = first[first.length - 1]!.next
    expect(cookie).toBe(3n)
    expect(h.sys.fd_readdir!(3, BUF, 512, cookie, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0)
  })

  it("lists a directory once for a full multi-page fd_readdir enumeration", () => {
    const dirent = (name: string): SyncDirentLike => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    })
    const names = Array.from({ length: 200 }, (_, index) => `entry-${String(index).padStart(3, "0")}`)
    let listings = 0
    const h = host({
      fs: stubFs({
        readdirSync: () => {
          listings++
          return names.map(dirent)
        }
      })
    })
    const seen: Array<string> = []
    let cookie = 0n
    let pages = 0
    for (;;) {
      expect(h.sys.fd_readdir!(3, BUF, 128, cookie, RET)).toBe(E.success)
      const used = h.u32(RET)
      if (used === 0) break
      pages++
      const complete = parseDirents(h.get(BUF, used))
      for (const entry of complete) seen.push(entry.name)
      cookie = complete[complete.length - 1]!.next
    }
    expect(seen).toEqual(names)
    expect(pages).toBeGreaterThan(10)
    expect(listings).toBe(1)
    // The snapshot is released at EOF: a fresh cookie-zero call lists again.
    expect(h.sys.fd_readdir!(3, BUF, 128, 0n, RET)).toBe(E.success)
    expect(listings).toBe(2)
  })

  it("shows entries added during an enumeration on the next cookie-zero fd_readdir", () => {
    const dirent = (name: string): SyncDirentLike => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    })
    const names = ["one", "two", "three"]
    const h = host({ fs: stubFs({ readdirSync: () => names.map(dirent) }) })
    expect(h.sys.fd_readdir!(3, BUF, 40, 0n, RET)).toBe(E.success)
    const first = parseDirents(h.get(BUF, h.u32(RET)))
    expect(first.map((entry) => entry.name)).toEqual(["one"])
    names.push("four")
    // Mid-enumeration the snapshot holds: the new entry is not yet visible.
    expect(h.sys.fd_readdir!(3, BUF, 512, first[0]!.next, RET)).toBe(E.success)
    expect(parseDirents(h.get(BUF, h.u32(RET))).map((entry) => entry.name)).toEqual(["two", "three"])
    // A fresh enumeration observes the mutation.
    expect(h.sys.fd_readdir!(3, BUF, 512, 0n, RET)).toBe(E.success)
    expect(parseDirents(h.get(BUF, h.u32(RET))).map((entry) => entry.name)).toEqual(["one", "two", "three", "four"])
  })

  it("drops the fd_readdir snapshot on fd_close so a reopened fd lists afresh", () => {
    const root = freshDir()
    fsModule.mkdirSync(join(root, "sub"))
    fsModule.writeFileSync(join(root, "sub", "a"), "a")
    const h = host({ root })
    const fd = open(h, "/sub", { oflags: OFLAG.directory })
    expect(h.sys.fd_readdir!(fd, BUF, 40, 0n, RET)).toBe(E.success)
    expect(parseDirents(h.get(BUF, h.u32(RET))).map((entry) => entry.name)).toEqual(["a"])
    expect(h.sys.fd_close!(fd)).toBe(E.success)
    fsModule.writeFileSync(join(root, "sub", "b"), "b")
    const again = open(h, "/sub", { oflags: OFLAG.directory })
    expect(h.sys.fd_readdir!(again, BUF, 512, 0n, RET)).toBe(E.success)
    expect(parseDirents(h.get(BUF, h.u32(RET))).map((entry) => entry.name).sort()).toEqual(["a", "b"])
  })

  it("rejects lossy fd_readdir cookies above MAX_SAFE_INTEGER", () => {
    const root = freshDir()
    const h = host({ root })
    expect(h.sys.fd_readdir!(3, BUF, 64, MAX_SAFE_U64, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0)
    expect(h.sys.fd_readdir!(3, BUF, 64, TOO_LARGE_U64, RET)).toBe(E.inval)
    expect(h.sys.fd_readdir!(3, BUF, 64, U64_MAX, RET)).toBe(E.inval)
    // The bit pattern as a real guest delivers it, negative across the ABI.
    expect(h.sys.fd_readdir!(3, BUF, 64, U64_MAX_AS_WASM_PASSES_IT, RET)).toBe(E.inval)
  })

  it("reports an empty directory and refuses readdir on non-directories", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "f.txt"), "x")
    const h = host({ root })
    fsModule.mkdirSync(join(root, "empty"))
    const fd = open(h, "/empty", { oflags: OFLAG.directory })
    expect(h.sys.fd_readdir!(fd, BUF, 512, 0n, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(0)
    const file = open(h, "/f.txt")
    expect(h.sys.fd_readdir!(file, BUF, 512, 0n, RET)).toBe(E.notdir)
    expect(h.sys.fd_readdir!(1, BUF, 512, 0n, RET)).toBe(E.notdir)
  })

  it("maps a backend dirent with no known type to d_type unknown", () => {
    const mystery: SyncDirentLike = {
      name: "mystery",
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }
    const h = host({ fs: stubFs({ readdirSync: () => [mystery] }) })
    expect(h.sys.fd_readdir!(3, BUF, 512, 0n, RET)).toBe(E.success)
    expect(parseDirents(h.get(BUF, h.u32(RET)))[0]?.type).toBe(0)
  })
})

describe("WasiPreview1 stat & times", () => {
  it("reports nanosecond filestats that agree with the backend", () => {
    const root = freshDir()
    const file = join(root, "stat.txt")
    fsModule.writeFileSync(file, "12345")
    const h = host({ root })
    const p = h.str(PATH_A, "/stat.txt")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.success)
    const stats = fsModule.statSync(file)
    expect(h.view().getUint8(STAT + 16)).toBe(4) // regular file
    expect(h.u64(STAT + 8)).toBe(BigInt(Math.trunc(stats.ino)))
    expect(h.u64(STAT + 32)).toBe(5n)
    expect(h.u64(STAT + 48)).toBe(nsOfMs(stats.mtimeMs))
    expect(h.u64(STAT + 40)).toBe(nsOfMs(stats.atimeMs))
    expect(h.u64(STAT + 56)).toBe(nsOfMs(stats.ctimeMs))
  })

  it("stats through fds: fstat for files, stat for directory fds", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "f.txt"), "abc")
    const h = host({ root })
    const fd = open(h, "/f.txt")
    expect(h.sys.fd_filestat_get!(fd, STAT)).toBe(E.success)
    expect(h.u64(STAT + 32)).toBe(3n)
    expect(h.view().getUint8(STAT + 16)).toBe(4)
    expect(h.sys.fd_filestat_get!(3, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(3)
  })

  it.skipIf(!supportsNativeSymlinks)("distinguishes lstat and stat through lookupflags", () => {
    const root = freshDir()
    fsModule.writeFileSync(join(root, "real.txt"), "real")
    fsModule.symlinkSync("real.txt", join(root, "ln"))
    const h = host({ root })
    const p = h.str(PATH_A, "/ln")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(4) // followed
    expect(h.sys.path_filestat_get!(3, 0, p.ptr, p.len, STAT)).toBe(E.success)
    expect(h.view().getUint8(STAT + 16)).toBe(7) // the link itself
  })

  it.skipIf(!supportsNativeSymlinks)("refuses to stat outside the preopen through a followed link", () => {
    const root = freshDir()
    const outside = freshDir()
    const outsideFile = join(outside, "stat-secret.txt")
    fsModule.writeFileSync(outsideFile, "outside stats")
    fsModule.symlinkSync(outsideFile, join(root, "peek"))
    const h = host({ root })
    const p = h.str(PATH_A, "/peek")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.noent)
    expect(fsModule.statSync(outsideFile).size).toBe(13)
  })

  it("interprets explicit nanosecond timestamps as unsigned WASI values", () => {
    const root = freshDir()
    const pathFile = join(root, "path-time.txt")
    const fdFile = join(root, "fd-time.txt")
    fsModule.writeFileSync(pathFile, "path")
    fsModule.writeFileSync(fdFile, "fd")
    const h = host({ root })
    const p = h.str(PATH_A, "/path-time.txt")
    const presentDay = 1_750_000_000_125_000_000n

    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, 0n, presentDay, 4)).toBe(E.success)
    expectNsClose(nsOfMs(fsModule.statSync(pathFile).mtimeMs), presentDay)

    const highBit = 1n << 63n
    const signedImport = BigInt.asIntN(64, highBit)
    expect(signedImport).toBeLessThan(0n)
    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, 0n, signedImport, 4)).toBe(E.success)
    expect(fsModule.statSync(pathFile).mtimeMs).toBeGreaterThan(Date.now())
    expectNsClose(nsOfMs(fsModule.statSync(pathFile).mtimeMs), highBit)

    const fd = open(h, "/fd-time.txt", { rights: RW })
    expect(h.sys.fd_filestat_set_times!(fd, 0n, signedImport, 4)).toBe(E.success)
    expect(fsModule.statSync(fdFile).mtimeMs).toBeGreaterThan(Date.now())
    expectNsClose(nsOfMs(fsModule.statSync(fdFile).mtimeMs), highBit)
    h.sys.fd_close!(fd)
  })

  it("sets explicit nanosecond times and 'now', keeping unset sides", () => {
    const root = freshDir()
    const file = join(root, "times.txt")
    fsModule.writeFileSync(file, "x")
    const h = host({ root })
    const p = h.str(PATH_A, "/times.txt")
    const atim = 1_600_000_000_250_000_000n
    const mtim = 1_600_000_111_500_000_000n
    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, atim, mtim, 1 | 4)).toBe(E.success)
    const stamped = fsModule.statSync(file)
    expectNsClose(nsOfMs(stamped.mtimeMs), mtim)
    expectNsClose(nsOfMs(stamped.atimeMs), atim)

    // only mtime explicitly: atime keeps its current value
    const mtim2 = 1_600_000_222_000_000_000n
    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, 0n, mtim2, 4)).toBe(E.success)
    const kept = fsModule.statSync(file)
    expectNsClose(nsOfMs(kept.mtimeMs), mtim2)
    expectNsClose(nsOfMs(kept.atimeMs), atim)

    // only atime explicitly: mtime keeps its current value
    const atim2 = 1_600_000_333_000_000_000n
    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, atim2, 0n, 1)).toBe(E.success)
    const kept2 = fsModule.statSync(file)
    expectNsClose(nsOfMs(kept2.atimeMs), atim2)
    expectNsClose(nsOfMs(kept2.mtimeMs), mtim2)

    // "now" on both sides, through the fd flavour
    const fd = open(h, "/times.txt", { rights: RW })
    expect(h.sys.fd_filestat_set_times!(fd, 0n, 0n, 2 | 8)).toBe(E.success)
    const now = fsModule.statSync(file)
    expect(Math.abs(now.mtimeMs - Date.now())).toBeLessThan(10_000)

    expect(h.sys.fd_filestat_set_times!(fd, 0n, 0n, 1 | 2)).toBe(E.inval)
    expect(h.sys.path_filestat_set_times!(3, 1, p.ptr, p.len, 0n, 0n, 4 | 8)).toBe(E.inval)
  })
})

describe("WasiPreview1 symlinks", () => {
  it.skipIf(!supportsNativeSymlinks)("creates and reads links, truncating into small buffers", () => {
    const root = freshDir()
    const h = host({ root })
    const target = h.str(PATH_A, "the/target.txt")
    const at = h.str(PATH_B, "/ln")
    expect(h.sys.path_symlink!(target.ptr, target.len, 3, at.ptr, at.len)).toBe(E.success)
    expect(fsModule.readlinkSync(join(root, "ln"))).toBe("the/target.txt")
    expect(h.sys.path_readlink!(3, at.ptr, at.len, BUF, 256, RET)).toBe(E.success)
    expect(decoder.decode(h.get(BUF, h.u32(RET)))).toBe("the/target.txt")
    expect(h.sys.path_readlink!(3, at.ptr, at.len, BUF, 3, RET)).toBe(E.success)
    expect(h.u32(RET)).toBe(3)
    expect(decoder.decode(h.get(BUF, 3))).toBe("the")
    expect(h.sys.path_symlink!(target.ptr, target.len, 3, at.ptr, at.len)).toBe(E.exist)
    expect(h.sys.path_symlink!(target.ptr, 0, 3, at.ptr, at.len)).toBe(E.noent) // empty target
    fsModule.writeFileSync(join(root, "plain.txt"), "x")
    const plain = h.str(PATH_A, "/plain.txt")
    expect(h.sys.path_readlink!(3, plain.ptr, plain.len, BUF, 256, RET)).toBe(E.inval)
  })

  it("declines hard links: the slice has none and jj's paths never need one", () => {
    const h = host({ root: freshDir() })
    const a = h.str(PATH_A, "/a")
    const b = h.str(PATH_B, "/b")
    expect(h.sys.path_link!(3, 1, a.ptr, a.len, 3, b.ptr, b.len)).toBe(E.notsup)
  })
})

describe("WasiPreview1 errno mapping", () => {
  const mapped: Array<readonly [string, number]> = [
    ["EACCES", E.acces],
    ["EAGAIN", E.again],
    ["EBADF", E.badf],
    ["EBUSY", E.busy],
    ["EEXIST", E.exist],
    ["EFBIG", E.fbig],
    ["EINVAL", E.inval],
    ["EIO", E.io],
    ["EISDIR", E.isdir],
    ["ELOOP", E.loop],
    ["EMFILE", E.mfile],
    ["ENAMETOOLONG", E.nametoolong],
    ["ENFILE", E.nfile],
    ["ENOENT", E.noent],
    ["ENOLCK", E.nolck],
    ["ENOSPC", E.nospc],
    ["ENOSYS", E.nosys],
    ["ENOTDIR", E.notdir],
    ["ENOTEMPTY", E.notempty],
    ["ENOTSUP", E.notsup],
    ["EOPNOTSUPP", E.notsup],
    ["EPERM", E.perm],
    ["EPIPE", E.pipe],
    ["ERANGE", E.range],
    ["EROFS", E.rofs],
    ["ESPIPE", E.spipe],
    ["EXDEV", E.xdev]
  ]

  it("maps every documented Node code onto its WASI errno", () => {
    for (const [code, errno] of mapped) {
      const h = host({ fs: boomFs(codeError(code)) })
      const p = h.str(PATH_A, "/x")
      expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT), code).toBe(errno)
    }
  })

  it("maps a coded error it has never heard of to EIO", () => {
    const h = host({ fs: boomFs(codeError("EWEIRD")) })
    const p = h.str(PATH_A, "/x")
    expect(h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toBe(E.io)
  })

  it("refuses to launder uncoded throws into errno", () => {
    for (const cause of [new Error("plain"), null, { code: 42 }, "boom"]) {
      const h = host({ fs: boomFs(cause) })
      const p = h.str(PATH_A, "/x")
      expect(() => h.sys.path_filestat_get!(3, 1, p.ptr, p.len, STAT)).toThrow()
    }
  })

  it("reports out-of-bounds wasm memory access as EFAULT", () => {
    const h = host({ root: freshDir() })
    expect(h.sys.path_filestat_get!(3, 1, 0x7fff_0000, 64, STAT)).toBe(E.fault)
  })

  it("propagates non-ENOENT stat and lstat probes out of path_open", () => {
    const plain = {
      size: 0,
      atimeMs: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false
    }
    const denied = host({
      fs: stubFs({
        lstatSync: () => plain,
        statSync: () => {
          throw codeError("EACCES")
        }
      })
    })
    expect(openErrno(denied, "/x")).toBe(E.acces)
    const locked = host({
      fs: stubFs({
        lstatSync: () => {
          throw codeError("EPERM")
        }
      })
    })
    expect(openErrno(locked, "/x", { dirflags: 0 })).toBe(E.perm)
  })
})
