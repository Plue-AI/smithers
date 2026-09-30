/**
 * Permission-aware filesystem operations.
 *
 * There is no kernel `FileSystem` interface and no kernel `FileSystem` tag.
 * Effect owns both, and its tag fixes the error channel to `PlatformError`, so
 * this module is only the middleware: a `Layer` over Effect's own tag that
 * reads the raw service out of context and returns a guarded one in its place.
 * Permission failures are projected into `PlatformError` by
 * `Permission.toPlatformError`, which keeps the structured kernel failure on
 * the error's `cause`.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 1.0.0-rc.0
 */

import { permissionDenied, type PermissionError, toPlatformError } from "@smthrs/capability/Permission"
import {
  Effect,
  Encoding,
  FileSystem as EffectFileSystem,
  Layer,
  Option,
  Path as EffectPath,
  PlatformError,
  Result,
  Sink,
  Stream
} from "effect"
import * as Batch from "./FileSystemBatch.ts"
import { GrantStore } from "./GrantStore.ts"
import { makeCapability } from "./internal/makeCapability.ts"
import { Workspace } from "./Workspace.ts"

export * from "./FileSystemBatch.ts"

/**
 * The directory name that stands in for the host's system temporary directory
 * in a capability resource. `makeTempFile` and friends called without an
 * explicit `directory` are checked against this name resolved one level above
 * the workspace root, so an implicit system-temp write names a resource that
 * is always outside the workspace envelope and is never confusable with a real
 * workspace path.
 *
 * @since 1.0.0-rc.0
 * @category models
 */
export const systemTemporaryDirectoryName = "<system-temp>"

/**
 * Host-private extension used for race-free, descriptor-relative filesystem
 * operations. A plain path-based `FileSystem` cannot provide confinement: an
 * attacker can replace any checked component before the delegate resolves it.
 * Platform adapters opt in only when they can pin a root handle and reject
 * symlinks while traversing from it. Hosts without this extension fail closed.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export const AtomicFileSystemTypeId = Symbol.for("@smthrs/kernel/AtomicFileSystem")

/** The pinned root every atomic request is resolved against.
 *
 * The guarded layer fills these in at the boundary from the composed
 * workspace, so a caller that builds a request leaves them out.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export interface AtomicRoot {
  readonly boundaryRoot?: string | undefined
  readonly logicalRoot?: string | undefined
  readonly rootIdentity?: string | undefined
}

/** A serializable operation executed relative to a pinned filesystem root.
 *
 * One member per operation, discriminated by `operation`, so a request cannot
 * omit an operand its operation needs — a `rename` carries both endpoints or
 * does not compile — and an adapter cannot quietly leave an operation
 * unimplemented. Every member is the same flat JSON object the helper protocol
 * already framed, so the wire shape is unchanged.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export type AtomicRequest =
  | (AtomicRoot & { readonly operation: "exists"; readonly path: string })
  | (AtomicRoot & { readonly operation: "chmod"; readonly path: string; readonly options: { readonly mode: number } })
  | (AtomicRoot & {
    readonly operation: "chown"
    readonly path: string
    readonly options: { readonly uid: number; readonly gid: number }
  })
  | (AtomicRoot & {
    readonly operation: "glob"
    readonly pattern: string
    readonly root: string
    readonly options?: { readonly exclude?: ReadonlyArray<string> | undefined } | undefined
  })
  | (AtomicRoot & {
    readonly operation: "makeDirectory"
    readonly path: string
    readonly options?: { readonly recursive?: boolean | undefined; readonly mode?: number | undefined } | undefined
  })
  | (AtomicRoot & {
    readonly operation: "readDirectory"
    readonly path: string
    readonly options?: { readonly recursive?: boolean | undefined } | undefined
  })
  | (AtomicRoot & { readonly operation: "readFile"; readonly path: string })
  | (AtomicRoot & {
    readonly operation: "readFileString"
    readonly path: string
    readonly encoding?: string | undefined
  })
  | (AtomicRoot & { readonly operation: "readLink"; readonly path: string })
  | (AtomicRoot & { readonly operation: "realPath"; readonly path: string })
  | (AtomicRoot & { readonly operation: "resolve"; readonly path: string })
  | (AtomicRoot & {
    readonly operation: "remove"
    readonly path: string
    readonly options?: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined } | undefined
  })
  | (AtomicRoot & { readonly operation: "rename"; readonly from: string; readonly to: string })
  | (AtomicRoot & { readonly operation: "stat"; readonly path: string })
  | (AtomicRoot & {
    readonly operation: "writeFile"
    readonly path: string
    /** Base64 of the bytes, bounded by the host's `contentLimit`. */
    readonly data: string
    readonly options?:
      | { readonly flag?: EffectFileSystem.OpenFlag | undefined; readonly mode?: number | undefined }
      | undefined
  })
  | (AtomicRoot & {
    readonly operation: "writeFileString"
    readonly path: string
    readonly data: string
    readonly options?:
      | { readonly flag?: EffectFileSystem.OpenFlag | undefined; readonly mode?: number | undefined }
      | undefined
  })
  | (AtomicRoot & { readonly operation: "batch"; readonly requests: ReadonlyArray<AtomicBatchRequest> })

/** Where a no-follow executor's `resolve` walk stopped.
 *
 * `path` is the canonical path the walk reached below the pinned root, in
 * on-disk spelling for every existing component. When `target` is `null`,
 * `path` is the whole request, with a missing component and its descendants
 * kept as requested. Otherwise `path` names the first link or reparse point
 * on the way and `target` is its text, which the executor read without
 * opening what it names.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export interface Resolution {
  readonly path: string
  readonly target: string | null
}

/** One member of an executor batch: a public read, or authorization's `resolve`.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export type AtomicBatchRequest = Batch.BatchRequest | { readonly operation: "resolve"; readonly path: string }

/** One member's value in an executor batch.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export type AtomicBatchValue = Batch.BatchValue | { readonly operation: "resolve"; readonly resolution: Resolution }

/** An executor batch's answer: {@link Batch.BatchResponse} over {@link AtomicBatchValue}.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export interface AtomicBatchResponse {
  readonly rootIdentity: string
  readonly entries: ReadonlyArray<{
    readonly index: number
    readonly path: string
    readonly result: Result.Result<AtomicBatchValue, PlatformError.PlatformError>
  }>
}

/** The value each atomic operation resolves to.
 *
 * The executor no longer takes the result type from its caller: an operation
 * names its own result here, so a host that answers a `stat` with a boolean is
 * a compile error rather than a decode that succeeds and reads wrong.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export interface AtomicResults {
  readonly exists: boolean
  readonly chmod: void
  readonly chown: void
  readonly glob: Array<string>
  readonly makeDirectory: void
  readonly readDirectory: Array<string>
  readonly readFile: Uint8Array
  readonly readFileString: string
  readonly readLink: string
  readonly realPath: string
  readonly resolve: Resolution
  readonly remove: void
  readonly rename: void
  readonly stat: EffectFileSystem.File.Info
  readonly writeFile: void
  readonly writeFileString: void
  readonly batch: AtomicBatchResponse
}

/** The result of one request, read from the operation it names.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export type AtomicResult<R extends AtomicRequest> = AtomicResults[R["operation"]]

/** One typed implementation per operation.
 *
 * A record of this type receives each operation's own request and returns that
 * operation's own result, and a record missing an operation does not compile,
 * which is the exhaustiveness a `string` operation could not give an adapter.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export type AtomicHandlers = {
  readonly [K in keyof AtomicResults]: (
    request: Extract<AtomicRequest, { readonly operation: K }>
  ) => Effect.Effect<AtomicResults[K], PlatformError.PlatformError>
}

/** Trusted host extension implementing atomic path resolution and operation.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export interface AtomicFileSystem {
  /**
   * The executor refuses symlinks and hard links during every handle-relative
   * operation. Authorization still resolves the on-disk path spelling, but
   * does not need a separate hard-link stat before invoking the executor.
   */
  readonly noFollowAuthorization?: true | undefined
  /** Exact composition-time identity when native file IDs exceed numeric precision. */
  readonly identifyRoot?: ((path: string) => Effect.Effect<string, PlatformError.PlatformError>) | undefined
  readonly execute: <R extends AtomicRequest>(
    request: R
  ) => Effect.Effect<AtomicResult<R>, PlatformError.PlatformError>
  /**
   * A filesystem already confined by an enforceable process/filesystem
   * boundary (for example an in-memory browser volume). Methods not expressible
   * as one descriptor-relative request may delegate only through this surface.
   */
  readonly isolated?: EffectFileSystem.FileSystem | undefined
  /** Advertised only by executors implementing the bounded batch protocol. */
  readonly batchLimits?: { readonly size: number; readonly response: number } | undefined
  /**
   * Advertised byte ceiling for one serialized `writeFile` payload. The kernel
   * refuses a larger payload with a typed `BadArgument` before base64-encoding
   * it, so an executor that frames requests across a serialized host boundary
   * never asks its runtime for a string it cannot represent. Hosts delegating
   * through `isolated` receive the bytes directly and advertise nothing.
   */
  readonly contentLimit?: number | undefined
}

