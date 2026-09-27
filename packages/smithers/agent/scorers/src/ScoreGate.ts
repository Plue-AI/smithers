/**
 * Pure grading over caller-owned, fixed score samples.
 *
 * Runtime evaluations and testing facades share this verdict and error contract.
 * No runner, store, or test framework is needed.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Codes raised by fixed-suite score gates.
 *
 * @since 0.1.0
 * @category codes
 */
export const ScoreGateCode = Schema.Literals([
  "invalid_threshold",
  "invalid_score",
  "mean_below_threshold",
  "min_below_threshold",
  "case_below_threshold"
])

/**
 * The decoded form of {@link ScoreGateCode}.
 *
 * @since 0.1.0
 * @category codes
 */
export type ScoreGateCode = typeof ScoreGateCode.Type

/**
 * One score observation a gate rejected, identified the way `ScoreSample`
 * identifies it, so a suite of five hundred samples names the scorer that
 * produced the bad value rather than reporting a bare number.
 *
 * @since 0.1.0
 * @category codes
 */
export const InvalidScoreSample = Schema.Struct({
  case: Schema.String,
  stepKey: Schema.String,
  scorer: Schema.String,
  value: Schema.Number
})

/**
 * The decoded form of {@link InvalidScoreSample}.
 *
 * @since 0.1.0
 * @category codes
 */
export type InvalidScoreSample = typeof InvalidScoreSample.Type

/**
 * A score sample did not satisfy a configured gate, or a gate was misused.
 *
 * `threshold` and `actual` are optional because not every code has both:
 * `invalid_threshold` has no observation and `invalid_score` has no threshold,
 * and a placeholder `0` in either position is a number a consumer would read
 * as meaningful. `samples` names every rejected observation for
 * `invalid_score`, so a run with ten bad scorers is diagnosed in one pass.
 *
 * @since 0.1.0
 * @category errors
 */
export class ScoreGateError extends Schema.TaggedError<ScoreGateError>()("ScoreGateError", {
  code: ScoreGateCode,
  threshold: Schema.optional(Schema.Number),
  actual: Schema.optional(Schema.Number),
  samples: Schema.optional(Schema.Array(InvalidScoreSample))
}) {}

/**
 * A score observation collected for one fixed test case and step key.
 *
 * @category models
 * @since 0.1.0
 */
export type ScoreSample =
  & {
    readonly case: string
    readonly stepKey: string
    readonly scorer: string
  }
  & (
    | { readonly kind: "score"; readonly value: number; readonly reason?: string | undefined }
    | { readonly kind: "inconclusive"; readonly reason: string }
  )

/**
 * The non-error result of grading a fixed suite.
 *
 * The two kinds of bad news are separate members, because they answer
 * different questions. `Failed` is a finding: the scores a run produced did
 * not meet a gate, which is a measurement and a red. `Inconclusive` is an
 * environment fault: nothing could be measured, which is a broken harness to
 * repair rather than a result to read. A fault observed beside a decidable
 * gate travels in `inconclusive` alongside the verdict, never instead of it.
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict =
  | { readonly _tag: "Passed"; readonly inconclusive: ReadonlyArray<string> }
  | {
    readonly _tag: "Failed"
    readonly reasons: ReadonlyArray<string>
    readonly inconclusive: ReadonlyArray<string>
  }
  | { readonly _tag: "Inconclusive"; readonly reasons: ReadonlyArray<string> }

const invalidThreshold = (threshold: number): Effect.Effect<never, ScoreGateError> =>
  Effect.fail(new ScoreGateError({ code: "invalid_threshold", threshold }))

const validateThreshold = (threshold: number): Effect.Effect<void, ScoreGateError> =>
  Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
    ? Effect.void
    : invalidThreshold(threshold)

/**
 * Rejects every score observation outside `[0, 1]`, naming each one.
 *
 * A gate builder validates its own samples, but a caller that constructs
 * samples itself -- a suite runner, a reporter -- has no other way to reach
 * this check, and an unvalidated `NaN` reaches a report as a passing number.
 *
 * @since 0.1.0
 * @category gates
 */
export const validateSamples = (samples: ReadonlyArray<ScoreSample>): Effect.Effect<void, ScoreGateError> => {
  const invalid: Array<InvalidScoreSample> = []
  for (const sample of samples) {
    if (sample.kind === "score" && (!Number.isFinite(sample.value) || sample.value < 0 || sample.value > 1)) {
      invalid.push({ case: sample.case, stepKey: sample.stepKey, scorer: sample.scorer, value: sample.value })
    }
  }
  return invalid.length === 0
    ? Effect.void
    : Effect.fail(new ScoreGateError({ code: "invalid_score", actual: invalid[0]!.value, samples: invalid }))
}

