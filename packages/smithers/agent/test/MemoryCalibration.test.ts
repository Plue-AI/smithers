/**
 * The threshold math behind every `memory` routing decision, checked against
 * hand-computed values: the cost-optimal threshold, the reliability table
 * lookup and its bucket edges, the monotone fit, the cost a threshold incurs,
 * and the guards that stop a weekly refit from landing on thin or jumpy
 * evidence.
 */
import { describe, expect, it } from "vitest"
import * as MemoryCalibration from "../src/MemoryCalibration.ts"

const symmetric = { miss: 1, extra: 1 }

/** A decision with the given table and threshold. */
const decided = (
  tau: number,
  reliability: ReadonlyArray<number> | null = null,
  costs = symmetric
): MemoryCalibration.Decided => ({ costs, tau, reliability })

/** `count` copies of one label. */
const labels = (count: number, label: MemoryCalibration.Label): Array<MemoryCalibration.Label> =>
  Array.from({ length: count }, () => label)

/** A table whose bucket `i` maps to `i / 10 + 0.01`, so every bucket is distinguishable. */
const table = Array.from({ length: 10 }, (_, index) => Number((index / 10 + 0.01).toFixed(2)))

describe("tau", () => {
  it("is extra / (miss + extra), low when a miss costs more and high when an extra does", () => {
    expect(MemoryCalibration.tau({ miss: 3, extra: 1 })).toBe(0.25)
    expect(MemoryCalibration.tau({ miss: 1, extra: 3 })).toBe(0.75)
    expect(MemoryCalibration.tau(symmetric)).toBe(0.5)
    expect(MemoryCalibration.tau({ miss: 13, extra: 7 })).toBeCloseTo(0.35, 10)
  })
})

describe("calibrated and include", () => {
  it("passes p through without a reliability table", () => {
    for (const p of [0, 0.1, 0.42, 0.999, 1]) expect(MemoryCalibration.calibrated(decided(0.5), p)).toBe(p)
  })

  it("maps p through the table's bucket, with 1 in the last bucket and out-of-range p clamped", () => {
    const withTable = decided(0.5, table)
    expect(MemoryCalibration.calibrated(withTable, 0)).toBe(0.01)
    expect(MemoryCalibration.calibrated(withTable, 0.0999)).toBe(0.01)
    expect(MemoryCalibration.calibrated(withTable, 0.1)).toBe(0.11)
    expect(MemoryCalibration.calibrated(withTable, 0.55)).toBe(0.51)
    expect(MemoryCalibration.calibrated(withTable, 0.999)).toBe(0.91)
    expect(MemoryCalibration.calibrated(withTable, 1)).toBe(0.91)
    expect(MemoryCalibration.calibrated(withTable, -0.3)).toBe(0.01)
    expect(MemoryCalibration.calibrated(withTable, 1.7)).toBe(0.91)
  })

  it("includes at or above tau on the calibrated scale, never below", () => {
    expect(MemoryCalibration.include(decided(0.5), 0.5)).toBe(true)
    expect(MemoryCalibration.include(decided(0.5), 0.4999)).toBe(false)
    // Raw 0.55 clears 0.52 without a table; its bucket maps to 0.51, which does not.
    expect(MemoryCalibration.include(decided(0.52), 0.55)).toBe(true)
    expect(MemoryCalibration.include(decided(0.52, table), 0.55)).toBe(false)
    // Raw 0.1 misses 0.11 without a table; its bucket maps to exactly 0.11.
    expect(MemoryCalibration.include(decided(0.11), 0.1)).toBe(false)
    expect(MemoryCalibration.include(decided(0.11, table), 0.1)).toBe(true)
  })
})

