---
title: "Quickstart"
description: "Declare a scorer, compose a durable store and runner, grade two executions, prove the writes are idempotent, and read the aggregate back."
sidebar:
  order: 2
---

This quickstart grades two executions of a greeting flow and keeps the results.
By the end you will have a scorer with a durable identity, two observations in
a real SQLite database, and an aggregate read back from it. The database is
in-memory, so the whole thing runs from one file with no setup.

## Prerequisites

Node.js 26.4.0 or later, and a project that depends on `@smthrs/scorers` and
`@smthrs/database`. The in-memory SQLite example also needs the optional Node
driver. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Declare the scorer

A scorer is a declaration plus one `score` function. The `id`, `version`, and
`config` are the whole durable identity: they hash into `scorerKey`, and the
closure source does not participate, so refactoring the function body leaves
every observation already recorded attributable to this scorer.

```ts
import { Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const exactMatch = Scorer.make({
  id: "quickstart/exact-match",
  version: "1",
  name: "exact-match",
  config: { comparison: "strict" },
  score: ({ groundTruth, output }) =>
    Effect.succeed(
      output === groundTruth
        ? { score: 1, reason: "The output matched the ground truth." }
        : { score: 0, reason: `Expected ${String(groundTruth)}, received ${String(output)}.` }
    )
})
```

The result must carry a finite `score` in `[0, 1]`. `reason` and `meta` are
optional. A scorer that returns anything else is not a crash: the runner turns
it into an inconclusive observation with code `invalid_score`.

## Compose the store and the runner

`SqlScoreStore.layer` implements the durable store over a SQL client and a
durable writer, and applies this package's migrations when it is built.
`RunnerLive.layer` puts the queue and the batch runner on top of whichever
store is provided. `TestDatabase.layer` supplies the client and the writer over
a fresh `:memory:` database:

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { RunnerLive, SqlScoreStore } from "@smthrs/scorers"
import { Layer } from "effect"

const scoring = RunnerLive.layer({ concurrency: 2 }).pipe(
  Layer.provideMerge(SqlScoreStore.layer),
  Layer.provide(TestDatabase.layer)
)
```

`provideMerge` keeps `ScoreStore` in the built context as well as `Runner`, so
the program below can read observations back. For a file-backed database, swap
`TestDatabase.layer` for `NodeDatabase.layer({ filename })` and
`DurableWriter.layer()`.

## Describe the work to grade

A job pairs one scorer execution with the durable identity that makes it
idempotent. `targetStepKey` names the work being graded, `scorerKey` names the
grader, and `identity` is the claim the store writes so a retry cannot record
the same job twice. Build the identity with `Runner.jobIdentity`, which
length-prefixes each component:

```ts
import { Runner } from "@smthrs/scorers"

const at = Date.parse("2026-01-01T00:00:00.000Z")

const jobs = [
  {
    identity: Runner.jobIdentity(["run-1", "greet/ada", exactMatch.scorerKey]),
    observation: { targetStepKey: "greet/ada", scorerKey: exactMatch.scorerKey },
    score: exactMatch.score({ input: { name: "Ada" }, output: "Hello, Ada", groundTruth: "Hello, Ada" }),
    at
  },
  {
    identity: Runner.jobIdentity(["run-1", "greet/grace", exactMatch.scorerKey]),
    observation: { targetStepKey: "greet/grace", scorerKey: exactMatch.scorerKey },
    score: exactMatch.score({ input: { name: "Grace" }, output: "Hi, Grace", groundTruth: "Hello, Grace" }),
    at
  }
]
```

`at` comes from you, not from the store. Passing one fixed instant for a whole
batch is what makes a re-run over the same inputs produce identical rows.

## Run the batch twice and read it back

`runBatchCorrelated` returns one outcome per job, each tagged with its identity
and with what the durable write did. Running the same batch again shows the
claim working:

```ts
import { ScoreStore } from "@smthrs/scorers"

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  const store = yield* ScoreStore.ScoreStore
  const first = yield* runner.runBatchCorrelated(jobs)
  const again = yield* runner.runBatchCorrelated(jobs)
  return {
    recorded: first.map((outcome) => outcome.recorded),
    retried: again.map((outcome) => outcome.recorded),
    ada: yield* store.observations("greet/ada"),
    aggregate: yield* store.aggregate("greet/ada", exactMatch.scorerKey)
  }
})

console.log(await Effect.runPromise(program.pipe(Effect.provide(scoring), Effect.orDie)))
```

Run the file with your TypeScript runner. The output:

```text
{
  recorded: [ 'persisted', 'persisted' ],
  retried: [ 'duplicate', 'duplicate' ],
  ada: [
    {
      kind: 'score',
      targetStepKey: 'greet/ada',
      scorerKey: '8f52f17bf570099b98bf7904a57e5ee1ebe6fefbf7214abd9cfaf75697ca75f9',
      score: 1,
      reason: 'The output matched the ground truth.',
      at: 1767225600000
    }
  ],
  aggregate: { count: 1, mean: 1, min: 1, inconclusive: 0 }
}
```

## What just happened

The first batch ran both scorers at concurrency 2, validated each result
against the `[0, 1]` contract, and wrote one row per job inside a transaction
that also claimed the job identity. The second batch ran the scorers again and
found both identities already claimed, so it recorded nothing and reported
`duplicate`. Grace scored 0 rather than failing anything: a low score is data,
not an error.

The `scorerKey` in the output is `sha256` over the canonical JSON of
`{id, version, config}`. Change `version` to `"2"` and every later observation
lands under a new key, leaving the old ones intact and attributable.

## Next steps

- [Declare a scorer](./guides/declare-a-scorer.md): what `Scorer.make` accepts,
  and the declarations it refuses at plan time.
- [Attach a scorer to a flow](./guides/attach-a-scorer-to-a-flow.md): bindings
  and the sampling policy that decides which steps get graded.
- [Read scores back](./guides/read-scores-back.md): paging a long history and
  reading the aggregate.
- [Observations](./concepts/observations.md): why a scorer failure becomes a
  record instead of an error.