/** An Effect filesystem carrying the atomic host extension.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export type AtomicHostFileSystem = EffectFileSystem.FileSystem & {
  readonly [AtomicFileSystemTypeId]: AtomicFileSystem
}

/** Attaches a trusted platform's descriptor-relative executor to its service.
 *
 * The executor is attached to the supplied object, so a later attachment over
 * the same service replaces this one. A host attaches exactly once at its
 * boundary; a caller that deliberately layers over an existing executor must
 * read it first and delegate to it, which is what makes replacement its own
 * decision rather than an accident.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export const withAtomicFileSystem = (
  fileSystem: EffectFileSystem.FileSystem,
  atomic: AtomicFileSystem
): AtomicHostFileSystem => Object.assign(fileSystem, { [AtomicFileSystemTypeId]: atomic })

/**
 * Attests that a host filesystem is already isolated as a whole. Intended for
 * browser/test volumes whose implementation cannot address the host
 * filesystem at all; native path-based adapters must not use this shortcut.
 *
 * The attestation is refused for a filesystem that already carries a
 * descriptor-relative executor. That executor is the stronger guarantee, and
 * replacing it with a path-delegating one would route `access`, `copy`,
 * `chmod`, `link`, `symlink`, `open`, `watch`, `sink`, `stream`, and every
 * `makeTemp*` back through pathnames after the capability check: the exact
 * symlink-swap window this module exists to close. The refusal is a throw at
 * composition time, so a host cannot be assembled that way.
 *
 * @since 1.0.0-rc.0
 * @category security
 */
export const withIsolatedFileSystem = (
  fileSystem: EffectFileSystem.FileSystem
): AtomicHostFileSystem => {
  if (AtomicFileSystemTypeId in fileSystem) {
    throw new Error(
      "filesystem already carries a descriptor-relative executor; attesting whole-filesystem isolation would replace it"
    )
  }
  return withAtomicFileSystem(fileSystem, {
    isolated: fileSystem,
    execute: dispatch({
      exists: (request) => fileSystem.exists(request.path),
      chmod: (request) => fileSystem.chmod(request.path, request.options.mode),
      chown: (request) => fileSystem.chown(request.path, request.options.uid, request.options.gid),
      glob: (request) => fileSystem.glob(request.pattern, { ...request.options, root: request.root }),
      makeDirectory: (request) => fileSystem.makeDirectory(request.path, request.options),
      readDirectory: (request) => fileSystem.readDirectory(request.path, request.options),
      readFile: (request) => fileSystem.readFile(request.path),
      readFileString: (request) => fileSystem.readFileString(request.path, request.encoding),
      readLink: (request) => fileSystem.readLink(request.path),
      realPath: (request) => fileSystem.realPath(request.path),
      // Authorization asks `resolve` only of an executor that claims
      // `noFollowAuthorization`, which an attested volume never does.
      resolve: (request) => unsupportedIsolated(request.operation),
      remove: (request) => fileSystem.remove(request.path, request.options),
      rename: (request) => fileSystem.rename(request.from, request.to),
      stat: (request) => fileSystem.stat(request.path),
      writeFile: (request) =>
        Encoding.decodeBase64(request.data).pipe(
          Effect.fromResult,
          Effect.orDie,
          Effect.flatMap((data) => fileSystem.writeFile(request.path, data, request.options))
        ),
      writeFileString: (request) => fileSystem.writeFileString(request.path, request.data, request.options),
      // An attested volume advertises no `batchLimits`, so the guarded layer
      // never frames a batch for this executor.
      batch: (request) => unsupportedIsolated(request.operation)
    })
  })
}

const unsupportedIsolated = (operation: string): Effect.Effect<never> =>
  Effect.die(`unsupported isolated filesystem operation: ${operation}`)

/**
 * Turns a typed handler record into the executor the host extension declares.
 *
 * The record is what carries the safety: every operation is implemented, each
 * handler reads its own operands, and each returns its own result. The lookup
 * itself is one assertion because TypeScript cannot correlate an index it
 * narrowed only on the key with the request and result types that key selects.
 * An operation no handler implements can only arrive from a serialized
 * boundary that framed an operation this build does not know, so it dies
 * rather than resolving to `undefined` and being called.
 */
const dispatch = (handlers: AtomicHandlers): AtomicFileSystem["execute"] => {
  const table = handlers as unknown as Record<
    string,
    ((request: AtomicRequest) => Effect.Effect<unknown, PlatformError.PlatformError>) | undefined
  >
  return <R extends AtomicRequest>(request: R) => {
    const handler = table[request.operation]
    return (
      handler === undefined ? unsupportedIsolated(request.operation) : handler(request)
    ) as Effect.Effect<AtomicResult<R>, PlatformError.PlatformError>
  }
}

/** Prefer the host's exact file ID over the public adapter's optional numeric inode. */
const identifyRoot = (
  atomic: AtomicFileSystem,
  fileSystem: EffectFileSystem.FileSystem,
  path: string
): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> =>
  atomic.identifyRoot === undefined
    ? Effect.map(fileSystem.stat(path), (info) => Option.map(info.ino, (ino) => `${info.dev}:${ino}`))
    : Effect.map(atomic.identifyRoot(path), Option.some)

/** The root a descriptor-relative request is resolved against, captured once. */
interface PinnedRoot {
  readonly boundaryRoot: string
  readonly logicalRoot: string
  readonly rootIdentity: string | undefined
}

/**
 * Stamps a request with its pinned root and runs it through the executor. The
 * one place both the guarded layer and {@link confined} build the wire request,
 * so the two surfaces cannot drift apart.
 */
