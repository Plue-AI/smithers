/**
 * A self-improving predictor: predict, record, observe, score, calibrate.
 *
 * The ledger is an append-only JSONL eval log. Folding it rebuilds every
 * prediction, observation, predictor failure and error statistic, so the next prediction learns
 * from all earlier ones across reloads. It is generic over named metrics;
 * `estimate.ts` is the time and token instance. See
 * `.plans/estimation-system.md`.
 *
 * Errors are log ratios (`actual / predicted`): a 2x miss is the same miss at
 * any scale. Calibration is fitted on raw predictions, never calibrated ones,
 * so a predictor that learns from its own feedback is not corrected twice.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export type Metrics = { readonly [metric: string]: number }

export interface Prediction {
  readonly id: string
  /** What kind of work: the calibration population. */
  readonly kind: string
  /** The reference class history is drawn from. */
  readonly key: string
  /** Which predictor produced `raw`; each method is calibrated on its own errors. */
  readonly method: string
  /** Human text, for prompts that learn from examples. */
  readonly subject: string
  readonly at: number
  /** The predictor's own value, before calibration. */
  readonly raw: Metrics
  /** The calibrated value, the one shown. */
  readonly value: Metrics
  readonly low: Metrics
  readonly high: Metrics
  /** How many scored predictions calibrated it. */
  readonly basis: number
}

export interface Observation {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly subject: string
  readonly at: number
  readonly outcome: "done" | "failed" | "cancelled"
  /** Metrics that could not be measured are absent. */
  readonly actual: Metrics
}

/** A predictor that produced nothing usable. Recorded so a fallback is never mistaken for the method itself. */
export interface Failure {
  readonly id: string
  readonly kind: string
  readonly key: string
  /** The method that failed. */
  readonly method: string
  /** The instance's typed reason, e.g. `model-error`. */
  readonly reason: string
  readonly message: string
  readonly at: number
}

export type Entry =
  | { readonly type: "prediction"; readonly prediction: Prediction }
  | { readonly type: "observation"; readonly observation: Observation }
  | { readonly type: "failure"; readonly failure: Failure }

export interface Scored {
  readonly prediction: Prediction
  readonly observation: Observation
  /** `actual / value` per measured metric. */
  readonly ratio: Metrics
  /** `actual / raw` per measured metric: what calibration fits. */
  readonly rawRatio: Metrics
  readonly inside: { readonly [metric: string]: boolean }
}

export interface Stats {
  readonly n: number
  /** Geometric median of `actual / raw`: the multiplier calibration applies. */
  readonly bias: Metrics
  /** Typical multiplicative miss of the shown value, e.g. 1.4 means within 1.4x half the time. */
  readonly error: Metrics
  /** Share of actuals inside the shown interval. */
  readonly coverage: Metrics
}

export type PredictInput = Omit<Prediction, "value" | "low" | "high" | "basis"> & {
  readonly low?: Metrics
  readonly high?: Metrics
}

/** Calibration looks back this far, so it follows drift. */
export const window = 30
/** Scored samples before the bias is applied, and before the interval comes from residuals. */
export const minimumBias = 3
export const minimumSpread = 5

const median = (values: ReadonlyArray<number>): number => quantile(values, 0.5)
export const quantile = (values: ReadonlyArray<number>, q: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below)
}
const map = (metrics: Metrics, f: (value: number, metric: string) => number | undefined): Metrics =>
  Object.fromEntries(
    Object.entries(metrics).flatMap(([metric, value]) => {
      const next = f(value, metric)
      return next === undefined || !Number.isFinite(next) ? [] : [[metric, next]]
    })
  )

