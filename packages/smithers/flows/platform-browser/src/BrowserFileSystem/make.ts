/**
 * Constructs a `FileSystem` over a ZenFS-shaped backend.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import { fileInfo } from "./fileInfo.ts"
import { platformError } from "./platformError.ts"
import { readDirectory } from "./readDirectory.ts"
import { realPath } from "./realPath.ts"
import { streamFile } from "./streamFile.ts"
import type { ZenFsPromisesLike } from "./ZenFsPromisesLike.ts"

/**
 * A private copy of a byte buffer.
 *
 * Bytes cross the backend boundary by value. A backend may hold the buffer it
 * was handed across its own asynchronous commit, and it may answer `readFile`
 * with the array it stores, so the adapter copies in both directions rather
 * than trusting the backend to. `new Uint8Array` rather than `slice`: Node's
 * `Buffer` overrides `slice` to return a view over the same memory.
 *
 * @private
 */
const snapshot = (bytes: Uint8Array): Uint8Array => new Uint8Array(bytes)

/**
 * Reads a whole file as bytes through the backend. The bytes are the
 * backend's own; a caller that keeps them takes a {@link snapshot} first.
 *
 * @private
 */
const readBytes = (fs: ZenFsPromisesLike, path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => fs.readFile(path), catch: platformError("readFile", path) })

/**
 * Writes bytes this adapter already owns, so nothing outside it can change
 * them before the backend reads them.
 *
 * `flag` is forwarded rather than dropped: both ZenFS and `node:fs/promises`
 * honour it, and silently turning an `"a"` into a truncating write would lose
 * the caller's data. `"wx"` surfaces as `EEXIST`, which {@link platformError}
 * already normalizes to `AlreadyExists`. Both options arrive as values rather
 * than as the caller's options object, so the effect describes the write the
 * caller asked for when it called, whatever that object holds when it runs.
 *
 * @private
 */
const writeBytes = (
  fs: ZenFsPromisesLike,
  path: string,
  data: Uint8Array,
  flag: string | undefined,
  mode: number | undefined
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(path, data, {
        ...(flag === undefined ? {} : { flag }),
        ...(mode === undefined ? {} : { mode })
      }),
    catch: platformError("writeFile", path)
  }).pipe(Effect.uninterruptible)

/**
 * Encodes a string and writes it. A string cannot change under the caller,
 * and the encoder allocates, so the bytes need no further copy.
 *
 * @private
 */
const writeText = (
  fs: ZenFsPromisesLike,
  path: string,
  text: string,
  flag: string | undefined,
  mode: number | undefined
): Effect.Effect<void, PlatformError.PlatformError> =>
  Effect.flatMap(
    Effect.try({
      try: () => new TextEncoder().encode(text),
      catch: (cause) =>
        PlatformError.badArgument({
          module: "FileSystem",
          method: "writeFileString",
          description: "could not encode string",
          cause
        })
    }),
    (bytes) => writeBytes(fs, path, bytes, flag, mode)
  )

/**
 * The refusal every deliberately unsupported operation answers with.
 *
 * `FileSystem.makeNoop` fails most unimplemented operations with `NotFound`
 * but hardcodes the `makeTemp*` family to a defect, so the documented
 * typed refusal for those four has to be wired explicitly.
 *
 * @private
 */
const unsupportedError = (method: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    description: `the browser backend does not support ${method}`,
    pathOrDescriptor: method
  })

const unsupported = (method: string): Effect.Effect<never, PlatformError.PlatformError> =>
  Effect.fail(unsupportedError(method))

/**
 * The permission bits `access` checks a stats `mode` against.
 *
 * A mounted volume has no user identity to check a request against, so the
 * reported `mode` is the whole answer: a path is readable when any read bit
 * is set and writable when any write bit is set. That is stricter than
 * dropping the option, which reports a read-only file as writable.
 *
 * @private
 */
const permitted = (
  mode: number,
  options: { readonly readable?: boolean | undefined; readonly writable?: boolean | undefined }
): boolean =>
  (options.readable !== true || (mode & 0o444) !== 0) &&
  (options.writable !== true || (mode & 0o222) !== 0)

/**
 * The refusal `access` answers with when the path exists but not with the
 * permission the caller asked about.
 *
 * @private
 */
const denied = (path: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: path,
    description: "the path does not carry the requested permission"
  })

