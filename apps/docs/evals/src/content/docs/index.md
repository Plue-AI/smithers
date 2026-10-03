---
title: "@smthrs/evals"
description: "Fixed-suite evaluation for flows: score a target against committed cases, compare the run with a baseline, and gate CI on the result."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/README.md"
---

`@smthrs/evals` tells you whether a flow still behaves. A flow is a declaration
of agent work built with [@smthrs/core](https://core.smithers.sh/reference/api/), and the thing a suite grades
is one execution of it. You declare a fixed set of cases and the scorers that
grade them, run the suite, and commit what it scored as a baseline file. Every
later run is compared with that file and graded into a CI exit code.

## Why you would reach for it

A unit test asserts equality. A flow that calls a model produces an answer that
is rarely equal to anything, only better or worse than the last one, so the
usual assertion has nothing to hold. Scoring the answer gives you a number, and
a number on its own decides nothing until there is another number to compare it
with.

This package supplies that half of the loop:

- **Fixed suites.** `Suite.make` validates a declaration once and freezes it, so
  the input half of the measurement cannot drift between the run that recorded a
  baseline and the run being judged.
- **A committed baseline.** `Baseline.write` emits byte-stable JSON, so the
  record of what the target used to score is a file you commit and diff.
- **A comparison that names the fault.** A score that dropped at a changed step
  key is a regression in the target. A score that moved at an unchanged step key
  is nondeterminism in the target or the scorer. Both are red, and they send you
  to different places.
- **A grade CI can act on.** `Gate.ciGrade` returns 0 for a pass, 1 for a real
  red, and 5 for a harness that could not decide, so a broken scorer never reads
  as a failing target.

Every stage is an `Effect` value, and nothing in a run reads a clock or
generates an identifier: `runId` and `at` come from the caller, so two runs over
the same inputs produce byte-identical observations.

The package is at 1.0.0-rc.0 and is not on the npm registry yet, so you get it
by working in a clone of the
[Smithers repository](https://github.com/smithersai/smithers).
[Installation](/installation/) has the steps.

## A working example

This script scores one case, compares the run with a committed
`baseline.json`, prints the Markdown report, and exits with the gate's grade.

```ts
import { Baseline, CaseExecutor, Gate, Regression, Report, Runner, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"

const greet = ({ name: "greet" })

const polite = Scorer.make({
  id: "example/polite",
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
    cases: [{ name: "ada", input: { name: "Ada" } }],
    bindings: [Binding.make({ scorer: polite, appliesTo: greet })],
    concurrency: 1
  })
  const run = yield* Runner.run(suite, { runId: "ci-1", at: "2026-01-01T00:00:00.000Z" })
  const committed = yield* Baseline.load(
    yield* Effect.promise(() => readFile("baseline.json", "utf8"))
  )
  const comparison = yield* Regression.compare(committed, run)
  yield* Effect.sync(() => process.stdout.write(Report.markdown(comparison)))
  return Gate.ciGrade(yield* Gate.check(comparison, { mean: 1 })).exitCode
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))

process.exitCode = await Effect.runPromise(program)
```

`Runner.run` needs only the `CaseExecutor` service: scoring runs in process by
default. Write `baseline.json` once with `Baseline.fromRun` and `Baseline.write`
before the comparison has anything to read;
[Quickstart](/quickstart/) walks both halves of the loop end to end.

## How this relates to @smthrs/agent

What a suite grades is a flow execution, and a `CaseExecutor` is one callback
from a case to that execution. Anything can sit behind the callback: a plain
function, a flow, or a whole agent run. That keeps `@smthrs/evals` independent
of what it measures, and it is why the examples on this site grade a two-line
greeting.

The parent package, [@smthrs/agent](https://agent.smithers.sh/reference/api/), is what usually sits behind the
callback in practice. An `AgentAction` or `AgentSession` runs the model-backed
work, the executor reduces that run to an output and a step key, and the suite
grades it like any other execution. The evaluation suite that ships with
Smithers does exactly this: it runs the agent loop against a scripted model with
no network access, so a score moves only when the agent's behavior moves.

`@smthrs/agent` is in turn one package of the smithers command-line tool,
[@smthrs/cli](https://cli.smithers.sh/reference/api/), which is where the whole system is driven from.

## Where to go next

- [Installation](/installation/): what the package needs to run, and its
  entry points.
- [Quickstart](/quickstart/): one complete loop, from suite to gate.
- How-to guides: [author a suite](/guides/author-a-suite/),
  [run a suite](/guides/run-a-suite/),
  [maintain a baseline](/guides/maintain-a-baseline/),
  [gate a run in CI](/guides/gate-a-run-in-ci/).
- Concepts: [fixed suites](/concepts/fixed-suites/),
  [step keys and comparison](/concepts/step-keys/),
  [determinism and canonical artifacts](/concepts/determinism/).
- The [API reference](/reference/api/) documents every export, the failure codes, and
  the batch protocol.
- [Troubleshooting](/troubleshooting/) maps every failure code to its cause
  and its fix.