export class Ledger {
  private predictions = new Map<string, Prediction>()
  private observed = new Map<string, Observation>()
  private failed = new Map<string, Failure>()
  private writeFailed = false
  constructor(
    /** Undefined keeps the ledger in memory. */
    readonly file: string | undefined,
    private readonly options: {
      /** Called once, on the first entry the file refused; the ledger keeps working in memory. */
      readonly onWriteError?: (error: unknown) => void
    } = {}
  ) {
    if (file === undefined || !existsSync(file)) return
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue
      try {
        this.fold(JSON.parse(line) as Entry)
      } catch { /* A torn last line from a crash loses one record, not the log. */ }
    }
  }
  private fold(entry: Entry) {
    if (entry.type === "prediction" && !this.predictions.has(entry.prediction.id)) {
      this.predictions.set(entry.prediction.id, entry.prediction)
    }
    if (entry.type === "observation" && !this.observed.has(entry.observation.id)) {
      this.observed.set(entry.observation.id, entry.observation)
    }
    if (entry.type === "failure" && !this.failed.has(entry.failure.id)) {
      this.failed.set(entry.failure.id, entry.failure)
    }
  }
  private append(entry: Entry) {
    this.fold(entry)
    if (this.file === undefined) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(entry) + "\n")
    } catch (error) {
      // The eval log never breaks the work it measures, but a lost log is said once.
      if (this.writeFailed) return
      this.writeFailed = true
      this.options.onWriteError?.(error)
    }
  }
  prediction = (id: string): Prediction | undefined => this.predictions.get(id)
  observation = (id: string): Observation | undefined => this.observed.get(id)
  failure = (id: string): Failure | undefined => this.failed.get(id)
  /** Records that a predictor failed for `id`. One per id. */
  fail = (failure: Failure): void => {
    if (!this.failed.has(failure.id)) this.append({ type: "failure", failure })
  }
  /** Every observation, oldest first; failed and cancelled work included. */
  observations = (filter: (observation: Observation) => boolean = () => true): ReadonlyArray<Observation> =>
    [...this.observed.values()].filter(filter).sort((a, b) => a.at - b.at)
  /** Predictions whose work finished, oldest first. */
  scored = (filter: (prediction: Prediction) => boolean = () => true): ReadonlyArray<Scored> =>
    [...this.observed.values()]
      .sort((a, b) => a.at - b.at)
      .flatMap((observation) => {
        const prediction = this.predictions.get(observation.id)
        return prediction !== undefined && filter(prediction) ? score(prediction, observation) ?? [] : []
      })
  stats = (filter: (prediction: Prediction) => boolean, metrics: ReadonlyArray<string>): Stats => {
    const recent = this.scored(filter).slice(-window)
    const of = (
      reduce: (values: ReadonlyArray<number>) => number,
      pick: (scored: Scored, metric: string) => number | undefined
    ) =>
      Object.fromEntries(metrics.flatMap((metric) => {
        const values = recent.flatMap((scored) => {
          const value = pick(scored, metric)
          return value === undefined ? [] : [value]
        })
        return values.length === 0 ? [] : [[metric, reduce(values)]]
      }))
    return {
      n: recent.length,
      bias: of((values) => Math.exp(median(values)), (scored, metric) => log(scored.rawRatio[metric])),
      error: of((values) => Math.exp(median(values)), (scored, metric) => abs(log(scored.ratio[metric]))),
      coverage: of(
        (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
        (scored, metric) => scored.inside[metric] === undefined ? undefined : scored.inside[metric] ? 1 : 0
      )
    }
  }
  /** Calibrates a raw prediction on its method's scored history and records it. One per id. */
  predict = (input: PredictInput): Prediction => {
    const existing = this.predictions.get(input.id)
    if (existing !== undefined) return existing
    const recent = this.scored((prediction) => prediction.kind === input.kind && prediction.method === input.method)
      .slice(-window)
    const residuals = (metric: string) =>
      recent.flatMap((scored) => {
        const value = log(scored.rawRatio[metric])
        return value === undefined ? [] : [value]
      })
    const bias = (metric: string) => {
      const values = residuals(metric)
      return values.length >= minimumBias ? median(values) : 0
    }
    const value = map(input.raw, (raw, metric) => raw * Math.exp(bias(metric)))
    const spread = (metric: string, q: number, fallback: number | undefined, factor: number) => {
      const values = residuals(metric)
      const center = value[metric]!
      if (values.length >= minimumSpread) return center * Math.exp(quantile(values, q) - bias(metric))
      return fallback === undefined ? center * factor : fallback * Math.exp(bias(metric))
    }
    const prediction: Prediction = {
      ...input,
      value,
      low: map(value, (center, metric) => Math.min(center, spread(metric, 0.1, input.low?.[metric], 0.5))),
      high: map(value, (center, metric) => Math.max(center, spread(metric, 0.9, input.high?.[metric], 2))),
      basis: recent.length
    }
    this.append({ type: "prediction", prediction })
    return prediction
  }
  /** Records what happened. Returns the score when the work finished and had a prediction. One per id. */
  observe = (observation: Observation): Scored | undefined => {
    if (this.observed.has(observation.id)) return undefined
    this.append({ type: "observation", observation })
    const prediction = this.predictions.get(observation.id)
    return prediction === undefined ? undefined : score(prediction, observation)
  }
}

const log = (value: number | undefined): number | undefined =>
  value === undefined || !(value > 0) || !Number.isFinite(value) ? undefined : Math.log(value)
const abs = (value: number | undefined) => value === undefined ? undefined : Math.abs(value)

/** Only finished work is scored: a failure's duration says nothing about how long success takes. */
export const score = (prediction: Prediction, observation: Observation): Scored | undefined => {
  if (observation.outcome !== "done") return undefined
  const measured = map(
    observation.actual,
    (actual, metric) => prediction.value[metric] === undefined || !(actual > 0) ? undefined : actual
  )
  if (Object.keys(measured).length === 0) return undefined
  return {
    prediction,
    observation,
    ratio: map(measured, (actual, metric) => actual / prediction.value[metric]!),
    rawRatio: map(measured, (actual, metric) => actual / prediction.raw[metric]!),
    inside: Object.fromEntries(
      Object.entries(measured).map(([metric, actual]) => [
        metric,
        actual >= (prediction.low[metric] ?? 0) && actual <= (prediction.high[metric] ?? Number.POSITIVE_INFINITY)
      ])
    )
  }
}