/**
 * Constructs a `FileSystem` over a ZenFS-shaped backend.
 *
 * Unsupported operations fail with `PermissionDenied` naming the operation,
 * so callers cannot mistake a host limitation for an absent file. Publication
 * uses the backend's rename and timestamp operations when available.
 * Reads use bounded file-handle chunks rather than loading the whole file.
 *
 * The operations that *are* served honour their options rather than dropping
 * them: `readDirectory` walks the tree for `recursive`, `access` answers
 * `readable`/`writable` from the reported mode, `makeDirectory` forwards
 * `mode`, `realPath` canonicalizes, `writeFile` forwards `flag` and `mode`,
 * and `exists` reports `false` only for a path that is absent, propagating
 * every other backend failure the way effect's own derivation does.
 *
 * Bytes and names cross the backend boundary by value. `writeFile` copies
 * `data` and reads `flag` and `mode` when it is called, so the effect it
 * returns describes one write however the caller's buffer or options change
 * before it runs or between retries, and however long the backend holds the
 * bytes it was handed. `readFile` and `readDirectory` return a buffer and an
 * array the caller owns, so a backend that answers from its own storage can
 * neither be corrupted through a result nor change one already returned.
 *
 * Mutations defer interruption until the backend promise settles, so cleanup
 * and replacement writes cannot overtake an abandoned mutation. The backend
 * slice has no cancellation signal.
 *
 * The service this builds carries **no** kernel isolation attestation; `layer`
 * is the composition that makes that claim.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (fs: ZenFsPromisesLike): FileSystem.FileSystem =>
  FileSystem.makeNoop({
    chmod: () => unsupported("chmod"),
    chown: () => unsupported("chown"),
    copy: () => unsupported("copy"),
    copyFile: () => unsupported("copyFile"),
    glob: () => unsupported("glob"),
    link: () => unsupported("link"),
    symlink: () => unsupported("symlink"),
    readLink: () => unsupported("readLink"),
    open: () => unsupported("open"),
    truncate: () => unsupported("truncate"),
    sink: () => Sink.fail(unsupportedError("sink")),
    watch: () => Stream.fail(unsupportedError("watch")),
    rename: (from, to) =>
      fs.rename === undefined ? unsupported("rename") : Effect.tryPromise({
        try: () => fs.rename!(from, to),
        catch: platformError("rename", from)
      }).pipe(Effect.uninterruptible),
    utimes: (path, atime, mtime) =>
      fs.utimes === undefined ? unsupported("utimes") : Effect.tryPromise({
        try: () => fs.utimes!(path, atime, mtime),
        catch: platformError("utimes", path)
      }).pipe(Effect.uninterruptible),
    makeTempDirectory: () => unsupported("makeTempDirectory"),
    makeTempDirectoryScoped: () => unsupported("makeTempDirectoryScoped"),
    makeTempFile: () => unsupported("makeTempFile"),
    makeTempFileScoped: () => unsupported("makeTempFileScoped"),
    readFile: (path) => Effect.map(readBytes(fs, path), snapshot),
    stream: (path, options) => streamFile(fs, path, options),
    writeFile: (path, data, options) => writeBytes(fs, path, snapshot(data), options?.flag, options?.mode),
    /**
     * `makeNoop` does not derive the string helpers from `readFile`/`writeFile`
     * the way `make` does — it hardcodes both to a `NotFound` failure — so they
     * have to be wired explicitly, with the same encode/decode error handling
     * effect's own `make` uses.
     */
    readFileString: (path, encoding) =>
      Effect.flatMap(readBytes(fs, path), (bytes) =>
        Effect.try({
          try: () => new TextDecoder(encoding).decode(bytes),
          catch: (cause) =>
            PlatformError.badArgument({
              module: "FileSystem",
              method: "readFileString",
              description: "invalid encoding",
              cause
            })
        })),
    writeFileString: (path, data, options) => writeText(fs, path, data, options?.flag, options?.mode),
    /**
     * `mode` is forwarded for the same reason `writeBytes` forwards it:
     * creating a directory 0755 when the caller asked for 0700 is a silent
     * permission widening, not a missing feature.
     */
    makeDirectory: (path, options) =>
      Effect.asVoid(
        Effect.tryPromise({
          try: () =>
            fs.mkdir(path, {
              recursive: options?.recursive ?? false,
              ...(options?.mode === undefined ? {} : { mode: options.mode })
            }),
          catch: platformError("makeDirectory", path)
        }).pipe(Effect.uninterruptible)
      ),
    readDirectory: (path, options) => readDirectory(fs, path, options),
    stat: (path) =>
      Effect.map(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("stat", path) }),
        fileInfo
      ),
    realPath: (path) => realPath(fs, path),
    remove: (path, options) =>
      Effect.tryPromise({
        try: () =>
          fs.rm(path, {
            recursive: options?.recursive ?? false,
            force: options?.force ?? false
          }),
        catch: platformError("remove", path)
      }).pipe(Effect.uninterruptible),
    /**
     * `readable` and `writable` are answered from the reported `mode` rather
     * than dropped: a `writable` check that succeeds on a read-only file is a
     * false green for a caller using `access` as a permission pre-check. `ok`
     * asks for the existence check a bare `access` already performs.
     */
    access: (path, options) =>
      Effect.flatMap(
        Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("access", path) }),
        (stats) =>
          options === undefined || permitted(stats.mode, options)
            ? Effect.void
            : Effect.fail(denied(path))
      ),
    /**
     * `makeNoop` hardcodes `exists` to `false` (it does not derive it from
     * `access` the way `make` does), so it has to be overridden explicitly —
     * with effect's own derivation, where only `NotFound` becomes `false` and
     * every other failure propagates. Collapsing a permission refusal into
     * "this path does not exist" answers a question the backend refused.
     */
    exists: (path) =>
      Effect.tryPromise({ try: () => fs.stat(path), catch: platformError("exists", path) }).pipe(
        Effect.as(true),
        Effect.catch((error) => error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error))
      )
  })
