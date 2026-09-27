/** Dependency-aware execution in fresh processes, with cancellation on file changes.
 * @since 0.1.0
 */

import { Cause, Effect, Exit, Queue, Stream } from "effect"
import { watch } from "node:fs"
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
  let cycles = 0
  let exitCode = 0
  // switchMap discards a replaced stream's error. Retain process cleanup
  // failures so a replacement cannot start after containment failed.
  let failure: unknown
  // A replacement starts after its stale cycle's cleanup, so it already sees
  // every change observed until then. Those changes must not replace it again.
  let observed = 0
  let covered = 0
  const cycle = Effect.suspend(() => {
    if (failure !== undefined) return Effect.fail(failure)
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
        try: () =>
          watch(options.root, { recursive: true }, (_event, filename) => {
            if (filename === null) return
            const path = filename.toString().replaceAll("\\", "/")
            if (
              path.split("/").includes("node_modules") ||
              ignored.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
            ) return
            Queue.offerUnsafe(queue, ++observed)
          }).on("error", (error) => {
            Queue.failCauseUnsafe(queue, Cause.fail(error))
          }),
        catch: (cause) => cause instanceof Error ? cause : new Error("filesystem watch failed", { cause })
      }),
      (watcher) => Effect.sync(() => watcher.close())
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
