import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Cause, Effect, Exit, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Walk from "../src/internal/Walk.ts"
import type * as StdError from "../src/StdError.ts"
import * as TestRun from "../src/TestRun.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"

const walk = (fileSystem: FileSystem.FileSystem, root: string) =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Walk.files(fileSystem, path, root, false)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  )

const failure = (exit: Exit.Exit<Walk.Walked, StdError.StdError>): StdError.StdError | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason !== undefined && Cause.isFailReason(reason) ? reason.error : undefined
}

const statFailing = (tag: PlatformError.SystemErrorTag, description: string) =>
  FileSystem.makeNoop({
    stat: (path) =>
      Effect.fail(PlatformError.systemError({
        _tag: tag,
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor: path,
        description
      }))
  })

describe("Walk.files", () => {
  it("reports a denied root as its own failure, naming the cause, not as a missing path", async () => {
    const cause = "ENOENT: no such file or directory, lstat '/usr/local/bin/smithers-jj-export'"
    const error = failure(await walk(statFailing("PermissionDenied", cause), "."))
    expect(error).toBeDefined()
    expect(error?.code).toBe("permission_denied")
    expect(error?.message).not.toContain("Path not found")
    expect(error?.message).toContain("PermissionDenied")
    expect(error?.message).toContain(cause)
    expect(error?.path).toBe(".")
  })

  it("reports a genuinely missing root as not_found", async () => {
    const error = failure(await walk(statFailing("NotFound", "ENOENT"), "/missing"))
    expect(error?.code).toBe("not_found")
    expect(error?.message).toBe("Path not found: /missing")
  })

  it("never descends into a live checkpoint or test-baseline checkout", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped()
        yield* fileSystem.writeFileString(`${root}/source.ts`, "x")
        for (const scratch of [Checkpoints.scratchDirectory, TestRun.scratchDirectory]) {
          yield* fileSystem.makeDirectory(`${root}/${scratch}/run-1`, { recursive: true })
          yield* fileSystem.writeFileString(`${root}/${scratch}/run-1/source.ts`, "stale")
        }
        return (yield* Walk.files(fileSystem, path, root, true)).files.map((file) => path.relative(root, file))
      })).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result).toEqual(["source.ts"])
  })

  it("shares its skip list with the tree fingerprint", () => {
    for (const name of Walk.skippedDirectories) expect(TreeFingerprint.defaultPrune).toContain(name)
    expect(TreeFingerprint.defaultPrune).toContain(Checkpoints.scratchDirectory)
    expect(TreeFingerprint.defaultPrune).toContain(TestRun.scratchDirectory)
  })

  it("narrows ignore diagnostics without changing the visited files", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        yield* fs.writeFileString(path.join(root, ".gitignore"), "ignored.txt\n")
        yield* fs.writeFileString(path.join(root, "ignored.txt"), "ignored")
        yield* fs.writeFileString(path.join(root, "keep.js"), "kept")
        expect(yield* Walk.files(fs, path, root, false)).toEqual({
          explicitFile: false,
          files: [path.join(root, "keep.js")],
          ignored: true
        })
        expect(yield* Walk.files(fs, path, root, false, false, (_relative, basename) => basename.endsWith(".js")))
          .toEqual({ explicitFile: false, files: [path.join(root, "keep.js")], ignored: false })
        expect(yield* Walk.files(fs, path, root, false, true)).toEqual({
          explicitFile: false,
          files: [path.join(root, "ignored.txt"), path.join(root, "keep.js")],
          ignored: false
        })
        expect(yield* Walk.files(fs, path, path.join(root, "ignored.txt"), false)).toEqual({
          explicitFile: true,
          files: [path.join(root, "ignored.txt")],
          ignored: false
        })
      })).pipe(Effect.provide(NodeServices.layer))
    )
  })

  it("reports an unreadable root directory but skips an unreadable descendant", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped()
        const child = path.join(root, "denied")
        yield* fs.makeDirectory(child)
        yield* fs.writeFileString(path.join(root, "keep.txt"), "kept")
        yield* fs.writeFileString(path.join(child, "hidden.txt"), "unreadable")
        const deny = (directory: string) => ({
          ...fs,
          readDirectory: (target: string) =>
            target === directory
              ? Effect.fail(PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readDirectory",
                pathOrDescriptor: target
              }))
              : fs.readDirectory(target)
        })
        const error = failure(yield* Effect.exit(Walk.files(deny(root), path, root, false)))
        expect(error?.code).toBe("permission_denied")
        expect(error?.path).toBe(root)
        expect(yield* Walk.files(deny(child), path, root, false)).toEqual({
          explicitFile: false,
          files: [path.join(root, "keep.txt")],
          ignored: false
        })
      })).pipe(Effect.provide(NodeServices.layer))
    )
  })
})
