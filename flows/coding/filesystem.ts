/** Private coding policy around the existing guarded standard file tools. */
import { Preconditions, type VersionedFileSystem } from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import { Effect, type FileSystem, PlatformError, Sink } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { NativeOptions } from "./native.ts"

const denied = (method: string) => PlatformError.systemError({
  _tag: "PermissionDenied", module: "FileSystem", method,
  description: "Authenticated atomic file mutation provider unavailable"
})
const refusal = (method: string) => Effect.fail(denied(method))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** One policy instance per coding tool host. Recomposition/resume starts with no read bases.
 * No host compare followed by rename can qualify as an atomic mutation provider.
 * Until the authenticated daemon is composed, all actual file mutations fail closed.
 */
export const make = (
  options: NativeOptions,
  fs: FileSystem.FileSystem,
  _spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalRoot: string
): VersionedFileSystem => {
  const root = resolve(options.repositoryPath)
  const pinnedRoot = resolve(canonicalRoot)
  const ledgers = new Map<string, Map<string, string>>()
  const inside = (path: string) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    return inside(suffix) ? resolve(pinnedRoot, suffix) : absolute
  }
  const identity = (path: string) => fs.realPath(key(path)).pipe(
    Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(key(path)) : Effect.fail(error)),
    Effect.flatMap((value) => inside(relative(pinnedRoot, value)) && value !== pinnedRoot
      ? Effect.succeed(value) : refusal("filePreconditions")),
    Effect.mapError(() => new StdError({ code: "permission_denied", message: `Permission denied: ${path}`, path }))
  )
  return {
    ...fs,
    [Preconditions]: {
      record: (path, bytes, session) => Effect.gen(function*() {
        const target = yield* identity(path)
        if (session === undefined) return
        const ledger = ledgers.get(session) ?? new Map<string, string>()
        ledger.set(target, digest(bytes))
        ledgers.set(session, ledger)
      }),
      validate: (paths, session) => Effect.gen(function*() {
        const ledger = session === undefined ? undefined : ledgers.get(session)
        for (const path of paths) {
          const target = yield* identity(path)
          const current = yield* fs.readFile(target).pipe(
            Effect.map(digest),
            Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed("absent") : Effect.fail(error)),
            Effect.mapError(() => new StdError({ code: "permission_denied", message: `Permission denied: ${path}`, path }))
          )
          const base = ledger?.get(target) ?? (current === "absent" ? "absent" : "unread")
          if (base !== current) return yield* Effect.fail(new StdError({
            code: "stale_read", path, base_digest: base, current_digest: current,
            message: `stale_read: ${path}; base_digest=${base}; current_digest=${current}. Re-read before retrying`
          }))
        }
        return yield* Effect.fail(new StdError({
          code: "provider_unavailable", message: "Authenticated atomic file mutation provider unavailable"
        }))
      })
    },
    makeDirectory: (path, options) => Effect.gen(function*() {
      // A write's existing parent needs no mutation. Do not create user directories
      // before discovering that the atomic provider is unavailable.
      if (options?.recursive) {
        const info = yield* fs.stat(path)
        if (info.type === "Directory") return
        return yield* refusal("makeDirectory")
      }
      return yield* refusal("makeDirectory")
    }).pipe(Effect.uninterruptible),
    remove: () => refusal("remove"),
    writeFile: () => refusal("writeFile"),
    writeFileString: () => refusal("writeFileString"),
    rename: () => refusal("rename"),
    copyFile: () => refusal("copyFile"),
    copy: () => refusal("copy"),
    open: (path, options) => options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : refusal("open"),
    sink: () => Sink.fail(denied("sink")),
    truncate: () => refusal("truncate"),
    link: () => refusal("link"),
    symlink: () => refusal("symlink"),
    utimes: () => refusal("utimes"),
    chmod: () => refusal("chmod"),
    chown: () => refusal("chown"),
    makeTempDirectory: () => refusal("makeTempDirectory"),
    makeTempDirectoryScoped: () => refusal("makeTempDirectoryScoped"),
    makeTempFile: () => refusal("makeTempFile"),
    makeTempFileScoped: () => refusal("makeTempFileScoped")
  }
}