describe("fit", () => {
  const monotone = (values: ReadonlyArray<number>) =>
    values.every((value, index) => index === 0 || value >= values[index - 1]!)

  it("gives every empty bucket its midpoint", () => {
    expect(MemoryCalibration.fit([])).toEqual([0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])
  })

  it("pools adjacent violators into their weighted mean", () => {
    // Bucket 2 hits 8/10, bucket 3 hits 2/10: pooled to 0.5, and the empty
    // bucket 4's midpoint 0.45 is pooled into that block too.
    const fitted = MemoryCalibration.fit([
      ...labels(8, { p: 0.25, needed: true }),
      ...labels(2, { p: 0.25, needed: false }),
      ...labels(2, { p: 0.35, needed: true }),
      ...labels(8, { p: 0.35, needed: false })
    ])
    expect(fitted).toEqual([0.05, 0.15, 0.5, 0.5, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95])
    expect(monotone(fitted)).toBe(true)
  })

  it("cascades a pool back through earlier blocks", () => {
    // 0.2, then 0.6, then 0.0 over 30 labels: pooling the last two gives 0.15,
    // below the first bucket, which then joins: (2 + 6 + 0) / 50 = 0.16.
    const fitted = MemoryCalibration.fit([
      ...labels(2, { p: 0.05, needed: true }),
      ...labels(8, { p: 0.05, needed: false }),
      ...labels(6, { p: 0.15, needed: true }),
      ...labels(4, { p: 0.15, needed: false }),
      ...labels(30, { p: 0.25, needed: false })
    ])
    expect(fitted.slice(0, 3)).toEqual([0.16, 0.16, 0.16])
    expect(fitted.slice(3)).toEqual([0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95])
    expect(monotone(fitted)).toBe(true)
  })

  it("weights each label, defaulting to 1", () => {
    const weighted = MemoryCalibration.fit([
      { p: 0.55, needed: true, weight: 3 },
      { p: 0.55, needed: false }
    ])
    const unweighted = MemoryCalibration.fit([{ p: 0.55, needed: true }, { p: 0.55, needed: false }])
    expect(weighted[5]).toBe(0.75)
    expect(unweighted[5]).toBe(0.5)
    // A zero-weight label counts as no label: the bucket keeps its midpoint.
    expect(MemoryCalibration.fit([{ p: 0.55, needed: true, weight: 0 }])[5]).toBe(0.55)
  })

  it("is monotone for arbitrary non-monotone labels", () => {
    const noisy = Array.from({ length: 200 }, (_, index) => ({
      p: (index * 37 % 100) / 100,
      needed: (index * 7919) % 3 === 0,
      weight: 1 + (index % 4)
    }))
    const fitted = MemoryCalibration.fit(noisy)
    expect(fitted).toHaveLength(10)
    expect(monotone(fitted)).toBe(true)
  })
})

describe("expectedCost", () => {
  const sample: ReadonlyArray<MemoryCalibration.Label> = [
    { p: 0.2, needed: true },
    { p: 0.8, needed: false, weight: 2 },
    { p: 0.6, needed: true },
    { p: 0.1, needed: false }
  ]

  it("charges each miss and each extra by its weight", () => {
    // One miss (0.2 < 0.5) at 3, one extra (0.8 ≥ 0.5) of weight 2 at 1.
    expect(MemoryCalibration.expectedCost(sample, null, 0.5, { miss: 3, extra: 1 })).toBe(5)
    // At 0 everything is included: extras 2 + 1.
    expect(MemoryCalibration.expectedCost(sample, null, 0, { miss: 3, extra: 1 })).toBe(3)
    // Above 1 everything is excluded: misses 3 + 3.
    expect(MemoryCalibration.expectedCost(sample, null, 1.01, { miss: 3, extra: 1 })).toBe(6)
  })

  it("reads probabilities through the table when one is given", () => {
    const ones = Array.from({ length: 10 }, () => 1)
    expect(MemoryCalibration.expectedCost(sample, ones, 0.5, { miss: 3, extra: 1 })).toBe(3)
    const zeros = Array.from({ length: 10 }, () => 0)
    expect(MemoryCalibration.expectedCost(sample, zeros, 0.5, { miss: 3, extra: 1 })).toBe(6)
  })
})

describe("bestTau", () => {
  it("picks the cost-minimizing threshold", () => {
    // Needed at 0.3, unneeded at 0.2: only (0.2, 0.3] costs nothing.
    const found = MemoryCalibration.bestTau(
      [...labels(5, { p: 0.3, needed: true }), ...labels(5, { p: 0.2, needed: false })],
      null,
      symmetric
    )
    expect(found).toBe(0.3)
    // Needed at 0.8, unneeded at 0.75 with extras dear: (0.75, 0.8] again.
    expect(
      MemoryCalibration.bestTau([{ p: 0.8, needed: true }, { p: 0.75, needed: false }], null, { miss: 1, extra: 9 })
    ).toBe(0.8)
  })

  it("breaks a tie toward tau(costs)", () => {
    // Every threshold costs nothing without labels.
    expect(MemoryCalibration.bestTau([], null, { miss: 13, extra: 7 })).toBe(0.35)
    expect(MemoryCalibration.bestTau([], null, { miss: 1, extra: 3 })).toBe(0.75)
    // Zero cost over (0.2, 0.9]: tau 0.5 is inside and wins.
    expect(
      MemoryCalibration.bestTau([{ p: 0.9, needed: true }, { p: 0.2, needed: false }], null, symmetric)
    ).toBe(0.5)
    // Zero cost over (0.2, 0.3]: of the tied thresholds, 0.3 is nearest 0.75.
    expect(
      MemoryCalibration.bestTau([{ p: 0.3, needed: true }, { p: 0.2, needed: false }], null, { miss: 1, extra: 3 })
    ).toBe(0.3)
  })
})

