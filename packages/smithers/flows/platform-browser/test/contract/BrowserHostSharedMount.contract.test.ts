/**
 * Cross-service BrowserHost contract over one real mounted directory.
 *
 * A page must hand BrowserFileSystem, just-bash, and BrowserJj views of the
 * same ZenFS mount. This test uses promise and synchronous adapters rooted at
 * one OS tmpdir so a split mount cannot satisfy the assertions by accident.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import type { SyncFsLike } from "@smthrs/jj/browser/WasiFs"
import { Effect, FileSystem } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as fsModule from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type * as BrowserChildProcessSpawner from "../../src/BrowserChildProcessSpawner/index.ts"
import * as BrowserFileSystem from "../../src/BrowserFileSystem/index.ts"
import * as BrowserHost from "../../src/BrowserHost.ts"

/**
 * `lstat` and `realpath` are supplied, not omitted: without them the adapter
 * falls back to lexical canonicalization, and this mount's synchronous slice
 * can create symlinks, so the kernel's boundary resolution would be naming
 * rather than resolution. `realpath` answers inside the virtual namespace by
 * stripping the canonical host root back off.
 */
const rootedPromisesFs = (hostRoot: string, canonicalRoot: string): BrowserFileSystem.ZenFsPromisesLike => {
  const at = (path: string): string => join(hostRoot, path)
  return {
    open: (path, flags) => fsPromises.open(at(path), flags),
    readFile: (path) => fsPromises.readFile(at(path)),
    writeFile: (path, data, options) => fsPromises.writeFile(at(path), data, options),
    mkdir: (path, options) => fsPromises.mkdir(at(path), options),
    readdir: (path) => fsPromises.readdir(at(path)),
    stat: (path) => fsPromises.stat(at(path)),
    lstat: (path) => fsPromises.lstat(at(path)),
    realpath: (path) =>
      fsPromises.realpath(at(path)).then((resolved) =>
        resolved.startsWith(canonicalRoot) ? resolved.slice(canonicalRoot.length) || "/" : resolved
      ),
    rm: (path, options) => fsPromises.rm(at(path), options)
  }
}

const rootedSyncFs = (hostRoot: string): SyncFsLike => {
  const at = (path: string): string => join(hostRoot, path)
  return {
    openSync: (path, flags, mode) => fsModule.openSync(at(path), flags, mode),
    closeSync: (fd) => fsModule.closeSync(fd),
    readSync: (fd, buffer, offset, length, position) => fsModule.readSync(fd, buffer, offset, length, position),
    writeSync: (fd, buffer, offset, length, position) => fsModule.writeSync(fd, buffer, offset, length, position),
    fstatSync: (fd) => fsModule.fstatSync(fd),
    ftruncateSync: (fd, length) => fsModule.ftruncateSync(fd, length),
    futimesSync: (fd, atime, mtime) => fsModule.futimesSync(fd, atime, mtime),
    statSync: (path) => fsModule.statSync(at(path)),
    lstatSync: (path) => fsModule.lstatSync(at(path)),
    mkdirSync: (path) => fsModule.mkdirSync(at(path)),
    readdirSync: (path, options) => fsModule.readdirSync(at(path), options),
    renameSync: (from, to) => fsModule.renameSync(at(from), at(to)),
    unlinkSync: (path) => fsModule.unlinkSync(at(path)),
    rmdirSync: (path) => fsModule.rmdirSync(at(path)),
    readlinkSync: (path) => fsModule.readlinkSync(at(path)),
    symlinkSync: (target, path) => fsModule.symlinkSync(target, at(path)),
    utimesSync: (path, atime, mtime) => fsModule.utimesSync(at(path), atime, mtime)
  }
}

const bashFor = (hostRoot: string): BrowserChildProcessSpawner.JustBashLike => ({
  exec: async (command, options) => {
    if (command !== "read-shared") return { stdout: "", stderr: "unsupported command", exitCode: 127 }
    const cwd = options?.cwd ?? "/"
    return {
      stdout: await fsPromises.readFile(join(hostRoot, cwd, "shared.txt"), "utf8"),
      stderr: "",
      exitCode: 0
    }
  }
})

const wasmPath = fileURLToPath(new URL("../../../jj/wasm/flows_jj.wasm", import.meta.url))
if (!fsModule.existsSync(wasmPath)) {
  throw new Error(
    "[BrowserHostSharedMount.contract] packages/smithers/flows/jj/wasm/flows_jj.wasm is required. Build it with "
      + "`pnpm --filter @smthrs/jj run build:wasm` (requires the rust wasm32-wasip1 toolchain "
      + "and crates/flows-jj)."
  )
}
const wasmBytes = new Uint8Array(fsModule.readFileSync(wasmPath))

const host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-host-shared-mount-"))
// The temp root itself can sit behind a symlink (macOS /var), so the prefix
// the adapter strips has to be the canonical one.
const canonicalHost = fsModule.realpathSync(host)
fsModule.mkdirSync(join(host, "repo"))
const layer = BrowserHost.layer({
  bash: bashFor(host),
  fs: rootedPromisesFs(host, canonicalHost),
  jj: { wasm: wasmBytes, fs: rootedSyncFs(host), root: "/" }
})

afterAll(() => {
  fsModule.rmSync(host, { recursive: true, force: true })
})

describe("BrowserHost shared mount contract", () => {
  it.effect("makes FileSystem writes visible to bash, jj status, snapshot, and diff", () =>
    Effect.gen(function*() {
      const observed = yield* (
        Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          const jj = yield* Jj

          yield* fileSystem.writeFileString("/shared.txt", "first\n")
          const bashRead = yield* spawner.string(
            ChildProcess.make("read-shared", [], { cwd: "/" })
          )
          const { commitId: first, changeId: firstChange } = yield* jj.snapshot("shared mount first")

          yield* fileSystem.writeFileString("/shared.txt", "second\n")
          const status = yield* jj.status()
          const { commitId: second, changeId: secondChange } = yield* jj.snapshot("shared mount second")
          const diff = yield* jj.diff(first, second)
          return { bashRead, diff, first, second, firstChange, secondChange, status }
        }).pipe(Effect.provide(layer))
      )

      expect(observed.bashRead).toBe("first\n")
      expect(observed.first).toMatch(/^[a-z0-9]+$/)
      expect(observed.second).not.toBe(observed.first)
      expect(observed.secondChange).toBe(observed.firstChange)
      // Snapshots amend the same change; its parent still has no shared file.
      expect(observed.status).toContain("A shared.txt")
      expect(observed.diff).toContain("shared.txt")
      expect(observed.diff).toContain("-first")
      expect(observed.diff).toContain("+second")
    }))
})
