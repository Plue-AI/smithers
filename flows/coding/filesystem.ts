/** Private coding policy around the existing guarded standard file tools. */
import { Preconditions, type VersionedFileSystem } from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import { Effect, type FileSystem, PlatformError, Sink } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { NativeOptions } from "./native.ts"

const denied = (method: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    description: "Authenticated atomic file mutation provider unavailable"
  })
const refusal = (method: string) => Effect.fail(denied(method))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const unavailable = () =>
  new StdError({
    code: "provider_unavailable",
    message: "Authenticated atomic file mutation provider unavailable"
  })
const invalid = (message: string) => new StdError({ code: "invalid_input", message })
const stale = (path: string, base: string, current: string) =>
  new StdError({
    code: "stale_read",
    path,
    base_digest: base,
    current_digest: current,
    message: `stale_read: ${path}; base_digest=${base}; current_digest=${current}. Re-read before retrying`
  })

/** Operator-only seam for the existing workspace batch API. The implementation
 * must authorize this exact root and logical run at commit time, enforce the
 * run's write permissions, and compare every base under guest-wide exclusion.
 * A host credential or caller-side filesystem lock does not meet this contract.
 * No production provider is composed until the machine/security gates pass.
 */
export interface MutationProvider {
  readonly compareWrite: (request: {
    readonly root: string
    readonly session: string
    readonly changes: ReadonlyArray<{
      readonly path: string
      readonly base_digest: string
      readonly content: Uint8Array | null
    }>
  }) => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly digest: string }>, StdError>
}

