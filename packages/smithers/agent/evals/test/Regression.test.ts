import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Baseline from "../src/Baseline.ts"
import type { EvalError } from "../src/EvalError.ts"
import * as Regression from "../src/Regression.ts"
import type * as Runner from "../src/Runner.ts"

/** Runs an effect that must fail and returns the typed failure it raised. */
const failure = (effect: Effect.Effect<unknown, EvalError>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

const baseline = {
  version: 1 as const,
  suite: "s",
  records: [{ suite: "s", case: "c", scorer: "x", stepKey: "old", score: 0.9 }]
}
const run = (stepKey: string, score: number): Runner.RunResult => ({
  runId: "run",
  suite: "s",
  cases: [],
  observations: [{ case: "c", scorer: "x", stepKey, kind: "score" as const, score, at: "t" }]
})

describe("Regression", () => {
  it("distinguishes a changed key regression from same-key nondeterminism", async () => {
    const changed = await Effect.runPromise(Regression.compare(baseline, run("new", 0.2)))
    const same = await Effect.runPromise(Regression.compare(baseline, run("old", 0.2)))
    expect(changed.regressions).toHaveLength(1)
    expect(changed.regressions[0]?.drop).toBeCloseTo(0.7)
    expect(changed.nondeterminism).toHaveLength(0)
    expect(same.regressions).toHaveLength(0)
    expect(same.nondeterminism).toHaveLength(1)
    expect(same.nondeterminism[0]?.delta).toBeCloseTo(-0.7)
  })

  it("ignores a score that improved at a changed key", async () => {
    const improved = await Effect.runPromise(Regression.compare(baseline, run("new", 1)))
    expect(improved.regressions).toEqual([])
    expect(improved.nondeterminism).toEqual([])
  })

  it("honours the absolute and relative tolerances independently", async () => {
    const drop = await Effect.runPromise(Regression.compare(baseline, run("new", 0.85), { absolute: 0.1 }))
    expect(drop.regressions).toEqual([])

    const relative = await Effect.runPromise(Regression.compare(baseline, run("new", 0.85), { relative: 0.2 }))
    expect(relative.regressions).toEqual([])

    const both = await Effect.runPromise(
      Regression.compare(baseline, run("new", 0.85), { absolute: 0.01, relative: 0.01 })
    )
    expect(both.regressions).toHaveLength(1)

    const jitter = await Effect.runPromise(Regression.compare(baseline, run("old", 0.85), { absolute: 0.1 }))
    expect(jitter.nondeterminism).toEqual([])
  })

  // A move is reported only when it exceeds both tolerances, so a move landing
  // exactly on one is silenced. 1, 0.5, 0.75 and the tolerances below are
  // exactly representable, so the moves sit on the boundary with no float
  // slack and relaxing either strict comparison to `>=` flips an expectation.
  const unitBaseline = {
    version: 1 as const,
    suite: "s",
    records: [{ suite: "s", case: "c", scorer: "x", stepKey: "old", score: 1 }]
  }
  const compareUnit = (stepKey: string, score: number, tolerances: Regression.Tolerances) =>
    Effect.runPromise(Regression.compare(unitBaseline, run(stepKey, score), tolerances))

  it("silences a changed-key drop that sits exactly on the absolute tolerance", async () => {
    const under = await compareUnit("new", 0.75, { absolute: 0.1875, relative: 0 })
    expect(under.regressions.map((item) => item.drop)).toEqual([0.25])

    const at = await compareUnit("new", 0.75, { absolute: 0.25, relative: 0 })
    expect(at.regressions).toEqual([])

    const over = await compareUnit("new", 0.75, { absolute: 0.3125, relative: 0 })
    expect(over.regressions).toEqual([])
  })

  it("silences a changed-key drop that sits exactly on the relative tolerance", async () => {
    const under = await compareUnit("new", 0.75, { absolute: 0, relative: 0.1875 })
    expect(under.regressions.map((item) => item.drop)).toEqual([0.25])

    const at = await compareUnit("new", 0.75, { absolute: 0, relative: 0.25 })
    expect(at.regressions).toEqual([])

    const over = await compareUnit("new", 0.75, { absolute: 0, relative: 0.3125 })
    expect(over.regressions).toEqual([])
  })

  it("silences same-key jitter that sits exactly on either tolerance", async () => {
    const underAbsolute = await compareUnit("old", 0.75, { absolute: 0.1875, relative: 0 })
    expect(underAbsolute.nondeterminism.map((item) => item.delta)).toEqual([-0.25])

    const atAbsolute = await compareUnit("old", 0.75, { absolute: 0.25, relative: 0 })
    expect(atAbsolute.nondeterminism).toEqual([])

    const overAbsolute = await compareUnit("old", 0.75, { absolute: 0.3125, relative: 0 })
    expect(overAbsolute.nondeterminism).toEqual([])

    const underRelative = await compareUnit("old", 0.75, { absolute: 0, relative: 0.1875 })
    expect(underRelative.nondeterminism.map((item) => item.delta)).toEqual([-0.25])

    const atRelative = await compareUnit("old", 0.75, { absolute: 0, relative: 0.25 })
    expect(atRelative.nondeterminism).toEqual([])

    const overRelative = await compareUnit("old", 0.75, { absolute: 0, relative: 0.3125 })
    expect(overRelative.nondeterminism).toEqual([])
  })

  // Same-key movement is reported in either direction, so the boundary holds
  // for a rise too. A rise from 0.5 to 0.75 is 0.25 absolute and 0.5 relative.
  it("silences a same-key rise that sits exactly on either tolerance", async () => {
    const halfBaseline = {
      version: 1 as const,
      suite: "s",
      records: [{ suite: "s", case: "c", scorer: "x", stepKey: "old", score: 0.5 }]
    }
    const rise = (tolerances: Regression.Tolerances) =>
      Effect.runPromise(Regression.compare(halfBaseline, run("old", 0.75), tolerances))

    const underAbsolute = await rise({ absolute: 0.1875, relative: 0 })
    expect(underAbsolute.nondeterminism.map((item) => item.delta)).toEqual([0.25])

    const atAbsolute = await rise({ absolute: 0.25, relative: 0 })
    expect(atAbsolute.nondeterminism).toEqual([])

    const underRelative = await rise({ absolute: 0, relative: 0.375 })
    expect(underRelative.nondeterminism.map((item) => item.delta)).toEqual([0.25])

    const atRelative = await rise({ absolute: 0, relative: 0.5 })
    expect(atRelative.nondeterminism).toEqual([])
  })

  it("reports any drop from a zero baseline score whatever the relative tolerance", async () => {
    const zero = {
      version: 1 as const,
      suite: "s",
      records: [{ suite: "s", case: "c", scorer: "x", stepKey: "old", score: 0 }]
    }
    const improved = await Effect.runPromise(Regression.compare(zero, run("new", 0.5), { relative: 10 }))
    expect(improved.regressions).toEqual([])

    const moved = await Effect.runPromise(Regression.compare(zero, run("old", 0.5), { relative: 10 }))
    expect(moved.nondeterminism).toHaveLength(1)
  })

  it("rejects a tolerance that is not finite and non-negative", async () => {
    const absolute = await failure(Regression.compare(baseline, run("old", 0.9), { absolute: -1 }))
    expect(absolute.code).toBe("invalid_tolerance")
    expect(absolute.message).toBe("Regression tolerance 'absolute' must be finite and non-negative, got -1")
    expect(absolute.path).toBe("tolerances.absolute")

    const relative = await failure(
      Regression.compare(baseline, run("old", 0.9), { relative: Number.POSITIVE_INFINITY })
    )
    expect(relative.code).toBe("invalid_tolerance")
    expect(relative.message).toBe("Regression tolerance 'relative' must be finite and non-negative, got Infinity")
    expect(relative.path).toBe("tolerances.relative")
  })

  // A baseline recorded for another suite used to compare clean, so the wrong
  // path in CI read as a pass.
  it("refuses a baseline that belongs to another suite", async () => {
    const foreign = await failure(
      Regression.compare(
        { version: 1, suite: "s", records: [{ suite: "OTHER", case: "c", scorer: "x", stepKey: "old", score: 0.9 }] },
        run("old", 0.9)
      )
    )
    expect(foreign.code).toBe("invalid_baseline")
    expect(foreign.message).toBe("Baseline holds records for suite 'OTHER', but the run is suite 's'")
    expect(foreign.path).toBe("baseline.records")

    const mixed = await failure(
      Regression.compare(
        {
          version: 1,
          suite: "s",
          records: [
            { suite: "s", case: "c", scorer: "x", stepKey: "old", score: 0.9 },
            { suite: "a", case: "c", scorer: "x", stepKey: "old", score: 0.9 },
            { suite: "b", case: "c", scorer: "x", stepKey: "old", score: 0.9 }
          ]
        },
        run("old", 0.9)
      )
    )
    expect(mixed.message).toBe("Baseline holds records for suite 'a', 'b', but the run is suite 's'")
  })

  it("checks artifact ownership even when a baseline has no records", async () => {
    const emptyForeign = await Effect.runPromise(Baseline.fromRun({
      runId: "run",
      suite: "OTHER",
      cases: [],
      observations: []
    }))
    const foreign = await failure(Regression.compare(emptyForeign, run("old", 0.9)))
    expect(foreign.code).toBe("invalid_baseline")
    expect(foreign.message).toBe("Baseline belongs to suite 'OTHER', but the run is suite 's'")
    expect(foreign.path).toBe("baseline.suite")
  })

  // An unvalidated baseline object must not carry a newline into an error
  // message a caller prints to a CI log.
  it("flattens control characters in suite ownership errors", async () => {
    const artifact = await failure(
      Regression.compare({ version: 1, suite: "s\n::warning::forged", records: [] }, run("old", 0.9))
    )
    expect(artifact.message).toBe("Baseline belongs to suite 's ::warning::forged', but the run is suite 's'")
    const records = await failure(
      Regression.compare(
        {
          version: 1,
          suite: "s",
          records: [{ suite: "o\u009b2K\n::error::x", case: "c", scorer: "x", stepKey: "old", score: 0.9 }]
        },
        run("old", 0.9)
      )
    )
    expect(records.message).toBe("Baseline holds records for suite 'o 2K ::error::x', but the run is suite 's'")
  })

  it("retains observations missing from either side", async () => {
    const missingFromRun = await Effect.runPromise(
      Regression.compare(baseline, { runId: "run", suite: "s", cases: [], observations: [] })
    )
    expect(missingFromRun.missing).toEqual([{ side: "run", case: "c", scorer: "x", stepKey: "old" }])

    const missingFromBaseline = await Effect.runPromise(
      Regression.compare({ version: 1, suite: "s", records: [] }, run("new", 0.5))
    )
    expect(missingFromBaseline.missing).toEqual([{ side: "baseline", case: "c", scorer: "x", stepKey: "new" }])
  })

  it("carries the paired scorer name into missing observations", async () => {
    const result = await Effect.runPromise(
      Regression.compare(
        {
          version: 1,
          suite: "s",
          records: [{
            suite: "s",
            case: "expected",
            scorer: "0123456789abcdef",
            scorerName: "baseline-name",
            stepKey: "old",
            score: 1
          }]
        },
        {
          runId: "run",
          suite: "s",
          cases: [],
          observations: [{
            case: "actual",
            scorer: "fedcba9876543210",
            scorerName: "actual-name",
            stepKey: "new",
            kind: "score",
            score: 1,
            at: "t"
          }]
        }
      )
    )
    expect(result.missing).toEqual([
      {
        side: "run",
        case: "expected",
        scorer: "0123456789abcdef",
        scorerName: "baseline-name",
        stepKey: "old"
      },
      {
        side: "baseline",
        case: "actual",
        scorer: "fedcba9876543210",
        scorerName: "actual-name",
        stepKey: "new"
      }
    ])
  })

  it("carries inconclusive observations through untouched", async () => {
    const report = await Effect.runPromise(
      Regression.compare({ version: 1, suite: "s", records: [] }, {
        runId: "run",
        suite: "s",
        cases: [],
        observations: [{ case: "c", scorer: "x", stepKey: "k", kind: "inconclusive", reason: "judge down", at: "t" }]
      })
    )
    expect(report.inconclusive).toHaveLength(1)
    expect(report.samples).toEqual([])
    expect(report.missing).toEqual([])
  })

  it("matches repeated scorer observations by step key before array order", async () => {
    const repeated = {
      version: 1 as const,
      suite: "s",
      records: [
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.2 },
        { suite: "s", case: "c", scorer: "x", stepKey: "b", score: 0.8 }
      ]
    }
    const result = await Effect.runPromise(
      Regression.compare(repeated, {
        runId: "run",
        suite: "s",
        cases: [],
        observations: [
          { case: "c", scorer: "x", stepKey: "b", kind: "score" as const, score: 0.8, at: "t" },
          { case: "c", scorer: "x", stepKey: "a", kind: "score" as const, score: 0.2, at: "t" }
        ]
      })
    )
    expect(result.regressions).toEqual([])
    expect(result.nondeterminism).toEqual([])
    expect(result.missing).toEqual([])
  })

  it("pairs a repeated scorer's leftovers in stable order and reports the rest as missing", async () => {
    const repeated = {
      version: 1 as const,
      suite: "s",
      records: [
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.2 },
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.8 },
        { suite: "s", case: "c", scorer: "x", stepKey: "b", score: 0.5 }
      ]
    }
    const result = await Effect.runPromise(
      Regression.compare(repeated, {
        runId: "run",
        suite: "s",
        cases: [],
        observations: [
          { case: "c", scorer: "x", stepKey: "a", kind: "score" as const, score: 0.2, at: "t" },
          { case: "c", scorer: "x", stepKey: "z", kind: "score" as const, score: 0.5, at: "t" }
        ]
      })
    )
    // `a`/0.2 pairs at the same step key; `a`/0.8 has no partner at `a`, so it
    // pairs with the leftover `z` observation as a changed-key comparison, and
    // the unmatched `b` record is missing from the run.
    expect(result.regressions.map((item) => item.baseline.stepKey)).toEqual(["a"])
    expect(result.missing).toEqual([{ side: "run", case: "c", scorer: "x", stepKey: "b" }])
  })

  it("orders leftovers sharing a step key by score", async () => {
    const repeated = {
      version: 1 as const,
      suite: "s",
      records: [
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.8 },
        { suite: "s", case: "c", scorer: "x", stepKey: "a", score: 0.2 }
      ]
    }
    const result = await Effect.runPromise(
      Regression.compare(repeated, {
        runId: "run",
        suite: "s",
        cases: [],
        observations: [
          { case: "c", scorer: "x", stepKey: "z", kind: "score" as const, score: 0.3, at: "t" },
          { case: "c", scorer: "x", stepKey: "z", kind: "score" as const, score: 0.1, at: "t" }
        ]
      })
    )
    expect(result.missing).toEqual([])
    expect(result.regressions.map((item) => [item.baseline.score, item.actual.score])).toEqual([[0.2, 0.1], [
      0.8,
      0.3
    ]])
  })

  // Joining a tuple on a delimiter is not injective: with a NUL join, the pairs
  // below produced one key, so two unrelated observations were compared as one.
  it("groups by an injective (case, scorer) key", async () => {
    const collidable = {
      version: 1 as const,
      suite: "s",
      records: [
        { suite: "s", case: "a", scorer: "b\u0000c", stepKey: "k", score: 1 },
        { suite: "s", case: "a\u0000b", scorer: "c", stepKey: "k", score: 1 }
      ]
    }
    const result = await Effect.runPromise(
      Regression.compare(collidable, { runId: "run", suite: "s", cases: [], observations: [] })
    )
    expect(result.missing).toEqual([
      { side: "run", case: "a", scorer: "b\u0000c", stepKey: "k" },
      { side: "run", case: "a\u0000b", scorer: "c", stepKey: "k" }
    ])
  })
})
