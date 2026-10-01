/**
 * What `apply` does when work conflicts with its target.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import { type Conflicted, Merged, MergeError } from "./Outcome.ts"
import type { Repository } from "./Repository.ts"

/**
 * A merge strategy: given the conflicted change `apply` recorded, answer the
 * outcome to report, or fail.
 *
 * `apply` always lands the work first, so a strategy starts from a change
 * that exists and loses nothing; it decides only what happens next.
 *
 * @category models
 * @since 1.0.0
 */
export interface Strategy<E = never, R = never> {
  readonly onConflict: (
    conflicted: Conflicted,
    repository: Repository
  ) => Effect.Effect<Merged | Conflicted, E | MergeError, R>
}

/**
 * The default: keep the conflicted change and report it, as `jj rebase` does.
 * Its files carry jj's conflict markers until someone resolves them.
 *
 * @category strategies
 * @since 1.0.0
 */
export const recordConflicts: Strategy = { onConflict: (conflicted) => Effect.succeed(conflicted) }

/**
 * Abandon the conflicted change and fail with a `conflict` {@link MergeError}
 * naming its paths. The work itself stays wherever the caller keeps it, in
 * the journal for an action's result, so applying again later is possible.
 *
 * @category strategies
 * @since 1.0.0
 */
export const failOnConflict: Strategy = {
  onConflict: (conflicted, repository) =>
    Effect.andThen(
      repository.jj(["abandon", conflicted.commit]),
      new MergeError({
        reason: "conflict",
        message: `the work conflicts with ${conflicted.onto} in ${conflicted.paths.join(", ")}`,
        paths: conflicted.paths
      })
    )
}

/**
 * Hand the conflicted change to `resolver`, then verify what it produced.
 *
 * The resolver receives the conflicted change (an agent may edit it in a
 * workspace and squash, or replace it) and answers a jj revision holding the
 * resolution. That revision must name exactly one commit that descends from
 * the change's target, and neither it nor anything between the target and it
 * may hold a conflict; otherwise the strategy fails with
 * `resolution_rejected` and the conflicted change is left as it is.
 *
 * @category strategies
 * @since 1.0.0
 */
export const resolveWith = <E, R>(
  resolver: (conflicted: Conflicted, repository: Repository) => Effect.Effect<{ readonly change: string }, E, R>
): Strategy<E, R> => ({
  onConflict: (conflicted, repository) =>
    Effect.gen(function*() {
      const { change } = yield* resolver(conflicted, repository)
      const rejected = (why: string) =>
        new MergeError({ reason: "resolution_rejected", message: `the resolution ${change} ${why}` })
      const named = (yield* Effect.mapError(
        repository.jj(["log", "--no-graph", "-r", change, "-T", "commit_id ++ \"\\t\" ++ change_id ++ \"\\n\""]),
        () => rejected("names no commit")
      )).trim().split("\n")
      if (named.length !== 1 || named[0] === "") return yield* rejected("must name exactly one commit")
      const [commit, changeId] = named[0]!.split("\t") as [string, string]
      const descends = yield* repository.jj([
        "log",
        "--no-graph",
        "-r",
        `${conflicted.onto} & ::${commit}`,
        "-T",
        "commit_id"
      ])
      if (descends.trim() === "") return yield* rejected(`does not descend from ${conflicted.onto}`)
      const conflicts = yield* repository.jj([
        "log",
        "--no-graph",
        "-r",
        `(${conflicted.onto}::${commit}) & conflicts()`,
        "-T",
        "commit_id ++ \"\\n\""
      ])
      if (conflicts.trim() !== "") return yield* rejected("still has conflicts")
      return new Merged({ change: changeId, commit, onto: conflicted.onto })
    })
})
