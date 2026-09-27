import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as ArtifactBackupLease from "../src/ArtifactBackupLease.ts"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactSweep from "../src/ArtifactSweep.ts"
import { hostPath } from "./HostPath.ts"

const payload = new TextEncoder().encode("cross-process-artifact")
const digest = "97af2a42624678e1e99f77a0cfa63accb6bf32a49ad5ab386a0a68f24ebe2c6c" as ArtifactStore.Digest
const fixture = new URL("./fixtures/artifact-lock-child.ts", import.meta.url)

const runLayer = Layer.merge(NodeFileSystem.layer, NodeCrypto.layer)

const launch = (
  mode: "backup-hold" | "freshen-hold" | "lock-hold",
  directory: string
): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(fixture), mode, directory, digest], {
    stdio: ["pipe", "pipe", "pipe"]
  })

const waitFor = (child: ChildProcessWithoutNullStreams, marker: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = ""
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes(marker)) {
        cleanup()
        resolve(output)
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`artifact lock child exited ${String(code)} before ${marker}`))
    }
    const cleanup = () => {
      child.stdout.off("data", onData)
      child.off("exit", onExit)
    }
    child.stdout.on("data", onData)
    child.once("exit", onExit)
  })

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode === 0 || child.signalCode === "SIGKILL") {
      resolve()
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error(`artifact lock child exited ${String(child.exitCode)} (${String(child.signalCode)})`))
      return
    }
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") resolve()
      else reject(new Error(`artifact lock child exited ${String(code)} (${String(signal)})`))
    })
  })

describe("cross-process artifact locking", () => {
  it.live("fences sweep deletion while another process holds a backup lease", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-artifact-backup-lease-" })
        const store = ArtifactStore.makeFileSystem(fs, hostPath, { directory, durability: "best-effort" })
        expect(yield* store.put(payload)).toBe(digest)

        const child = launch("backup-hold", directory)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (child.exitCode === null) child.kill("SIGKILL")
          })
        )
        yield* Effect.promise(() => waitFor(child, "leased"))

        const sweep = ArtifactSweep.makeFileSystem(fs, { directory })
        expect(yield* sweep.remove(digest)).toBe(false)
        expect(Array.from(yield* store.get(digest))).toEqual(Array.from(payload))

        child.stdin.write("release\n")
        yield* Effect.promise(() => waitForExit(child))
        expect(yield* sweep.remove(digest)).toBe(true)
      }).pipe(Effect.provide(runLayer))
    ))

  it.live("keeps a child-process freshen ahead of a fenced sweep deletion", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-artifact-lock-" })
        const store = ArtifactStore.makeFileSystem(fs, hostPath, { directory, durability: "best-effort" })
        expect(yield* store.put(payload)).toBe(digest)
        const blobPath = `${directory}/${digest.slice(0, 2)}/${digest}`
        const old = Date.now() - 120_000
        yield* fs.utimes(blobPath, new Date(old), new Date(old))

        const child = launch("freshen-hold", directory)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (child.exitCode === null) child.kill("SIGKILL")
          })
        )
        yield* Effect.promise(() => waitFor(child, "freshened"))

        const sweep = ArtifactSweep.makeFileSystem(fs, { directory })
        const removing = yield* sweep.remove(digest, { ifUnmodifiedSinceMs: old }).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.sleep("100 millis")
        expect(removing.pollUnsafe()).toBeUndefined()

        child.stdin.write("release\n")
        yield* Effect.promise(() => waitForExit(child))
        expect(yield* Fiber.join(removing)).toBe(false)
        expect(Array.from(yield* store.get(digest))).toEqual(Array.from(payload))
      }).pipe(Effect.provide(runLayer))
    ))

  it.live("recovers an atomically held lock after its owner is hard-killed", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-artifact-stale-lock-" })
        const child = launch("lock-hold", directory)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (child.exitCode === null) child.kill("SIGKILL")
          })
        )
        yield* Effect.promise(() => waitFor(child, "locked"))
        child.kill("SIGKILL")
        yield* Effect.promise(() => waitForExit(child))

        const lockPath = `${directory}/.locks/${digest}.lock`
        const stale = Date.now() - 120_000
        yield* fs.utimes(lockPath, new Date(stale), new Date(stale))
        const store = ArtifactStore.makeFileSystem(fs, hostPath, { directory, durability: "best-effort" })
        expect(yield* store.put(payload)).toBe(digest)
        expect(yield* fs.exists(lockPath)).toBe(false)
        expect(Array.from(yield* store.get(digest))).toEqual(Array.from(payload))
      }).pipe(Effect.provide(runLayer))
    ))
})
