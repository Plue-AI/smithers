---
title: "Maintain a baseline"
description: "Record what a run scored, commit the canonical artifact, and load it back for comparison."
sidebar:
  order: 3
---

A baseline is the record of what a suite used to score, committed beside the
suite it belongs to. Record one with `Baseline.fromRun` and `Baseline.write`;
load it back with `Baseline.load`.

## Record a baseline

`Baseline.fromRun` keeps a run's successful score observations and drops
inconclusive ones: a baseline records what was measured, and an inconclusive
observation measured nothing.

```ts
Effect.gen(function*() {
  const failures = run.cases.filter((result) => result.error !== undefined)
  if (failures.length > 0) {
    return yield* Effect.fail(
      new EvalError.EvalError({
        code: "executor",
        message: `Refusing to record a baseline: ${failures.length} case(s) did not finish`
      })
    )
  }
  const baseline = yield* Baseline.fromRun(run)
  yield* Effect.promise(() => writeFile("baseline.json", Baseline.write(baseline)))
})
```

`Baseline.write` serializes canonical JSON: object keys sorted recursively,
records ordered by an injective encoding of `(suite, case, scorer, stepKey)`,
and a trailing newline. Two runs over the same inputs produce byte-identical
baseline files, so the committed artifact diffs cleanly.

Do not record over a broken run. The guard above refuses when any case failed,
because a baseline recorded over a failed case ratifies the absence of a
measurement. Keep it on every update path.

Re-record the baseline only when a score moved for a reason you can name. The
baseline is the record of what the target used to do; overwriting it to quiet
a red gate erases the regression the gate caught.

## The artifact

A baseline is versioned JSON owned by one suite. This is the shape
`Baseline.write` emits, with every object key sorted:

```json
{
  "records": [
    {
      "case": "adds numbers",
      "score": 1,
      "scorer": "exact",
      "stepKey": "step-a",
      "suite": "arithmetic"
    }
  ],
  "suite": "arithmetic",
  "version": 1
}
```

- `version` is `1`, the current artifact version (`Baseline.version`).
- `suite` names the owning suite even when `records` is empty.
- Each record carries `suite`, `case`, `scorer`, `stepKey`, and `score`, plus
  an optional `scorerName`. The `scorer` field is the scorer key, a digest of
  the scorer's declaration, and it is what a comparison matches on.

## Load and validate

`Baseline.load` parses and validates committed JSON. `Baseline.make` validates
an in-memory value. Both rebuild every record from the validated fields, so
nothing a caller happened to attach to an object travels into a committed
artifact, and the returned array is frozen. Validation fails with
`invalid_baseline`, carrying the record index and field name in `path`, for a
wrong version, a non-array `records`, a record that is not an object, a
top-level `suite` or identity field that holds a control character, a record
identity field that is not a string, a file longer than
`Baseline.limits.length`, or a score that is not finite in [0, 1]. A negative zero score is normalized to 0.

Ownership is checked at comparison time: `Regression.compare` refuses a
baseline whose artifact or any record names a suite other than the run's,
failing with `invalid_baseline` rather than reporting a clean pass for the
wrong file.

Next: [gate the run in CI](./gate-a-run-in-ci.md).