const pinned =
  (atomic: AtomicFileSystem, root: PinnedRoot) =>
  <R extends AtomicRequest>(request: R): Effect.Effect<AtomicResult<R>, PlatformError.PlatformError> =>
    atomic.execute<R>({ ...request, ...root })

const unconfinedDescription = "host does not provide descriptor-relative, no-follow filesystem isolation"

const unconfined = (method: string, pathOrDescriptor: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    description: unconfinedDescription
  })

/**
 * Brands a {@link confined} view with the logical root it is pinned to, so a
 * caller handed an already-confined view does not wrap it a second time.
 */
const ConfinedFileSystemTypeId = Symbol.for("@smthrs/kernel/ConfinedFileSystem")

/**
 * Whether {@link confined} can build a view over this filesystem: it carries a
 * descriptor-relative executor, or a whole-filesystem isolation attestation.
 * A plain path-based host answers `false`.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export const isConfinable = (fileSystem: EffectFileSystem.FileSystem): boolean =>
  ConfinedFileSystemTypeId in fileSystem || AtomicFileSystemTypeId in fileSystem

/**
 * The logical root a filesystem is already confined to: a {@link confined}
 * view's pinned root, or the guarded {@link layer} service's workspace root.
 * `undefined` for any other filesystem, including a host that is merely
 * confinable. Machinery that shares a filesystem with its caller confines to
 * this root, so its paths resolve exactly where the caller's do.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export const confinedRoot = (fileSystem: EffectFileSystem.FileSystem): string | undefined =>
  (fileSystem as { readonly [ConfinedFileSystemTypeId]?: string })[ConfinedFileSystemTypeId]

/**
 * Fails with the typed `PermissionDenied` refusal unless {@link confined} can
 * build a view over this filesystem. Composition-time check for layers that
 * pin their root later, when it is known to exist.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export const requireConfinable = (
  fileSystem: EffectFileSystem.FileSystem,
  root: string
): Effect.Effect<void, PlatformError.PlatformError> =>
  isConfinable(fileSystem) ? Effect.void : Effect.fail(unconfined("confined", root))

/**
 * A filesystem view confined to `root` without capability checks: engine
 * machinery that must not ask a grant store for its own bookkeeping, but must
 * still never be redirected outside the workspace.
 *
 * Every operation is one descriptor-relative request against the root pinned
 * here (its canonical path and `device:inode` identity), resolved by the host
 * helper with `O_NOFOLLOW` at each component, so there is no window between a
 * check and a write for a symlink to be swapped into. A symlink anywhere on the
 * path, a hard-linked file, `..` traversal, or a root whose identity changed is
 * refused by the host, never followed. The requests are exactly the ones the
 * guarded {@link layer} sends, minus the grant check.
 *
 * A host carrying a whole-filesystem isolation attestation
 * ({@link withIsolatedFileSystem}) is returned as it is: its attestation is
 * the boundary. So is the guarded {@link layer}'s own service when it is
 * rooted at the same workspace, since each of its path operations is already
 * one such request. A plain path-based host is refused with `PermissionDenied`, so
 * there is no path-based fallback that claims confinement. Operations that
 * cannot be expressed as one atomic request (`open`, `stream`, `sink`, `copy`,
 * `link`, `symlink`, `watch`, `truncate`, `utimes`, `access`, and every
 * `makeTemp*`) fail with the same refusal.
 *
 * The root must exist when the view is built.
 *
 * @since 1.0.0-rc.1
 * @category security
 */
export const confined = (
  fileSystem: EffectFileSystem.FileSystem,
  root: string
): Effect.Effect<EffectFileSystem.FileSystem, PlatformError.PlatformError, EffectPath.Path> =>
  Effect.gen(function*() {
    const path = yield* EffectPath.Path
    const logicalRoot = path.resolve(root === "" ? "." : root)
    if (confinedRoot(fileSystem) === logicalRoot) return fileSystem
    const atomic = (fileSystem as Partial<AtomicHostFileSystem>)[AtomicFileSystemTypeId]
    if (atomic === undefined) return yield* Effect.fail(unconfined("confined", logicalRoot))
    if (atomic.isolated !== undefined) return fileSystem
    const boundaryRoot = yield* fileSystem.realPath(logicalRoot)
    const rootIdentity = yield* identifyRoot(atomic, fileSystem, boundaryRoot)
    if (Option.isNone(rootIdentity)) return yield* Effect.fail(unconfined("confined", logicalRoot))
    const run = pinned(atomic, { boundaryRoot, logicalRoot, rootIdentity: rootIdentity.value })
    const normalize = (value: string): string => path.resolve(logicalRoot, value)
    const refuse = (method: string, value: string): Effect.Effect<never, PlatformError.PlatformError> =>
      Effect.fail(unconfined(method, normalize(value)))
    const view: EffectFileSystem.FileSystem = {
      ...EffectFileSystem.make({
        access: (value) => refuse("access", value),
        copy: (from) => refuse("copy", from),
        copyFile: (from) => refuse("copyFile", from),
        chmod: (value, mode) => run({ operation: "chmod", path: normalize(value), options: { mode } }),
        chown: (value, uid, gid) => run({ operation: "chown", path: normalize(value), options: { uid, gid } }),
        glob: (pattern, options) => {
          const base = options?.root === undefined ? logicalRoot : normalize(options.root)
          return run({
            operation: "glob",
            pattern: path.resolve(base, pattern),
            root: base,
            options: options === undefined ? undefined : { exclude: options.exclude ?? [] }
          })
        },
        link: (from) => refuse("link", from),
        makeDirectory: (value, options) =>
          run({
            operation: "makeDirectory",
            path: normalize(value),
            options
          }),
        makeTempDirectory: () => refuse("makeTempDirectory", logicalRoot),
        makeTempDirectoryScoped: () => refuse("makeTempDirectoryScoped", logicalRoot),
        makeTempFile: () => refuse("makeTempFile", logicalRoot),
        makeTempFileScoped: () => refuse("makeTempFileScoped", logicalRoot),
        open: (value) => refuse("open", value),
        readDirectory: (value, options) =>
          run({
            operation: "readDirectory",
            path: normalize(value),
            options
          }),
        readFile: (value) => run({ operation: "readFile", path: normalize(value) }),
        readLink: (value) => run({ operation: "readLink", path: normalize(value) }),
        realPath: (value) => run({ operation: "realPath", path: normalize(value) }),
        remove: (value, options) =>
          run({
            operation: "remove",
            path: normalize(value),
            options
          }),
        rename: (from, to) => run({ operation: "rename", from: normalize(from), to: normalize(to) }),
        stat: (value) => run({ operation: "stat", path: normalize(value) }),
        symlink: (_from, to) => refuse("symlink", to),
        truncate: (value) => refuse("truncate", value),
        utimes: (value) => refuse("utimes", value),
        watch: (value) => Stream.fail(unconfined("watch", normalize(value))),
        writeFile: (value, data, options) => {
          const limit = atomic.contentLimit
          if (limit !== undefined && data.byteLength > limit) {
            return Effect.fail(PlatformError.badArgument({
              module: "FileSystem",
              method: "writeFile",
              description:
                `writeFile payload of ${data.byteLength} bytes exceeds the ${limit} byte limit advertised by the host`
            }))
          }
          return run({
            operation: "writeFile",
            path: normalize(value),
            data: Encoding.encodeBase64(data),
            options
          })
        }
      }),
      exists: (value) => run({ operation: "exists", path: normalize(value) }),
      readFileString: (value, encoding) => run({ operation: "readFileString", path: normalize(value), encoding }),
      writeFileString: (value, data, options) =>
        run({
          operation: "writeFileString",
          path: normalize(value),
          data,
          options
        })
    }
    return Object.assign(view, { [ConfinedFileSystemTypeId]: logicalRoot })
  })

const readableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r",
  "r+",
  "w+",
  "wx+",
  "a+",
  "ax+"
])

const writableOpenFlags: ReadonlySet<EffectFileSystem.OpenFlag> = new Set([
  "r+",
  "w",
  "wx",
  "w+",
  "wx+",
  "a",
  "ax",
  "a+",
  "ax+"
])

const isInside = (path: EffectPath.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * The `device:inode` identity a descriptor-bound authorization pins, or
 * `Option.none` when the entry is not a regular file or the host reports no
 * inode identity. A host without inode identity is an isolated volume, and its
 * isolation attestation — not inode evidence — is the confinement boundary.
 */
const identityOf = (info: EffectFileSystem.File.Info): Option.Option<string> =>
  info.type === "File"
    ? Option.map(info.ino, (ino) => `${info.dev}:${ino}`)
    : Option.none()

/**
 * Resolves a path through every existing ancestor and maps paths inside the
 * canonical workspace back to the stable logical workspace root. Existing
 * symlinks therefore cannot turn an inside-workspace grant into outside
 * authority, while capability resources remain stable when the root itself is
 * a symlink. The host's `realPath` must return the on-disk spelling of existing
 * components, including on case-insensitive volumes. Native Node hosts use
 * the promise-based `realpath`, which uses the native implementation.
 *
 * @category security
 * @since 1.0.0-rc.0
 */
export const canonicalResource = (
  fileSystem: EffectFileSystem.FileSystem,
  path: EffectPath.Path,
  workspaceRoot: string,
  value: string
): Effect.Effect<string, PlatformError.PlatformError> => {
  const normalizedRoot = path.normalize(workspaceRoot)
  const normalizedValue = path.normalize(
    path.isAbsolute(value) ? value : path.resolve(normalizedRoot, value)
  )
  const resolveExistingAncestor = (
    candidate: string,
    symlinkDepth = 0
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    fileSystem.realPath(candidate).pipe(
      Effect.catch((error) => {
        const resolveParent = () => {
          const parent = path.dirname(candidate)
          if (parent === candidate) {
            return Effect.fail(error)
          }
          return resolveExistingAncestor(parent, symlinkDepth).pipe(
            Effect.map((resolvedParent) => path.join(resolvedParent, path.basename(candidate)))
          )
        }
        return fileSystem.readLink(candidate).pipe(
          Effect.matchEffect({
            onFailure: resolveParent,
            onSuccess: (target) =>
              symlinkDepth >= 40
                ? Effect.fail(error)
                : resolveExistingAncestor(
                  path.isAbsolute(target) ? target : path.resolve(path.dirname(candidate), target),
                  symlinkDepth + 1
                )
          })
        )
      })
    )

  return Effect.all([
    fileSystem.realPath(normalizedRoot),
    resolveExistingAncestor(normalizedValue)
  ]).pipe(
    Effect.map(([canonicalRoot, canonicalValue]) =>
      isInside(path, canonicalRoot, canonicalValue)
        ? path.normalize(path.join(normalizedRoot, path.relative(canonicalRoot, canonicalValue)))
        : path.normalize(canonicalValue)
    )
  )
}

type PinnedRun = <R extends AtomicRequest>(
  request: R
) => Effect.Effect<AtomicResult<R>, PlatformError.PlatformError>

const uninspectable = "path component could not be inspected without following it"

/** `value` spelled below the pinned boundary root, or `undefined` outside both roots. */
const pinnedPath = (
  path: EffectPath.Path,
  root: Pick<PinnedRoot, "boundaryRoot" | "logicalRoot">,
  value: string
): string | undefined => {
  const base = isInside(path, root.logicalRoot, value)
    ? root.logicalRoot
    : isInside(path, root.boundaryRoot, value)
    ? root.boundaryRoot
    : undefined
  return base === undefined ? undefined : path.join(root.boundaryRoot, path.relative(base, value))
}

const segmentsBelow = (path: EffectPath.Path, root: string, value: string): Array<string> =>
  path.relative(root, value).split(path.sep).filter((segment) => segment !== "")

/**
 * Resolves the resource a no-follow executor addresses without resolving any
 * pathname on the host. Windows `realpath` opens its argument through every
 * link, so asking the host about a planted link to `\\.\pipe\name` or
 * `\\host\share\x` connects to that pipe or share during authorization,
 * and a component swapped for a link between two host checks is followed
 * even when each check alone was safe (#2882).
 *
 * The executor answers one descriptor-relative `resolve` request from the
 * pinned root instead ({@link Resolution}): existing components in their
 * on-disk spelling, a missing component and its descendants as requested, or
 * the first link on the way with its text. Link text is resolved lexically
 * and asked again, and a result outside both roots is returned untouched for
 * the caller to deny. Any failure is refused.
 */
const confinedResource = <E>(
  run: PinnedRun,
  path: EffectPath.Path,
  root: Pick<PinnedRoot, "boundaryRoot" | "logicalRoot">,
  value: string,
  refuse: (resource: string, reason: string) => Effect.Effect<never, E>,
  symlinkDepth = 0
): Effect.Effect<string, E> => {
  const requested = pinnedPath(path, root, value)
  if (requested === undefined) {
    return Effect.succeed(value)
  }
  return run({ operation: "resolve", path: requested }).pipe(
    Effect.matchEffect({
      onFailure: () => refuse(logicalPath(path, root, requested), uninspectable),
      onSuccess: (resolution) => followResolution(run, path, root, requested, resolution, refuse, symlinkDepth)
    })
  )
}

const logicalPath = (
  path: EffectPath.Path,
  root: Pick<PinnedRoot, "boundaryRoot" | "logicalRoot">,
  canonical: string
): string => path.normalize(path.join(root.logicalRoot, path.relative(root.boundaryRoot, canonical)))

/** Turns one executor {@link Resolution} of `requested` into the resource it names. */
const followResolution = <E>(
  run: PinnedRun,
  path: EffectPath.Path,
  root: Pick<PinnedRoot, "boundaryRoot" | "logicalRoot">,
  requested: string,
  resolution: Resolution,
  refuse: (resource: string, reason: string) => Effect.Effect<never, E>,
  symlinkDepth: number
): Effect.Effect<string, E> => {
  const resolved = path.normalize(resolution.path)
  if (!isInside(path, root.boundaryRoot, resolved)) {
    return refuse(logicalPath(path, root, requested), "path resolves outside the pinned root")
  }
  if (resolution.target === null) {
    return Effect.succeed(logicalPath(path, root, resolved))
  }
  if (symlinkDepth >= 40) {
    return refuse(logicalPath(path, root, resolved), "too many levels of symbolic links")
  }
  const rest = segmentsBelow(path, root.boundaryRoot, requested).slice(
    segmentsBelow(path, root.boundaryRoot, resolved).length
  )
  return confinedResource(
    run,
    path,
    root,
    path.resolve(path.dirname(resolved), resolution.target, ...rest),
    refuse,
    symlinkDepth + 1
  )
}

/** A public read's batch value; a `resolve` answer to a read is a host defect and fails closed. */
const publicValue = (
  resource: string,
  result: Result.Result<AtomicBatchValue, PlatformError.PlatformError>
): Result.Result<Batch.BatchValue, PlatformError.PlatformError> =>
  Result.isFailure(result) || result.success.operation !== "resolve"
    ? result as Result.Result<Batch.BatchValue, PlatformError.PlatformError>
    : Result.fail(PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "batch",
      pathOrDescriptor: resource,
      description: "executor answered a batch read with a resolution"
    }))

