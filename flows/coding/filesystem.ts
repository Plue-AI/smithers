/** Private coding policy around the existing guarded standard file tools. */
import { Cause, Effect, type FileSystem, PlatformError, Schema, Sink, Stream } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { helperPath } from "./helper.ts"
import type { NativeOptions } from "./native.ts"

const Eligibility = Schema.Union([
  Schema.Struct({ eligible: Schema.Literal(true) }),
  Schema.Struct({ eligible: Schema.Literal(false), reason: Schema.String })
])
const denied = (method: string, description: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    description
  })
const refusal = (method: string) =>
  Effect.fail(denied(method, "This file mutation has no native JJ compensation policy in the configured coding host"))

/** Keep the guarded filesystem and the privileged eligibility process separate.
 * The latter can invoke only the packaged helper's fixed native operation.
 */
export const make = (
  options: NativeOptions,
  fs: FileSystem.FileSystem,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  canonicalRoot: string
): FileSystem.FileSystem => {
  const root = resolve(options.repositoryPath)
  const pinnedRoot = resolve(canonicalRoot)
  const inside = (path: string) => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  // Preserve owns exclusive sibling files only until rename/cleanup. This is
  // transient process state, not another durable source of file ownership.
  const temporaries = new Set<string>()
  // The already-guarded filesystem supplies its pinned real root. Preserve can
  // return that spelling; normalize only the root alias, never child symlinks.
  // Native requests still carry the exact provisioned repositoryPath.
  const key = (path: string) => {
    const absolute = resolve(root, path)
    const suffix = relative(root, absolute)
    return inside(suffix) ? resolve(pinnedRoot, suffix) : absolute
  }
  const temporary = (path: string, flag: FileSystem.OpenFlag | undefined) =>
    flag === "wx" &&
    /^\.smithers-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(basename(path))
  const eligible = (method: string, path: string, byteLength: number) =>
    Effect.gen(function*() {
      const target = relative(pinnedRoot, key(path))
      if (
        target === "" || !inside(target) ||
        !Number.isSafeInteger(byteLength) || byteLength < 0
      ) return yield* refusal(method)
      const request = JSON.stringify({
        repositoryPath: root,
        operation: "eligible",
        path: target.split(sep).join("/"),
        byteLength
      })
      const child = yield* spawner.spawn(
        ChildProcess.make(helperPath(options), ["--engine"], {
          cwd: root,
          stdin: Stream.make(new TextEncoder().encode(request))
        })
      )
      const capture = (stream: typeof child.stdout) =>
        Stream.runFoldEffect(stream, () => ({ bytes: 0, text: "", decoder: new TextDecoder() }), (state, chunk) => {
          if (state.bytes + chunk.length > 64 * 1024) return refusal(method)
          return Effect.succeed({
            bytes: state.bytes + chunk.length,
            text: state.text + state.decoder.decode(chunk, { stream: true }),
            decoder: state.decoder
          })
        }).pipe(Effect.map((state) => state.text + state.decoder.decode()))
      const [output, , exit] = yield* Effect.all([capture(child.stdout), capture(child.stderr), child.exitCode], {
        concurrency: "unbounded"
      })
      if (exit !== 0) return yield* Effect.fail(denied(method, "Native JJ file eligibility could not be verified"))
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Eligibility))(output)
      if (!result.eligible) {
        return yield* Effect.fail(denied(method, `Native JJ cannot compensate this path: ${result.reason}`))
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout("4 minutes"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.fail(
          error instanceof PlatformError.PlatformError
            ? error
            : denied(method, "Native JJ file eligibility could not be verified")
        )
      })
    )
  const fileSize = (method: string, path: string) =>
    fs.stat(path).pipe(Effect.flatMap((info) =>
      info.type === "File" && info.size <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Effect.succeed(Number(info.size)) :
        refusal(method)
    ))
  const write = (
    method: string,
    path: string,
    size: number,
    flag: FileSystem.OpenFlag | undefined,
    action: Effect.Effect<void, PlatformError.PlatformError>
  ) =>
    Effect.suspend(() => {
      if (temporary(path, flag)) {
        temporaries.add(key(path))
        return action.pipe(Effect.tapError((error) =>
          Effect.sync(() => {
            if (error.reason._tag === "AlreadyExists") temporaries.delete(key(path))
          })
        ))
      }
      if (flag !== undefined && flag !== "w" && flag !== "wx") return refusal(method)
      return eligible(method, path, size).pipe(Effect.andThen(action))
    })
  return {
    ...fs,
    writeFile: (path, bytes, options) =>
      write("writeFile", path, bytes.byteLength, options?.flag, fs.writeFile(path, bytes, options)),
    writeFileString: (path, text, options) =>
      write(
        "writeFileString",
        path,
        new TextEncoder().encode(text).byteLength,
        options?.flag,
        fs.writeFileString(path, text, options)
      ),
    rename: (from, to) =>
      Effect.gen(function*() {
        const size = yield* fileSize("rename", from)
        if (!temporaries.has(key(from))) yield* eligible("rename", from, 0)
        // Always validate the final path, even when the exclusive sibling itself
        // is ignored. Never infer user-file eligibility from a temporary suffix.
        yield* eligible("rename", to, size)
        yield* fs.rename(from, to)
        temporaries.delete(key(from))
      }),
    remove: (path, options) =>
      Effect.gen(function*() {
        if (temporaries.has(key(path))) {
          yield* fs.remove(path, options)
          temporaries.delete(key(path))
          return
        }
        if (options?.recursive) return yield* refusal("remove")
        if (!(yield* fs.exists(path)) && options?.force) return yield* fs.remove(path, options)
        yield* fileSize("remove", path)
        yield* eligible("remove", path, 0)
        yield* fs.remove(path, options)
      }),
    copyFile: (from, to) =>
      fileSize("copyFile", from).pipe(
        Effect.flatMap((size) => eligible("copyFile", to, size)),
        Effect.andThen(fs.copyFile(from, to))
      ),
    copy: () => refusal("copy"),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r" ? fs.open(path, options) : refusal("open"),
    sink: () => Sink.fail(denied("sink", "Streaming writes have no native JJ compensation policy")),
    truncate: () => refusal("truncate"),
    link: () => refusal("link"),
    symlink: () => refusal("symlink"),
    utimes: () => refusal("utimes"),
    chmod: (path, mode) => temporaries.has(key(path)) ? fs.chmod(path, mode) : refusal("chmod"),
    chown: (path, uid, gid) => temporaries.has(key(path)) ? fs.chown(path, uid, gid) : refusal("chown"),
    makeTempDirectory: () => refusal("makeTempDirectory"),
    makeTempDirectoryScoped: () => refusal("makeTempDirectoryScoped"),
    makeTempFile: () => refusal("makeTempFile"),
    makeTempFileScoped: () => refusal("makeTempFileScoped")
  }
}
