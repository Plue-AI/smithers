/**
 * The public-API-against-prose review macro.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import { review } from "./ReviewLint.ts"
import type { Options, ReviewLint } from "./ReviewLint.ts"

/**
 * Reviews changed public APIs against the prose that documents them.
 *
 * `context` defaults to the package's own `README.md` and `docs/*.md` plus the
 * site API reference pages at
 * `//apps/site/src/content/docs/docs/reference/api/<package>*.mdx`, where
 * `<package>` is the last directory in `cwd`. At the workspace root only the
 * local prose is selected. Override `context` to opt into concept or guide
 * sections. Context crosses package boundaries and is read into every batch
 * whether or not it changed; the set must fit LlmLint's 2 MiB aggregate cap.
 * Findings report at `warning` while the rubric is tuned. The call returns a
 * declaration and runs no review; see "Failure contracts" in the package
 * README for declaration and execution failures.
 *
 * @example
 * ```ts
 * import { ReviewDocsAgainstCode } from "@smthrs/repo-targets"
 *
 * const reviewDocsAgainstCode = ReviewDocsAgainstCode({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewDocsAgainstCode = (options: Options): ReviewLint => {
  const packageName = Input.resolvePath("", options.cwd).replace(/\/$/, "").split("/").at(-1)!
  return review(options, {
    summary: "A cheap Codex review of changed public APIs against package prose and matching site API references.",
    include: [Input.glob("src/**")],
    context: [
      Input.glob("README.md"),
      Input.glob("docs/*.md"),
      ...(packageName === "." ? [] : [
        Input.glob(`//apps/site/src/content/docs/docs/reference/api/${packageName}*.mdx`)
      ])
    ],
    batchSize: 3,
    failOn: "warning",
    rubric: [
      "The context files are package prose and selected site reference, concept, or guide pages.",
      "Compare their current contents against the changed source, whether or not they changed.",
      "1. A public export whose reference page still describes removed, renamed, or changed",
      "   behavior is a warning against the reference page.",
      "2. A new public export absent from its package's reference page is a warning against the",
      "   reference page.",
      "3. A concept page contradicted by the change is a warning against the concept page.",
      "Name the stale documentation page in `file`. Do not report a source file for these.",
      "Private helpers, tests, and internal modules are out of scope."
    ].join("\n")
  })
}
