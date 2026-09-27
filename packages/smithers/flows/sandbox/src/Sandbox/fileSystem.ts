/**
 * Derives an Effect `FileSystem` from a sandbox session.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { platformReason } from "../internal/platformReason.ts"
import { rootedAt } from "../internal/rootedPath.ts"
import type { ProviderError, ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "./Session.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * The shared provider-code mapping, with one deliberate exception.
 *
 * `internal/platformReason` reports `unavailable` as `NotFound`, which is what
 * a spawner's caller needs: a session that cannot run a command is a session to
 * retry elsewhere. A filesystem's `NotFound` means something narrower and
 * load-bearing — `exists` converts it to `false`, and callers remove
 * idempotently by catching it — so a broken session reported as `NotFound`
 * here would read as "the path is not there". It stays `Unknown`.
 */
const REASON: Record<ProviderErrorCode, PlatformError.SystemErrorTag> = {
  ...platformReason,
  unavailable: "Unknown"
}

const providerFailure = (method: string, path: string) =>
(
  error: ProviderError
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: REASON[error.code],
    module: "FileSystem",
    method,
    description: `\`${path}\`: ${error.message}`,
    pathOrDescriptor: path,
    cause: error
  })

/** One probe-decided refusal, in the platform's normalized vocabulary. */
const refused = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string,
  description: string
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    description,
    pathOrDescriptor: path
  })

const notFound = (method: string, path: string): PlatformError.PlatformError =>
  refused("NotFound", method, path, `\`${path}\` does not exist in the sandbox`)

interface ProbeResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Every `FileSystem` operation whose leading arguments are paths, and how many
 * of them are. The table exists so an adapter's native overrides are installed
 * THROUGH the workdir rooting rule rather than beside it: spreading them raw
 * handed an override the caller's unresolved `report.txt`, which the platform
 * then resolved against the host process's working directory instead of the
 * machine's workspace, contradicting this module's own promise. `glob` is
 * absent on purpose: its first argument is a pattern, not a path, and
 * `makeTempDirectory` and its siblings take no path at all.
 *
 * `symlink` is `"second"` rather than `2`. Its first argument is the text
 * stored inside the link, not a path to reach, and POSIX resolves a relative
 * one against the directory the LINK sits in. Rooting it changed where the
 * link pointed: `symlink("../shared", "sub/link")` in `/work` means
 * `/work/shared`, while the rooted `/work/../shared` is written into the link
 * as `/shared` and names something one directory outside the workspace.
 * `link` and `rename` keep both arguments rooted, because both of theirs are
 * paths the machine has to reach.
 */
const pathArity: Readonly<Record<string, 1 | 2 | "second">> = {
  access: 1,
  chmod: 1,
  chown: 1,
  copy: 2,
  copyFile: 2,
  exists: 1,
  link: 2,
  makeDirectory: 1,
  open: 1,
  readDirectory: 1,
  readFile: 1,
  readFileString: 1,
  readLink: 1,
  realPath: 1,
  remove: 1,
  rename: 2,
  sink: 1,
  stat: 1,
  stream: 1,
  symlink: "second",
  truncate: 1,
  utimes: 1,
  watch: 1,
  writeFile: 1,
  writeFileString: 1
}

/** Installs an adapter's native overrides behind the workdir rooting rule. */
const rooted = (
  files: Partial<FileSystem.FileSystem>,
  resolve: (path: string) => string
): Partial<FileSystem.FileSystem> => {
  const wrapped: Record<string, unknown> = { ...files }
  for (const [name, paths] of Object.entries(pathArity)) {
    const override = wrapped[name]
    if (override === undefined) continue
    const call = override as (...args: ReadonlyArray<unknown>) => unknown
    wrapped[name] = paths === 1
      ? (path: string, ...rest: ReadonlyArray<unknown>) => call(resolve(path), ...rest)
      : paths === "second"
      ? (target: string, to: string, ...rest: ReadonlyArray<unknown>) => call(target, resolve(to), ...rest)
      : (from: string, to: string, ...rest: ReadonlyArray<unknown>) => call(resolve(from), resolve(to), ...rest)
  }
  return wrapped
}

const probeFailed = (method: string, path: string) =>
(
  result: ProbeResult
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    description: `\`${path}\`: ${result.stderr.trim() === "" ? `probe exited ${result.code}` : result.stderr.trim()}`,
    pathOrDescriptor: path
  })

