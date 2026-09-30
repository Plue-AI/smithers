/**
 * The Node host the workspace walk runs on.
 *
 * `WorkspaceObservation.fileSystemHost` spends two Effect `FileSystem` calls
 * on every entry: `readLink`, which fails with an error value on every regular
 * file, then `stat`. On this repository that was 3.4–5 s a measurement, twice
 * a frame, and a one-line `ctx.done()` answer reached the TUI 8 s after the
 * model wrote it. This host reads each entry's type off the directory listing,
 * so directories and symlinks cost no call at all, and measures a directory's
 * files with concurrent `lstat`s. `lstat` never follows a link, so the walk's
 * "a symlink is not part of the tree" rule holds without asking twice.
 *
 * Errors carry the tags Effect's own Node `FileSystem` gives them, so the walk
 * reads a vanished path and a denied one exactly as it does on the portable host.
 *
 * {@link changes} is the feed that lets a worker skip the walk entirely when
 * nothing under the root moved: a 15,000-path checkout still cost 3 to 15 s a
 * walk, twice a frame, on a loaded machine.
 *
 * @since 1.0.0
 */

import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Effect, Option, type Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import { randomUUID } from "node:crypto"
import { type Dirent, type FSWatcher, rmSync, watch } from "node:fs"
import { lstat, readdir, rm, writeFile } from "node:fs/promises"

/** The reason tags `@effect/platform-node`'s `handleErrnoException` assigns. */
const reason = (code: unknown): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    default:
      return "Unknown"
  }
}

const platformError = (method: string, path: string, error: unknown): PlatformError.PlatformError => {
  const errno = error as NodeJS.ErrnoException
  return PlatformError.systemError({
    _tag: reason(errno?.code),
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    ...(errno?.syscall === undefined ? {} : { syscall: errno.syscall }),
    cause: error
  })
}

const measure = async (directory: string, entry: Dirent): Promise<WorkspaceObservation.Measured> => {
  if (entry.isDirectory()) return { _tag: "Directory" }
  if (!entry.isFile()) return { _tag: "Skipped" }
  const path = `${directory}/${entry.name}`
  try {
    // `bigint`, as Effect's Node `FileSystem` asks: its millisecond mtime is
    // truncated from nanoseconds, and the default float one can round up. A
    // run journaled on one host and resumed on the other must read the same
    // tree as the same digest.
    const info = await lstat(path, { bigint: true })
    // Replaced by a link or a directory between the listing and the lstat.
    if (!info.isFile()) return { _tag: "Skipped" }
    return { _tag: "File", size: Number(info.size), modified: info.mtime.getTime() }
  } catch (error) {
    return { _tag: "Failed", method: "stat", cause: platformError("stat", path, error) }
  }
}

/**
 * Lists one directory with its entry types and measures its kept files together.
 *
 * @category constructors
 * @since 1.0.0
 */
export const host: WorkspaceObservation.Host = {
  entries: (directory, keep) =>
    Effect.tryPromise({
      try: async () => {
        const listed = (await readdir(directory, { withFileTypes: true })).filter((entry) => keep(entry.name))
        return Promise.all(
          listed.map(async (entry) => ({ name: entry.name, measured: await measure(directory, entry) }))
        )
      },
      catch: (error) => platformError("readDirectory", directory, error)
    })
}

/** How long a fence may take to come back through the feed before the feed stops waiting for it. */
const fenceTimeoutMillis = 10_000

/** The name every fence file starts with. */
const fencePrefix = ".smithers-observe-"

const unvouched: WorkspaceObservation.Changes = {
  delivered: Effect.succeed(Option.none()),
  settled: Effect.succeed(Option.none())
}

