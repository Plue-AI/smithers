# @smthrs/evals

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://evals.smithers.sh

Fixed-suite evaluation for flows: it connects target execution and scorer runners
to validated suites, committed baselines, regression comparison, reports, and CI
gates.

A unit test asserts equality. A flow that calls a model produces an answer that
is rarely equal to anything, only better or worse than the last one. This package
scores the answer, compares the score with a committed baseline, and turns the
comparison into a CI exit code.

Runtime grading belongs to `@smthrs/scorers/ScoreGate`: score samples, verdicts,
threshold checks, CI grades, and `ScoreGateError` share one pure contract.
`@smthrs/testing/ScoreGate` is its test facade and also supplies a fixed-suite
runner. Runtime evaluation code imports scorers directly.

## Install

The package is at 1.0.0-rc.0 and is not on the npm registry yet. It is a
workspace package of https://github.com/smithersai/smithers, so you use it from
a package in a clone of that repository. The steps are at
https://evals.smithers.sh/installation/.

## Example

```ts
import { CaseExecutor, Runner, Suite } from "@smthrs/evals"
import { Effect, Layer } from "effect"

const greet = ({ name: "greet" })

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
    name: "smoke",
    cases: [{ name: "hello", input: { name: "Ada" } }],
    concurrency: 1
  })
  return yield* Runner.run(suite, { runId: "nightly-2026-01-01", at: "2026-01-01T00:00:00.000Z" })
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))
```

`Runner.run` needs only `CaseExecutor`: scoring runs in process by default.
Baselines, regression comparison, reports, and gates complete the loop;
https://evals.smithers.sh/quickstart/ walks all of it end to end.

## Reference

https://evals.smithers.sh/reference/api/ documents every export, the stable
failure codes, the batch-runner protocol, the step-key rule that separates a
regression from nondeterminism, and the declared size and concurrency limits.
