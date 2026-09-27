/**
 * The identity, migration, and durable-key review macro.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import { review } from "./ReviewLint.ts"
import type { Options, ReviewLint } from "./ReviewLint.ts"

/**
 * Reviews changed sources for identity strings, migrations, persisted
 * schemas, and durable keys.
 *
 * The rubric is written for a package that persists something: a store, a
 * journal, a cache, or a database driver. `include` defaults to `src/**`,
 * which already contains a `src/migrations` tree, and findings fail the
 * target at `error`. The call returns a declaration and runs no review; see
 * "Failure contracts" in the package README for declaration and execution
 * failures.
 *
 * @example
 * ```ts
 * import { ReviewTagsMigrationsAndKeys } from "@smthrs/repo-targets"
 *
 * const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewTagsMigrationsAndKeys = (options: Options): ReviewLint =>
  review(options, {
    summary:
      "A cheap Codex review of the diff against origin/main for identity strings, migrations, persisted schemas and durable keys.",
    include: [Input.glob("src/**")],
    context: [],
    batchSize: 2,
    failOn: "error",
    rubric: [
      "1. An identity string passed to `Action.make`, `Flow.make`, a service tag, or a",
      "   `Schema.TaggedError` tag must equal the defining module path. A tag that names a",
      "   different module, a moved module that kept its old tag, or a tag that no longer",
      "   matches the file it is defined in is an error.",
      "2. A rename must rename the identity everywhere and leave no backwards-compatible",
      "   alias, re-export, or fallback branch. A compat alias is an error.",
      "3. A change to a persisted schema, a table, or a stored column must add a NEW migration",
      "   file. Editing a migration that has already shipped is an error.",
      "4. A change to a durable key: a step key, a cache key, a run key, or the material any of",
      "   them hashes, is a replay and cache hazard. It is an error unless the diff carries an",
      "   explicit note saying so.",
      "Report the offending identity or key by name. Line 1 is fine for whole-file findings."
    ].join("\n")
  })