/** One policy instance per coding tool host. Recomposition/resume starts with no read bases.
 * No host compare followed by rename can qualify as an atomic mutation provider.
 * Without a qualified authenticated guest/daemon provider, mutations fail closed.
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
  // Entry identity also fences reads racing a commit: settlement must not
  // overwrite a newer model-facing read, even when its bytes happen to match.
  const ledgers = new Map<string, Map<string, { readonly digest: string }>>()
  const inside = (path: string) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    return inside(suffix) ? resolve(pinnedRoot, suffix) : absolute
  }
  const identity = (path: string) =>
    fs.realPath(key(path)).pipe(
      Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(key(path)) : Effect.fail(error)),
      Effect.flatMap((value) =>
        inside(relative(pinnedRoot, value)) && value !== pinnedRoot
          ? Effect.succeed(value) :
          refusal("filePreconditions")
      ),
      Effect.mapError(() => new StdError({ code: "permission_denied", message: `Permission denied: ${path}`, path }))
    )
  const capture = (paths: ReadonlyArray<string>, session: string | undefined) =>
    Effect.gen(function*() {
      const ledger = new Map(session === undefined ? undefined : ledgers.get(session))
      const inputs = [...paths]
      if (inputs.length === 0 || inputs.length > 256 || new Set(inputs).size !== inputs.length) {
        return yield* Effect.fail(invalid("A file mutation requires 1–256 distinct paths"))
      }
      const snapshots = new Map<string, {
        readonly target: string
        readonly relative: string
        readonly base: string
        readonly entry: { readonly digest: string } | undefined
        readonly bytes: Uint8Array | null
      }>()
      for (const path of inputs) {
        if (path.includes("\0") || Buffer.from(path, "utf8").toString("utf8") !== path) {
          return yield* Effect.fail(invalid("Invalid file path encoding"))
        }
        const name = relative(pinnedRoot, key(path)).split(sep).join("/")
        if (
          Buffer.byteLength(name, "utf8") > 4096 ||
          [...snapshots.values()].some((other) =>
            other.relative === name || other.relative.startsWith(`${name}/`) || name.startsWith(`${other.relative}/`)
          )
        ) return yield* Effect.fail(invalid("File mutation paths overlap or exceed the path limit"))
        const target = yield* identity(path)
        // Sending a resolved alias could bypass the permissions on the requested
        // path or change the file a later symlink swap addresses. Refuse aliases.
        if (target !== key(path)) {
          return yield* Effect.fail(
            new StdError({
              code: "permission_denied",
              message: `Symlink mutation refused: ${path}`,
              path
            })
          )
        }
        const bytes = yield* fs.readFile(target).pipe(
          Effect.map((value) => new Uint8Array(value)),
          Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error)),
          Effect.mapError(() =>
            new StdError({ code: "permission_denied", message: `Permission denied: ${path}`, path })
          )
        )
        const current = bytes === null ? "absent" : digest(bytes)
        const entry = ledger.get(target)
        const base = entry?.digest ?? (bytes === null ? "absent" : "unread")
        if (base !== current) return yield* Effect.fail(stale(path, base, current))
        snapshots.set(path, { target, relative: name, base, entry, bytes })
      }
      return snapshots
    })
  return {
    ...fs,
    [Preconditions]: {
      record: (path, bytes, session) =>
        Effect.gen(function*() {
          const target = yield* identity(path)
          if (session === undefined) return
          const ledger = ledgers.get(session) ?? new Map<string, { readonly digest: string }>()
          ledger.set(target, { digest: digest(bytes) })
          ledgers.set(session, ledger)
        }),
      validate: (paths, session) =>
        Effect.gen(function*() {
          yield* capture(paths, session)
          if (provider === undefined || session === undefined || session.length === 0) {
            return yield* Effect.fail(unavailable())
          }
        }),
      prepare: (paths, session) =>
        Effect.gen(function*() {
          const snapshots = yield* capture(paths, session)
          if (provider === undefined || session === undefined || session.length === 0) {
            return yield* Effect.fail(unavailable())
          }
          let attempted = false
          return {
            read: (path) =>
              Effect.suspend(() => {
                const snapshot = snapshots.get(path)
                if (snapshot === undefined) return Effect.fail(invalid("Read is outside the prepared file batch"))
                if (snapshot.bytes === null) {
                  return Effect.fail(
                    new StdError({
                      code: "not_found",
                      message: `File not found: ${path}`,
                      path
                    })
                  )
                }
                return Effect.succeed(new Uint8Array(snapshot.bytes))
              }),
            commit: (changes) =>
              Effect.gen(function*() {
                if (attempted) return yield* Effect.fail(invalid("A prepared file batch can be submitted only once"))
                attempted = true
                if (
                  changes.length !== snapshots.size || new Set(changes.map((change) =>
                      change.path
                    )).size !== changes.length ||
                  changes.some((change) => !snapshots.has(change.path))
                ) {
                  return yield* Effect.fail(invalid("Commit must contain exactly the prepared file paths"))
                }
                if (changes.reduce((size, change) => size + (change.content?.length ?? 0), 0) > 1024 * 1024) {
                  return yield* Effect.fail(invalid("File mutation exceeds the batch byte limit"))
                }
                // Copy before yielding: callers and concurrent reads cannot change
                // submitted content, captured bases, or expected acknowledgments.
                const batch = changes.map((change) => ({
                  path: snapshots.get(change.path)!.relative,
                  base_digest: snapshots.get(change.path)!.base,
                  content: change.content === null ? null : new Uint8Array(change.content)
                }))
                const expected = new Map(
                  batch.map((change) => [change.path, change.content === null ? "absent" : digest(change.content)])
                )
                const receipt = yield* provider.compareWrite({ root: pinnedRoot, session, changes: batch }).pipe(
                  Effect.mapError((error) => {
                    if (error.code !== "stale_read") return error
                    const snapshot = [...snapshots.entries()].find(([, value]) => value.relative === error.path)
                    return snapshot !== undefined && /^(absent|[0-9a-f]{64})$/.test(error.current_digest ?? "")
                      ? stale(snapshot[0], snapshot[1].base, error.current_digest!) :
                      unavailable()
                  })
                )
                if (
                  receipt.length !== expected.size || new Set(receipt.map((entry) =>
                      entry.path
                    )).size !== expected.size ||
                  receipt.some((entry) => !expected.has(entry.path) || expected.get(entry.path) !== entry.digest)
                ) {
                  return yield* Effect.fail(unavailable())
                }
                const ledger = ledgers.get(session) ?? new Map<string, { readonly digest: string }>()
                for (const snapshot of snapshots.values()) {
                  if (ledger.get(snapshot.target) === snapshot.entry) {
                    ledger.set(snapshot.target, { digest: expected.get(snapshot.relative)! })
                  }
                }
                ledgers.set(session, ledger)
              })
          }
        })
    },
    makeDirectory: (path, options) =>
      Effect.gen(function*() {
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
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : refusal("open"),
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
