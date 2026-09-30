/**
 * Calibration harness for the deterministic cleanup signals S1-S5 (#3150): per-stratum human p90
 * anchors and simplex-constrained logistic weights. Pure and seeded, so a rerun yields the
 * checked-in artifacts.
 */
export const DETERMINISTIC = ["duplicates", "churn", "lexicon", "stubs", "dead-code"] as const
export type Deterministic = (typeof DETERMINISTIC)[number]
export const LANGUAGES = ["ts", "python", "go", "rust"] as const
export const BANDS = ["small", "medium", "large"] as const
export type Label = "human" | "agent" | "hybrid"

export interface CorpusCase {
  readonly id: string
  readonly language: (typeof LANGUAGES)[number]
  readonly band: (typeof BANDS)[number]
  readonly label: Label
  /** `null`: not measurable for this repository (dead code needs 20 TypeScript or JavaScript exports). */
  readonly values: Readonly<Record<Deterministic, number | null>>
}

export type Anchors = Readonly<Record<Deterministic, number>>

/** Deterministic weights total 55 of 100 (registration-scores.md section 2). */
export const DETERMINISTIC_TOTAL = 55

const percentile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  return sorted[low]! + (sorted[Math.min(sorted.length - 1, low + 1)]! - sorted[low]!) * (position - low)
}

/** Human p90 per signal, per language and size band. */
export const fitAnchors = (cases: ReadonlyArray<CorpusCase>) => {
  const human = cases.filter((entry) => entry.label === "human")
  const measured = (subset: ReadonlyArray<CorpusCase>, id: Deterministic) =>
    subset.flatMap((entry) => entry.values[id] === null ? [] : [entry.values[id]])
  /** A signal no human case measured keeps anchor 1; its cases normalize to 0 anyway. */
  const pooled = Object.fromEntries(
    DETERMINISTIC.map((id) => [id, measured(human, id).length === 0 ? 1 : percentile(measured(human, id), 0.9)])
  ) as Anchors
  /** A stratum with fewer than three measured human values borrows the pooled anchor for that signal. */
  const anchors = (subset: ReadonlyArray<CorpusCase>): Anchors =>
    Object.fromEntries(
      DETERMINISTIC.map((id) => [id, measured(subset, id).length < 3 ? pooled[id] : percentile(measured(subset, id), 0.9)])
    ) as Anchors
  const strata: Record<string, Anchors> = {}
  for (const language of LANGUAGES) {
    for (const band of BANDS) {
      const subset = human.filter((entry) => entry.language === language && entry.band === band)
      if (subset.length > 0) strata[`${language}/${band}`] = anchors(subset)
    }
  }
  return { pooled, strata }
}

export const normalize = (entry: CorpusCase, strata: Record<string, Anchors>, pooled: Anchors) => {
  const anchor = strata[`${entry.language}/${entry.band}`] ?? pooled
  return DETERMINISTIC.map((id) => entry.values[id] === null ? 0 : Math.min(1, entry.values[id]! / anchor[id]))
}

/** Euclidean projection onto {w >= 0, sum w = 1}. */
export const projectSimplex = (vector: ReadonlyArray<number>) => {
  const sorted = [...vector].sort((a, b) => b - a)
  let cumulative = 0, theta = 0
  sorted.forEach((value, index) => {
    cumulative += value
    const candidate = (cumulative - 1) / (index + 1)
    if (value - candidate > 0) theta = candidate
  })
  return vector.map((value) => Math.max(0, value - theta))
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value))

/**
 * Logistic regression p(agent) = sigmoid(scale * theta.x + bias) with theta on the simplex,
 * by projected gradient descent from a uniform start. Weights are theta scaled to `total`.
 */
export const fitWeights = (rows: ReadonlyArray<{ x: ReadonlyArray<number>; y: 0 | 1 }>, total = DETERMINISTIC_TOTAL) => {
  const size = rows[0]!.x.length
  let theta = Array.from({ length: size }, () => 1 / size), scale = 1, bias = 0
  for (let step = 0; step < 4000; step++) {
    const gradient = new Array<number>(size).fill(0)
    let gradScale = 0, gradBias = 0
    for (const { x, y } of rows) {
      const dot = x.reduce((sum, value, index) => sum + value * theta[index]!, 0)
      const error = sigmoid(scale * dot + bias) - y
      for (let index = 0; index < size; index++) gradient[index]! += (error * scale * x[index]!) / rows.length
      gradScale += (error * dot) / rows.length
      gradBias += error / rows.length
    }
    theta = projectSimplex(theta.map((value, index) => value - 0.5 * gradient[index]!))
    scale -= 0.5 * gradScale
    bias -= 0.5 * gradBias
  }
  return { weights: theta.map((value) => value * total), scale, bias }
}