describe("refit", () => {
  /** Separable labels: every threshold in (0, 1] costs nothing, so the fit proposes tau(costs) exactly. */
  const separable = (count: number) => [
    ...labels(Math.ceil(count / 2), { p: 0.95, needed: true }),
    ...labels(Math.floor(count / 2), { p: 0.05, needed: false })
  ]

  it("refuses 199 labels as too_few_labels and names what it would have proposed", () => {
    expect(MemoryCalibration.refit(decided(0.5), separable(199))).toEqual({
      _tag: "Refused",
      reason: "too_few_labels",
      proposed: 0.5,
      labels: 199
    })
  })

  it("lands at 200 labels with the fitted table", () => {
    const result = MemoryCalibration.refit(decided(0.5), separable(200))
    expect(result).toEqual({
      _tag: "Refit",
      labels: 200,
      decided: {
        costs: symmetric,
        tau: 0.5,
        reliability: [0, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 1]
      }
    })
  })

  it("refuses a 0.06 move as move_too_large and lands a 0.05 move either way", () => {
    expect(MemoryCalibration.refit(decided(0.44), separable(200))).toEqual({
      _tag: "Refused",
      reason: "move_too_large",
      proposed: 0.5,
      labels: 200
    })
    expect(MemoryCalibration.refit(decided(0.56), separable(200))).toMatchObject({
      _tag: "Refused",
      reason: "move_too_large",
      proposed: 0.5
    })
    expect(MemoryCalibration.refit(decided(0.45), separable(200))).toMatchObject({
      _tag: "Refit",
      decided: { tau: 0.5 }
    })
    expect(MemoryCalibration.refit(decided(0.55), separable(200))).toMatchObject({
      _tag: "Refit",
      decided: { tau: 0.5 }
    })
  })

  it("checks the label count before the move", () => {
    expect(MemoryCalibration.refit(decided(0.2), separable(10))).toMatchObject({
      _tag: "Refused",
      reason: "too_few_labels",
      proposed: 0.5
    })
  })
})

describe("digest", () => {
  it("is stable for equal settings and changes when any threshold does", () => {
    const base = MemoryCalibration.digest(MemoryCalibration.initial)
    expect(MemoryCalibration.digest(structuredClone(MemoryCalibration.initial))).toBe(base)
    const moved = {
      ...MemoryCalibration.initial,
      decisions: {
        ...MemoryCalibration.initial.decisions,
        commit: { ...MemoryCalibration.initial.decisions.commit, tau: 0.55 }
      }
    }
    expect(MemoryCalibration.digest(moved)).not.toBe(base)
    const tabled = {
      ...MemoryCalibration.initial,
      decisions: {
        ...MemoryCalibration.initial.decisions,
        file: { ...MemoryCalibration.initial.decisions.file, reliability: table }
      }
    }
    expect(MemoryCalibration.digest(tabled)).not.toBe(base)
    expect(MemoryCalibration.digest(tabled)).not.toBe(MemoryCalibration.digest(moved))
  })
})

describe("initial", () => {
  it("declares each decision's threshold from its costs, with no table", () => {
    const taus = Object.fromEntries(
      Object.entries(MemoryCalibration.initial.decisions).map(([name, setting]) => [name, setting.tau])
    )
    expect(taus).toEqual({
      page: 0.35,
      skill: 0.35,
      file: 0.35,
      descend: 0.3,
      commit: 0.5,
      dep: 0.5,
      fact: 0.7
    })
    for (const setting of Object.values(MemoryCalibration.initial.decisions)) {
      expect(setting.reliability).toBeNull()
      expect(setting.tau).toBe(Number(MemoryCalibration.tau(setting.costs).toFixed(2)))
    }
    expect(MemoryCalibration.initial.model).toBe("typesafe-ai/jev")
  })
})
