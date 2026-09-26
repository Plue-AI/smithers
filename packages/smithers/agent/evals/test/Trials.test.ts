import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Trials from "../src/Trials.ts"

const failure = (run: () => unknown): EvalError => {
  try {
    run()
  } catch (error) {
    if (error instanceof EvalError) return error
    throw error
  }
  throw new Error("expected an EvalError")
}

const binomial = (n: bigint, k: bigint): bigint => {
  let value = 1n
  for (let i = 0n; i < k; i++) value = value * (n - i) / (i + 1n)
  return value
}

describe("Trials.passAtK", () => {
  it("matches 1 - C(n - c, k) / C(n, k)", () => {
    expect(Trials.passAtK(5, 2, 2)).toBeCloseTo(0.7, 12)
    expect(Trials.passAtK(10, 3, 1)).toBeCloseTo(0.3, 12)
    expect(Trials.passAtK(5, 0, 3)).toBe(0)
    expect(Trials.passAtK(4, 4, 2)).toBe(1)
    expect(Trials.passAtK(3, 1, 3)).toBe(1)
    expect(Trials.passAtK(1000, 1, 1)).toBeCloseTo(0.001, 12)
  })

  it("stays exact where the binomials overflow a double", () => {
    const exact = 1 - Number(binomial(1990n, 1000n) * 10n ** 15n / binomial(2000n, 1000n)) / 1e15
    expect(Trials.passAtK(2000, 10, 1000)).toBeCloseTo(exact, 12)
  })

  it("rejects counts outside their bounds", () => {
    for (
      const [n, c, k, path] of [
        [0, 0, 1, "n"],
        [2.5, 1, 1, "n"],
        [5, -1, 1, "c"],
        [5, 6, 1, "c"],
        [5, 1.5, 1, "c"],
        [5, 1, 0, "k"],
        [5, 1, 6, "k"],
        [5, 1, 1.5, "k"]
      ] as const
    ) {
      const error = failure(() => Trials.passAtK(n, c, k))
      expect(error.code).toBe("invalid_trials")
      expect(error.path).toBe(path)
    }
    expect(failure(() => Trials.passAtK(5, 1, 6)).message).toBe("k must be an integer from 1 to 5, received 6")
  })
})

describe("Trials.passHatK", () => {
  it("matches C(c, k) / C(n, k)", () => {
    expect(Trials.passHatK(5, 3, 2)).toBeCloseTo(0.3, 12)
    expect(Trials.passHatK(5, 3, 1)).toBeCloseTo(0.6, 12)
    expect(Trials.passHatK(5, 1, 2)).toBe(0)
    expect(Trials.passHatK(5, 0, 5)).toBe(0)
    expect(Trials.passHatK(4, 4, 4)).toBe(1)
  })

  it("rejects counts outside their bounds", () => {
    expect(failure(() => Trials.passHatK(3, 4, 1)).code).toBe("invalid_trials")
  })
})

describe("Trials.summarize", () => {
  it("summarizes one case", () => {
    const summary = Trials.summarize([true, false, true, true], 2)
    expect(summary).toMatchObject({ n: 4, passes: 3, rate: 0.75, passAt1: 0.75, passAtK: 1 })
    expect(summary.passHatK).toBeCloseTo(0.5, 12)
    expect(summary.stderr).toBeCloseTo(Math.sqrt(0.75 * 0.25 / 4), 12)
    expect(Trials.summarize([true], 1)).toEqual({
      n: 1,
      passes: 1,
      rate: 1,
      passAt1: 1,
      passAtK: 1,
      passHatK: 1,
      stderr: 0
    })
  })

  it("rejects no outcomes and a k above the run count", () => {
    expect(failure(() => Trials.summarize([], 1)).message).toBe("Run count must be a positive integer, received 0")
    expect(failure(() => Trials.summarize([true], 2)).path).toBe("k")
  })
})

describe("Trials.aggregate", () => {
  it("averages over cases and clamps k to a short case's run count", () => {
    const aggregate = Trials.aggregate({
      flaky: [true, false, true, true],
      broken: [false, false],
      solid: [true, true, true]
    }, 3)
    expect(aggregate.cases).toBe(3)
    expect(aggregate.passAt1).toBeCloseTo(1.75 / 3, 12)
    expect(aggregate.passAtK).toBeCloseTo(2 / 3, 12)
    expect(aggregate.passHatK).toBeCloseTo(1.25 / 3, 12)
    expect(aggregate.allPass).toBeCloseTo(1 / 3, 12)
    expect(aggregate.perCase.broken).toMatchObject({ n: 2, passAtK: 0, passHatK: 0 })
    expect(aggregate.perCase.flaky!.passHatK).toBeCloseTo(0.25, 12)
  })

  it("aggregates no cases to zeros", () => {
    expect(Trials.aggregate({}, 1)).toEqual({ cases: 0, passAt1: 0, passAtK: 0, passHatK: 0, allPass: 0, perCase: {} })
  })

  it("rejects a non-positive k and a case with no runs", () => {
    expect(failure(() => Trials.aggregate({ a: [true] }, 0)).path).toBe("k")
    expect(failure(() => Trials.aggregate({ a: [true] }, 1.5)).code).toBe("invalid_trials")
    const empty = failure(() => Trials.aggregate({ a: [true], b: [] }, 1))
    expect(empty).toMatchObject({ code: "invalid_trials", message: "Case 'b' has no runs", path: "cases['b']" })
  })
})
