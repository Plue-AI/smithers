/**
 * The full Host contract over `BrowserHost.layer`, jj included: the committed
 * `flows_jj.wasm` artifact runs against a temp-directory-rooted sync
 * filesystem, exactly the shape a page supplies from a ZenFS mount. The wasm
 * artifact is a hard prerequisite: without it this file fails during setup and
 * tells the developer how to build it, rather than weakening the contract.
 *
 * The contract exercises each service independently, so the memory fs behind
 * `FileSystem`/bash and the tmpdir behind jj may diverge here; a real page
 * must hand all three the same mount. The cross-service invariant has its own
 * real-mount proof in `BrowserHostSharedMount.contract.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import type { SyncFsLike } from "@smthrs/jj/browser/WasiFs"
import { runHostContract } from "@smthrs/kernel/test/contract"
import type * as BrowserChildProcessSpawner from "@smthrs/platform-browser/BrowserChildProcessSpawner"
import * as BrowserHost from "@smthrs/platform-browser/BrowserHost"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as TestHost from "../../src/TestHost.ts"

type BashResult = Awaited<ReturnType<BrowserChildProcessSpawner.JustBashLike["exec"]>>

const result = (stdout: string): BashResult => ({ stdout, stderr: "", exitCode: 0 })

const bash: BrowserChildProcessSpawner.JustBashLike = {
  exec: (command, options) => {
    if (command === "host-contract-exec") return Promise.resolve(result("browser-exec"))
    if (command === "host-contract-stream") return Promise.resolve(result("browser-stream"))
    if (command === "host-contract-options") {
      const valid = options?.cwd === "/" && options.env?.HOST_CONTRACT_ENV === "browser"
      return Promise.resolve(result(valid ? "browser-options" : "invalid-options"))
    }
    if (command === "host-contract-interrupt") {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal
        if (signal?.aborted === true) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }
    return Promise.resolve(result(""))
  }
}

// `node:fs` confined under a host directory, exposed as the `SyncFsLike` the
// wasm mounts as its namespace — the test-side stand-in for a ZenFS sync
// slice, mirroring packages/smithers/flows/jj/test/RootedSyncFs.ts.
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

const wasmPath = fileURLToPath(new URL("../../../smithers/flows/jj/wasm/flows_jj.wasm", import.meta.url))
if (!fsModule.existsSync(wasmPath)) {
  throw new Error(
    "[BrowserHost.contract] packages/smithers/flows/jj/wasm/flows_jj.wasm is required for the real BrowserHost "
      + "contract. Build it with `pnpm --filter @smthrs/jj run build:wasm` "
      + "(requires the rust wasm32-wasip1 toolchain and crates/flows-jj)."
  )
}
const wasmBytes = new Uint8Array(fsModule.readFileSync(wasmPath))

const host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-host-contract-"))
fsModule.mkdirSync(join(host, "repo"))

const layer = BrowserHost.layer({
  bash,
  fs: TestHost.makeMemoryFs(),
  jj: {
    wasm: wasmBytes,
    fs: rootedSyncFs(host),
    root: "/"
  }
})

// The contract's jj probe is `status()` alone; seed one snapshot so the
// workspace exists before the probe, the way any real page's first write does.
let jj: Jj
beforeAll(async () => {
  fsModule.writeFileSync(join(host, "repo", "seed.txt"), "seed\n")
  // A vitest hook is a Promise boundary; @effect/vitest has no Effect hook.
  jj = await Effect.runPromise(Effect.provide(Jj, layer))
  await Effect.runPromise(jj.snapshot("browser host contract seed"))
}, 60_000)

afterAll(() => {
  fsModule.rmSync(host, { recursive: true, force: true })
})

describe("BrowserHost real wasm contract", () => {
  it.effect("diffs two snapshots and restores one through the Host-provided jj", () =>
    Effect.gen(function*() {
      const path = join(host, "repo", "real-wasm.txt")
      fsModule.writeFileSync(path, "first\n")
      const { commitId: first } = yield* (jj.snapshot("real wasm first"))
      fsModule.writeFileSync(path, "second\n")
      const { commitId: second } = yield* (jj.snapshot("real wasm second"))

      const diff = yield* (jj.diff(first, second))
      expect(diff).toContain("real-wasm.txt")
      expect(diff).toContain("-first")
      expect(diff).toContain("+second")

      yield* (jj.restore(first))
      expect(fsModule.readFileSync(path, "utf8")).toBe("first\n")
    }))
})

runHostContract(
  "BrowserHost",
  layer,
  {
    fileSystem: {
      expected: "success",
      scratchPath: "/browser-host-contract",
      unsupported: {
        chmod: "PermissionDenied",
        chown: "PermissionDenied",
        copy: "PermissionDenied",
        copyFile: "PermissionDenied",
        glob: "PermissionDenied",
        link: "PermissionDenied",
        makeTempDirectory: "PermissionDenied",
        makeTempDirectoryScoped: "PermissionDenied",
        makeTempFile: "PermissionDenied",
        makeTempFileScoped: "PermissionDenied",
        open: "PermissionDenied",
        readLink: "PermissionDenied",
        rename: "PermissionDenied",
        sink: "PermissionDenied",
        symlink: "PermissionDenied",
        truncate: "PermissionDenied",
        utimes: "PermissionDenied",
        watch: "PermissionDenied"
      }
    },
    path: { expected: "success" },
    childProcess: {
      expected: "success",
      execCommand: ChildProcess.make("host-contract-exec"),
      expectedStdout: "browser-exec",
      streamCommand: ChildProcess.make("host-contract-stream"),
      expectedStreamText: "browser-stream",
      optionsCommand: ChildProcess.make("host-contract-options", [], {
        cwd: "/",
        env: { HOST_CONTRACT_ENV: "browser" }
      }),
      expectedOptionsStdout: "browser-options",
      // The adapter does not use just-bash's string stdin option yet, so a
      // supplied stdin stream is rejected.
      stdin: { expected: "failure", code: "BadArgument" },
      pipeline: { expected: "failure", code: "BadArgument" },
      interruptCommand: ChildProcess.make("host-contract-interrupt")
    },
    jj: {
      expected: "success",
      prepareChange: (phase) => Effect.sync(() => fsModule.writeFileSync(join(host, `${phase}.txt`), `${phase}\n`)),
      workspacePath: "/host-contract-workspace",
      rootFrom: "/",
      unsupported: { revert: "not_installed" }
    },
    httpClient: { expected: "failure", code: "TransportError" }
  }
)
