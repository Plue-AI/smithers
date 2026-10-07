/** The coding host's one run-scoped std read ledger and atomic provider boundary. */
import { Preconditions, type VersionedFileSystem } from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import { Effect, type FileSystem, PlatformError, Sink } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { NativeOptions } from "./native.ts"

/** Installed authority only. The provider must authenticate the registered run,
 * confine paths, recompare every base and atomically settle the complete batch.
 * A refusal changes no bytes; rollback must preserve outside replacements.
 * The host must never adapt ordered single-file writes to this transaction.
 */
export interface MutationProvider {
  readonly commit: (
    session: string,
    changes: ReadonlyArray<{ readonly path: string; readonly base_digest: string; readonly content: Uint8Array | null }>
  ) => Effect.Effect<void, StdError>
}

const unavailable = () =>
  Effect.fail(
    new StdError({
      code: "provider_unavailable",
      message: "Authenticated atomic file mutation provider unavailable"
    })
  )
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const stale = (path: string, base: string, current: string) =>
  Effect.fail(
    new StdError({
      code: "stale_read",
      path,
      base_digest: base,
      current_digest: current,
      message: `Re-read ${path}`
    })
  )

/** A new filesystem instance has no inherited read authority, including on resume.
 * Only successful model-facing reads record bases. Mutation-internal reads do not.
 */
export const make = (
  options: NativeOptions,
  fs: FileSystem.FileSystem,
  _spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalRoot: string,
  provider?: MutationProvider
): VersionedFileSystem => {
  const root = resolve(options.repositoryPath)
  const pinnedRoot = resolve(canonicalRoot)
  const ledgers = new Map<string, Map<string, string>>()
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    const canonicalSuffix = relative(pinnedRoot, absolute)
    const inside = (value: string) =>
      value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)
    const target = inside(suffix) ? suffix : canonicalSuffix
    if (!inside(target)) return undefined
    return target.split(sep).join("/")
  }
  const authority = (session: string | undefined) =>
    session === undefined || session === "" || provider === undefined ? unavailable() : Effect.succeed(session)
  const current = (path: string) =>
    fs.readFile(path).pipe(
      Effect.map((bytes) => ({ bytes, digest: digest(bytes) })),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed({ bytes: undefined, digest: "absent" })
          : Effect.fail(new StdError({ code: "permission_denied", path, message: `Could not read ${path}` }))
      )
    )
  const prepare: NonNullable<NonNullable<VersionedFileSystem[typeof Preconditions]>["prepare"]> = (paths, session) =>
    Effect.gen(function*() {
      const run = yield* authority(session)
      const bases = new Map<string, { path: string; base: string; bytes: Uint8Array | undefined }>()
      for (const path of paths) {
        const target = key(path)
        if (target === undefined || bases.has(target)) return yield* unavailable()
        const observed = yield* current(path)
        const base = ledgers.get(run)?.get(target) ?? (observed.digest === "absent" ? "absent" : "unread")
        if (base !== observed.digest) return yield* stale(path, base, observed.digest)
        bases.set(target, { path, base, bytes: observed.bytes?.slice() })
      }
      let committed = false
      return {
        read: (path: string) =>
          Effect.suspend(() => {
            const target = key(path)
            const captured = target === undefined ? undefined : bases.get(target)
            if (captured === undefined) return unavailable()
            if (captured.bytes === undefined) {
              return Effect.fail(new StdError({ code: "not_found", path, message: `File not found: ${path}` }))
            }
            return Effect.succeed(captured.bytes.slice())
          }),
        commit: (changes) =>
          Effect.gen(function*() {
            if (committed || changes.length === 0) return yield* unavailable()
            const seen = new Set<string>()
            const request = []
            for (const change of changes) {
              const target = key(change.path)
              const captured = target === undefined ? undefined : bases.get(target)
              if (target === undefined || captured === undefined || seen.has(target)) return yield* unavailable()
              seen.add(target)
              request.push({ path: target, base_digest: captured.base, content: change.content?.slice() ?? null })
            }
            // A provider's interruption/failure can have an unknown outcome. Never
            // reuse this prepared invocation or claim its ledger advanced.
            committed = true
            yield* provider!.commit(run, request)
            let ledger = ledgers.get(run)
            if (ledger === undefined) {
              ledger = new Map()
              ledgers.set(run, ledger)
            }
            for (const change of request) {
              ledger.set(change.path, change.content === null ? "absent" : digest(change.content))
            }
          }).pipe(Effect.uninterruptible)
      }
    })
  const denied = (method: string) =>
    Effect.fail(PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      description: "Coding mutations require an authenticated atomic provider"
    }))
  return {
    ...fs,
    [Preconditions]: {
      record: (path, bytes, session) =>
        Effect.sync(() => {
          const target = key(path)
          if (target === undefined || session === undefined || session === "") return
          let ledger = ledgers.get(session)
          if (ledger === undefined) {
            ledger = new Map()
            ledgers.set(session, ledger)
          }
          ledger.set(target, digest(bytes))
        }),
      validate: (_paths, session) => authority(session).pipe(Effect.asVoid),
      prepare
    },
    writeFile: () => denied("writeFile"),
    writeFileString: () => denied("writeFileString"),
    rename: () => denied("rename"),
    remove: () => denied("remove"),
    copy: () => denied("copy"),
    copyFile: () => denied("copyFile"),
    makeDirectory: () => denied("makeDirectory"),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : denied("open"),
    sink: () =>
      Sink.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "sink" })),
    truncate: () => denied("truncate"),
    link: () => denied("link"),
    symlink: () => denied("symlink"),
    utimes: () => denied("utimes"),
    chmod: () => denied("chmod"),
    chown: () => denied("chown"),
    makeTempDirectory: () => denied("makeTempDirectory"),
    makeTempDirectoryScoped: () => denied("makeTempDirectoryScoped"),
    makeTempFile: () => denied("makeTempFile"),
    makeTempFileScoped: () => denied("makeTempFileScoped")
  }
}
