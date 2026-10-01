/**
 * What applying a session's work on the host produced.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import { Unchanged } from "../Sandbox/Work.ts"

/**
 * The work is one conflict-free jj change on `onto`.
 *
 * @category models
 * @since 1.0.0
 */
export class Merged extends Schema.TaggedClass<Merged>()("Merged", {
  /** The jj change id holding the work. Stable across rewrites of the change. */
  change: Schema.String,
  /** The commit id the change had when the outcome was read. */
  commit: Schema.String,
  /** The commit id the change was applied onto. */
  onto: Schema.String
}) {}

/**
 * The work is one jj change on `onto` that records conflicts, the way `jj
 * rebase` records them: the change exists, its conflicted files hold jj's
 * conflict markers, and nothing was dropped or overwritten.
 *
 * @category models
 * @since 1.0.0
 */
export class Conflicted extends Schema.TaggedClass<Conflicted>()("Conflicted", {
  /** The jj change id holding the work. */
  change: Schema.String,
  /** The commit id the change had when the outcome was read. */
  commit: Schema.String,
  /** The commit id the change was applied onto. */
  onto: Schema.String,
  /** The repository-relative paths that hold conflicts. */
  paths: Schema.Array(Schema.String)
}) {}

/**
 * What `apply` returns: {@link Merged}, {@link Conflicted}, or the session's
 * own {@link Unchanged}, which applies as nothing.
 *
 * @category models
 * @since 1.0.0
 */
export const Outcome = Schema.Union([Merged, Conflicted, Unchanged])

/**
 * The value form of {@link Outcome}.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome = Merged | Conflicted | Unchanged

/**
 * Why work could not be applied.
 *
 * - `base_not_found`: the work's base is not in the repository, even after
 *   the configured fetch.
 * - `onto_unresolved`: `onto` does not name exactly one commit.
 * - `patch_rejected`: the patch does not apply to its own base, so it was not
 *   captured from that base.
 * - `conflict`: the `failOnConflict` strategy met a conflict; `paths` names it.
 * - `resolution_rejected`: a resolver's change still has conflicts or does
 *   not descend from `onto`.
 * - `vcs_failed`: `jj` or `git` failed on the host.
 *
 * @category errors
 * @since 1.0.0
 */
export class MergeError extends Schema.TaggedError<MergeError>()("@smthrs/sandbox/SandboxMerge/MergeError", {
  reason: Schema.Literals([
    "base_not_found",
    "onto_unresolved",
    "patch_rejected",
    "conflict",
    "resolution_rejected",
    "vcs_failed"
  ]),
  message: Schema.String,
  paths: Schema.optional(Schema.Array(Schema.String))
}) {}
