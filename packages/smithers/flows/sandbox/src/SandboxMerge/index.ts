/**
 * Lands a sandbox session's work on the host.
 *
 * `Sandbox.run` returns a body's result with the {@link Work} its machine's
 * checkout gained: a git diff from a base the host can resolve. This module
 * is the host half. {@link apply} turns that diff into one jj change on a
 * target revision, exactly as `jj rebase` would have produced it: clean, or
 * with first-class conflicts recorded in the change. A {@link Strategy}
 * decides what a conflict means for the caller: keep it
 * ({@link recordConflicts}, the default), refuse it ({@link failOnConflict}),
 * or hand it to a resolver whose answer is verified ({@link resolveWith}).
 *
 * The 0.x `<Sandbox>` component did the same through a `diffBundle` its
 * provider returned and `applyDiffBundle` wrote into the parent's tree with
 * `git apply`; that executor was removed with the JSX runtime. This keeps its
 * idea, a provider-neutral diff the host applies, and replaces the copy-back
 * with a change in the host's history, so a conflict is recorded instead of
 * failing the apply or overwriting files.
 *
 * @since 1.0.0
 */

import type { Work } from "../Sandbox/Work.ts"

export * from "./apply.ts"
export * from "./Outcome.ts"
export type { Repository } from "./Repository.ts"
export * from "./Strategy.ts"
export type { Work }
