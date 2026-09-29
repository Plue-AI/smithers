/** Metrics for paired, repeated security reviews; failures never count as clean. */
export interface SecurityObservation {
  readonly repeat: number
  readonly fixture: string
  readonly vulnerable: boolean
  readonly completed: boolean
  readonly refused: boolean
  readonly candidates: number
  readonly reproduced: number
}

/** Per-repeat rates and population variance; null means no measurable denominator. */
export function scoreSecurity(observations: ReadonlyArray<SecurityObservation>) {
  const ratio = (a: number, b: number): number | null => b === 0 ? null : a / b
  const repeats = [...new Set(observations.map((entry) => entry.repeat))].sort((a, b) => a - b)
  const runs = repeats.map((repeat) => {
    const rows = observations.filter((entry) => entry.repeat === repeat)
    const vulnerable = rows.filter((entry) => entry.vulnerable)
    return {
      repeat,
      recall: ratio(vulnerable.filter((entry) => entry.reproduced > 0).length, vulnerable.length),
      postReproductionPrecision: ratio(
        rows.reduce((sum, entry) => sum + entry.reproduced, 0),
        rows.reduce((sum, entry) => sum + entry.candidates, 0)
      ),
      refusalRate: ratio(rows.filter((entry) => entry.refused).length, rows.length),
      incompleteRate: ratio(rows.filter((entry) => !entry.completed).length, rows.length)
    }
  })
  const stats = (values: ReadonlyArray<number | null>) => {
    const measured = values.filter((value): value is number => value !== null)
    if (measured.length === 0) return { mean: null, variance: null, measuredRepeats: 0 }
    const mean = measured.reduce((a, b) => a + b, 0) / measured.length
    return {
      mean,
      variance: measured.reduce((sum, value) => sum + (value - mean) ** 2, 0) / measured.length,
      measuredRepeats: measured.length
    }
  }
  return {
    observations: observations.length,
    runs,
    recall: stats(runs.map((run) => run.recall)),
    postReproductionPrecision: stats(runs.map((run) => run.postReproductionPrecision)),
    refusalRate: stats(runs.map((run) => run.refusalRate)),
    incompleteRate: stats(runs.map((run) => run.incompleteRate))
  }
}
