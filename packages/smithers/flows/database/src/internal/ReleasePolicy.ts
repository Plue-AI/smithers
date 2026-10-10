/** The manifest facts this release's refusal and notice texts quote.
 * @since 1.0.0
 */

/**
 * The published version, mirroring `version` in this package's manifest.
 *
 * Every refusal names the release it speaks for, so a version bump has to
 * reach the text an operator reads. This is the one copy the bump edits;
 * `test/SourceReferences.test.ts` fails when it drifts from the manifest or
 * when a second copy appears under `src/`.
 *
 * @category models
 * @since 1.0.0
 */
export const releaseVersion = "1.0.0-rc.4"

/**
 * The Node.js floor, mirroring `engines.node` in this package's manifest.
 *
 * The runtime refusal quotes it, so a raised floor that missed this line
 * would tell an operator to install the version they already run.
 *
 * @category models
 * @since 1.0.0
 */
export const nodeFloor = ">=26.4.0"
