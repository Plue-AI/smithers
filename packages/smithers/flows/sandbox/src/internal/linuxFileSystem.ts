/**
 * Native Linux filesystem operations for sessions on a Linux guest, shared by
 * the container and microVM providers.
 *
 * @since 0.1.0
 */

import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Stream from "effect/Stream"
import type { Session } from "../Sandbox/Session.ts"

const encoder = new TextEncoder()
const validMode = (mode: number): boolean => Number.isInteger(mode) && mode >= 0 && mode <= 0o7777
const validOwner = (id: number): boolean => Number.isInteger(id) && id >= -1 && id < 0xffffffff

/**
 * Supplies metadata and exclusive creation using GNU or BusyBox utilities.
 * A complete sibling file is linked into place with `ln -T`, which refuses
 * every existing destination, including directories, symlinks and FIFOs.
 * The sibling lives in a private directory on the destination filesystem.
 * `guest` names the machine kind in refusals, such as `container`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const linuxFileSystem = (session: Session, guest: string): Partial<FileSystem.FileSystem> => {
  const badArgument = (method: string, description: string) =>
    PlatformError.badArgument({ module: "FileSystem", method, description })
  const failed = (method: string, path: string, description: string, code = 1) =>
    PlatformError.systemError({
      _tag: code === 9 ? "NotFound" : code === 10 ? "AlreadyExists" : "Unknown",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description
    })
  const run = (method: string, path: string, script: string, stdin?: Uint8Array) =>
    Effect.scoped(Effect.gen(function*() {
      const process = yield* session.spawn(script, { stdin })
      const [stdout, stderr, code] = yield* Effect.all([
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ], { concurrency: "unbounded" })
      if (code !== 0) return yield* Effect.fail(failed(method, path, stderr, code))
      return stdout
    })).pipe(
      Effect.mapError((error) =>
        error instanceof PlatformError.PlatformError ? error : failed(method, path, error.message)
      )
    )
  const stat: FileSystem.FileSystem["stat"] = (path) =>
    Effect.gen(function*() {
      const quoted = CommandLine.quote(path)
      const text = yield* run(
        "stat",
        path,
        `if [ ! -e ${quoted} ] && [ ! -L ${quoted} ] && [ -x "$(dirname -- ${quoted})" ]; then exit 9; fi; stat -L -c '%f %s %u %g %d %i %h %Y' -- ${quoted}`
      )
      const fields = text.trim().split(/\s+/)
      const mode = Number.parseInt(fields[0]!, 16)
      const values = fields.slice(1).map(Number)
      if (
        fields.length !== 8 || !/^[0-9a-f]+$/i.test(fields[0]!) || !Number.isSafeInteger(mode) ||
        values.some((value) => !Number.isSafeInteger(value)) || values.slice(0, 6).some((value) => value < 0)
      ) {
        return yield* Effect.fail(failed("stat", path, `${guest} stat returned invalid metadata`))
      }
      const [size, uid, gid, dev, ino, nlink, mtime] = values as [
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
      const types: Record<number, FileSystem.File.Info["type"]> = {
        0o100000: "File",
        0o040000: "Directory",
        0o120000: "SymbolicLink",
        0o010000: "FIFO",
        0o020000: "CharacterDevice",
        0o060000: "BlockDevice",
        0o140000: "Socket"
      }
      return {
        type: types[mode & 0o170000] ?? "Unknown",
        size: ByteSize.fromInputUnsafe(size),
        mode,
        uid: Option.some(uid),
        gid: Option.some(gid),
        dev,
        ino: Option.some(ino),
        nlink: Option.some(nlink),
        mtime: Option.some(new Date(mtime * 1000)),
        atime: Option.none(),
        birthtime: Option.none(),
        rdev: Option.none(),
        blksize: Option.none(),
        blocks: Option.none()
      }
    })
  const writeFile: FileSystem.FileSystem["writeFile"] = (path, content, options) => {
    const flag = options?.flag ?? "w"
    if (flag === "w" && options?.mode === undefined) {
      return session.writeFile(path, content).pipe(Effect.mapError((error) => failed("writeFile", path, error.message)))
    }
    if (flag !== "wx" || (options?.mode !== undefined && !validMode(options.mode))) {
      return Effect.fail(badArgument("writeFile", `${guest} writes support w without a mode, or wx with a valid mode`))
    }
    const quoted = CommandLine.quote(path)
    const mode = (options?.mode ?? 0o666).toString(8)
    // chmod starts from the guest umask, as open(O_CREAT, mode) would. The
    // payload is never streamed to an existing entry, even if a rival wins.
    const script = `set -e
parent=$(dirname -- ${quoted})
tmp=$(mktemp -d "$parent/.smithers-write.XXXXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
mask=$(umask)
cat > "$tmp/content"
chmod "$(printf '%o' $((0${mode} & ~0$mask)))" "$tmp/content"
if ln -T -- "$tmp/content" ${quoted}; then exit 0; fi
if [ -e ${quoted} ] || [ -L ${quoted} ]; then exit 10; fi
exit 1`
    return Effect.asVoid(run("writeFile", path, script, content))
  }
  return {
    stat,
    writeFile,
    writeFileString: (path, content, options) => writeFile(path, encoder.encode(content), options),
    chmod: (path, mode) =>
      validMode(mode)
        ? Effect.asVoid(run("chmod", path, `chmod ${mode.toString(8)} -- ${CommandLine.quote(path)}`))
        : Effect.fail(badArgument("chmod", "mode must be an integer between 0 and 07777")),
    chown: (path, uid, gid) => {
      if (!validOwner(uid) || !validOwner(gid)) return Effect.fail(badArgument("chown", "invalid uid or gid"))
      if (uid === -1 && gid === -1) return Effect.asVoid(stat(path))
      return Effect.asVoid(
        run(
          "chown",
          path,
          `chown ${CommandLine.quote(`${uid === -1 ? "" : uid}${gid === -1 ? "" : `:${gid}`}`)} -- ${
            CommandLine.quote(path)
          }`
        )
      )
    }
  }
}
