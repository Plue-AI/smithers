/**
 * Repeated-run statistics for live model evaluations.
 *
 * A live case runs `n` times and passes `c` of them. {@link passAtK} is the
 * chance that at least one of `k` runs passes, the capability a best-of-k
 * caller sees; {@link passHatK} is the chance that all `k` pass, the
 * consistency a user sees on every attempt. Both are exact for sampling `k` of
 * the `n` recorded runs without replacement.
 *
 * Every function is pure and throws an `EvalError` with code `invalid_trials`
 * for counts outside the documented bounds.
 *
 * @since 0.1.0
 */
import { EvalError } from "./EvalError.ts"

/**
 * Repeated-run statistics for one case.
 *
 * `rate` equals `passAt1`; `stderr` is the standard error of the pass rate,
 * `sqrt(rate * (1 - rate) / n)`, and 0 for a single run.
 *
 * @since 0.1.0
 * @category models
 */
export interface Summary {
  readonly n: number
  readonly passes: number
  readonly rate: number
  readonly passAt1: number
  readonly passAtK: number
  readonly passHatK: number
  readonly stderr: number
}

/**
 * Repeated-run statistics across cases.
 *
 * `passAt1`, `passAtK`, and `passHatK` are means over cases, and `allPass` is
 * the fraction of cases whose every run passed.
 *
 * @since 0.1.0
 * @category models
 */
export interface Aggregate {
  readonly cases: number
  readonly passAt1: number
  readonly passAtK: number
  readonly passHatK: number
  readonly allPass: number
  readonly perCase: Readonly<Record<string, Summary>>
}

const invalid = (message: string, path: string): EvalError => new EvalError({ code: "invalid_trials", message, path })

const validate = (n: number, c: number, k: number): void => {
  if (!Number.isInteger(n) || n < 1) throw invalid(`Run count must be a positive integer, received ${n}`, "n")
  if (!Number.isInteger(c) || c < 0 || c > n) {
    throw invalid(`Pass count must be an integer from 0 to ${n}, received ${c}`, "c")
  }
  if (!Number.isInteger(k) || k < 1 || k > n) throw invalid(`k must be an integer from 1 to ${n}, received ${k}`, "k")
}

/**
 * The unbiased pass@k estimator, `1 - C(n - c, k) / C(n, k)` (Chen et al.,
 * 2021): the chance that at least one of `k` runs drawn from `n` passes. It is
 * computed as a product, so large `n` neither overflows nor loses precision.
 *
 * Throws `invalid_trials` unless `n`, `c`, and `k` are integers with
 * `0 <= c <= n` and `1 <= k <= n`.
 *
 * @since 0.1.0
 * @category statistics
 */
export const passAtK = (n: number, c: number, k: number): number => {
  validate(n, c, k)
  if (n - c < k) return 1
  let fail = 1
  for (let i = n - c + 1; i <= n; i++) fail *= 1 - k / i
  return 1 - fail
}

/**
 * pass^k, `C(c, k) / C(n, k)`: the chance that all `k` runs drawn from `n`
 * without replacement pass, the consistency measure of tau-bench.
 *
 * Throws `invalid_trials` under the same bounds as {@link passAtK}.
 *
 * @since 0.1.0
 * @category statistics
 */
export const passHatK = (n: number, c: number, k: number): number => {
  validate(n, c, k)
  let all = 1
  for (let i = 0; i < k; i++) all *= (c - i) / (n - i)
  return Math.max(0, all)
}

/**
 * Summarizes one case's run outcomes at `k`.
 *
 * Throws `invalid_trials` for no outcomes or a `k` outside `1..n`.
 *
 * @since 0.1.0
 * @category statistics
 */
export const summarize = (outcomes: ReadonlyArray<boolean>, k: number): Summary => {
  const n = outcomes.length
  const passes = outcomes.filter(Boolean).length
  validate(n, passes, k)
  const rate = passes / n
  return {
    n,
    passes,
    rate,
    passAt1: rate,
    passAtK: passAtK(n, passes, k),
    passHatK: passHatK(n, passes, k),
    stderr: n <= 1 ? 0 : Math.sqrt(rate * (1 - rate) / n)
  }
}

const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

/**
 * Summarizes every case at `k` and averages over cases.
 *
 * A case with fewer than `k` runs is summarized at `k = n`, its own run
 * count, so a short case still contributes rather than failing the whole
 * aggregate. No cases aggregate to zeros. Throws `invalid_trials` for a case
 * with no runs or a `k` that is not a positive integer.
 *
 * @since 0.1.0
 * @category statistics
 */
export const aggregate = (cases: Readonly<Record<string, ReadonlyArray<boolean>>>, k: number): Aggregate => {
  if (!Number.isInteger(k) || k < 1) throw invalid(`k must be a positive integer, received ${k}`, "k")
  const perCase: Record<string, Summary> = {}
  for (const [name, outcomes] of Object.entries(cases)) {
    if (outcomes.length === 0) throw invalid(`Case '${name}' has no runs`, `cases['${name}']`)
    perCase[name] = summarize(outcomes, Math.min(k, outcomes.length))
  }
  const summaries = Object.values(perCase)
  return {
    cases: summaries.length,
    passAt1: mean(summaries.map((summary) => summary.passAt1)),
    passAtK: mean(summaries.map((summary) => summary.passAtK)),
    passHatK: mean(summaries.map((summary) => summary.passHatK)),
    allPass: mean(summaries.map((summary) => summary.passes === summary.n ? 1 : 0)),
    perCase
  }
}
