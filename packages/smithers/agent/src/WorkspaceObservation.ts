/**
 * Measuring the workspace a run is changing, so the loop's mutation
 * accounting is a fact rather than a claim.
 *
 * `@smthrs/harness` declares the port
 * (`EngineLike.observe`) and states why it exists. This module is the
 * production answer to it: a pruned walk of the workspace root that reads a
 * cheap identity off every file it keeps and folds the lot into one digest.
 * Two measurements taken around a frame answer "did this frame change the
 * tree", which is the question `bash` makes unanswerable from declarations —
 * a spawned process writes wherever it likes and tells nobody.
 *
 * These properties are the design:
 *
 * - **Identity, not content.** Each kept file contributes its path, its size,
 *   and its modification time. Reading every byte would be the stronger
 *   measurement and it costs the whole tree twice per frame; size and mtime
 *   move for every write a shell command can perform, including the redirect
 *   that started this. A rewrite that restores the byte count *and* the
 *   timestamp is invisible here, and that is the stated limit.
 * - **Pruning is the signal.** An unpruned walk reports a mutation every time
 *   the run executes anything: `pytest` writes `__pycache__`, a build writes
 *   `.so` files beside their sources, `git` rewrites its own index. Those are
 *   derived artifacts, not the work a run is judged on, and counting them
 *   would keep the read-only cap permanently satisfied — the same blindness
 *   the measurement exists to remove, inverted. {@link defaultPrune} and
 *   {@link defaultIgnoreSuffixes} name what is skipped and both are
 *   injectable, so a host whose derived artifacts differ declares its own.
 * - **A vanished path is not an error.** Paths are listed and then measured,
 *   and a background process the run spawned can remove one in between. Such a
 *   path is left out of the measurement rather than failing it: the tree moved,
 *   and the next measurement will say so.
 * - **A partial walk says so.** The walk stops at {@link Options.maxPaths}, and
 *   a measurement that stopped there covers a prefix. It reports
 *   `complete: false`, and the controller then decides changed-ness from what
 *   the frame's calls declared rather than from a prefix that may never have
 *   looked at the files being edited. Listing and stat failures other than
 *   `NotFound` also make the walk partial, and emit warning diagnostics with
 *   the failed operation, path, and cause.
 * - **A symlink is not part of the tree.** Every symlink is skipped whole:
 *   never measured, never descended into. That is what keeps the walk inside
 *   the root on any filesystem, including one whose `stat` follows links.
 *
 * ## The filesystem to hand this
 *
 * The host's own `FileSystem`, not the kernel-guarded one — and the difference
 * is not a detail. A guarded operation is resolved, authorized, re-resolved and
 * then executed relative to a pinned root descriptor, which on Node is one
 * helper process per call. This walk performs one call per file, so guarding it
 * bills a process for every file in the checkout, twice per frame. SWE-bench
 * wave 6 measured 88–123 ms per path that way: django's opening walk ran 912 s
 * of a 1,200 s budget and the run never reached its first tool call. Running the
 * calls concurrently does not repair it — sixteen helper processes in flight
 * still bill a process per file, because the cost is the call and not the wait.
 *
 * Nothing is given up, because the guard has nothing to decide here:
 *
 * - **Stat only.** The walk lists directories and reads metadata. It never
 *   opens a file, never reads a byte, never writes, and never creates a
 *   descriptor — so the confinement a descriptor-bound authorization exists to
 *   protect has nothing to bind to.
 * - **Root-confined.** Every path is a listed entry name appended to a
 *   directory the walk already reached from the root it was constructed with.
 *   No path comes from a model, a tool call, or a file's contents, and no
 *   symlink is followed, so no name the walk builds can leave the root.
 * - **Host equipment.** The root is chosen by whoever composed the workspace.
 *   This service is not reachable from a cell: it answers one question the
 *   controller asks about the tree, and returns a digest and a count.
 *
 * The one behaviour that does change is that the kernel refuses a hard-linked
 * regular file and this walk measures one, which is the answer a measurement
 * wants: an edit through either name moves the tree.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as TreeFingerprint from "@smthrs/std/TreeFingerprint"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"

/**
 * Directory names never descended into.
 *
 * `@smthrs/std/TreeFingerprint` owns the list, because the same measurement
 * is taken inside a container by the `bash` flow and the two must skip the
 * same derived artifacts. Re-exported here so a host that names its own
 * prune list still finds the default beside the walk that uses it.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultPrune: ReadonlyArray<string> = TreeFingerprint.defaultPrune

/**
 * File and directory name suffixes left out of a measurement.
 *
 * Owned by `@smthrs/std/TreeFingerprint`, for the reason {@link defaultPrune}
 * is.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultIgnoreSuffixes: ReadonlyArray<string> = TreeFingerprint.defaultIgnoreSuffixes

/**
 * What a measurement covers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Directory names never descended into. Defaults to {@link defaultPrune}. */
  readonly prune?: ReadonlyArray<string> | undefined
  /** Name suffixes skipped. Defaults to {@link defaultIgnoreSuffixes}. */
  readonly ignoreSuffixes?: ReadonlyArray<string> | undefined
  /** Exact root-relative paths to omit, including a directory's descendants. Uses `/` separators. */
  readonly excludePaths?: ReadonlyArray<string> | undefined
  /**
   * The largest number of files one measurement will cover.
   *
   * A bound rather than a budget: it keeps one pathological checkout from
   * turning every frame into a full-disk walk. A walk that stops there covers
   * a prefix chosen by nothing but sort order, so it reports
   * `complete: false` and the controller sets it aside rather than reading it
   * as the workspace's answer. Both of its answers would be wrong: the prefix
   * holding still says nothing about the files the run is editing outside it,
   * and the prefix moving is as likely to be a tool's own churn as work. This
   * repository is the case — pruned, it is 279,440 paths, and the first 50,000
   * end inside `.smithers`, so a measurement that called itself whole would
   * report every edit under `packages/` as an idle frame and every frame at all
   * as a mutation.
   */
  readonly maxPaths?: number | undefined
}