const unique = (reasons: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(reasons)]

const faults = (samples: ReadonlyArray<ScoreSample>): ReadonlyArray<string> =>
  samples.flatMap((sample) => sample.kind === "inconclusive" ? [sample.reason] : [])

/** Trims binary noise: a mean of `0.8500000000000001` reads as `0.85`. */
const rounded = (value: number): number => Number(value.toPrecision(6))

/**
 * Renders one breach with the stable code the error channel uses for misuse,
 * so a reason line names the gate, its threshold, and what the run scored.
 */
const breach = (code: ScoreGateCode, threshold: number, actual: number): string =>
  `${code}: threshold ${rounded(threshold)}, actual ${rounded(actual)}`

/**
 * Renders a per-case breach, naming the case that missed its threshold. The
 * name belongs in the reason because `combine` deduplicates equal reason
 * strings: two cases that miss the same threshold with the same score would
 * otherwise collapse into one finding that names neither of them.
 */
const caseBreach = (caseName: string, threshold: number, actual: number): string =>
  `case_below_threshold: case '${caseName}', threshold ${rounded(threshold)}, actual ${rounded(actual)}`

/** Stands in for a verdict that states bad news without stating a reason. */
const unstatedFailure = "A gate failed without a stated reason"

/** The undecidable counterpart of {@link unstatedFailure}. */
const unstatedUndecidable = "A gate was undecidable without a stated reason"

const passed = (samples: ReadonlyArray<ScoreSample>): Extract<Verdict, { readonly _tag: "Passed" }> => ({
  _tag: "Passed",
  inconclusive: unique(faults(samples))
})

const failed = (
  samples: ReadonlyArray<ScoreSample>,
  reasons: ReadonlyArray<string>
): Extract<Verdict, { readonly _tag: "Failed" }> => ({
  _tag: "Failed",
  reasons,
  inconclusive: unique(faults(samples))
})

const undecidable = (samples: ReadonlyArray<ScoreSample>, extra: ReadonlyArray<string>): Verdict => ({
  _tag: "Inconclusive",
  reasons: unique([...faults(samples), ...extra])
})

const scoreValues = (samples: ReadonlyArray<ScoreSample>): ReadonlyArray<number> =>
  samples.flatMap((sample) => sample.kind === "score" ? [sample.value] : [])

const minimum = (values: ReadonlyArray<number>): number =>
  values.reduce((low, value) => value < low ? value : low, Number.POSITIVE_INFINITY)

/**
 * Reduces the verdicts of several gates, plus the environment faults observed
 * outside them, to one verdict.
 *
 * Precedence is findings first: a gate a run measurably missed is a red even
 * when another observation went missing, because the failing measurement
 * happened. A gate that could not be evaluated at all keeps the run
 * inconclusive, and faults that decided nothing travel alongside a pass.
 *
 * @category grading
 * @since 0.1.0
 */
export const combine = (
  verdicts: ReadonlyArray<Verdict>,
  environmentFaults: ReadonlyArray<string> = []
): Verdict => {
  const reasons = unique(verdicts.flatMap((verdict) => verdict._tag === "Failed" ? verdict.reasons : []))
  const undecided = unique(verdicts.flatMap((verdict) => verdict._tag === "Inconclusive" ? verdict.reasons : []))
  const observed = unique([
    ...environmentFaults,
    ...verdicts.flatMap((verdict) => verdict._tag === "Inconclusive" ? [] : verdict.inconclusive)
  ])
  // Precedence reads the tags, not the reason lists. `Verdict` permits an
  // empty `reasons` array, and deriving severity from a list length turns a
  // stated failure that carries no reason into a clean pass and a CI exit 0.
  if (verdicts.some((verdict) => verdict._tag === "Failed")) {
    return {
      _tag: "Failed",
      reasons: reasons.length === 0 ? [unstatedFailure] : reasons,
      inconclusive: unique([...observed, ...undecided])
    }
  }
  if (verdicts.some((verdict) => verdict._tag === "Inconclusive")) {
    const stated = unique([...undecided, ...observed])
    return { _tag: "Inconclusive", reasons: stated.length === 0 ? [unstatedUndecidable] : stated }
  }
  if (verdicts.length === 0 && observed.length > 0) return { _tag: "Inconclusive", reasons: observed }
  return { _tag: "Passed", inconclusive: observed }
}

/**
 * Maps a verdict to the shared CI convention: a finding exits 1, an
 * undecidable run exits 5, and a clean pass exits 0. A pass that carries
 * unresolved observations exits 5 as well: the gates it met were met over
 * fewer observations than the suite declared.
 *
 * @category grading
 * @since 0.1.0
 */
