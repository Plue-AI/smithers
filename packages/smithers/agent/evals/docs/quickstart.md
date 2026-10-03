---
title: "Quickstart"
description: "Declare a fixed suite, run it, record a baseline, and gate the next run against it."
---

This tutorial walks one complete evaluation loop. You declare a suite for a
greeting flow, run it, record the scores as a baseline, and gate a later run
against that baseline. By the end you have a script that exits 0 while the
flow behaves and 1 when a score drops.

You need a workspace package with `@smthrs/evals` installed. For setup, see
[Installation](./installation.md).

## 1. Declare a target and a scorer

A target is the flow the suite exercises. A scorer grades one execution and
returns a number in [0, 1]. Both come from packages the pipeline composes:
`Flow` from [@smthrs/core](/api/core) and `Scorer` from
[@smthrs/scorers](/api/scorers).

```ts
import { Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const greet = ({ name: "greet" })

const polite = Scorer.make({
  id: "quickstart/polite",
  version: "1",
  name: "polite",
  score: ({ output }) => Effect.succeed({ score: String(output).startsWith("Hello") ? 1 : 0 })
})
```

## 2. Declare the suite

A suite is the fixed half of the evaluation: named cases, the scorer bindings
that grade them, and the concurrency the runner is allowed. `Suite.make`
validates the declaration and snapshots it, so the suite cannot change after
validation.

```ts
import { Suite } from "@smthrs/evals"
import { Binding } from "@smthrs/scorers"

Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: "greetings",
    cases: [
      { name: "ada", input: { name: "Ada" }, expected: "Hello, Ada" },
      { name: "grace", input: { name: "Grace" }, expected: "Hello, Grace" }
    ],
    bindings: [Binding.make({ scorer: polite, appliesTo: greet })],
    concurrency: 2
  })
})
```

`Binding.make` attaches the `polite` scorer to the `greet` flow. The match is
by reference identity: only an execution that reports the `greet` value itself
as its target is graded by this binding.

## 3. Execute cases through an injected boundary

The `CaseExecutor` service says how one case runs against the target. Each
execution reports its output, a step key identifying the work, a latency, and
the target flow value itself.

```ts
import { CaseExecutor } from "@smthrs/evals"

const executor = CaseExecutor.make((suiteCase) =>
  Effect.succeed({
    output: `Hello, ${(suiteCase.input as { readonly name: string }).name}`,
    stepKey: suiteCase.name,
    latencyMs: 0,
    target: greet
  })
)
```

Keep the step key fixed per case. The comparison reads a changed key as
different work and a moved score under an unchanged key as nondeterminism, and
both readings need the key stated, not derived from the run. For the full
rule, see [Step keys and comparison](./concepts/step-keys.md).

## 4. Run the suite

`Runner.run` executes the cases at the suite's concurrency and scores every
execution whose target matches a binding. It takes `runId` and `at` from you,
so a re-run over the same inputs produces identical observations.

```ts
import { Runner } from "@smthrs/evals"

Effect.gen(function*() {
  const run = yield* Runner.run(suite, {
    runId: "quickstart-1",
    at: "2026-01-01T00:00:00.000Z"
  })
})
```

The `at` value must be a canonical UTC timestamp with millisecond precision,
such as `2026-01-01T00:00:00.000Z`. `new Date().toISOString()` satisfies the
format.

## 5. Record the baseline

`Baseline.fromRun` keeps the run's successful scores, and `Baseline.write`
serializes them as canonical JSON to commit beside the suite.

```ts
import { Baseline, EvalError } from "@smthrs/evals"
import { writeFile } from "node:fs/promises"

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

Inconclusive observations are dropped: a baseline records what was measured,
and an inconclusive observation measured nothing.

## 6. Gate the next run against the baseline

On the next run, load the committed artifact, compare it against the run,
render the report, and grade the comparison.

```ts
import { Gate, Regression, Report } from "@smthrs/evals"
import { readFile } from "node:fs/promises"

Effect.gen(function*() {
  const committed = yield* Baseline.load(
    yield* Effect.promise(() => readFile("baseline.json", "utf8"))
  )
  const comparison = yield* Regression.compare(committed, run)
  yield* Effect.sync(() => process.stdout.write(Report.markdown(comparison)))
  const verdict = yield* Gate.check(comparison, { mean: 1 })
  const grade = Gate.ciGrade(verdict)
})
```

## 7. Put it together

The complete script, `quickstart.ts`:

```ts
import { Baseline, CaseExecutor, EvalError, Gate, Regression, Report, Runner, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { Effect, Layer } from "effect"
import { readFile, writeFile } from "node:fs/promises"

const greet = ({ name: "greet" })

const polite = Scorer.make({
  id: "quickstart/polite",
  version: "1",
  name: "polite",
  score: ({ output }) => Effect.succeed({ score: String(output).startsWith("Hello") ? 1 : 0 })
})

const executor = CaseExecutor.make((suiteCase) =>
  Effect.succeed({
    output: `Hello, ${(suiteCase.input as { readonly name: string }).name}`,
    stepKey: suiteCase.name,
    latencyMs: 0,
    target: greet
  })
)

const program = Effect.gen(function*() {
  const suite = yield* Suite.make({
    name: "greetings",
    cases: [
      { name: "ada", input: { name: "Ada" }, expected: "Hello, Ada" },
      { name: "grace", input: { name: "Grace" }, expected: "Hello, Grace" }
    ],
    bindings: [Binding.make({ scorer: polite, appliesTo: greet })],
    concurrency: 2
  })
  const run = yield* Runner.run(suite, {
    runId: "quickstart-1",
    at: "2026-01-01T00:00:00.000Z"
  })

  if (process.argv.includes("--update")) {
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
    yield* Effect.sync(() => process.stdout.write("baseline recorded\n"))
    return 0
  }

  const committed = yield* Baseline.load(
    yield* Effect.promise(() => readFile("baseline.json", "utf8"))
  )
  const comparison = yield* Regression.compare(committed, run)
  yield* Effect.sync(() => process.stdout.write(Report.markdown(comparison)))
  const verdict = yield* Gate.check(comparison, { mean: 1 })
  const { exitCode, summary } = Gate.ciGrade(verdict)
  yield* Effect.sync(() => process.stdout.write(`${summary}\n`))
  return exitCode
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))

process.exitCode = await Effect.runPromise(program)
```

1. Record the baseline with `node quickstart.ts --update`. The script prints
   `baseline recorded` and exits 0. If any case failed, it refuses to record
   and fails with an `executor` `EvalError` instead.
2. Gate against it with `node quickstart.ts`. The script prints the Markdown
   report, then `passed`, and exits 0.
3. Change the executor to answer `Hi` instead of `Hello` and gate again. Both
   cases score 0 at their unchanged step keys, the comparison reports
   nondeterminism, and the script exits 1.

From here: [author a larger suite](./guides/author-a-suite.md), or read how
[step keys decide what a comparison reports](./concepts/step-keys.md).