/**
 * The port {@link EngineLike.Observation} is produced through.
 *
 * A service rather than an option threaded through the agent, because it is
 * host equipment: whoever composed a workspace is the only party that knows
 * where its root is and what it keeps under it. A composition that provides
 * none leaves the loop on declared writes, and the journal says so.
 *
 * @category services
 * @since 0.1.0
 */
export interface Observer {
  readonly observe: Effect.Effect<EngineLike.Observation, HarnessError>
}

/**
 * The {@link Observer} tag.
 *
 * @category services
 * @since 0.1.0
 */
export const Observer: Context.Service<Observer, Observer> = Context.Service<Observer>(
  "@smthrs/agent/WorkspaceObservation/Observer"
)

const defaultMaxPaths = TreeFingerprint.maxPaths

/**
 * What one kept directory entry turned out to be.
 *
 * `Skipped` is a symlink or anything that is neither a file nor a directory.
 * `Failed` is a measurement the host could not take; the walk decides what
 * the failure means.
 *
 * @category models
 * @since 0.1.0
 */
export type Measured =
  | { readonly _tag: "File"; readonly size: number; readonly modified: number }
  | { readonly _tag: "Directory" }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Failed"; readonly method: string; readonly cause: PlatformError.PlatformError }

/**
 * The host operation the walk is built on: one directory, listed and measured.
 *
 * One call per directory rather than per entry, so a host can measure a
 * directory's entries together. {@link fileSystemHost} is the portable one; a
 * Node host reads entry types off the listing and measures files concurrently.
 * The order of the answer is free: the walk sorts it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  readonly entries: (
    directory: string,
    keep: (name: string) => boolean
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly measured: Measured }>, PlatformError.PlatformError>
}

/**
 * A {@link Host} over Effect's `FileSystem`, two host calls per entry.
 *
 * Symlinks are skipped before anything else looks at them. `readLink`
 * succeeding is the definition of "this entry is a symlink", and it is the
 * only question Effect's `FileSystem` can ask about a path without resolving
 * it: `stat` follows, so on a host filesystem a linked directory would
 * otherwise be descended into — out of the root, or around a cycle — and a
 * linked file would contribute the size and mtime of whatever it points at.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fileSystemHost = (fs: FileSystem.FileSystem): Host => ({
  entries: (directory, keep) =>
    Effect.flatMap(fs.readDirectory(directory), (names) =>
      Effect.forEach(names.filter(keep), (name) => {
        const path = `${directory}/${name}`
        return Effect.gen(function*() {
          const link = yield* fs.readLink(path).pipe(Effect.asSome, Effect.orElseSucceed(() => Option.none()))
          if (Option.isSome(link)) return { _tag: "Skipped" } as const
          const info = yield* Effect.result(fs.stat(path))
          if (Result.isFailure(info)) return { _tag: "Failed", method: "stat", cause: info.failure } as const
          if (info.success.type === "Directory") return { _tag: "Directory" } as const
          if (info.success.type !== "File") return { _tag: "Skipped" } as const
          return {
            _tag: "File",
            size: Number(info.success.size),
            modified: Option.match(info.success.mtime, { onNone: () => 0, onSome: (at) => at.getTime() })
          } as const
        }).pipe(Effect.map((measured): { readonly name: string; readonly measured: Measured } => ({ name, measured })))
      }))
})

/** Whether one entry name is skipped outright. */
const ignored = (name: string, suffixes: ReadonlyArray<string>): boolean =>
  suffixes.some((suffix) => name.endsWith(suffix))

