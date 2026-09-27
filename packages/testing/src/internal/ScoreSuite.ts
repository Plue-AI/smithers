/**
 * Fixed-suite test execution using the runtime grading contract.
 *
 * @since 0.0.0
 */

import {
  combine,
  expectScores,
  grade,
  type ScoreGateError,
  type ScoreSample,
  validateSamples,
  type Verdict
} from "@smthrs/scorers/ScoreGate"
import { Effect } from "effect"

/**
 * One fixed suite case: a name, its input, and optional score gates scoped to
 * this case only.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteCase<I> {
  readonly name: string
  readonly input: I
  /** Per-case minimum applied through the `perCase` gate. */
  readonly minScore?: number | undefined
}

/**
 * Gates applied across the whole fixed suite.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteGates {
  readonly mean?: number | undefined
  readonly min?: number | undefined
}

/**
 * The graded outcome of one case.
 *
 * @since 0.0.0
 * @category models
 */
export interface CaseReport {
  readonly name: string
  readonly verdict: CaseVerdict
  readonly samples: ReadonlyArray<ScoreSample>
}

/**
 * A per-case verdict. Environment faults — a case-runner failure or defect —
 * grade `Inconclusive`, never `Failed`: the smithers `eval` lesson.
 *
 * @since 0.0.0
 * @category models
 */
export type CaseVerdict =
  | { readonly _tag: "Scored" }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }

/**
 * The full graded report of a fixed suite run.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteReport {
  readonly cases: ReadonlyArray<CaseReport>
  readonly samples: ReadonlyArray<ScoreSample>
  readonly verdict: Verdict
}

/**
 * Options for {@link suite}. The `run` case-runner is caller-supplied: it
 * executes one case and returns the score samples the case's scorers
 * observed. Any failure or defect it raises is an environment fault and
 * grades that case `Inconclusive`.
 *
 * @since 0.0.0
 * @category models
 */
export interface SuiteOptions<I> {
  readonly cases: ReadonlyArray<SuiteCase<I>>
  readonly run: (suiteCase: SuiteCase<I>) => Effect.Effect<ReadonlyArray<ScoreSample>, unknown>
  readonly gates?: SuiteGates | undefined
}

/**
 * Runs a fixed suite through its case-runner, collects every score sample,
 * applies the declared gates over the samples that exist, and grades the whole
 * run.
 *
 * A case that hit an environment fault contributes no samples and its reason
 * to the verdict's `inconclusive` list; it no longer cancels the gates the
 * finished cases can still be judged by. A gate those cases miss is `Failed`,
 * which {@link ciGrade} exits 1 on.
 *
 * @since 0.0.0
 * @category constructors
 */
export const suite = <I>(options: SuiteOptions<I>): Effect.Effect<SuiteReport, ScoreGateError> =>
  Effect.gen(function*() {
    const reports: Array<CaseReport> = []
    for (const suiteCase of options.cases) {
      const exit = yield* Effect.exit(options.run(suiteCase))
      if (exit._tag === "Success") {
        reports.push({
          name: suiteCase.name,
          verdict: { _tag: "Scored" },
          // Bound to the case that was actually run. Trusting the runner's own
          // `case` field let a runner bug attribute samples to another case, so
          // the per-case gates silently measured the wrong one.
          samples: exit.value.map((sample) => ({ ...sample, case: suiteCase.name }))
        })
      } else {
        reports.push({
          name: suiteCase.name,
          verdict: {
            _tag: "Inconclusive",
            reasons: [`Case '${suiteCase.name}' hit an environment fault: ${String(exit.cause)}`]
          },
          samples: []
        })
      }
    }
    const samples = reports.flatMap((report) => report.samples)
    const environmentFaults = reports.flatMap((report) =>
      report.verdict._tag === "Inconclusive" ? report.verdict.reasons : []
    )
    // Unconditionally, before any gate branch. Validation used to live inside
    // the individual gates, so a suite that declared none never checked its
    // samples at all and a `NaN` reached `SuiteReport.samples` under a passing
    // verdict.
    yield* validateSamples(samples)
    const expectation = expectScores(samples)
    const gates = options.gates ?? {}
    const verdicts: Array<Verdict> = []
    if (gates.mean !== undefined) verdicts.push(yield* expectation.mean(gates.mean))
    if (gates.min !== undefined) verdicts.push(yield* expectation.min(gates.min))
    const perCase = Object.fromEntries(
      options.cases.flatMap((suiteCase) =>
        suiteCase.minScore === undefined ? [] : [[suiteCase.name, suiteCase.minScore]]
      )
    )
    if (Object.keys(perCase).length > 0) verdicts.push(yield* expectation.perCase(perCase))
    return { cases: reports, samples, verdict: graded(options.cases.length, samples, verdicts, environmentFaults) }
  })

/**
 * A suite that gated nothing and measured nothing decided nothing.
 *
 * `combine` alone answers `Passed` for an empty verdict list, so a suite with
 * no cases, or one whose every observation was inconclusive and which declared
 * no gate, used to report a clean pass over zero evidence.
 */
const graded = (
  caseCount: number,
  samples: ReadonlyArray<ScoreSample>,
  verdicts: ReadonlyArray<Verdict>,
  environmentFaults: ReadonlyArray<string>
): Verdict => {
  if (caseCount === 0) return { _tag: "Inconclusive", reasons: ["The suite declared no cases"] }
  const unmeasured = samples.filter((sample) => sample.kind === "inconclusive")
  if (verdicts.length === 0 && unmeasured.length === samples.length) {
    return {
      _tag: "Inconclusive",
      reasons: [
        ...new Set([
          ...unmeasured.map((sample) => sample.reason),
          ...environmentFaults,
          "The suite produced no score observations"
        ])
      ]
    }
  }
  return combine(verdicts, [...environmentFaults, ...unmeasured.map((sample) => sample.reason)])
}

/**
 * The CI grading of a suite report, through {@link grade}: a clean pass exits
 * 0, a gate the run missed exits 1, and a run that could not be decided exits 5
 * (never a red), mirroring the smithers `eval` CLI contract the conversion note
 * inherits.
 *
 * @since 0.0.0
 * @category grading
 */
export const ciGrade = (report: SuiteReport): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => {
  const graded = grade(report.verdict)
  return graded.exitCode === 0
    ? {
      exitCode: 0,
      summary: `passed: ${report.cases.length} case(s), ${
        report.samples.filter((sample) => sample.kind === "score").length
      } sample(s)`
    }
    : graded
}
