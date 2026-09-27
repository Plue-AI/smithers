/**
 * The export-against-JSDoc review macro.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import { review } from "./ReviewLint.ts"
import type { Options, ReviewLint } from "./ReviewLint.ts"

/**
 * Reviews changed exports against the JSDoc that describes them.
 *
 * `include` defaults to `src/**\/*.ts`, and findings report at `warning` while
 * the rubric is tuned. Presence of JSDoc is already gated by eslint; this
 * rubric is about truthfulness alone. The call returns a declaration and runs
 * no review; see "Failure contracts" in the package README for declaration
 * and execution failures.
 *
 * @example
 * ```ts
 * import { ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
 *
 * const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewJsdocAgainstCode = (options: Options): ReviewLint =>
  review(options, {
    summary: "A cheap Codex review of changed exports against their JSDoc.",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    batchSize: 3,
    failOn: "warning",
    rubric: [
      "For each export whose body changed in this diff:",
      "1. The JSDoc prose must still describe what the code does. Prose that describes the old",
      "   behavior is a warning.",
      "2. The documented error channel must match the actual `Schema.TaggedError` union the",
      "   code can fail with. A documented error the code cannot raise, or a raised error the",
      "   doc never mentions, is a warning.",
      "3. A documented default must match the default in the code.",
      "4. `@since` on a NEW export must be the current unreleased version, not a value",
      "   copy-pasted from a neighboring export.",
      "Report against the source file and the line of the JSDoc block. Presence of JSDoc is",
      "already gated by eslint; only truthfulness is in scope."
    ].join("\n")
  })