/**
 * Runs one probe line in the session and gathers its three outputs. The
 * streams and the exit are consumed concurrently, the way `std`'s own exec
 * adapter does, so a probe whose output outgrows a pipe cannot deadlock.
 */
const probe = (
  session: Session,
  method: string,
  path: string,
  script: string
): Effect.Effect<ProbeResult, PlatformError.PlatformError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(script, {})
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(process.stdout)),
          Stream.mkString(Stream.decodeText(process.stderr)),
          process.exitCode
        ],
        { concurrency: "unbounded" }
      )
      return { code, stdout, stderr }
    })
  ).pipe(Effect.mapError(providerFailure(method, path)))

const emptyInfo = {
  mtime: Option.none<Date>(),
  atime: Option.none<Date>(),
  birthtime: Option.none<Date>(),
  dev: 0,
  ino: Option.none<number>(),
  mode: 0,
  nlink: Option.none<number>(),
  uid: Option.none<number>(),
  gid: Option.none<number>(),
  rdev: Option.none<number>(),
  blksize: Option.none<ByteSize.ByteSize>(),
  blocks: Option.none<number>()
}

const fileTypes: Record<string, FileSystem.File.Info["type"]> = {
  Directory: "Directory",
  File: "File",
  SymbolicLink: "SymbolicLink",
  Unknown: "Unknown"
}

/**
 * Exit codes the probe scripts reserve for outcomes the caller must tell
 * apart, each mapped onto the reason the platform implementations report for
 * the same tree. They sit outside anything the probed utilities answer
 * themselves (0, 1, or 2) and below the shell's own 126/127 markers, so a
 * reserved code can only mean what the script's presence checks decided.
 */
/** The absence marker: the path (or a required source) is not there. */
const absentExit = 9
/** The path already exists where the operation needs absence. */
const alreadyExistsExit = 10
/** The path's kind refuses the operation: a directory in `mv`'s way, a non-directory listed. */
const badResourceExit = 11
/** The path sits behind a directory the session may not search. */
const deniedExit = 12
/** The machine's utility lacks the mode the operation needs: a `mv` without `-T`. */
const unsupportedExit = 13

