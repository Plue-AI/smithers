import { describe, expect, it } from "@effect/vitest"
import * as Permission from "@smthrs/capability/Permission"
import {
  Effect,
  FileSystem as EffectFileSystem,
  Option,
  Path as EffectPath,
  type PlatformError,
  Sink,
  Stream
} from "effect"
import * as FileSystem from "../src/FileSystem.ts"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * `canonicalResource` is the anti-escape core of the filesystem kernel: it
 * decides which resource string a capability check is made against. It has to
 * cope with paths that do not exist yet, symlinks anywhere along the path,
 * relative link targets, and link cycles — and it must never loop forever or
 * silently succeed with an unresolved path.
 */

const platformError = (message: string): PlatformError.PlatformError =>
  new Error(message) as unknown as PlatformError.PlatformError

const path = EffectPath.layer

const resolve = (
  host: EffectFileSystem.FileSystem,
  value: string,
  root = "/workspace"
) =>
  Effect.gen(function*() {
    const pathService = yield* EffectPath.Path
    return yield* FileSystem.canonicalResource(host, pathService, root, value)
  }).pipe(Effect.provide(path))

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>) => it.effect(name, () => body())

describe("canonicalResource", () => {
  itEffect("resolves a workspace-relative value against the workspace root", () =>
    Effect.gen(function*() {
      const host = EffectFileSystem.makeNoop({ realPath: (value) => Effect.succeed(value) })
      expect(yield* resolve(host, "sub/./nested/../file.ts")).toBe("/workspace/sub/file.ts")
    }))

  itEffect(
    "walks up to the nearest existing ancestor for a path that does not exist yet",
    () =>
      Effect.gen(function*() {
        const existing = new Set(["/workspace", "/"])
        const host = EffectFileSystem.makeNoop({
          realPath: (value) => existing.has(value) ? Effect.succeed(value) : Effect.fail(platformError("ENOENT")),
          readLink: () => Effect.fail(platformError("EINVAL"))
        })
        // Neither `missing` nor `missing/deep/file.txt` exists; the ancestor walk
        // stops at `/workspace` and re-attaches the missing tail verbatim.
        expect(yield* resolve(host, "missing/deep/file.txt")).toBe("/workspace/missing/deep/file.txt")
      })
  )

  itEffect(
    "fails with the original error when no ancestor up to the filesystem root exists",
    () =>
      Effect.gen(function*() {
        const host = EffectFileSystem.makeNoop({
          realPath: (value) => value === "/workspace" ? Effect.succeed(value) : Effect.fail(platformError("EACCES")),
          readLink: () => Effect.fail(platformError("EINVAL"))
        })
        const failure = yield* Effect.flip(resolve(host, "/elsewhere/file.txt"))
        expect((failure as unknown as Error).message).toBe("EACCES")
      })
  )

  itEffect("follows a relative symlink target against the link's own directory", () =>
    Effect.gen(function*() {
      const host = EffectFileSystem.makeNoop({
        realPath: (value) =>
          value === "/workspace/dir/link" ? Effect.fail(platformError("ENOENT")) : Effect.succeed(value),
        readLink: (value) =>
          value === "/workspace/dir/link"
            ? Effect.succeed("../sibling")
            : Effect.fail(platformError("EINVAL"))
      })
      // `../sibling` is relative to `/workspace/dir`, not to the process cwd.
      expect(yield* resolve(host, "dir/link")).toBe("/workspace/sibling")
    }))

  itEffect("follows an absolute symlink target that escapes the workspace", () =>
    Effect.gen(function*() {
      const host = EffectFileSystem.makeNoop({
        realPath: (value) => value === "/workspace/link" ? Effect.fail(platformError("ENOENT")) : Effect.succeed(value),
        readLink: (value) =>
          value === "/workspace/link" ? Effect.succeed("/outside/target") : Effect.fail(platformError("EINVAL"))
      })
      expect(yield* resolve(host, "link")).toBe("/outside/target")
    }))

  itEffect("gives up on a symlink cycle instead of recursing forever", () =>
    Effect.gen(function*() {
      let hops = 0
      const host = EffectFileSystem.makeNoop({
        realPath: (value) => value === "/workspace" ? Effect.succeed(value) : Effect.fail(platformError("ELOOP")),
        readLink: (value) =>
          Effect.sync(() => {
            hops += 1
            return value
          })
      })
      const failure = yield* Effect.flip(resolve(host, "loop"))
      expect((failure as unknown as Error).message).toBe("ELOOP")
      // 40 hops are followed, then the 41st read is refused.
      expect(hops).toBe(41)
    }))

  itEffect(
    "maps a resolved path back onto the logical root when the root is itself a symlink",
    () =>
      Effect.gen(function*() {
        const host = EffectFileSystem.makeNoop({
          realPath: (value) => Effect.succeed(value.replace("/workspace", "/private/workspace"))
        })
        expect(yield* resolve(host, "src/file.ts")).toBe("/workspace/src/file.ts")
      })
  )
})

describe("FileSystem.sink failures", () => {
  itEffect("surfaces a host sink failure through the decorated tag's PlatformError channel", () => {
    const grants = GrantStore.of({
      policy: closedPolicy,
      check: () => Effect.void,
      reply: () => Effect.die("not used"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const host = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
      realPath: (value) => Effect.succeed(value),
      sink: () => Sink.forEach(() => Effect.fail(platformError("ENOSPC")))
    }))
    return Effect.gen(function*() {
      const fileSystem = yield* EffectFileSystem.FileSystem
      const failure = yield* Effect.flip(
        Stream.make(new Uint8Array([1])).pipe(Stream.run(fileSystem.sink("out.bin")))
      )
      expect((failure as unknown as Error).message).toBe("ENOSPC")
    }).pipe(
      Effect.provide(FileSystem.layer),
      Effect.provideService(EffectFileSystem.FileSystem, host),
      Effect.provide(path),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, grants)
    )
  })

  itEffect("keeps a denied sink from ever reaching the host", () => {
    let opened = false
    const grants = GrantStore.of({
      policy: closedPolicy,
      check: (capability) => Effect.fail(Permission.permissionDenied(capability, "denied by test")),
      reply: () => Effect.die("not used"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const host = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
      realPath: (value) => Effect.succeed(value),
      sink: () =>
        Sink.forEach(() =>
          Effect.sync(() => {
            opened = true
          })
        )
    }))
    return Effect.gen(function*() {
      const fileSystem = yield* EffectFileSystem.FileSystem
      const failure = yield* Effect.flip(
        Stream.make(new Uint8Array([1])).pipe(Stream.run(fileSystem.sink("out.bin")))
      )
      expect(failure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "PermissionDenied", module: "FileSystem", method: "write" }
      })
      expect(Option.getOrThrow(Permission.fromPlatformError(failure))).toMatchObject({
        code: "permission_denied",
        capability: { action: "fs:write", resource: "/workspace/out.bin" }
      })
      expect(opened).toBe(false)
    }).pipe(
      Effect.provide(FileSystem.layer),
      Effect.provideService(EffectFileSystem.FileSystem, host),
      Effect.provide(path),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, grants)
    )
  })
})
