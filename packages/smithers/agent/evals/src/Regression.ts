/**
 * Step-key-aware evaluation regression comparison.
 *
 * The step key is what separates the two findings this module reports. A score
 * that moved at a *changed* step key is a regression: the target produced
 * different work and it graded worse. A score that moved at an *unchanged* step
 * key is nondeterminism: the same work graded differently twice. Both are
 * results, and a gate reads both as red.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import type { Baseline, BaselineRecord } from "./Baseline.ts"
import { EvalError } from "./EvalError.ts"
import { CanonicalJson } from "./internal/CanonicalJson.ts"
import { flattenControlCharacters } from "./internal/controlCharacters.ts"
import { tupleKey } from "./internal/tupleKey.ts"
import type { Observation, RunResult } from "./Runner.ts"

/**
 * Tolerances used for score comparisons.
 *
 * A move is reported only when it exceeds both tolerances, so either one alone
 * is enough to silence it. Both default to `0`, which reports every move.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tolerances {
  readonly absolute?: number | undefined
  readonly relative?: number | undefined
}

/**
 * A score drop at a changed step key.
 *
 * @category models
 * @since 0.1.0
 */
export interface Regression {
  readonly case: string
  readonly scorer: string
  readonly baseline: BaselineRecord
  readonly actual: Extract<Observation, { readonly kind: "score" }>
  readonly drop: number
}

/**
 * A changed score at the same step key, indicating nondeterminism.
 *
 * @category models
 * @since 0.1.0
 */
export interface Nondeterminism {
  readonly case: string
  readonly scorer: string
  readonly baseline: BaselineRecord
  readonly actual: Extract<Observation, { readonly kind: "score" }>
  readonly delta: number
}

/**
 * An observation present on only one side of a comparison.
 *
 * `side` names the side it is missing from: `"run"` for a baseline record the
 * run never reproduced, `"baseline"` for a score the run produced that no
 * baseline record accounts for. `scorerName` comes from the observation that
 * is present, when that artifact carried one.
 *
 * @category models
 * @since 0.1.0
 */
export interface MissingObservation {
  readonly side: "baseline" | "run"
  readonly case: string
  readonly scorer: string
  readonly scorerName?: string | undefined
  readonly stepKey: string
}

/**
 * Complete regression comparison.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report {
  readonly suite: string
  readonly baseline: Baseline
  readonly run: RunResult
  readonly regressions: ReadonlyArray<Regression>
  readonly nondeterminism: ReadonlyArray<Nondeterminism>
  readonly missing: ReadonlyArray<MissingObservation>
  readonly samples: ReadonlyArray<Extract<Observation, { readonly kind: "score" }>>
  readonly inconclusive: ReadonlyArray<Extract<Observation, { readonly kind: "inconclusive" }>>
}

type Score = Extract<Observation, { readonly kind: "score" }>

// Injective: two distinct (case, scorer) pairs can never encode to one key,
// which a delimiter join could not promise once a name may contain the
// delimiter.
const key = (caseName: string, scorer: string): string => tupleKey(caseName, scorer)
const validTolerance = (value: number): boolean => Number.isFinite(value) && value >= 0

const groupBy = <A>(items: ReadonlyArray<A>, of: (item: A) => string): Map<string, Array<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const bucket = groups.get(of(item))
    if (bucket === undefined) groups.set(of(item), [item])
    else bucket.push(item)
  }
  return groups
}

const byScore = <A extends { readonly score: number }>(items: ReadonlyArray<A>): Array<A> =>
  [...items].sort((left, right) => left.score - right.score)

const byStepThenScore = <A extends { readonly stepKey: string; readonly score: number }>(
  items: ReadonlyArray<A>
): Array<A> =>
  [...items].sort((left, right) => CanonicalJson.compareText(left.stepKey, right.stepKey) || left.score - right.score)

/** One matched pair, or one record that nothing on the other side accounts for. */
type Pair =
  | { readonly kind: "matched"; readonly expected: BaselineRecord; readonly observed: Score }
  | { readonly kind: "missing-run"; readonly expected: BaselineRecord }
  | { readonly kind: "missing-baseline"; readonly observed: Score }

/**
 * Pairs one case's baseline records with one case's observations.
 *
 * Same-step-key pairs are matched first, lowest score to lowest score, so a
 * repeated scorer does not report a move that never happened. Whatever is left
 * over is paired in stable order, and an unpaired record on either side is a
 * missing observation rather than a silent drop.
 */
const pairsFor = (
  expected: ReadonlyArray<BaselineRecord>,
  observed: ReadonlyArray<Score>
): ReadonlyArray<Pair> => {
  const pairs: Array<Pair> = []
  const expectedByStep = groupBy(expected, (record) => record.stepKey)
  const observedByStep = groupBy(observed, (record) => record.stepKey)
  const leftoverExpected: Array<BaselineRecord> = []
  const leftoverObserved: Array<Score> = []
  for (const stepKey of [...expectedByStep.keys()].sort(CanonicalJson.compareText)) {
    const atStep = byScore(expectedByStep.get(stepKey)!)
    const observedAtStep = byScore(observedByStep.get(stepKey) ?? [])
    const count = Math.min(atStep.length, observedAtStep.length)
    for (let index = 0; index < count; index++) {
      pairs.push({ kind: "matched", expected: atStep[index]!, observed: observedAtStep[index]! })
    }
    leftoverExpected.push(...atStep.slice(count))
    leftoverObserved.push(...observedAtStep.slice(count))
  }
  for (const [stepKey, atStep] of observedByStep) {
    if (!expectedByStep.has(stepKey)) leftoverObserved.push(...atStep)
  }
  const remainingExpected = byStepThenScore(leftoverExpected)
  const remainingObserved = byStepThenScore(leftoverObserved)
  const matched = Math.min(remainingExpected.length, remainingObserved.length)
  for (let index = 0; index < matched; index++) {
    pairs.push({ kind: "matched", expected: remainingExpected[index]!, observed: remainingObserved[index]! })
  }
  for (const record of remainingExpected.slice(matched)) pairs.push({ kind: "missing-run", expected: record })
  for (const record of remainingObserved.slice(matched)) pairs.push({ kind: "missing-baseline", observed: record })
  return pairs
}

