import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ArtifactBackupLease from "../../src/ArtifactBackupLease.ts"
import * as ArtifactStore from "../../src/ArtifactStore.ts"
import { hostPath } from "../HostPath.ts"

const [mode, directory, digest] = process.argv.slice(2)
if (
  (mode !== "backup-hold" && mode !== "freshen-hold" && mode !== "lock-hold") ||
  directory === undefined ||
  digest === undefined
) {
  process.stderr.write("invalid fixture arguments\n")
  process.exitCode = 2
} else {
  const bytes = new TextEncoder().encode("cross-process-artifact")
  const blobPath = `${directory}/${digest.slice(0, 2)}/${digest}`
  const awaitRelease = Effect.callback<void>((resume) => {
    const release = () => {
      process.stdin.pause()
      resume(Effect.void)
    }
    process.stdin.once("data", release)
    process.stdin.resume()
    return Effect.sync(() => process.stdin.off("data", release))
  })

  const program = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (mode === "backup-hold") {
      yield* ArtifactBackupLease.withLease(
        fs,
        directory,
        Effect.sync(() => process.stdout.write("leased\n")).pipe(Effect.andThen(awaitRelease)),
        (cause) => cause instanceof Error ? cause : new Error(String(cause))
      )
      process.stdout.write("done:backup\n")
      process.stdin.destroy()
      return
    }
    let announced = false
    const gated: FileSystem.FileSystem = {
      ...fs,
      exists: (path) =>
        mode === "lock-hold" && path === blobPath
          ? Effect.sync(() => process.stdout.write("locked\n")).pipe(Effect.andThen(Effect.never))
          : fs.exists(path),
      utimes: (path, atime, mtime) =>
        mode === "freshen-hold" && path === blobPath && !announced
          ? fs.utimes(path, atime, mtime).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                announced = true
                process.stdout.write("freshened\n")
              })
            ),
            Effect.andThen(awaitRelease)
          )
          : fs.utimes(path, atime, mtime)
    }
    process.stdout.write("started\n")
    const store = ArtifactStore.makeFileSystem(gated, hostPath, { directory, durability: "best-effort" })
    const published = yield* store.put(bytes)
    process.stdout.write(`done:${published}\n`)
    process.stdin.destroy()
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodeCrypto.layer)))

  Effect.runPromise(program).catch((cause) => {
    process.stderr.write(`${String(cause)}\n`)
    process.exitCode = 1
  })
}