export const grade = (verdict: Verdict): { readonly exitCode: 0 | 1 | 5; readonly summary: string } => {
  switch (verdict._tag) {
    case "Failed":
      return {
        exitCode: 1,
        summary: `failed: ${
          [
            ...verdict.reasons,
            ...(verdict.inconclusive.length === 0 ? [] : [`unresolved: ${verdict.inconclusive.join("; ")}`])
          ].join("; ")
        }`
      }
    case "Inconclusive":
      return { exitCode: 5, summary: `inconclusive: ${verdict.reasons.join("; ")}` }
    case "Passed":
      return verdict.inconclusive.length === 0
        ? { exitCode: 0, summary: "passed" }
        : { exitCode: 5, summary: `passed every gate with unresolved: ${verdict.inconclusive.join("; ")}` }
  }
}

/**
 * A fixed-suite score-gate builder.
 *
 * @category constructors
 * @since 0.1.0
 */
export interface ScoreExpectation {
  /** Requires the arithmetic mean of all score observations to meet `threshold`. @since 0.1.0 @category gates */
  readonly mean: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  /** Requires every score observation to meet `threshold`. @since 0.1.0 @category gates */
  readonly min: (threshold: number) => Effect.Effect<Verdict, ScoreGateError>
  /** Requires every named case's lowest score observation to meet its threshold. @since 0.1.0 @category gates */
  readonly perCase: (thresholds: Readonly<Record<string, number>>) => Effect.Effect<Verdict, ScoreGateError>
}

/**
 * Builds gates over a fixed sample set.
 *
 * A gate is evaluated over the score observations that exist. An inconclusive
 * observation is an environment fault or an unavailable judge: it is reported
 * beside the verdict, and it withholds a decision only when it leaves the gate
 * nothing to measure. A gate the surviving scores miss is `Failed`, not
 * inconclusive. The error channel is reserved for misuse of the gate itself, a
 * threshold or a score outside `[0, 1]`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const expectScores = (samples: ReadonlyArray<ScoreSample>): ScoreExpectation => {
  const validate = validateSamples(samples)

  return {
    mean: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const values = scoreValues(samples)
        if (values.length === 0) return undecidable(samples, ["No score samples for mean gate"])
        const actual = values.reduce((total, value) => total + value, 0) / values.length
        return actual < threshold
          ? failed(samples, [breach("mean_below_threshold", threshold, actual)])
          : passed(samples)
      }),
    min: (threshold) =>
      Effect.gen(function*() {
        yield* validateThreshold(threshold)
        yield* validate
        const values = scoreValues(samples)
        if (values.length === 0) return undecidable(samples, ["No score samples for min gate"])
        // Iterative, not `Math.min(...values)`: a spread above the engine's
        // argument-count limit throws a RangeError out of a module whose error
        // channel is otherwise a closed code union.
        const actual = minimum(values)
        return actual < threshold
          ? failed(samples, [breach("min_below_threshold", threshold, actual)])
          : passed(samples)
      }),
    perCase: (thresholds) =>
      Effect.gen(function*() {
        for (const threshold of Object.values(thresholds)) yield* validateThreshold(threshold)
        yield* validate
        const named = Object.entries(thresholds)
        if (named.length === 0) return passed(samples)
        // Grouped in one pass rather than rescanned per case: a suite with
        // thousands of named cases otherwise pays cases x samples comparisons
        // inside a grading call the other gates keep linear.
        const byCase = new Map<string, Array<number>>()
        for (const sample of samples) {
          if (sample.kind !== "score") continue
          const values = byCase.get(sample.case)
          if (values === undefined) byCase.set(sample.case, [sample.value])
          else values.push(sample.value)
        }
        const breaches: Array<string> = []
        const unmeasured: Array<string> = []
        for (const [caseName, threshold] of named) {
          const values = byCase.get(caseName)
          if (values === undefined) {
            unmeasured.push(`No score samples for case ${caseName}`)
            continue
          }
          const actual = minimum(values)
          if (actual < threshold) breaches.push(caseBreach(caseName, threshold, actual))
        }
        // Every named case went unmeasured, so this gate decided nothing. One
        // unmeasured case among measured ones is reported alongside the
        // verdict the others earned.
        if (unmeasured.length === named.length) return undecidable(samples, unmeasured)
        const verdict = breaches.length === 0 ? passed(samples) : failed(samples, breaches)
        return { ...verdict, inconclusive: unique([...verdict.inconclusive, ...unmeasured]) }
      })
  }
}