/**
 * A change feed over one workspace root: a recursive `fs.watch` whose events
 * move the count, except those under a directory or name the walk skips.
 *
 * An event arrives after the write that caused it, so the `delivered` count
 * can miss a write made just before the call. `settled` first writes a fence
 * file and waits for its event: the feed delivers one root's events in order,
 * so once the fence is back, every earlier change is counted. The fence goes in
 * the first pruned directory the root holds (`.git` in a checkout), which the
 * walk never measures. A root with none, or a watch the host refuses or that
 * fails, answers `Option.none()`, and so does a fence that is not back within
 * `fenceTimeoutMillis`. `WorkspaceObservation.cached` races the fence
 * against the walk, so a slow feed costs no more than the walk. On Linux a
 * fence came back in 1 to 2 ms against a 150 ms walk of 15,000 paths. macOS
 * routes events through one system daemon: under a load average of 25 to 80 a
 * fence took 0.5 to 3 s, and a starved daemon delivered nothing for minutes.
 * The watch is not live the moment it returns, so construction sends one fence
 * ahead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const changes = (
  root: string,
  options: WorkspaceObservation.Options = {}
): Effect.Effect<WorkspaceObservation.Changes, never, Scope.Scope> =>
  Effect.gen(function*() {
    const base = root.replaceAll(/\/+$/g, "")
    const prune = options.prune ?? WorkspaceObservation.defaultPrune
    const pruned = new Set(prune)
    const suffixes = options.ignoreSuffixes ?? WorkspaceObservation.defaultIgnoreSuffixes
    const excluded = new Set(options.excludePaths)
    const home = yield* Effect.promise(async () => {
      for (const name of prune) {
        const info = await lstat(`${base}/${name}`).catch(() => undefined)
        if (info?.isDirectory()) return name
      }
      return undefined
    })
    if (home === undefined) return unvouched
    let generation = 0
    let broken = false
    const waiters = new Map<string, (arrived: boolean) => void>()
    // Fence files not yet removed: each fence removes its own, and a close
    // removes those still in flight.
    const outstanding = new Set<string>()
    const skipped = (relative: string): boolean => {
      const segments = relative.split("/")
      return segments.some((segment, index) =>
        pruned.has(segment) || suffixes.some((suffix) => segment.endsWith(suffix)) ||
        excluded.has(segments.slice(0, index + 1).join("/"))
      )
    }
    const fail = (): void => {
      broken = true
      for (const arrive of waiters.values()) arrive(false)
      waiters.clear()
    }
    const watcher = yield* Effect.acquireRelease(
      Effect.sync((): FSWatcher | undefined => {
        try {
          return watch(base, { recursive: true, persistent: false }, (_event, filename) => {
            const relative = filename === null ? undefined : String(filename).replaceAll("\\", "/")
            if (relative !== undefined) {
              const arrive = waiters.get(relative)
              if (arrive !== undefined) {
                waiters.delete(relative)
                return arrive(true)
              }
              if (relative.startsWith(`${home}/${fencePrefix}`) || skipped(relative)) return
            }
            generation++
          }).on("error", fail)
        } catch {
          return undefined
        }
      }),
      (watcher) =>
        Effect.sync(() => {
          watcher?.close()
          fail()
          for (const path of outstanding) rmSync(path, { force: true })
        })
    )
    if (watcher === undefined) return unvouched
    const nonce = `${process.pid}-${randomUUID()}`
    let fences = 0
    const fence = async (): Promise<Option.Option<number>> => {
      if (broken) return Option.none()
      const relative = `${home}/${fencePrefix}${nonce}-${fences++}`
      const path = `${base}/${relative}`
      outstanding.add(path)
      let timer: ReturnType<typeof setTimeout> | undefined
      const arrived = new Promise<boolean>((resolve) => {
        waiters.set(relative, resolve)
        timer = setTimeout(() => {
          waiters.delete(relative)
          resolve(false)
        }, fenceTimeoutMillis)
        // A fence never holds the process open.
        timer.unref()
      })
      if (!(await writeFile(path, "").then(() => true, () => false))) {
        waiters.get(relative)?.(false)
        waiters.delete(relative)
      }
      const vouched = await arrived
      clearTimeout(timer)
      // Also after a close, whose sweep may have run before this write landed.
      await rm(path, { force: true }).catch(() => undefined)
      outstanding.delete(path)
      return vouched && !broken ? Option.some(generation) : Option.none()
    }
    void fence()
    return {
      delivered: Effect.sync(() => broken ? Option.none() : Option.some(generation)),
      settled: Effect.promise(fence)
    }
  })