/**
 * Decorates Effect's filesystem service in place with workspace-normalized
 * capability checks. Every host resolves canonical path spelling before the
 * capability check and again after every grant decision. Descriptor-relative
 * executors enforce hard-link refusal themselves; other hosts also run the
 * hard-link guard here. A decision can
 * suspend (an attended request, a journal-backed store), and an operation
 * whose path no longer names the resource that was authorized is refused
 * rather than performed. Open file handles bind their authorization to the
 * `device:inode` identity fstat'd at open time and refuse any operation once
 * the authorized path names a different resource.
 *
 * The layer provides the tag it also requires: compose it over a host
 * filesystem layer with `Layer.provide` and every consumer of
 * `FileSystem.FileSystem` — including one that never heard of the kernel —
 * resolves the guarded implementation. A denied request surfaces as a
 * `PlatformError` whose reason is `PermissionDenied` and whose `cause` is the
 * kernel's own `PermissionRequired`, `PermissionDenied`, or `GrantStoreError`;
 * `Permission.fromPlatformError` reads it back.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<
  EffectFileSystem.FileSystem,
  PlatformError.PlatformError,
  EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.effect(
  EffectFileSystem.FileSystem,
  Effect.gen(function*() {
    const fileSystem = yield* EffectFileSystem.FileSystem
    const path = yield* EffectPath.Path
    const workspace = yield* Workspace
    const grants = yield* GrantStore
    const atomic = (fileSystem as Partial<AtomicHostFileSystem>)[AtomicFileSystemTypeId]
    const normalizeFrom = (base: string, value: string): string =>
      path.normalize(path.isAbsolute(value) ? value : path.resolve(base, value))
    const logicalRoot = path.normalize(path.resolve(workspace.root))
    const normalize = (value: string): string => normalizeFrom(logicalRoot, value)
    const boundaryRoot = yield* fileSystem.realPath(logicalRoot)
    // Descriptor-relative hosts need the composition-time identity even when
    // they expose no batching. Already-isolated volumes need no native inode.
    const rootIdentity = atomic === undefined || (atomic.isolated !== undefined && atomic.batchLimits === undefined)
      ? Option.none<string>()
      : yield* identifyRoot(atomic, fileSystem, boundaryRoot)
    const root: PinnedRoot = { boundaryRoot, logicalRoot, rootIdentity: Option.getOrUndefined(rootIdentity) }
    const refuse = (method: string, resource: string) => (error: PermissionError): PlatformError.PlatformError =>
      toPlatformError({ module: "FileSystem", method, pathOrDescriptor: resource, error })
    const deny = (action: "fs:read" | "fs:write", method: string, resource: string, reason: string) =>
      makeCapability(action, resource).pipe(
        Effect.flatMap((capability) => Effect.fail(permissionDenied(capability, reason))),
        Effect.mapError(refuse(method, resource))
      )
    const insideWorkspace = (action: "fs:read" | "fs:write", method: string) => (resource: string) =>
      isInside(path, logicalRoot, resource)
        ? Effect.succeed(resource)
        : deny(action, method, resource, "path is outside the workspace")
    /**
     * Resolves the on-disk resource spelling even for no-follow executors:
     * a differently cased name can address the same file. No-follow executors
     * resolve through {@link confinedResource}, one executor request that
     * reads link text instead of following links. `guard` runs it twice — once
     * before the grant decision and once after — so the resolution must be a
     * pure question about the current filesystem state.
     */
    const resolvedResource = (
      action: "fs:read" | "fs:write",
      method: string,
      value: string
    ): Effect.Effect<string, PlatformError.PlatformError> => {
      const normalized = normalize(value)
      if (atomic?.noFollowAuthorization === true) {
        return confinedResource(
          pinned(atomic, root),
          path,
          root,
          normalized,
          (resource, reason) => deny(action, method, resource, reason)
        ).pipe(Effect.flatMap(insideWorkspace(action, method)))
      }
      return canonicalResource(fileSystem, path, logicalRoot, normalized).pipe(
        Effect.flatMap((resource) =>
          fileSystem.stat(normalized).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(resource),
              onSuccess: (info) => {
                const hardLinked = info.type === "File" && Option.isSome(info.nlink) && info.nlink.value > 1
                return hardLinked
                  ? deny(action, method, resource, "hard-linked files cannot be confined to the workspace")
                  : Effect.succeed(resource)
              }
            })
          )
        )
      )
    }
    /**
     * Resolves every read of one batch. A no-follow executor that batches
     * answers all of them in one `resolve` batch, so authorizing a batch
     * costs one executor request rather than one per member; only a member
     * that meets a link asks again, for its target. Other hosts resolve each
     * member with bounded concurrency.
     */
    const resolvedResources = (
      values: ReadonlyArray<string>
    ): Effect.Effect<Array<Result.Result<string, PlatformError.PlatformError>>, PlatformError.PlatformError> => {
      const refuseRead = (resource: string, reason: string) => deny("fs:read", "read", resource, reason)
      if (atomic?.noFollowAuthorization !== true || atomic.batchLimits === undefined) {
        return Effect.forEach(values, (value) => Effect.result(resolvedResource("fs:read", "read", value)), {
          concurrency: Batch.fallbackConcurrency
        })
      }
      const run = pinned(atomic, root)
      const requested = values.map((value) => pinnedPath(path, root, normalize(value)))
      const members: Array<{ readonly operation: "resolve"; readonly path: string }> = []
      const memberOf = requested.map((value) =>
        value === undefined ? undefined : members.push({ operation: "resolve", path: value }) - 1
      )
      const answered = members.length === 0
        ? Effect.succeed<AtomicBatchResponse["entries"]>([])
        : Effect.map(run({ operation: "batch", requests: members }), (response) => response.entries)
      return Effect.flatMap(answered, (entries) => {
        const results = new Map(entries.map((entry) => [entry.index, entry.result] as const))
        return Effect.forEach(values, (value, index) => {
          const member = memberOf[index]
          const resource = member === undefined
            ? Effect.succeed(normalize(value))
            : Effect.suspend(() => {
              const pinnedValue = members[member]!.path
              const result = results.get(member)
              // The executor's batch framing already requires one entry per
              // member; an answer of another shape is refused, not guessed.
              return result === undefined || Result.isFailure(result) || result.success.operation !== "resolve"
                ? refuseRead(logicalPath(path, root, pinnedValue), uninspectable)
                : followResolution(run, path, root, pinnedValue, result.success.resolution, refuseRead, 0)
            })
          return Effect.result(Effect.flatMap(resource, insideWorkspace("fs:read", "read")))
        }, { concurrency: Batch.fallbackConcurrency })
      })
    }
    const guard = (
      action: "fs:read" | "fs:write",
      value: string
    ): Effect.Effect<void, PlatformError.PlatformError> => {
      const method = action === "fs:read" ? "read" : "write"
      return resolvedResource(action, method, value).pipe(
        Effect.flatMap((resource) =>
          makeCapability(action, resource).pipe(
            Effect.flatMap((capability) => grants.check(capability)),
            Effect.mapError(refuse(method, resource)),
            // The grant decision can suspend — an attended request waiting for
            // a human, a journal-backed store doing IO. What was authorized is
            // the resource the path named at check time, so the path must
            // still name it when the decision arrives: a symlink or rename
            // swapped in during the wait is refused, never followed.
            Effect.andThen(resolvedResource(action, method, value)),
            Effect.flatMap((settled) =>
              settled === resource
                ? Effect.void
                : deny(action, method, resource, "path no longer names the resource that was authorized")
            )
          )
        )
      )
    }
    const read = (value: string) => guard("fs:read", value)
    const write = (value: string) => guard("fs:write", value)
    const atomicUnavailable = (
      action: "fs:read" | "fs:write",
      value: string,
      method: string
    ): Effect.Effect<never, PlatformError.PlatformError> =>
      deny(
        action,
        method,
        normalize(value),
        unconfinedDescription
      )
    const atomicOne = <R extends AtomicRequest>(
      action: "fs:read" | "fs:write",
      value: string,
      method: string,
      request: R
    ): Effect.Effect<AtomicResult<R>, PlatformError.PlatformError> =>
      atomic === undefined
        ? atomicUnavailable(action, value, method)
        : guard(action, value).pipe(Effect.andThen(pinned(atomic, root)(request)))
    const atomicTwo = <R extends AtomicRequest>(
      first: readonly ["fs:read" | "fs:write", string],
      second: readonly ["fs:read" | "fs:write", string],
      method: string,
      request: R
    ): Effect.Effect<AtomicResult<R>, PlatformError.PlatformError> =>
      atomic === undefined
        ? atomicUnavailable(first[0], first[1], method)
        : guard(first[0], first[1]).pipe(
          Effect.andThen(guard(second[0], second[1])),
          Effect.andThen(pinned(atomic, root)(request))
        )
    const isolatedOne = <A>(
      action: "fs:read" | "fs:write",
      value: string,
      method: string,
      use: (isolated: EffectFileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic?.isolated === undefined
        ? atomicUnavailable(action, value, method)
        : guard(action, value).pipe(Effect.andThen(use(atomic.isolated)))
    const isolatedTwo = <A>(
      first: readonly ["fs:read" | "fs:write", string],
      second: readonly ["fs:read" | "fs:write", string],
      method: string,
      use: (isolated: EffectFileSystem.FileSystem) => Effect.Effect<A, PlatformError.PlatformError>
    ): Effect.Effect<A, PlatformError.PlatformError> =>
      atomic?.isolated === undefined
        ? atomicUnavailable(first[0], first[1], method)
        : guard(first[0], first[1]).pipe(
          Effect.andThen(guard(second[0], second[1])),
          Effect.andThen(use(atomic.isolated))
        )
    const temp = (directory: string | undefined) =>
      directory === undefined
        ? write(path.resolve(workspace.root, "..", systemTemporaryDirectoryName))
        : write(directory)
    const snapshotOptions = <T>(value: T): T => {
      if (Array.isArray(value)) return Object.freeze(value.map(snapshotOptions)) as T
      if (typeof value !== "object" || value === null) return value
      const snapshot: Record<string, unknown> = {}
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        if (!("value" in descriptor)) throw new TypeError("filesystem options must contain only data properties")
        snapshot[name] = snapshotOptions(descriptor.value)
      }
      return Object.freeze(snapshot) as T
    }
    const normalizeTempOptions = <T extends { readonly directory?: string | undefined }>(options: T | undefined) =>
      options?.directory === undefined ? options : { ...options, directory: normalize(options.directory) }
    const openChecks = (value: string, flag: EffectFileSystem.OpenFlag) => {
      const readable = readableOpenFlags.has(flag)
      const writable = writableOpenFlags.has(flag)
      return readable && writable ?
        read(value).pipe(Effect.andThen(write(value))) :
        writable ?
        write(value) :
        read(value)
    }
    const descriptorRefusal = (action: "fs:read" | "fs:write", value: string) =>
      deny(
        action,
        action === "fs:read" ? "read" : "write",
        normalize(value),
        "descriptor no longer names the resource at its authorized path"
      )
    /**
     * Confirms an open descriptor still names the resource its authorization
     * bound: the `device:inode` identity fstat'd at open time must be what the
     * authorized path names right now. Rechecking the pathname alone would
     * re-authorize the CURRENT occupant of the path and then delegate to the
     * OLD descriptor — after a rename that descriptor can name an inode
     * outside the workspace even though the replacement path is still allowed.
     * A host that reports no inode identity is an isolated volume whose
     * attestation is the boundary; there is no descriptor evidence to verify.
     */
    const verifyDescriptor = (
      host: EffectFileSystem.FileSystem,
      action: "fs:read" | "fs:write",
      value: string,
      identity: Option.Option<string>
    ): Effect.Effect<void, PlatformError.PlatformError> =>
      Option.match(identity, {
        onNone: () => Effect.void,
        onSome: (bound) =>
          host.stat(normalize(value)).pipe(
            Effect.matchEffect({
              onFailure: () => descriptorRefusal(action, value),
              onSuccess: (info) =>
                Option.match(identityOf(info), {
                  onNone: () => descriptorRefusal(action, value),
                  onSome: (current) => current === bound ? Effect.void : descriptorRefusal(action, value)
                })
            })
          )
      })
    const wrapFile = (
      host: EffectFileSystem.FileSystem,
      file: EffectFileSystem.File,
      value: string,
      identity: Option.Option<string>
    ): EffectFileSystem.File => {
      const readable = Effect.suspend(() =>
        read(value).pipe(Effect.andThen(verifyDescriptor(host, "fs:read", value, identity)))
      )
      const writable = Effect.suspend(() =>
        write(value).pipe(Effect.andThen(verifyDescriptor(host, "fs:write", value, identity)))
      )
      return {
        [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
        stat: Effect.fn("FileSystem.File.stat")(() => readable.pipe(Effect.andThen(file.stat)))(),
        seek: Effect.fn("FileSystem.File.seek")(file.seek),
        sync: Effect.fn("FileSystem.File.sync")(() => writable.pipe(Effect.andThen(file.sync)))(),
        read: Effect.fn("FileSystem.File.read")((buffer) => readable.pipe(Effect.andThen(file.read(buffer)))),
        readAlloc: Effect.fn("FileSystem.File.readAlloc")((size) =>
          readable.pipe(Effect.andThen(file.readAlloc(size)))
        ),
        truncate: Effect.fn("FileSystem.File.truncate")((length) =>
          writable.pipe(Effect.andThen(file.truncate(length)))
        ),
        write: Effect.fn("FileSystem.File.write")((buffer) => writable.pipe(Effect.andThen(file.write(buffer)))),
        writeAll: Effect.fn("FileSystem.File.writeAll")((buffer) =>
          writable.pipe(Effect.andThen(file.writeAll(buffer)))
        )
      }
    }
    // `EffectFileSystem.make` brands the implementation with Effect's own
    // (non-exported) type id. The five operations `make` would derive from
    // the primitives are overridden below with guarded delegates to the host
    // implementation, so delegation semantics do not change.
    const guarded: EffectFileSystem.FileSystem = {
      ...EffectFileSystem.make({
        access: Effect.fn("FileSystem.access")((value, options) => {
          const captured = snapshotOptions(options)
          return isolatedOne("fs:read", value, "access", (host) => host.access(normalize(value), captured))
        }),
        copy: Effect.fn("FileSystem.copy")((from, to, options) => {
          const captured = snapshotOptions(options)
          return (
            isolatedTwo(
              ["fs:read", from],
              ["fs:write", to],
              "copy",
              (host) => host.copy(normalize(from), normalize(to), captured)
            )
          )
        }),
        copyFile: Effect.fn("FileSystem.copyFile")((from, to) =>
          isolatedTwo(
            ["fs:read", from],
            ["fs:write", to],
            "copyFile",
            (host) => host.copyFile(normalize(from), normalize(to))
          )
        ),
        chmod: Effect.fn("FileSystem.chmod")((value, mode) =>
          atomicOne("fs:write", value, "chmod", { operation: "chmod", path: normalize(value), options: { mode } })
        ),
        chown: Effect.fn("FileSystem.chown")((value, uid, gid) =>
          atomicOne("fs:write", value, "chown", {
            operation: "chown",
            path: normalize(value),
            options: { uid, gid }
          })
        ),
        glob: Effect.fn("FileSystem.glob")((pattern, options) => {
          const captured = snapshotOptions(options)
          const root = captured?.root === undefined ? workspace.root : normalize(captured.root)
          const normalizedPattern = normalizeFrom(root, pattern)
          return atomicOne("fs:read", normalizedPattern, "glob", {
            operation: "glob",
            pattern: normalizedPattern,
            root,
            options: captured === undefined ? undefined : { exclude: captured.exclude ?? [] }
          })
        }),
        link: Effect.fn("FileSystem.link")((from, to) =>
          isolatedTwo(["fs:read", from], ["fs:write", to], "link", (host) => host.link(normalize(from), normalize(to)))
        ),
        makeDirectory: Effect.fn("FileSystem.makeDirectory")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne("fs:write", value, "makeDirectory", {
            operation: "makeDirectory",
            path: normalize(value),
            options: captured
          })
        }),
        makeTempDirectory: Effect.fn("FileSystem.makeTempDirectory")((options) => {
          const captured = snapshotOptions(options)
          return (
            atomic?.isolated === undefined
              ? atomicUnavailable(
                "fs:write",
                captured?.directory ?? `../${systemTemporaryDirectoryName}`,
                "makeTempDirectory"
              )
              : temp(captured?.directory).pipe(
                Effect.andThen(atomic.isolated.makeTempDirectory(normalizeTempOptions(captured)))
              )
          )
        }),
        makeTempDirectoryScoped: Effect.fn("FileSystem.makeTempDirectoryScoped")((options) => {
          const captured = snapshotOptions(options)
          return (
            atomic?.isolated === undefined
              ? atomicUnavailable(
                "fs:write",
                captured?.directory ?? `../${systemTemporaryDirectoryName}`,
                "makeTempDirectoryScoped"
              )
              : temp(captured?.directory).pipe(
                Effect.andThen(atomic.isolated.makeTempDirectoryScoped(normalizeTempOptions(captured)))
              )
          )
        }),
        makeTempFile: Effect.fn("FileSystem.makeTempFile")((options) => {
          const captured = snapshotOptions(options)
          return (
            atomic?.isolated === undefined
              ? atomicUnavailable(
                "fs:write",
                captured?.directory ?? `../${systemTemporaryDirectoryName}`,
                "makeTempFile"
              )
              : temp(captured?.directory).pipe(
                Effect.andThen(atomic.isolated.makeTempFile(normalizeTempOptions(captured)))
              )
          )
        }),
        makeTempFileScoped: Effect.fn("FileSystem.makeTempFileScoped")((options) => {
          const captured = snapshotOptions(options)
          return (
            atomic?.isolated === undefined
              ? atomicUnavailable(
                "fs:write",
                captured?.directory ?? `../${systemTemporaryDirectoryName}`,
                "makeTempFileScoped"
              )
              : temp(captured?.directory).pipe(
                Effect.andThen(atomic.isolated.makeTempFileScoped(normalizeTempOptions(captured)))
              )
          )
        }),
        open: Effect.fn("FileSystem.open")((value, options) => {
          const captured = snapshotOptions(options)
          const flag = captured?.flag ?? "r"
          const isolated = atomic?.isolated
          return isolated === undefined
            ? atomicUnavailable("fs:read", value, "open")
            : openChecks(value, flag).pipe(
              Effect.andThen(isolated.open(normalize(value), captured)),
              // fstat the handle the moment it exists: the authorization the
              // open checks granted binds to THIS resource identity, and every
              // later handle operation verifies the authorized path still
              // names it before delegating to the descriptor.
              Effect.flatMap((file) =>
                file.stat.pipe(
                  Effect.map((info) => wrapFile(isolated, file, value, identityOf(info)))
                )
              )
            )
        }),
        readDirectory: Effect.fn("FileSystem.readDirectory")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne("fs:read", value, "readDirectory", {
            operation: "readDirectory",
            path: normalize(value),
            options: captured
          })
        }),
        readFile: Effect.fn("FileSystem.readFile")((value) =>
          atomicOne("fs:read", value, "readFile", {
            operation: "readFile",
            path: normalize(value)
          })
        ),
        readLink: Effect.fn("FileSystem.readLink")((value) =>
          atomicOne("fs:read", value, "readLink", {
            operation: "readLink",
            path: normalize(value)
          })
        ),
        realPath: Effect.fn("FileSystem.realPath")((value) =>
          atomicOne("fs:read", value, "realPath", {
            operation: "realPath",
            path: normalize(value)
          })
        ),
        remove: Effect.fn("FileSystem.remove")((value, options) => {
          const captured = snapshotOptions(options)
          return atomicOne("fs:write", value, "remove", {
            operation: "remove",
            path: normalize(value),
            options: captured
          })
        }),
        rename: Effect.fn("FileSystem.rename")((from, to) =>
          atomicTwo(["fs:write", from], ["fs:write", to], "rename", {
            operation: "rename",
            from: normalize(from),
            to: normalize(to)
          })
        ),
        stat: Effect.fn("FileSystem.stat")((value) =>
          atomicOne("fs:read", value, "stat", {
            operation: "stat",
            path: normalize(value)
          })
        ),
        symlink: Effect.fn("FileSystem.symlink")((from, to) =>
          isolatedOne("fs:write", to, "symlink", (host) => host.symlink(from, normalize(to)))
        ),
        truncate: Effect.fn("FileSystem.truncate")((value, length) =>
          isolatedOne("fs:write", value, "truncate", (host) => host.truncate(normalize(value), length))
        ),
        utimes: Effect.fn("FileSystem.utimes")((value, atime, mtime) =>
          isolatedOne("fs:write", value, "utimes", (host) => host.utimes(normalize(value), atime, mtime))
        ),
        watch: (value) =>
          Stream.unwrap(
            Effect.fn("FileSystem.watch")(() =>
              Effect.suspend(() =>
                atomic?.isolated === undefined
                  ? atomicUnavailable("fs:read", value, "watch")
                  : read(value).pipe(Effect.map(() => atomic.isolated!.watch(normalize(value))))
              )
            )()
          ),
        writeFile: Effect.fn("FileSystem.writeFile")((value, data, options) => {
          const captured = snapshotOptions(options)
          const bytes = data.slice()
          // An isolated host shares this address space, so the detached
          // snapshot crosses no serialization boundary: hand it straight to
          // the delegate rather than base64 round-tripping it through the
          // serializable request shape.
          if (atomic?.isolated !== undefined) {
            return isolatedOne(
              "fs:write",
              value,
              "writeFile",
              (host) => host.writeFile(normalize(value), bytes, captured)
            )
          }
          // A serialized executor frames the base64 payload as one JS string.
          // Refuse what its runtime cannot represent before encoding, so an
          // oversized artifact is a typed BadArgument and not a defect out of
          // the encoder.
          const limit = atomic?.contentLimit
          if (limit !== undefined && bytes.byteLength > limit) {
            return Effect.fail(PlatformError.badArgument({
              module: "FileSystem",
              method: "writeFile",
              description:
                `writeFile payload of ${bytes.byteLength} bytes exceeds the ${limit} byte limit advertised by the host`
            }))
          }
          return atomicOne("fs:write", value, "writeFile", {
            operation: "writeFile",
            path: normalize(value),
            data: Encoding.encodeBase64(bytes),
            options: captured
          })
        })
      }),
      exists: Effect.fn("FileSystem.exists")((value) =>
        atomicOne("fs:read", value, "exists", {
          operation: "exists",
          path: normalize(value)
        })
      ),
      readFileString: Effect.fn("FileSystem.readFileString")((value, encoding) =>
        atomicOne("fs:read", value, "readFileString", {
          operation: "readFileString",
          path: normalize(value),
          encoding
        })
      ),
      sink: (value, options) => {
        const captured = snapshotOptions(options)
        return (
          Sink.unwrap(
            Effect.fn("FileSystem.sink")(
              () =>
                Effect.suspend(() =>
                  atomic?.isolated === undefined
                    ? atomicUnavailable("fs:write", value, "sink")
                    : write(value).pipe(Effect.map(() => atomic.isolated!.sink(normalize(value), captured)))
                )
            )()
          )
        )
      },
      stream: (value, options) => {
        const captured = snapshotOptions(options)
        return (
          Stream.unwrap(
            Effect.fn("FileSystem.stream")(() =>
              Effect.suspend(() =>
                atomic?.isolated === undefined
                  ? atomicUnavailable("fs:read", value, "stream")
                  : read(value).pipe(Effect.map(() => atomic.isolated!.stream(normalize(value), captured)))
              )
            )()
          )
        )
      },
      writeFileString: Effect.fn("FileSystem.writeFileString")((value, data, options) => {
        const captured = snapshotOptions(options)
        return atomicOne("fs:write", value, "writeFileString", {
          operation: "writeFileString",
          path: normalize(value),
          data,
          options: captured
        })
      })
    }
    // Every path operation of the guarded surface is already one
    // descriptor-relative request against this root (or refuses), so machinery
    // composed over it may use it as its confined view.
    Object.assign(guarded, { [ConfinedFileSystemTypeId]: logicalRoot })
    if (atomic === undefined || atomic.batchLimits === undefined) {
      return guarded
    } else {
      const limits = atomic.batchLimits
      const executeBatch: Batch.FileSystemBatch["execute"] = Effect.fn("FileSystem.batch")(function*(requests) {
        if (requests.length === 0 || requests.length > Math.min(limits.size, Batch.maxBatchSize)) {
          return yield* Effect.fail(
            PlatformError.badArgument({
              module: "FileSystem",
              method: "batch",
              description: `batch must contain 1 to ${Math.min(limits.size, Batch.maxBatchSize)} operations`
            })
          )
        }
        if (Option.isNone(rootIdentity)) {
          return yield* atomicUnavailable("fs:read", logicalRoot, "batch")
        }
        // Snapshot before any asynchronous root or permission checks.
        const captured = snapshotOptions(requests).map((request) => ({
          ...request,
          path: request.operation === "glob"
            ? normalizeFrom(normalize(request.root), request.path)
            : normalize(request.path),
          ...(request.operation === "glob" ? { root: normalize(request.root) } : {})
        }))
        const rootChanged = (cause: unknown) =>
          PlatformError.systemError({
            _tag: "Busy",
            module: "FileSystem",
            method: "batch",
            pathOrDescriptor: logicalRoot,
            description: "batch root no longer names the authorized descriptor",
            cause
          })
        // A vanished workspace is a lost boundary, not N absent files. Check
        // before canonical resource resolution could turn it into per-path
        // NotFound results. Check the logical path as well: a workspace alias
        // may be retargeted while its old canonical directory still exists.
        // The helper separately checks the canonical root through no-follow
        // handles, binding both names to the same captured descriptor.
        const expectedRoot = rootIdentity.value
        const verifyRoot = () =>
          identifyRoot(atomic, fileSystem, logicalRoot).pipe(
            Effect.mapError(rootChanged),
            Effect.flatMap((current) =>
              Option.isSome(current) && current.value === expectedRoot
                ? Effect.void
                : Effect.fail(rootChanged(new Error("workspace descriptor identity changed")))
            )
          )
        yield* verifyRoot()
        // Resolve in bounded groups while retaining request-order grant
        // decisions. Quota/once grants therefore retain their ordering, and
        // native metadata latency need not serialize every member twice.
        const resources = yield* resolvedResources(captured.map((request) => request.path))
        const admitted: Array<Batch.BatchRequest> = []
        const indexes: Array<number> = []
        const entries: Array<Batch.BatchEntry> = []
        const granted: Array<
          { readonly request: Batch.BatchRequest; readonly index: number; readonly resource: string }
        > = []
        for (const [index, request] of captured.entries()) {
          const resource = resources[index]!
          const checked = Result.isFailure(resource) ? Result.fail(resource.failure) : yield* Effect.result(
            makeCapability("fs:read", resource.success).pipe(
              Effect.flatMap((capability) => grants.check(capability)),
              Effect.mapError(refuse("read", resource.success))
            )
          )
          if (Result.isFailure(checked)) {
            entries.push({ index, path: request.path, result: Result.fail(checked.failure) })
          } else granted.push({ request, index, resource: Result.getOrThrow(resource) })
        }
        const current = granted.length === 0
          ? []
          : yield* resolvedResources(granted.map(({ request }) => request.path))
        const settled = yield* Effect.forEach(granted, ({ resource }, position) => {
          const now = current[position]!
          return Effect.result(
            Result.isFailure(now)
              ? Effect.fail(now.failure)
              : now.success === resource
              ? Effect.void
              : deny("fs:read", "read", resource, "path no longer names the resource that was authorized")
          )
        })
        for (const [position, member] of granted.entries()) {
          const checked = settled[position]!
          if (Result.isFailure(checked)) {
            entries.push({ index: member.index, path: member.request.path, result: Result.fail(checked.failure) })
          } else {
            admitted.push(member.request)
            indexes.push(member.index)
          }
        }
        yield* verifyRoot()
        if (admitted.length > 0) {
          const measured = yield* atomic.execute({
            operation: "batch",
            boundaryRoot,
            logicalRoot,
            rootIdentity: rootIdentity.value,
            requests: admitted
          })
          for (const entry of measured.entries) {
            entries.push({
              index: indexes[entry.index]!,
              path: entry.path,
              result: publicValue(entry.path, entry.result)
            })
          }
        }
        entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index)
        return { rootIdentity: rootIdentity.value, entries }
      })
      return Object.assign(guarded, {
        [Batch.FileSystemBatchTypeId]: {
          maxSize: Math.min(limits.size, Batch.maxBatchSize),
          maxResponseBytes: limits.response,
          execute: executeBatch
        }
      })
    }
  })
)
