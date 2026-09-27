/**
 * Test facade for the runtime score-gate contract in `@smthrs/scorers/ScoreGate`.
 *
 * The fixed-suite runner and its report grading remain test helpers. Shared
 * grading functions and types are re-exported without wrappers.
 *
 * @since 0.0.0
 */

export {
  combine,
  expectScores,
  grade,
  type ScoreExpectation,
  type ScoreSample,
  validateSamples,
  type Verdict
} from "@smthrs/scorers/ScoreGate"
export {
  type CaseReport,
  type CaseVerdict,
  ciGrade,
  suite,
  type SuiteCase,
  type SuiteGates,
  type SuiteOptions,
  type SuiteReport
} from "./internal/ScoreSuite.ts"
