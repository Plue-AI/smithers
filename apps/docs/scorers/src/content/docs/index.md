---
title: "@smthrs/scorers"
description: "Flow-native scoring for Smithers: declare a scorer with a durable identity, attach it to a target flow, sample deterministically, and persist every score or failure as an observation."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/README.md"
---

`@smthrs/scorers` grades work a flow already did, and keeps the grade. A flow
is a Smithers unit of work: a callable, schema-described declaration with typed
input and output, from [`@smthrs/core`](https://core.smithers.sh/reference/api/). This package never runs one.
It reads the input and the output of an execution and writes a grade beside
them.

A scorer is a declaration: an id, a version, an optional configuration, and one
`score` function that turns an execution into a number in `[0, 1]`. The
declaration hashes into a `scorerKey`, the durable identity written on every
observation the scorer produces, so a score recorded a month ago is still
attributable to the exact scorer that produced it. A binding attaches that
scorer to a target flow, a sampling policy decides which target steps get
graded, and the store keeps the results across restarts.

## What it solves

Grading agent output is easy to start and hard to keep. Reach for this package
once you have hit one of these four problems:

- **Attribution.** Six months of scores are worthless if you cannot say which
  grader produced each number. A `scorerKey` is `sha256` over the
  `{id, version, config}` declaration, so rewriting the `score` function leaves
  old scores attributable and bumping `version` starts a clean history beside
  them.
- **Cost.** Grading every step of a long-running flow is often too expensive. A
  sampling policy grades a deterministic fraction instead, and the decision is
  a pure function of the step key, the scorer key, and your seed, so a run that
  resumes after a crash never re-decides a step it already skipped.
- **Blast radius.** A judge that times out must not fail the work it was
  judging. A scorer failure becomes an `inconclusive` observation carrying a
  classified code and a reason, and the target flow and the rest of the batch
  carry on.
- **Retries.** Scoring gets retried, and a naive append turns one graded step
  into five rows. Each job claims a durable identity, and the claim and the
  observation commit in one transaction.

Write a scorer here when you need a reusable grader with a stable identity: an
exact-match check, a rubric, a model judge. Compose the store and the runner
here when you host evaluation yourself and need the observations to survive a
restart.

Runtime grading belongs to `@smthrs/scorers/ScoreGate`: score samples, verdicts,
threshold checks, CI grades, and `ScoreGateError` share one pure contract.
`@smthrs/testing/ScoreGate` is its test facade and also supplies a fixed-suite
runner. Runtime evaluation code imports scorers directly.

## Install

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

It needs Node.js 26.4.0 or later and [`effect`](https://effect.website), plus
[`@smthrs/database`](https://database.smithers.sh/reference/api/) when you persist observations. For the
runtime requirements and the import forms, see
[Installation](/installation/).

## Grade one execution

A scorer runs on its own, with no store and no runner behind it:

```ts
import { Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const exactMatch = Scorer.make({
  id: "docs/scorers/exact-match",
  version: "1",
  name: "exact-match",
  score: ({ groundTruth, output }) => Effect.succeed({ score: output === groundTruth ? 1 : 0 })
})

const graded = await Effect.runPromise(
  exactMatch.score({ input: { name: "Ada" }, output: "Hello, Ada", groundTruth: "Hello, Ada" })
)
```

`graded` is `{ score: 1 }`, and `exactMatch.scorerKey` is the 64-character hex
digest that will identify this grader in every row it ever writes.

To keep the grade instead of printing it, hand the work to a `Runner`. Each job
pairs one scorer execution with the identity that makes its write idempotent:

```ts
import { Runner } from "@smthrs/scorers"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  return yield* runner.runBatch([{
    identity: Runner.jobIdentity(["run-1", "greet/ada", exactMatch.scorerKey]),
    observation: { targetStepKey: "greet/ada", scorerKey: exactMatch.scorerKey },
    score: exactMatch.score({ input: { name: "Ada" }, output: "Hello, Ada", groundTruth: "Hello, Ada" }),
    at: Date.now()
  }])
})
```

`runBatch` returns one observation per job and never fails: a scorer that
throws produces an inconclusive observation instead of failing the batch or the
target it was grading. The [Quickstart](/quickstart/) composes the database
layers this program needs and runs it end to end.

## Where it sits in Smithers

`@smthrs/scorers` is one of the agent-layer packages of Smithers.
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the package that layer is named for: it runs
the agent loop, and its executions are the work a scorer grades. The two are
independent, and that is deliberate. A scorer is a plain declaration that reads
an input and an output, so it grades an agent step, a hand-written flow, or a
fixture from a file with the same code. Start at
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) for the loop itself, and at
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/) for the `smithers` command line that every one of
these packages sits under.

This package deliberately stops at the scorer contract. It does not decide what
to score or when to score it. [`@smthrs/evals`](https://evals.smithers.sh/reference/api/) does that: it
filters bindings by target, calls `Sampling.decide` for each candidate step,
and hands the selected work to a `Runner`. If you want suites, baselines, and
regression gates rather than the grading primitives, start with
[the evals documentation](https://evals.smithers.sh/) and come back here for the scorer
contract.

## The package at a glance

The root entry point exports these namespaces, and each top-level module is
also importable from `@smthrs/scorers/<Module>`:

| Namespace       | What it is                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `Scorer`        | The declaration: input and result schemas, the `score` implementation, and the derived `scorerKey`.   |
| `Binding`       | A scorer, a target flow, optional ground truth and context, and a sampling policy.                    |
| `Sampling`      | The replay-stable policy vocabulary and the decision function over it.                                |
| `ScoreStore`    | The durable observation contract: record, record once, page, aggregate.                               |
| `SqlScoreStore` | The SQLite and PostgreSQL implementation of that contract, migrations included.                       |
| `Runner`        | Job identities, batch outcomes, and the conversion of a scorer failure into an observation.           |
| `RunnerLive`    | The scoped queue and batch runner over whichever store is provided.                                   |
| `ScorerError`   | The eight stable failure codes and the tagged error that carries them.                                |
| `ScoreGate`     | Pure sample validation, threshold gates, verdict composition, CI grades, and the typed grading error. |
| `Migrations`    | The score-store schema migrations, applied by `SqlScoreStore` or on their own.                        |
| `Checks`        | Pure text and action checks, and a scorer over a list of them.                                        |
| `Rubric`        | A model-agnostic LLM rubric judge declared as a scorer, and judge calibration.                        |

Every export of every namespace, with signatures and bounds, is on the
[API reference](/reference/api/). The one-line member index is in
[Exported members](/exports/).

## Where to go next

- [Installation](/installation/): requirements, dependencies, and import
  forms.
- [Quickstart](/quickstart/): score two executions, persist them, and read
  the aggregate back.
- Guides: [declare a scorer](/guides/declare-a-scorer/),
  [attach one to a flow](/guides/attach-a-scorer-to-a-flow/),
  [run a batch](/guides/run-a-batch-of-scorers/),
  [record a score exactly once](/guides/record-a-score-once/),
  [read scores back](/guides/read-scores-back/), and
  [test with scorers](/guides/test-with-scorers/).
- Concepts: [scorer identity](/concepts/scorer-identity/),
  [replay-stable sampling](/concepts/sampling/), and
  [observations](/concepts/observations/).
- [Durability](/durability/): what the store guarantees across a restart,
  what it refuses to persist, and what it never prunes.
- [Troubleshooting](/troubleshooting/): each failure code, its cause, and
  the fix.