/**
 * Builds an Effect `FileSystem` over one sandbox session.
 *
 * `readFile` and `writeFile` ride the session's own byte-typed operations.
 * Derived writes support only an omitted flag or `w`, with no mode. Other
 * flags and explicit modes fail with `BadArgument` before session access:
 * the transfer seam cannot guarantee atomic append, exclusive creation, or
 * creation permissions. Native write overrides receive the options unchanged.
 * Everything else is derived through portable `sh` probes over
 * `Session.spawn`: POSIX `test`, `wc -c`, `find`, `mkdir`, `rm`, `mv`, and
 * `dirname`, plus `readlink`/`readlink -f` and `find -mindepth`/`-maxdepth`/
 * `-print0`,
 * which POSIX omits but GNU, busybox, and the BSDs all ship — so any session
 * whose machine has a mainstream `sh` userland serves the whole surface with
 * no adapter work. An adapter that can do better supplies `Session.files`,
 * whose entries override the probes one operation at a time.
 *
 * Failure reasons mirror `NodeFileSystem` wherever a script can tell the
 * outcomes apart: absence is `NotFound`, an occupied `mkdir` target is
 * `AlreadyExists`, a directory in `rename`'s way or a listed non-directory is
 * `BadResource`, and a path an unsearchable ancestor hides fails `exists`
 * with `PermissionDenied`. What a probe cannot classify stays `Unknown`; the
 * one deliberate divergence is `readLink` of an existing non-link, which
 * answers `BadArgument` where Node surfaces its unmapped `EINVAL` as
 * `Unknown`.
 *
 * The derived surface is deliberately partial, on the `makeNoop` base: an
 * operation with no meaningful remote form (a watch, an open file handle, a
 * temp directory) answers with the platform's own refusal rather than a
 * plausible lie, the same stance the workspace transaction's filesystem takes.
 *
 * Relative paths resolve against {@link Session.workdir} before they reach the
 * session or an override, so a body that writes `report.txt` lands in the
 * machine's workspace on every backend; the session contract itself stays
 * absolute-only. An override is installed through the resolver rather than
 * beside it, so an adapter's native operation gets the rooted path without
 * having to re-implement the rule.
 *
 * Honest limits of the probe dialect: `stat` reports no mode, no times, and no
 * owner (the portable shell cannot name them; its `size` is exact, from the
 * machine's `stat` where it has one and a byte count otherwise, and a size the
 * probe cannot read fails rather than reading as zero); `rename` replaces an
 * empty directory with a directory only where `mv` knows `-T`. `stat` follows links the way the platform
 * implementations do, and reports `SymbolicLink` only for a dangling link.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fileSystem = (session: Session): FileSystem.FileSystem => {
  const quote = CommandLine.quote
  const resolve = rootedAt(session.workdir)
  const statOf = Effect.fn("Sandbox.fileSystem.stat")(function*(raw: string) {
    const path = resolve(raw)
    const target = quote(path)
    const result = yield* probe(
      session,
      "stat",
      path,
      `if [ -d ${target} ]; then t=Directory; elif [ -f ${target} ]; then t=File; ` +
        `elif [ -h ${target} ]; then t=SymbolicLink; elif [ -e ${target} ]; then t=Unknown; ` +
        `else exit ${absentExit}; fi; s=0; if [ "$t" = File ]; then ` +
        // Size comes from the machine's own metadata call first: GNU and
        // busybox spell it `-c %s`, BSD `-f %z`, and `-L` follows a link the
        // way `-f` did. Reading the bytes with `wc` is the last resort, and a
        // failed read (a mode-000 file, a missing `wc`) fails the probe rather
        // than leaving `s` empty for the parse to read as an honest zero.
        `s=$(stat -L -c %s ${target} 2>/dev/null) || s=$(stat -L -f %z ${target} 2>/dev/null) || ` +
        `s=$(wc -c < ${target}) || exit 1; fi; printf '%s %s' "$t" "$s"`
    )
    if (result.code === absentExit) return yield* Effect.fail(notFound("stat", path))
    if (result.code !== 0) return yield* Effect.fail(probeFailed("stat", path)(result))
    // BSD `wc -c` pads its count, so the fields are whitespace-run separated.
    const [type, size] = result.stdout.trim().split(/\s+/)
    // A size that is not a whole number is a probe the shell mangled, never a
    // file of zero bytes; the documented contract is an exact size or a failure.
    if (size === undefined || !/^\d+$/.test(size)) {
      return yield* Effect.fail(PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "stat",
        description: `\`${path}\`: stat probe answered \`${result.stdout.trim()}\` instead of a type and a size`,
        pathOrDescriptor: path
      }))
    }
    return {
      ...emptyInfo,
      /* v8 ignore next -- `split` always yields a first field, so the `type` nullish arm only discharges the indexed-access optional */
      type: fileTypes[type ?? ""] ?? "Unknown",
      size: ByteSize.bytes(BigInt(size))
    } satisfies FileSystem.File.Info
  })
  const readFile = (raw: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> => {
    const path = resolve(raw)
    return session.readFile(path).pipe(Effect.mapError(providerFailure("readFile", path)))
  }
  const writeFile = (
    method: "writeFile" | "writeFileString",
    raw: string,
    data: Uint8Array,
    options: Parameters<FileSystem.FileSystem["writeFile"]>[2]
  ): Effect.Effect<void, PlatformError.PlatformError> => {
    const path = resolve(raw)
    // A read/check followed by replacement races other writers. Refuse options
    // the byte-transfer seam cannot honor before invoking any session method.
    if ((options?.flag !== undefined && options.flag !== "w") || options?.mode !== undefined) {
      return Effect.fail(PlatformError.badArgument({
        module: "FileSystem",
        method,
        description: `\`${path}\`: unsupported write options; derived writes require flag 'w' or no flag, and no mode`
      }))
    }
    return session.writeFile(path, data).pipe(Effect.mapError(providerFailure(method, path)))
  }
  return FileSystem.makeNoop({
    exists: Effect.fn("Sandbox.fileSystem.exists")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // `test -e` answers false for "missing" and "unstatable" alike, but the
      // platform `exists` converts only `NotFound` into `false` — an `EACCES`
      // or `ENOTDIR` from `access(2)` propagates as a failure. When the path
      // is not visible, the script walks up to the deepest ancestor it can
      // stat: a non-directory there is the `ENOTDIR`, an unsearchable
      // directory is the `EACCES` barrier, and a searchable directory proves
      // the path genuinely absent.
      const script = `if [ -e ${target} ]; then exit 0; fi; p=${target}; ` +
        `while [ "$p" != / ]; do p=$(dirname "$p"); if [ -e "$p" ]; then ` +
        `if [ ! -d "$p" ]; then exit ${badResourceExit}; ` +
        `elif [ ! -x "$p" ]; then exit ${deniedExit}; else exit 1; fi; fi; done; exit 1`
      const result = yield* probe(session, "exists", path, script)
      if (result.code === 0) return true
      if (result.code === 1) return false
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "exists", path, `\`${path}\` sits under a non-directory in the sandbox`)
        )
      }
      if (result.code === deniedExit) {
        return yield* Effect.fail(
          refused("PermissionDenied", "exists", path, `\`${path}\` sits under an unsearchable directory in the sandbox`)
        )
      }
      return yield* Effect.fail(probeFailed("exists", path)(result))
    }),
    stat: (path) => statOf(path),
    readFile,
    readFileString: (path) => Effect.map(readFile(path), (bytes) => decoder.decode(bytes)),
    writeFile: (path, data, options) => writeFile("writeFile", path, data, options),
    writeFileString: (path, data, options) => writeFile("writeFileString", path, encoder.encode(data), options),
    makeDirectory: Effect.fn("Sandbox.fileSystem.makeDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      // `mkdir` flattens every refusal to exit 1, so the script decides the
      // reasons the platform implementations report before it runs: an
      // occupied target is `AlreadyExists` (`-h` counts a dangling symlink,
      // which `mkdir` also refuses with `EEXIST`) and a missing parent is
      // `NotFound`. Recursive creation of an existing directory succeeds, as
      // Node's does, and refuses a non-directory occupant.
      const script = options?.recursive === true
        ? `if [ -d ${target} ]; then exit 0; ` +
          `elif [ -e ${target} ]; then exit ${alreadyExistsExit}; else mkdir -p ${target}; fi`
        : `if [ -e ${target} ] || [ -h ${target} ]; then exit ${alreadyExistsExit}; ` +
          `elif [ ! -e "$(dirname ${target})" ]; then exit ${absentExit}; else mkdir ${target}; fi`
      const result = yield* probe(session, "makeDirectory", path, script)
      if (result.code === alreadyExistsExit) {
        return yield* Effect.fail(
          refused("AlreadyExists", "makeDirectory", path, `\`${path}\` already exists in the sandbox`)
        )
      }
      if (result.code === absentExit) return yield* Effect.fail(notFound("makeDirectory", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("makeDirectory", path)(result))
    }),
    readDirectory: Effect.fn("Sandbox.fileSystem.readDirectory")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      const recursive = options?.recursive === true
      // `find` names every entry by the path it was given, so the listed
      // directory is handed over without trailing slashes and stripped back
      // off each entry below. The root keeps its one slash.
      const base = path.replace(/\/+$/, "") || "/"
      const prefix = base === "/" ? "/" : `${base}/`
      // A present non-directory is the `ENOTDIR` the platform reports as
      // `BadResource`; only true absence is `NotFound` (a dangling symlink
      // is absent to `readdir`, which follows it, so `-e` is the question).
      // Entries are NUL-framed with `-print0`, never line-framed: a newline
      // is a legal filename byte, and `ls` output split on lines read `a\nb`
      // as two entries. `find` also never columnizes on a pseudo-terminal
      // (ECS Exec's Session Manager channel is one), which a bare `ls` does.
      // `-H` follows a symlinked directory the way `readdir` does.
      const script = `if [ -d ${target} ]; then find -H ${quote(base)} -mindepth 1 ` +
        `${recursive ? "" : "-maxdepth 1 "}-print0; ` +
        `elif [ -e ${target} ]; then exit ${badResourceExit}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "readDirectory", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("readDirectory", path))
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "readDirectory", path, `\`${path}\` is not a directory in the sandbox`)
        )
      }
      if (result.code !== 0) return yield* Effect.fail(probeFailed("readDirectory", path)(result))
      // Sorted for determinism: `find` order differs by platform.
      return result.stdout
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)
        .sort()
    }),
    remove: Effect.fn("Sandbox.fileSystem.remove")(function*(raw, options) {
      const path = resolve(raw)
      const target = quote(path)
      const forced = options?.force === true
      const flags = `${options?.recursive === true ? "-r " : ""}${forced ? "-f " : ""}`
      // `rm` answers 1 for everything, so an unforced removal checks presence
      // itself: the platform implementations report a missing path as
      // `NotFound`, and a caller removing idempotently catches exactly that
      // reason. `-h` is part of the question because a dangling symlink is
      // absent to `-e` and still a thing `rm` deletes.
      const script = forced
        ? `rm ${flags}${target}`
        : `if [ -e ${target} ] || [ -h ${target} ]; then rm ${flags}${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "remove", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("remove", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("remove", path)(result))
    }),
    rename: Effect.fn("Sandbox.fileSystem.rename")(function*(rawOld, rawNew) {
      const oldPath = resolve(rawOld)
      const newPath = resolve(rawNew)
      const source = quote(oldPath)
      const destination = quote(newPath)
      // Bare `mv` diverges from `rename(2)`: a missing source is an
      // undistinguished exit 1, and an existing directory destination
      // silently moves the source *into* it. The script probes both before
      // `mv` runs — the missing source is `NotFound` (`-h` keeps a dangling
      // symlink renameable, as it is everywhere), and a directory
      // destination in a non-directory's way is the `EISDIR` the platform
      // reports as `BadResource`. A directory source may still replace an
      // empty directory or name itself, as `rename(2)` allows: the same
      // directory (`-ef`, which every `sh` in use answers) is a no-op, and
      // any other one goes through `mv -T`, the GNU and busybox spelling of
      // `rename(2)` without the nesting. A `mv` without `-T` (BSD answers
      // `EX_USAGE`, 64, before touching anything) is a refusal, never a
      // remove-then-move emulation that could lose the destination.
      const script = `if [ ! -e ${source} ] && [ ! -h ${source} ]; then exit ${absentExit}; ` +
        `elif [ -d ${destination} ]; then ` +
        `if [ -h ${destination} ] || [ ! -d ${source} ] || [ -h ${source} ]; then exit ${badResourceExit}; ` +
        `elif [ ${source} -ef ${destination} ]; then :; ` +
        `else mv -T ${source} ${destination}; c=$?; if [ "$c" -eq 64 ]; then exit ${unsupportedExit}; fi; exit "$c"; fi; ` +
        `else mv ${source} ${destination}; fi`
      const result = yield* probe(session, "rename", oldPath, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("rename", oldPath))
      if (result.code === badResourceExit) {
        return yield* Effect.fail(
          refused("BadResource", "rename", oldPath, `the destination \`${newPath}\` is a directory in the sandbox`)
        )
      }
      if (result.code === unsupportedExit) {
        return yield* Effect.fail(
          refused(
            "BadResource",
            "rename",
            oldPath,
            `the destination \`${newPath}\` is a directory and the sandbox's \`mv\` cannot replace one (no \`-T\`)`
          )
        )
      }
      if (result.code !== 0) return yield* Effect.fail(probeFailed("rename", oldPath)(result))
    }),
    realPath: Effect.fn("Sandbox.fileSystem.realPath")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // busybox and GNU `readlink -f` answer a missing path with the path
      // itself and exit 0, so presence is probed first; `-e` also treats a
      // dangling symlink as absent, exactly what the platform `realpath`
      // reports.
      const script = `if [ -e ${target} ]; then readlink -f ${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "realPath", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("realPath", path))
      if (result.code !== 0) return yield* Effect.fail(probeFailed("realPath", path)(result))
      return result.stdout.replace(/\n$/, "")
    }),
    readLink: Effect.fn("Sandbox.fileSystem.readLink")(function*(raw) {
      const path = resolve(raw)
      const target = quote(path)
      // `readlink` exits 1 for "missing" and "not a link" alike; `-h` keeps
      // a dangling symlink readable, so the leftover refusal is a present
      // non-link, which stays `BadArgument`.
      const script = `if [ -e ${target} ] || [ -h ${target} ]; then readlink ${target}; else exit ${absentExit}; fi`
      const result = yield* probe(session, "readLink", path, script)
      if (result.code === absentExit) return yield* Effect.fail(notFound("readLink", path))
      if (result.code !== 0) {
        return yield* Effect.fail(
          PlatformError.badArgument({
            module: "FileSystem",
            method: "readLink",
            description: `\`${path}\` is not a symbolic link in the sandbox`
          })
        )
      }
      return result.stdout.replace(/\n$/, "")
    }),
    ...session.files === undefined ? {} : rooted(session.files, resolve)
  })
}
