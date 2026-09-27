/**
 * Canonical JSON and Markdown regression reports.
 *
 * The JSON report is the machine-readable artifact; the Markdown report is what
 * an operator reads in a CI log, so it names every case the run could not
 * decide rather than only counting them.
 *
 * @since 0.1.0
 */

import type { Baseline } from "./Baseline.ts"
import { CanonicalJson } from "./internal/CanonicalJson.ts"
import { scorerLabel } from "./internal/scorerLabel.ts"
import type { MissingObservation, Nondeterminism, Regression, Report as RegressionReport } from "./Regression.ts"
import type { CaseResult, Observation, RunResult } from "./Runner.ts"

/**
 * Current serialized report format version.
 *
 * It versions {@link Data}, the wire shape, independently of the nested
 * `Baseline.version`: the comparison can change shape without the committed
 * baseline artifact changing at all.
 *
 * @category serialization
 * @since 0.1.0
 */
export const version = 1 as const

/** An index into {@link Data.run}'s `observations` table. */
type ObservationRef = number

/**
 * The serialized shape of a regression report.
 *
 * `run.observations` is the observation table: every observation the report
 * mentions appears in it exactly once, and everything else refers to one by
 * index. `run.cases[i].observations` is a list of indexes, and a regression or
 * nondeterminism entry's `actual` is a single index. An in-memory
 * `Regression.Report` carries the same observation object in up to four
 * places, so encoding it directly repeated every reason and every `meta` that
 * many times.
 *
 * `samples` and `inconclusive` are absent by construction: both are filters of
 * `run.observations` by `kind`, so a reader recomputes them rather than
 * downloading a third copy.
 *
 * @category serialization
 * @since 0.1.0
 */
export interface Data {
  readonly reportVersion: typeof version
  readonly suite: string
  readonly baseline: Baseline
  readonly run:
    & Omit<RunResult, "cases">
    & {
      readonly cases: ReadonlyArray<
        & Omit<CaseResult, "observations">
        & { readonly observations: ReadonlyArray<ObservationRef> }
      >
    }
  readonly regressions: ReadonlyArray<Omit<Regression, "actual"> & { readonly actual: ObservationRef }>
  readonly nondeterminism: ReadonlyArray<Omit<Nondeterminism, "actual"> & { readonly actual: ObservationRef }>
  readonly missing: ReadonlyArray<MissingObservation>
}

/**
 * Projects a comparison into its serialized form.
 *
 * The observation table starts as `run.observations` and grows to hold any
 * observation reached only through a case or a comparison entry, so a
 * hand-built report whose case lists are not flattened still serializes every
 * reference. Observations are pooled by identity, not by value: two distinct
 * objects that happen to be equal stay two rows, because collapsing them would
 * claim one grading where there were two.
 *
 * @category serialization
 * @since 0.1.0
 */
export const data = (report: RegressionReport): Data => {
  const positions = new Map<Observation, ObservationRef>()
  const observations: Array<Observation> = []
  const refer = (observation: Observation): ObservationRef => {
    const known = positions.get(observation)
    if (known !== undefined) return known
    const position = observations.length
    observations.push(observation)
    positions.set(observation, position)
    return position
  }
  for (const observation of report.run.observations) refer(observation)
  const cases = report.run.cases.map((result) => ({ ...result, observations: result.observations.map(refer) }))
  return {
    reportVersion: version,
    suite: report.suite,
    baseline: report.baseline,
    run: { ...report.run, cases, observations },
    regressions: report.regressions.map((entry) => ({ ...entry, actual: refer(entry.actual) })),
    nondeterminism: report.nondeterminism.map((entry) => ({ ...entry, actual: refer(entry.actual) })),
    missing: report.missing
  }
}

/**
 * Serializes a regression report as stable, sorted-key JSON.
 *
 * The wire shape is {@link Data}, stamped with {@link version}: each
 * observation is encoded once and referred to by index everywhere else. The
 * report embeds each case's raw `execution.output`, which comes from an
 * arbitrary target flow, so the encoding is total rather than trusting: keys
 * are sorted by code unit, embedded strings are capped, total traversal is
 * bounded, and anything JSON cannot express becomes a named marker
 * (`[circular]`, `[NaN]`, `[function]`, `[budget exceeded]`) instead of a
 * `RangeError` or a silent `null`. Two identical runs therefore produce
 * byte-identical JSON.
 *
 * Nothing redacts the embedded output. A suite whose cases carry secrets must
 * not print this report where the log is readable.
 *
 * @category serialization
 * @since 0.1.0
 */
