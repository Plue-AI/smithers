/**
 * Instances excluded from the scoreboard by name, and the cause on record.
 *
 * An exclusion is a claim about the *measurement*, never about a harness, and
 * this file is the only place the rig makes one. Three rules keep it honest,
 * and every reader below obeys all three:
 *
 * 1. **Both arms, or neither.** An exclusion removes an instance from the
 *    denominator for flows and for codex identically. A row dropped from one
 *    side is tuning; a row dropped from both is scoping.
 * 2. **The cause is documented and is about the environment.** Each entry
 *    carries the sentence a reader would otherwise have to reconstruct from a
 *    disclosure section, and that sentence has to name something outside the
 *    agent — a grading container, a public service, a dataset defect. "The
 *    harness does badly here" is never a cause.
 * 3. **Both denominators are printed, always.** Every rate this rig states over
 *    a population an entry here can reach — `compare-runs.mjs`,
 *    `three-way.mjs`, `compare-arms.mjs` and `fullbench-report.mjs` — carries
 *    the scored count *and* the raw count, in the same sentence. A scoreboard
 *    that quietly says 43 is a scoreboard nobody can check. A population that
 *    excludes nothing reads exactly as it did before this file existed, so
 *    every reader can obey the rule unconditionally.
 *
 * ## The `psf/requests` pair
 *
 * `fullbench/reports/rerun-r92.md` records three waves producing three
 * different verdicts for one byte-identical patch, decided entirely by whether
 * `httpbin.org` was answering:
 *
 * - `psf__requests-1766` graded `resolved` in r90 and r91 and `unresolved` in
 *   r92, on a patch byte-identical across all three. It failed exactly one
 *   `PASS_TO_PASS` test — `test_mixed_case_scheme_acceptable` — and passed
 *   every one of its six `FAIL_TO_PASS` tests. That test needs an https route
 *   the grading container does not have: `lib/httpbin.sh` serves a documented
 *   local fallback, and the file says in those words that the fallback cannot
 *   answer it.
 * - `psf__requests-2317` went the same way. A re-grade against the public
 *   service found that service degraded too — 22 of 133 `PASS_TO_PASS` and 5 of
 *   8 `FAIL_TO_PASS` refused — so there was no healthy environment to appeal to
 *   in either direction.
 *
 * Both codex verdicts for the pair come from a backfill graded when
 * `httpbin.org` was healthy, so the two arms are not like-for-like on those
 * rows today. That is the whole reason the exclusion is by name: nothing about
 * either patch is in question, and no reading of these two rows says anything
 * about a harness.
 *
 * ## Getting an instance back
 *
 * Delete its entry. The right repair is an https listener the graded container
 * trusts, at which point both rows are measurements again and both arms can be
 * re-graded against it. Until then the honest number is the one that says how
 * many instances were scored and how many were run.
 *
 * @since 0.1.0
 */

/**
 * The excluded instances, keyed by id, each with the cause on record.
 *
 * @category constants
 * @since 0.1.0
 */
export const EXCLUDED = new Map([
  [
    "psf__requests-1766",
    {
      cause:
        "grading environment: the container has no https httpbin route, so `test_mixed_case_scheme_acceptable` cannot pass"
        + " against the documented local fallback, and the public service was degraded when the re-grade appealed to it."
        + " The r92 patch is byte-identical to r90's and r91's, which graded resolved. Excluded for both arms.",
      reportedIn: "fullbench/reports/rerun-r92.md"
    }
  ],
  [
    "psf__requests-2317",
    {
      cause: "grading environment: same httpbin dependency. A re-grade against the public service refused 22 of 133"
        + " PASS_TO_PASS and 5 of 8 FAIL_TO_PASS, so no healthy environment existed to appeal to in either direction."
        + " Excluded for both arms.",
      reportedIn: "fullbench/reports/rerun-r92.md"
    }
  ]
])

/**
 * Whether this instance is outside the scoreboard.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isExcluded = (id) => EXCLUDED.has(id)

/**
 * The excluded instances present in a population, with their causes.
 *
 * Only the ones actually present: a scoreboard over a sample that never
 * contained `psf/requests` says nothing about it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const excludedIn = (ids) =>
  [...ids]
    .filter(isExcluded)
    .sort()
    .map((id) => ({ id, ...EXCLUDED.get(id) }))

/**
 * The two denominators one population has: what was scored, and what was run.
 *
 * Returned as a pair rather than a number so no caller can print one without
 * the other by accident.
 *
 * @category conversions
 * @since 0.1.0
 */
export const denominators = (ids) => {
  const excluded = excludedIn(ids)
  const raw = [...ids].length
  return { scored: raw - excluded.length, raw, excluded }
}

/**
 * Both denominators in one phrase, which is the only way this rig states one.
 *
 * @category rendering
 * @since 0.1.0
 */
export const denominatorLabel = ({ scored, raw }) => (scored === raw ? `${raw}` : `${scored} scored of ${raw} run`)

/**
 * The markdown section naming what was excluded and why, or nothing when a
 * population excludes nothing.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderExclusions = (excluded) => {
  if (excluded.length === 0) return []
  return [
    "",
    "## Excluded from the scoreboard, by name",
    "",
    "These instances were run and graded; their verdicts are statements about the grading environment rather than"
    + " about a harness, so they are outside every rate above. The exclusion applies to both arms equally, and the"
    + " raw count is printed beside the scored one everywhere.",
    "",
    "| instance | cause | reported in |",
    "| --- | --- | --- |",
    ...excluded.map((row) => `| ${row.id} | ${row.cause} | \`${row.reportedIn}\` |`)
  ]
}