/** Probability a random agent case outscores a random human case (ties count half). */
export const auroc = (scores: ReadonlyArray<{ score: number; positive: boolean }>) => {
  const positives = scores.filter((entry) => entry.positive), negatives = scores.filter((entry) => !entry.positive)
  let wins = 0
  for (const positive of positives) {
    for (const negative of negatives) wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0
  }
  return wins / (positives.length * negatives.length)
}

/** Held-out cases: every third case of each stratum and label, by id order. */
export const split = (cases: ReadonlyArray<CorpusCase>) => {
  const seen = new Map<string, number>()
  const train: Array<CorpusCase> = [], heldOut: Array<CorpusCase> = []
  for (const entry of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${entry.language}/${entry.band}/${entry.label}`
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    ;(index % 3 === 2 ? heldOut : train).push(entry)
  }
  return { train, heldOut }
}

const round = (value: number) => Math.round(value * 10_000) / 10_000
const roundAll = (anchors: Anchors) => Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, round(v)])) as Anchors

export interface Fit {
  readonly method: "calibrated-synthetic-v1" | "calibrated-real-v1"
  readonly pooled: Anchors
  readonly strata: Record<string, Anchors>
  readonly weights: Record<Deterministic, number>
  readonly scale: number
  readonly bias: number
  readonly trainCases: number
  readonly heldOutCases: number
  readonly auroc: { readonly train: number; readonly heldOut: number; readonly hybridVsHuman: number }
  /** Share of cases above the pooled p90 that are agent-labelled, per signal (held out). */
  readonly precisionAtP90: Record<Deterministic, number | null>
  /** Held-out cases above the pooled anchor, per signal: the denominator of `precisionAtP90`. */
  readonly flaggedAtP90: Record<Deterministic, number>
}

export const fit = (cases: ReadonlyArray<CorpusCase>, method: Fit["method"] = "calibrated-synthetic-v1"): Fit => {
  const { train, heldOut } = split(cases)
  const { pooled, strata } = fitAnchors(train)
  const vector = (entry: CorpusCase) => normalize(entry, strata, pooled)
  const rows = train.filter((entry) => entry.label !== "hybrid").map((entry) => ({
    x: vector(entry),
    y: (entry.label === "agent" ? 1 : 0) as 0 | 1
  }))
  const { weights, scale, bias } = fitWeights(rows)
  const score = (entry: CorpusCase) => vector(entry).reduce((sum, value, index) => sum + value * weights[index]!, 0)
  /** AUROC of agent cases against human cases. */
  const evaluate = (subset: ReadonlyArray<CorpusCase>) =>
    auroc(
      subset.filter((entry) => entry.label !== "hybrid")
        .map((entry) => ({ score: score(entry), positive: entry.label === "agent" }))
    )
  const flaggedBy = (index: number) => heldOut.filter((entry) => vector(entry)[index]! >= 1)
  const precision = Object.fromEntries(DETERMINISTIC.map((id, index) => {
    const flagged = flaggedBy(index)
    return [id, flagged.length === 0 ? null : round(flagged.filter((entry) => entry.label === "agent").length / flagged.length)]
  })) as Record<Deterministic, number | null>
  const flagged = Object.fromEntries(DETERMINISTIC.map((id, index) => [id, flaggedBy(index).length])) as Record<Deterministic, number>
  return {
    method,
    pooled: roundAll(pooled),
    strata: Object.fromEntries(Object.entries(strata).map(([key, value]) => [key, roundAll(value)])),
    weights: Object.fromEntries(DETERMINISTIC.map((id, index) => [id, round(weights[index]!)])) as Record<Deterministic, number>,
    scale: round(scale),
    bias: round(bias),
    trainCases: train.length,
    heldOutCases: heldOut.length,
    auroc: {
      train: round(evaluate(train)),
      heldOut: round(evaluate(heldOut)),
      hybridVsHuman: round(auroc(
        cases.filter((entry) => entry.label !== "agent")
          .map((entry) => ({ score: score(entry), positive: entry.label === "hybrid" }))
      ))
    },
    precisionAtP90: precision,
    flaggedAtP90: flagged
  }
}
