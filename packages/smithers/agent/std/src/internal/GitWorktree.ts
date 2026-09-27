/**
 * Detached checkouts shared by checkpoint reads and baseline test runs.
 *
 * @since 1.0.0
 */

import type { ChildProcessSpawner } from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Semaphore } from "effect"
import * as StdError from "../StdError.ts"
import * as Exec from "./Exec.ts"

const failed = (message: string, code: StdError.Code = "command_failed") => new StdError.StdError({ code, message })

const git = (root: string, args: ReadonlyArray<string>) =>
  Exec.exec("git", { args: ["-C", root, ...args] }).pipe(
    Effect.mapError((error) => failed(`git could not run: ${error.message}`))
  )

const resolveCommit = (root: string, refs: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    for (const ref of refs) {
      const answer = yield* git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      const commit = answer.stdout.trim()
      if (answer.exitCode === 0 && commit !== "") return { ref, commit }
    }
    return yield* Effect.fail(failed(`No commit resolves from ${refs.join(" or ")} in ${root}.`, "not_found"))
  })

const formatState = (root: string) =>
  Effect.gen(function*() {
    const version = yield* git(root, ["config", "--local", "--get", "core.repositoryformatversion"])
    const marker = yield* git(root, ["config", "--local", "--get", "extensions.relativeWorktrees"])
    return {
      version: version.exitCode === 0 ? version.stdout.trim() : undefined,
      marked: marker.exitCode === 0
    }
  })

// Git 2.48+ stamps the shared repository when adding a relative worktree.
// Older container Git then refuses the repository. Restore only introduced
// keys before use; the relative .git pointers keep working without the stamp.
const restoreFormat = (root: string, before: { readonly version: string | undefined; readonly marked: boolean }) =>
  Effect.gen(function*() {
    if (before.marked) return
    const marker = yield* git(root, ["config", "--local", "--get", "extensions.relativeWorktrees"])
    if (marker.exitCode !== 0) return
    const unset = yield* git(root, ["config", "--local", "--unset", "extensions.relativeWorktrees"])
    if (unset.exitCode !== 0) {
      return yield* Effect.fail(failed(`Could not restore the repository format: ${unset.stderr.trim()}`))
    }
    const version = yield* git(root, ["config", "--local", "core.repositoryformatversion", before.version ?? "0"])
    if (version.exitCode !== 0) {
      return yield* Effect.fail(failed(`Could not restore the repository format: ${version.stderr.trim()}`))
    }
  })

// Serialize format read/add/restore within this process, even across stores.
// Only setup holds the permit; callbacks can use their checkouts concurrently.
const setup = Semaphore.makeUnsafe(1)

const withDetachedWorktree = <A, E, R>(
  root: string,
  prefix: string,
  commit: string,
  use: (host: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | StdError.StdError, R | ChildProcessSpawner> =>
  Effect.gen(function*() {
    // Allocate on execution, including when the same Effect is run twice.
    // Never remove an existing checkout: another call may still be using it.
    const host = `${root.replace(/\/+$/, "")}/${prefix}-${globalThis.crypto.randomUUID()}`
    return yield* Effect.acquireUseRelease(
      Effect.succeed(host),
      () =>
        Effect.gen(function*() {
          yield* setup.withPermit(
            Effect.gen(function*() {
              const before = yield* formatState(root)
              const added = yield* git(root, [
                "-c",
                "worktree.useRelativePaths=true",
                "worktree",
                "add",
                "--detach",
                "--force",
                host,
                commit
              ]).pipe(
                Effect.flatMap((added) =>
                  added.exitCode === 0
                    ? Effect.void
                    : Effect.fail(failed(`Could not check out ${commit}: ${added.stderr.trim()}`))
                ),
                Effect.exit
              )
              yield* restoreFormat(root, before)
              yield* added
            }).pipe(Effect.uninterruptible)
          )
          return yield* use(host)
        }),
      // A checkout left behind is a stale copy of the repository inside the
      // workspace. Walks prune it, but the operator must still hear about it.
      () =>
        git(root, ["worktree", "remove", "--force", host]).pipe(
          Effect.flatMap((removed) =>
            removed.exitCode === 0 ? Effect.void : Effect.fail(failed(removed.stderr.trim()))
          ),
          Effect.catch((error) =>
            Effect.logWarning("could not remove a scratch checkout").pipe(
              Effect.annotateLogs({ path: host, reason: error.message })
            )
          )
        )
    )
  })

/**
 * Internal Git operations used by both checkpoint and baseline leases.
 *
 * @category utilities
 * @since 1.0.0
 */
export const GitWorktree = { resolveCommit, withDetachedWorktree }