/**
 * Walks one workspace through a {@link Host} and folds it into one measurement.
 *
 * The listing is built depth-first in sorted order so two measurements of an
 * unchanged tree are byte-identical whichever host took them, and the digest
 * is taken over the whole listing rather than per file: the controller only
 * ever asks whether two measurements are equal, so one hash is all it can use.
 *
 * @category constructors
 * @since 0.1.0
 */
export const observeHost = (
  host: Host,
  root: string,
  options: Options = {}
): Effect.Effect<EngineLike.Observation> =>
  Effect.gen(function*() {
    const prune = new Set(options.prune ?? defaultPrune)
    const suffixes = options.ignoreSuffixes ?? defaultIgnoreSuffixes
    const excluded = new Set(options.excludePaths)
    const maxPaths = options.maxPaths ?? defaultMaxPaths
    const keep = (name: string): boolean => !prune.has(name) && !ignored(name, suffixes)
    const lines: Array<string> = []
    // Set the moment the walk turns back at the bound with entries still to
    // visit, which is what makes `complete` false. A walk that ends because it
    // ran out of tree and a walk that ends because it ran out of budget are
    // different answers, and only the first is the workspace's.
    let bounded = false
    let unreadable = false
    const failed = (method: string, path: string, cause: PlatformError.PlatformError): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Disappearance is movement; every other failure leaves coverage unknown.
        if (cause.reason._tag === "NotFound") return
        unreadable = true
        yield* Effect.logWarning(`Workspace observation could not ${method} ${path}`, cause)
      })
    const walk = (directory: string, relative = ""): Effect.Effect<void> =>
      Effect.gen(function*() {
        const within = (name: string): string => relative === "" ? name : `${relative}/${name}`
        const entries = yield* host.entries(directory, (name) => keep(name) && !excluded.has(within(name))).pipe(
          Effect.catch((cause) => failed("readDirectory", directory, cause).pipe(Effect.as([])))
        )
        // Names in one directory are unique, so the order is total. `<` is the
        // UTF-16 order `Array.prototype.sort` uses on strings.
        for (const { name, measured } of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (lines.length >= maxPaths) {
            bounded = true
            return
          }
          const path = `${directory}/${name}`
          if (measured._tag === "Failed") yield* failed(measured.method, path, measured.cause)
          else if (measured._tag === "Directory") yield* walk(path, within(name))
          else if (measured._tag === "File") lines.push(`${measured.size} ${measured.modified} ${JSON.stringify(path)}`)
        }
      })
    yield* walk(root.replaceAll(/\/+$/g, ""))
    return new EngineLike.Observation({
      digest: Digest.digest(lines.join("\n")),
      paths: lines.length,
      complete: !bounded && !unreadable
    })
  })

/**
 * Walks one workspace through Effect's `FileSystem`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const observe = (
  fs: FileSystem.FileSystem,
  root: string,
  options: Options = {}
): Effect.Effect<EngineLike.Observation> => observeHost(fileSystemHost(fs), root, options)

/**
 * Builds an {@link Observer} over one workspace root.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  fs: FileSystem.FileSystem,
  root: string,
  options: Options = {}
): Observer => Observer.of({ observe: observe(fs, root, options) })

/**
 * Provides an {@link Observer} over the workspace root through a {@link Host}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHost = (
  host: Host,
  root: string,
  options: Options = {}
): Layer.Layer<Observer> => Layer.succeed(Observer)(Observer.of({ observe: observeHost(host, root, options) }))

/**
 * Provides an {@link Observer} over the workspace root, from the `FileSystem`
 * in context.
 *
 * That must be the **host's** `FileSystem` and not a kernel-guarded one. The
 * module documentation above states why it is safe and what guarding it costs;
 * `NodeControl.layerHostPlatform` is the layer the CLI provides it under.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  root: string,
  options: Options = {}
): Layer.Layer<Observer, never, FileSystem.FileSystem> =>
  Layer.effect(Observer)(Effect.map(FileSystem.FileSystem, (fs) => make(fs, root, options)))

/**
 * Provides an observer that reports a failure rather than a measurement.
 *
 * This is not "measures nothing" — a composition that wants that provides no
 * observer at all, and `FlowEngineLike` then reports the workspace as
 * unobserved. This exists so a host can prove the failing path.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Observer> = Layer.succeed(Observer)(
  Observer.of({
    observe: Effect.fail(
      new HarnessError({ code: "engine_failed", message: "No workspace observer is configured" })
    )
  })
)