/**
 * Compares a run to a baseline, preserving missing and inconclusive observations.
 *
 * Records and observations are grouped by `(case, scorer)` and then paired by
 * step key, so a scorer that ran several times against one case is compared
 * pairwise instead of by array position. A pair whose step key is unchanged and
 * whose score moved is nondeterminism; a pair whose step key changed and whose
 * score dropped is a regression; an unpaired record on either side is a missing
 * observation. Inconclusive observations are carried through untouched, because
 * they decide nothing and a gate has to see them.
 *
 * Fails with `invalid_tolerance` when a tolerance is not finite and
 * non-negative, and with `invalid_baseline` when the artifact or any of its
 * records belongs to a suite other than the one the run reports.
 *
 * @category constructors
 * @since 0.1.0
 */
export const compare = (
  baseline: Baseline,
  run: RunResult,
  tolerances: Tolerances = {}
): Effect.Effect<Report, EvalError> => {
  const absolute = tolerances.absolute ?? 0
  const relative = tolerances.relative ?? 0
  if (!validTolerance(absolute)) {
    return Effect.fail(
      new EvalError({
        code: "invalid_tolerance",
        message: `Regression tolerance 'absolute' must be finite and non-negative, got ${String(absolute)}`,
        path: "tolerances.absolute"
      })
    )
  }
  if (!validTolerance(relative)) {
    return Effect.fail(
      new EvalError({
        code: "invalid_tolerance",
        message: `Regression tolerance 'relative' must be finite and non-negative, got ${String(relative)}`,
        path: "tolerances.relative"
      })
    )
  }
  const baselineSuite = baseline.suite
  if (baselineSuite !== run.suite) {
    return Effect.fail(
      new EvalError({
        code: "invalid_baseline",
        message: flattenControlCharacters(
          `Baseline belongs to suite '${baselineSuite}', but the run is suite '${run.suite}'`
        ),
        path: "baseline.suite"
      })
    )
  }
  const foreign = [...new Set(baseline.records.filter((record) => record.suite !== run.suite).map((r) => r.suite))]
  if (foreign.length > 0) {
    return Effect.fail(
      new EvalError({
        code: "invalid_baseline",
        message: flattenControlCharacters(
          `Baseline holds records for suite ${
            foreign.map((suite) => `'${suite}'`).join(", ")
          }, but the run is suite '${run.suite}'`
        ),
        path: "baseline.records"
      })
    )
  }
  const actual = run.observations.filter((observation): observation is Score => observation.kind === "score")
  const inconclusive = run.observations.filter((
    observation
  ): observation is Extract<Observation, { readonly kind: "inconclusive" }> => observation.kind === "inconclusive")
  const baselineByKey = groupBy(baseline.records, (record) => key(record.case, record.scorer))
  const actualByKey = groupBy(actual, (observation) => key(observation.case, observation.scorer))
  const regressions: Array<Regression> = []
  const nondeterminism: Array<Nondeterminism> = []
  const missing: Array<MissingObservation> = []
  for (const groupedKey of new Set([...baselineByKey.keys(), ...actualByKey.keys()])) {
    const pairs = pairsFor(baselineByKey.get(groupedKey) ?? [], actualByKey.get(groupedKey) ?? [])
    for (const pair of pairs) {
      if (pair.kind === "missing-baseline") {
        missing.push({
          side: "baseline",
          case: pair.observed.case,
          scorer: pair.observed.scorer,
          ...(pair.observed.scorerName === undefined ? {} : { scorerName: pair.observed.scorerName }),
          stepKey: pair.observed.stepKey
        })
        continue
      }
      if (pair.kind === "missing-run") {
        missing.push({
          side: "run",
          case: pair.expected.case,
          scorer: pair.expected.scorer,
          ...(pair.expected.scorerName === undefined ? {} : { scorerName: pair.expected.scorerName }),
          stepKey: pair.expected.stepKey
        })
        continue
      }
      const baselineRecord = pair.expected
      const observation = pair.observed
      const delta = observation.score - baselineRecord.score
      // Both branches divide by the same guarded magnitude. A baseline score of
      // exactly 0 used to be special-cased in the regression branch, which was
      // dead: a score is validated into [0, 1], so nothing can drop below 0.
      if (observation.stepKey === baselineRecord.stepKey) {
        if (
          Math.abs(delta) > absolute && Math.abs(delta) / Math.max(Math.abs(baselineRecord.score), 1e-12) > relative
        ) {
          nondeterminism.push({
            case: observation.case,
            scorer: observation.scorer,
            baseline: baselineRecord,
            actual: observation,
            delta
          })
        }
      } else if (
        delta < 0 && -delta > absolute && -delta / Math.max(baselineRecord.score, 1e-12) > relative
      ) {
        regressions.push({
          case: observation.case,
          scorer: observation.scorer,
          baseline: baselineRecord,
          actual: observation,
          drop: -delta
        })
      }
    }
  }
  return Effect.succeed({
    suite: run.suite,
    baseline,
    run,
    regressions,
    nondeterminism,
    missing,
    samples: actual,
    inconclusive
  })
}
