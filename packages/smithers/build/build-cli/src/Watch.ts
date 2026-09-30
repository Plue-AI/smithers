/** Dependency-aware execution in fresh processes, with cancellation on file changes.
 * @since 0.1.0
 */

import { Cause, Effect, Exit, Queue, Stream } from "effect"
import { createHash } from "node:crypto"
import { watch } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as ContainedProcess from "./internal/ContainedProcess.ts"

/** Runs fresh CLI processes until interrupted, cancelling stale work when an input changes.
 * @category execution
 * @since 0.1.0
 */
export const run = async (options: {
  readonly root: string
  readonly args: ReadonlyArray<string>
  readonly ignored: ReadonlyArray<string>
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly debounceMs: number
  /** How often the workspace is rescanned for changes the notifier dropped. Defaults to 1000 ms. */
  readonly rescanMs?: number | undefined
  readonly once: boolean
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly cycleCompleted?:
    | ((cycle: {
      readonly number: number
      readonly exitCode: number
      readonly output: string
    }) => void)
    | undefined
}) => {
  options.signal?.throwIfAborted()
  // The package bootstrap installs declaration identity hooks before importing
  // any command modules, both in a checkout and in a compiled distribution.
  const manifest = createRequire(import.meta.url).resolve("@smthrs/build-cli/package.json")
  const entry = fileURLToPath(new URL("./src/main.js", pathToFileURL(manifest)))
  const ignored = [".git", "node_modules", ...options.ignored].map((path) =>
    path.replaceAll("\\", "/").replace(/\/$/, "")
  )
  const relevant = (path: string) =>
    !path.split("/").includes("node_modules") &&
    !ignored.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  // The notifier coalesces and drops events under load (FSEvents discards its
  // must-scan notifications, and a busy fseventsd can hold or lose an edit),
  // so each cycle records a digest of the watched tree and a periodic rescan
  // starts a replacement when the tree no longer matches it.
  let baseline: string | undefined
  let baselineObserved = 0
  let cycles = 0
  let exitCode = 0
  // switchMap discards a replaced stream's error. Retain process cleanup
  // failures so a replacement cannot start after containment failed.
  let failure: unknown
  // A replacement starts after its stale cycle's cleanup, so it already sees
  // every change observed until then. Those changes must not replace it again.
  let observed = 0
  let covered = 0
  const recordBaseline = Effect.suspend(() => {
    const since = observed
    return Effect.tryPromise({
      try: () => digest(options.root, relevant),
      catch: (cause) => cause instanceof Error ? cause : new Error("workspace rescan failed", { cause })
    }).pipe(Effect.map((tree) => {
      baseline = tree
      baselineObserved = since
    }))
  })
  const cycle = Effect.suspend(() => {
    if (failure !== undefined) return Effect.fail(failure)
    return options.once ? launch : Effect.andThen(recordBaseline, launch)
  })
  const launch = Effect.suspend(() => {
    const number = ++cycles
    let output = ""
    return ContainedProcess.runEffect({
      command: process.execPath,
      args: [entry, ...options.args, "--workspace", options.root],
      cwd: options.root,
      environment: options.environment,
      stdout: (text) => {
        if (options.cycleCompleted !== undefined) output = `${output}${text}`.slice(-16 * 1024)
        options.stdout(text)
      },
      stderr: options.stderr
    }).pipe(Effect.onExit((exit) =>
      Effect.sync(() => {
        exitCode = Exit.isSuccess(exit) ? exit.value : 1
        if (Exit.isFailure(exit)) {
          if (Cause.hasInterruptsOnly(exit.cause)) covered = observed
          else failure = Cause.squash(exit.cause)
        }
        options.cycleCompleted?.({ number, exitCode, output })
      })
    ))
  })
  const changes = Stream.callback<number, Error>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          let closed = false
          let scanning = false
          let again = false
          // Offers a change only when no event arrived since the running
          // cycle's digest; an observed event already has a replacement coming.
          const rescan = (): void => {
            if (closed || baseline === undefined) return
            if (scanning) {
              again = true
              return
            }
            scanning = true
            const expected = baseline
            digest(options.root, relevant).then(
              (tree) => {
                if (!closed && tree !== expected && baseline === expected && observed === baselineObserved) {
                  Queue.offerUnsafe(queue, ++observed)
                }
              },
              (error) => {
                if (!closed) Queue.failCauseUnsafe(queue, Cause.fail(error))
              }
            ).finally(() => {
              scanning = false
              if (again) {
                again = false
                rescan()
              }
            })
          }
          const timer = setInterval(rescan, options.rescanMs ?? 1000)
          const watcher = watch(options.root, { recursive: true }, (_event, filename) => {
            // A notification without a name says only that something changed.
            if (filename === null) return rescan()
            const path = filename.toString().replaceAll("\\", "/")
            if (relevant(path)) Queue.offerUnsafe(queue, ++observed)
          }).on("error", (error) => {
            Queue.failCauseUnsafe(queue, Cause.fail(error))
          })
          return () => {
            closed = true
            clearInterval(timer)
            watcher.close()
          }
        },
        catch: (cause) => cause instanceof Error ? cause : new Error("filesystem watch failed", { cause })
      }),
      (close) => Effect.sync(close)
    ), { bufferSize: 1, strategy: "sliding" }).pipe(
      Stream.debounce(options.debounceMs),
      Stream.filter((change) => change > covered),
      Stream.prepend([0])
    )
  const result = await Effect.runPromiseExit(
    (options.once ? Stream.make(0) : changes).pipe(
      Stream.switchMap(() => Stream.fromEffect(cycle), { bufferSize: 1 }),
      Stream.runDrain,
      Effect.scoped
    ),
    { signal: options.signal }
  )
  if (failure !== undefined) throw failure
  if (Exit.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)) throw Cause.squash(result.cause)
  return { cycles, exitCode, stopped: options.signal?.aborted ?? false }
}

/**
 * A digest of every relevant path's type, size, modification time and inode,
 * in name order. Entries that vanish or cannot be read mid-walk are skipped.
 */
const digest = async (root: string, relevant: (path: string) => boolean): Promise<string> => {
  const hash = createHash("sha256")
  const skipped = (cause: unknown) =>
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory === "" ? root : `${root}/${directory}`, { withFileTypes: true })
      .catch((cause) => {
        if (skipped(cause)) return []
        throw cause
      })
    const paths = entries
      .map((entry) => ({ entry, path: directory === "" ? entry.name : `${directory}/${entry.name}` }))
      .filter(({ path }) => relevant(path))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const stats = await Promise.all(
      paths.map(({ path }) =>
        lstat(`${root}/${path}`, { bigint: true }).catch((cause) => {
          if (skipped(cause)) return undefined
          throw cause
        })
      )
    )
    for (const [index, { entry, path }] of paths.entries()) {
      const stat = stats[index]
      if (stat === undefined) continue
      hash.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}\n`)
      if (entry.isDirectory()) await visit(path)
    }
  }
  await visit("")
  return hash.digest("hex")
}
