/**
 * The host jj repository work is applied to.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { MergeError } from "./Outcome.ts"

/**
 * A host jj repository, as a merge strategy sees it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Repository {
  /** The repository's root directory on the host. */
  readonly path: string
  /**
   * Runs `jj -R <path> --ignore-working-copy` with `args` and answers its
   * standard output. Nothing here snapshots or rewrites a working copy, so
   * the repository may be a checkout other people are editing.
   */
  readonly jj: (args: ReadonlyArray<string>) => Effect.Effect<string, MergeError>
}

/** Options for one host command. */
interface Run {
  /** The directory the command runs in; `jj` prints paths relative to it. */
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly stdin?: string | undefined
}

/**
 * One host command's output, failing with `vcs_failed` when it exits non-zero
 * or cannot start.
 *
 * @category utils
 * @since 1.0.0
 */
export const output = (
  spawner: ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  options: Run = {}
): Effect.Effect<string, MergeError> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
      ...options.cwd === undefined ? {} : { cwd: options.cwd },
      // Extends, never replaces, the host environment: `PATH` and the identity still apply.
      ...options.env === undefined ? {} : { env: options.env, extendEnv: true },
      ...options.stdin === undefined ? {} : { stdin: Stream.make(new TextEncoder().encode(options.stdin)) }
    }))
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (code !== 0) {
      return yield* new MergeError({
        reason: "vcs_failed",
        message: `${command} ${args.join(" ")} exited ${code}: ${stderr.trim().split("\n").slice(-3).join("\n")}`
      })
    }
    return stdout
  })).pipe(
    Effect.catchTag(
      "PlatformError",
      (cause) => new MergeError({ reason: "vcs_failed", message: `${command} could not run: ${cause.message}` })
    )
  )

/**
 * The {@link Repository} at `path`, running jj through the ambient spawner.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (path: string): Effect.Effect<Repository, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return {
      path,
      jj: (args) =>
        // From the repository's root, so the paths jj prints are repository-relative.
        output(spawner, "jj", ["-R", path, "--ignore-working-copy", "--no-pager", "--color=never", ...args], {
          cwd: path
        })
    }
  })
