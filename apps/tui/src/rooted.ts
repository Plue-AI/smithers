/**
 * The host's filesystem, path and process services, bound to its directory.
 *
 * Node resolves a relative path against `process.cwd()`. A host serves one
 * directory whatever the process's own, so here every relative path a flow
 * names, and every command spawned without a `cwd`, resolves against `root`.
 * Absolute paths pass through unchanged, and so does a symlink's target, which
 * is relative to the link rather than to any directory.
 */
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

/** `base` with every relative path resolved against the absolute `root`. */
export const path = (base: Path.Path, root: string): Path.Path => {
  const resolve = (...segments: ReadonlyArray<string>) => base.resolve(root, ...segments)
  return {
    ...base,
    resolve,
    relative: (from, to) => base.relative(resolve(from), resolve(to)),
    toFileUrl: (value) => base.toFileUrl(resolve(value))
  }
}

/** `base` with every relative path resolved by `rooted`, a {@link path}. */
export const fileSystem = (base: FileSystem.FileSystem, rooted: Path.Path): FileSystem.FileSystem => {
  const at = (value: string) => rooted.resolve(value)
  const temp = <O extends { readonly directory?: string | undefined }>(options: O | undefined) =>
    options?.directory === undefined ? options : { ...options, directory: at(options.directory) }
  return {
    ...base,
    access: (value, options) => base.access(at(value), options),
    copy: (from, to, options) => base.copy(at(from), at(to), options),
    copyFile: (from, to) => base.copyFile(at(from), at(to)),
    chmod: (value, mode) => base.chmod(at(value), mode),
    chown: (value, uid, gid) => base.chown(at(value), uid, gid),
    glob: (pattern, options) => base.glob(pattern, { ...options, root: at(options?.root ?? ".") }),
    exists: (value) => base.exists(at(value)),
    link: (from, to) => base.link(at(from), at(to)),
    makeDirectory: (value, options) => base.makeDirectory(at(value), options),
    makeTempDirectory: (options) => base.makeTempDirectory(temp(options)),
    makeTempDirectoryScoped: (options) => base.makeTempDirectoryScoped(temp(options)),
    makeTempFile: (options) => base.makeTempFile(temp(options)),
    makeTempFileScoped: (options) => base.makeTempFileScoped(temp(options)),
    open: (value, options) => base.open(at(value), options),
    readDirectory: (value, options) => base.readDirectory(at(value), options),
    readFile: (value) => base.readFile(at(value)),
    readFileString: (value, encoding) => base.readFileString(at(value), encoding),
    readLink: (value) => base.readLink(at(value)),
    realPath: (value) => base.realPath(at(value)),
    remove: (value, options) => base.remove(at(value), options),
    rename: (from, to) => base.rename(at(from), at(to)),
    sink: (value, options) => base.sink(at(value), options),
    stat: (value) => base.stat(at(value)),
    stream: (value, options) => base.stream(at(value), options),
    symlink: (target, value) => base.symlink(target, at(value)),
    truncate: (value, length) => base.truncate(at(value), length),
    utimes: (value, atime, mtime) => base.utimes(at(value), atime, mtime),
    watch: (value, options) => base.watch(at(value), options),
    writeFile: (value, data, options) => base.writeFile(at(value), data, options),
    writeFileString: (value, data, options) => base.writeFileString(at(value), data, options)
  }
}

/** `base` spawning each command in its `cwd` resolved by `rooted`, a {@link path}; in its root without one. */
export const spawner = (
  base: ChildProcessSpawner.ChildProcessSpawner["Service"],
  rooted: Path.Path
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  const at = (command: ChildProcess.Command): ChildProcess.Command =>
    ChildProcess.isStandardCommand(command)
      ? ChildProcess.setCwd(command, rooted.resolve(command.options.cwd ?? "."))
      : ChildProcess.pipeTo(at(command.left), at(command.right), command.options)
  return ChildProcessSpawner.make((command) => base.spawn(at(command)))
}

/**
 * Decorates the `FileSystem`, `Path` and `ChildProcessSpawner` it is provided
 * in place, so everything downstream resolves against `root`.
 */
export const layer = (
  root: string
): Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effectContext(Effect.gen(function*() {
    const base = yield* Path.Path
    const rooted = path(base, base.resolve(root))
    return Context.make(Path.Path, rooted).pipe(
      Context.add(FileSystem.FileSystem, fileSystem(yield* FileSystem.FileSystem, rooted)),
      Context.add(
        ChildProcessSpawner.ChildProcessSpawner,
        spawner(yield* ChildProcessSpawner.ChildProcessSpawner, rooted)
      )
    )
  }))