export const json = (report: RegressionReport): string =>
  CanonicalJson.stringify(data(report), { maxStringLength: CanonicalJson.maxStringLength })

/** Maximum escaped UTF-16 code units per value, before a truncation ellipsis. */
const maxCellLength = 240

const cell = (value: unknown): string => {
  let text = ""
  if (value !== undefined && value !== null) {
    if (typeof value === "string") text = value
    else {
      try {
        text = String(value)
      } catch {
        text = "[unreadable]"
      }
    }
  }
  let escaped = ""
  for (const character of text) {
    const code = character.codePointAt(0)!
    // Escape each input character once, including backslashes before pipes.
    // Ampersands prevent entities; dots, colons, and @ prevent GFM autolinks.
    const token = code < 0x20 || code === 0x7f
      ? " "
      : /[\\|`*_[\]<>!#~&.:@]/u.test(character)
      ? `\\${character}`
      : character
    if (escaped.length + token.length > maxCellLength) return `${escaped}…`
    escaped += token
  }
  return escaped
}

const scorerCell = (scorer: string, scorerName: string | undefined): string => cell(scorerLabel({ scorer, scorerName }))

const section = (
  heading: string,
  header: ReadonlyArray<string>,
  alignment: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> =>
  rows.length === 0 ? [] : [
    `## ${heading}`,
    "",
    `| ${header.join(" | ")} |`,
    `| ${alignment.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    ""
  ]

/**
 * Renders a concise stable Markdown regression report.
 *
 * Every count in the summary that is not zero has a section naming its rows:
 * the regressions and the nondeterminism a gate reads as red, and the case
 * failures, missing observations, and inconclusive observations that leave a
 * gate undecided. A report that only counted them named nothing an operator
 * could act on, which is exactly the run that needs debugging.
 *
 * Every cell and the suite heading value replace C0 controls and DEL with
 * spaces and escape backslashes, pipes, inline GFM syntax, raw HTML, entities,
 * and URL/email autolinks. Values are capped at 240 escaped UTF-16 code units,
 * plus an ellipsis when truncated, without splitting escapes or code points.
 *
 * @category rendering
 * @since 0.1.0
 */
export const markdown = (report: RegressionReport): string => {
  const lines = [
    `# Evaluation report: ${cell(report.suite)}`,
    "",
    `- Regressions: ${report.regressions.length}`,
    `- Nondeterminism: ${report.nondeterminism.length}`,
    `- Missing observations: ${report.missing.length}`,
    `- Inconclusive observations: ${report.inconclusive.length}`,
    `- Failed cases: ${report.run.cases.filter((result) => result.error !== undefined).length}`,
    "",
    ...section(
      "Regressions",
      ["Case", "Scorer", "Baseline", "Actual", "Drop"],
      ["---", "---", "---:", "---:", "---:"],
      report.regressions.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.actual.scorerName),
        item.baseline.score.toFixed(6),
        item.actual.score.toFixed(6),
        item.drop.toFixed(6)
      ])
    ),
    ...section(
      "Nondeterminism",
      ["Case", "Scorer", "Step key", "Baseline", "Actual", "Delta"],
      ["---", "---", "---", "---:", "---:", "---:"],
      report.nondeterminism.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.actual.scorerName),
        cell(item.actual.stepKey),
        item.baseline.score.toFixed(6),
        item.actual.score.toFixed(6),
        item.delta.toFixed(6)
      ])
    ),
    ...section(
      "Case failures",
      ["Case", "Code", "Message"],
      ["---", "---", "---"],
      report.run.cases.flatMap((result) =>
        result.error === undefined ? [] : [[cell(result.case), cell(result.error.code), cell(result.error.message)]]
      )
    ),
    ...section(
      "Missing observations",
      ["Side", "Case", "Scorer", "Step key"],
      ["---", "---", "---", "---"],
      report.missing.map((item) => [
        cell(item.side),
        cell(item.case),
        scorerCell(item.scorer, item.scorerName),
        cell(item.stepKey)
      ])
    ),
    ...section(
      "Inconclusive",
      ["Case", "Scorer", "Step key", "Reason"],
      ["---", "---", "---", "---"],
      report.inconclusive.map((item) => [
        cell(item.case),
        scorerCell(item.scorer, item.scorerName),
        cell(item.stepKey),
        cell(item.reason)
      ])
    )
  ]
  return `${lines.join("\n").trim()}\n`
}
