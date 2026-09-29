import { describe, expect, test } from "bun:test"
import { scoreSecurity, type SecurityObservation } from "./security-completion-score.ts"

const observation = (overrides: Partial<SecurityObservation>): SecurityObservation => ({
  repeat: 0,
  fixture: "sql-injection",
  vulnerable: true,
  completed: true,
  refused: false,
  candidates: 0,
  reproduced: 0,
  ...overrides
})

describe("security completion scoring", () => {
  test("measures recall and candidate precision per repeat with population variance", () => {
    const score = scoreSecurity([
      observation({ repeat: 2, candidates: 1, reproduced: 0 }),
      observation({ repeat: 1, candidates: 2, reproduced: 1 }),
      observation({ repeat: 1, fixture: "fixed", vulnerable: false, candidates: 1 }),
      observation({ repeat: 2, fixture: "fixed", vulnerable: false })
    ])

    expect(score.observations).toBe(4)
    expect(score.runs.map((run) => run.repeat)).toEqual([1, 2])
    expect(score.runs.map((run) => run.recall)).toEqual([1, 0])
    expect(score.runs.map((run) => run.postReproductionPrecision)).toEqual([1 / 3, 0])
    expect(score.recall).toEqual({ mean: 0.5, variance: 0.25, measuredRepeats: 2 })
    expect(score.postReproductionPrecision.mean).toBeCloseTo(1 / 6)
    expect(score.postReproductionPrecision.variance).toBeCloseTo(1 / 36)
  })

  test("does not count an unconfirmed candidate as a true positive", () => {
    const score = scoreSecurity([
      observation({ candidates: 2, reproduced: 1 }),
      observation({ fixture: "fixed", vulnerable: false, candidates: 1, reproduced: 0 })
    ])
    expect(score.runs[0]?.recall).toBe(1)
    expect(score.runs[0]?.postReproductionPrecision).toBe(1 / 3)
  })

  test("separates refusal from other incomplete runs", () => {
    const score = scoreSecurity([
      observation({ fixture: "refused", completed: false, refused: true }),
      observation({ fixture: "missing-context", completed: false, refused: false }),
      observation({ fixture: "completed", completed: true, refused: false })
    ])
    expect(score.runs[0]?.refusalRate).toBe(1 / 3)
    expect(score.runs[0]?.incompleteRate).toBe(2 / 3)
  })

  test("uses null for unmeasured denominators and omits them from repeat statistics", () => {
    const score = scoreSecurity([
      observation({ repeat: 0, fixture: "fixed", vulnerable: false }),
      observation({ repeat: 1, candidates: 1, reproduced: 1 })
    ])
    expect(score.runs[0]).toMatchObject({ recall: null, postReproductionPrecision: null })
    expect(score.recall).toEqual({ mean: 1, variance: 0, measuredRepeats: 1 })
    expect(score.postReproductionPrecision).toEqual({ mean: 1, variance: 0, measuredRepeats: 1 })
    expect(scoreSecurity([])).toMatchObject({
      observations: 0,
      runs: [],
      recall: { mean: null, variance: null, measuredRepeats: 0 },
      postReproductionPrecision: { mean: null, variance: null, measuredRepeats: 0 },
      refusalRate: { mean: null, variance: null, measuredRepeats: 0 },
      incompleteRate: { mean: null, variance: null, measuredRepeats: 0 }
    })
  })
})
