/**
 * The chat coordinator's reads, kept inside the workspace.
 *
 * Its `read`, `grep` and `ls` are refused twice: a call naming a `path` or
 * `root` outside the workspace is refused before it runs, and each file or
 * directory the flow then opens is checked again where it is opened, so a
 * symlink swapped in after the first check does not carry the read out.
 *
 * Node has no descriptor-relative open, so a writer that swaps a path out and
 * back around the open can still win; such a writer, as a worker with a shell
 * is, can copy the file in anyway. These checks keep the coordinator's own
 * reads inside the workspace; they do not defend it against a racing writer.
 */
import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Search from "@smthrs/std/Search"
import { StdError } from "@smthrs/std/StdError"
import { Effect, FileSystem, PlatformError } from "effect"
import * as ServiceContext from "effect/Context"
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { real, within } from "./approvals.ts"

/**
 * `path` resolved against `cwd` with every symlink followed, or why it may
 * not be read: it lands outside, or its symlinks never end.
 */
const resolved = (cwd: string, path: string): { readonly path: string } | { readonly refused: string } => {
  try {
    const inside = within(cwd, path)
    return inside === undefined ? { refused: "outside this repository" } : { path: join(real(resolve(cwd)), inside) }
  } catch {
    return { refused: "too many symlinks" }
  }
}

/** Why `path` may not be read from `cwd`, or `undefined` when it may. */
export const refusal = (cwd: string, path: string): string | undefined => {
  const target = resolved(cwd, path)
  return "refused" in target ? target.refused : undefined
}

/** `source` answering a call whose `path` or `root` may not be read with a failed result, never running it. */
export const inWorkspace = (source: FlowBinding.Source, cwd: string): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) =>
      bindings.map((binding): FlowBinding.Binding => ({
        ...binding,
        run: (call) => {
          const input = call.input !== null && typeof call.input === "object"
            ? call.input as Record<string, unknown>
            : {}
          const refused = [input.path, input.root].flatMap((path) => {
            const why = typeof path === "string" ? refusal(cwd, path) : undefined
            return why === undefined ? [] : [`${path}: ${why}`]
          })[0]
          return refused === undefined
            ? binding.run(call)
            : Effect.succeed(new Cell.CallResult({ outcome: "failure", value: null, message: refused }))
        }
      })))
})

const denied = (method: string, path: string, description: string): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description
  })

/** A Node read failure as the `PlatformError` the standard flows map. */
const failed = (method: string, path: string, cause: unknown): PlatformError.PlatformError => {
  const code = (cause as { readonly code?: unknown }).code
  return PlatformError.systemError({
    _tag: code === "ENOENT" || code === "ENOTDIR"
      ? "NotFound"
      : code === "EACCES" || code === "EPERM"
      ? "PermissionDenied"
      : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause
  })
}

/**
 * `path` read through the descriptor it opened, once that descriptor is the
 * file the path now resolves to inside `cwd`: a symlink swapped in before the
 * open fails the identity check, one swapped in after it the second resolve.
 */
const readOpened = (cwd: string, path: string): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    const absolute = resolve(cwd, path)
    let descriptor: number
    try {
      descriptor = openSync(absolute, "r")
    } catch (cause) {
      return Effect.fail(failed("readFile", path, cause))
    }
    try {
      const target = resolved(cwd, absolute)
      if ("refused" in target) return Effect.fail(denied("readFile", path, target.refused))
      const opened = fstatSync(descriptor)
      const named = statSync(target.path)
      if (opened.dev !== named.dev || opened.ino !== named.ino) {
        return Effect.fail(denied("readFile", path, "changed while it was read"))
      }
      return Effect.succeed(new Uint8Array(readFileSync(descriptor)))
    } catch (cause) {
      return Effect.fail(failed("readFile", path, cause))
    } finally {
      closeSync(descriptor)
    }
  })

/**
 * `fileSystem` checking each file and directory it opens against `cwd` as it
 * opens it. A file is read whole through {@link readOpened}; an open handle,
 * which a stream would read from, is refused, so a search reads whole files.
 */
const confined = (fileSystem: FileSystem.FileSystem, cwd: string): FileSystem.FileSystem => {
  const checked = (method: string, path: string): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      const why = refusal(cwd, path)
      return why === undefined ? Effect.void : Effect.fail(denied(method, path, why))
    })
  return FileSystem.make({
    ...fileSystem,
    open: (path) => Effect.fail(denied("open", path, "read whole files only")),
    readFile: (path) => readOpened(cwd, path),
    readDirectory: (path, options) =>
      Effect.andThen(checked("readDirectory", path), fileSystem.readDirectory(path, options))
  })
}

/**
 * `services` whose filesystem refuses, where it opens them, files and
 * directories outside `cwd`.
 */
export const confine = <R>(services: ServiceContext.Context<R | FileSystem.FileSystem>, cwd: string) =>
  ServiceContext.add(
    services,
    FileSystem.FileSystem,
    confined(ServiceContext.get(services, FileSystem.FileSystem), cwd)
  )

/**
 * `search` refusing a result from a file it may no longer read. `rg` opens
 * the files the walk chose itself, so each file it matched is checked again
 * once it answers: still inside `cwd` and still not a symlink, as the walk
 * found it.
 */
export const rechecked = (search: Search.Search, cwd: string): Search.Search => ({
  ...search,
  grep: (input) =>
    Effect.flatMap(search.grep(input), (output) => {
      for (const file of output.files) {
        const why = refusal(cwd, file) ?? (isLink(resolve(cwd, file)) ? "changed while it was read" : undefined)
        if (why !== undefined) {
          return Effect.fail(new StdError({ code: "permission_denied", message: `${file}: ${why}`, path: file }))
        }
      }
      return Effect.succeed(output)
    })
})

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
