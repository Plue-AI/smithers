/**
 * The pass/fail decision over a finished evaluation run: how a threshold
 * is applied and what a failing gate reports.
 *
 * @since 0.1.0
 */

import {
  combine,
  expectScores,
  grade,
  type ScoreGateError,
  type ScoreSample,
  type Verdict
} from "@smthrs/scorers/ScoreGate"
import * as Effect from "effect/Effect"
import { flattenControlCharacters } from "./internal/controlCharacters.ts"
import { scorerLabel } from "./internal/scorerLabel.ts"
import type { Report } from "./Regression.ts"

/**
 * Thresholds accepted by a CI score gate.
 *
 * `mean` gates the arithmetic mean of every score observation, `min` gates the
 * lowest one, and `perCase` gates each named case's lowest score. With none of
 * them set the gate still runs, as `mean(0)`, so a run with no score at all is
 * undecidable rather than a pass.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly mean?: number | undefined
  readonly min?: number | undefined
  readonly perCase?: Readonly<Record<string, number>> | undefined
}

const samples = (report: Report): ReadonlyArray<ScoreSample> =>
  report.run.observations.map((observation) =>
    observation.kind === "score"
      ? {
        case: observation.case,
        scorer: observation.scorer,
        stepKey: observation.stepKey,
        kind: "score",
        value: observation.score,
        reason: observation.reason
      }
      : {
        case: observation.case,
        scorer: observation.scorer,
        stepKey: observation.stepKey,
        kind: "inconclusive",
        reason: observation.reason
      }
  )

/**
 * An environment fault: something the comparison needed was never observed, so
 * the harness owes an answer it cannot give. A fault withholds a decision;
 * it does not make one.
 */
const environmentFaults = (report: Report): ReadonlyArray<string> => [
  ...report.run.cases.flatMap((result) =>
    result.error === undefined ? [] : [`case '${result.case}' failed: ${result.error.code}: ${result.error.message}`]
  ),
  ...report.missing.map((item) =>
    `missing ${item.side} observation for ${item.case}/${scorerLabel(item)}/${item.stepKey}`
  )
]

/**
 * A finding: the run measured something the baseline says it should not have.
 * A regression scored lower at a changed step key, and nondeterminism moved a
 * score at an unchanged one. Both are results, so both are red.
 */
const findings = (report: Report): ReadonlyArray<string> => [
  ...report.regressions.map((item) =>
    `regression for ${item.case}/${scorerLabel({ scorer: item.scorer, scorerName: item.actual.scorerName })}`
  ),
  ...report.nondeterminism.map((item) =>
    `nondeterminism for ${item.case}/${scorerLabel({ scorer: item.scorer, scorerName: item.actual.scorerName })}`
  )
]

/**
 * Checks thresholds through `@smthrs/scorers`' shared ScoreGate arithmetic.
 *
 * The threshold gates always run: an unobserved case cannot excuse the cases
 * that were observed. Faults and findings are kept apart, and the verdict
 * carries both, so a regression is a red while an unusable harness stays
 * undecided.
 *
 * @category constructors
 * @since 0.1.0
 */
export const check = (report: Report, options: Options = {}): Effect.Effect<Verdict, ScoreGateError> =>
  Effect.gen(function*() {
    const expectation = expectScores(samples(report))
    const verdicts: Array<Verdict> = []
    if (options.mean !== undefined) verdicts.push(yield* expectation.mean(options.mean))
    if (options.min !== undefined) verdicts.push(yield* expectation.min(options.min))
    if (options.perCase !== undefined) verdicts.push(yield* expectation.perCase(options.perCase))
    if (options.mean === undefined && options.min === undefined && options.perCase === undefined) {
      verdicts.push(yield* expectation.mean(0))
    }
    const reasons = findings(report)
    if (reasons.length > 0) verdicts.push({ _tag: "Failed", reasons, inconclusive: [] })
    return combine(verdicts, environmentFaults(report))
  })

/**
 * Maps a gate verdict to the shared CI convention: a finding is exit code 1,
 * an undecidable run is exit code 5.
 *
 * The summary is one log line: every C0 control and DEL in it becomes a
 * space, the way a report cell is written, so a value that reached a verdict
 * reason from a baseline, a step key or a target's failure cannot emit its own
 * line, which on GitHub Actions would be a workflow command, or a terminal
 * escape.
 *
 * @category grading
 * @since 0.1.0
 */
export const ciGrade = (verdict: Verdict): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => {
  const graded = grade(verdict)
  return { exitCode: graded.exitCode, summary: flattenControlCharacters(graded.summary) }
}
