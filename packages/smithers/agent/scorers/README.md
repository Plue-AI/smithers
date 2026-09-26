# @smthrs/scorers

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

**Documentation:** https://scorers.smithers.sh

Flow-native scoring for Smithers. Declare a scorer with a durable identity,
attach it to a target flow, sample deterministically, and persist every score or
failure as an observation that survives a restart.

A scorer is a declaration: an id, a version, an optional configuration, and one
`score` function that turns an execution into a number in `[0, 1]`. The
declaration hashes into a `scorerKey`, written on every observation it produces,
so a score recorded a month ago is still attributable to the exact scorer that
produced it.

Runtime grading belongs to `@smthrs/scorers/ScoreGate`: score samples, verdicts,
threshold checks, CI grades, and `ScoreGateError` share one pure contract.
`@smthrs/testing/ScoreGate` is its test facade and also supplies a fixed-suite
runner. Runtime evaluation code imports scorers directly.

## Install

Install the current release candidate with `pnpm add @smthrs/scorers@next`.

It needs Node.js 26.4.0 or later and
[`effect`](https://effect.website) 4.0.0-rc.115, plus
[`@smthrs/database`](https://database.smithers.sh) when you persist
observations.

## Grade one execution

A scorer runs on its own, with no store and no runner behind it:

```ts
import { Scorer } from "@smthrs/scorers"
import { Effect } from "effect"

const exactMatch = Scorer.make({
  id: "my-package/scorers/exact-match",
  version: "1",
  name: "exact-match",
  score: ({ groundTruth, output }) => Effect.succeed({ score: output === groundTruth ? 1 : 0 })
})

const graded = await Effect.runPromise(
  exactMatch.score({ input: { name: "Ada" }, output: "Hello, Ada", groundTruth: "Hello, Ada" })
)
```

`graded` is `{ score: 1 }`, and `exactMatch.scorerKey` is the 64-character hex
digest that identifies this grader in every row it ever writes.

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

`runBatch` returns one observation per job and never fails: a scorer that throws
produces an inconclusive observation instead of failing the batch or the target
it was grading.

Use `SqlScoreStore.layer` for persistence, `ScoreStore.layerNoop` to run a flow
with scoring inert, and `RunnerLive.layer()` for live execution over whichever
store is provided. The
[quickstart](https://scorers.smithers.sh/quickstart/) composes the database
layers and runs this end to end.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/scorers/<Module>`. `internal/*`, `migrations/*`, and nested `*/index`
subpaths are blocked, so the migrations are reachable only through the root
`Migrations` namespace.

| Namespace       | What it is                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `Scorer`        | The declaration: input and result schemas, the `score` implementation, and the derived `scorerKey`.   |
| `Binding`       | A scorer, a target flow, optional ground truth and context, and a sampling policy.                    |
| `Sampling`      | The replay-stable policy vocabulary and the decision function over it.                                |
| `ScoreStore`    | The durable observation contract: record, record once, page, aggregate.                               |
| `SqlScoreStore` | The SQLite implementation of that contract, migrations included.                                      |
| `Runner`        | Job identities, batch outcomes, and the conversion of a scorer failure into an observation.           |
| `RunnerLive`    | The scoped queue and batch runner over whichever store is provided.                                   |
| `ScorerError`   | The eight stable failure codes and the tagged error that carries them.                                |
| `ScoreGate`     | Pure sample validation, threshold gates, verdict composition, CI grades, and the typed grading error. |
| `Migrations`    | The score-store schema migrations, applied by `SqlScoreStore` or on their own.                        |
| `Checks`        | Pure text and action checks, and a scorer over a list of them.                                        |
| `Rubric`        | A model-agnostic LLM rubric judge declared as a scorer, and judge calibration.                        |

Every export, with signatures and bounds, is in the
[API reference](https://scorers.smithers.sh/reference/api/).

## Failures and limits

Every constraint a caller can trip, in one place. The reasoning behind each is
in the [API reference](https://scorers.smithers.sh/reference/api/) and under
[Durability](https://scorers.smithers.sh/durability/).

- **Sampling** is `"all"`, `"none"`, or a `ratio` in the **open** interval
  `(0, 1)` with a non-empty `seed`. Use `"all"` and `"none"` for the endpoints;
  `0` and `1` are rejected.
- **A score** must be finite and within `[0, 1]`, in the `Result` schema and in
  `Scorer.validate` alike.
- **`Scorer.make` throws** a `ScorerError` at plan time for a blank `id` or
  `version`, or a `config` carrying anything canonical JSON would drop.
- **An observation** is validated and fully encoded before the transaction
  opens: non-empty keys, a non-negative integer `at`, a non-empty `reason` and
  structured `code` on an inconclusive observation, a `reason` within
  `maxReasonBytes`, and `meta` losslessly representable as canonical JSON and
  within `maxMetadataBytes`. A later mutation of the object cannot change what
  is stored.
- **A job identity** must be non-empty, within `maxIdentityBytes`, and stable
  across a restart. Build it with `Runner.jobIdentity`.
- **`observations()`** is paged: `limit` defaults to and may not exceed
  `maxObservations`, `offset` walks a long history, and `before` is an exclusive
  upper `at` filter. All three must be safe integers in range or the call fails
  naming the value.
- **`submit`** does not wait for the scorer to run, but it backpressures once
  `capacity` queued jobs are outstanding, so it is not safe on a
  latency-critical path. `capacity` defaults to 1024 and `concurrency` to 1; a
  value that is not a positive safe integer is coerced to the default rather
  than rejected.
- **A store failure never fails a batch.** It is logged as a warning, so
  `runBatch`'s result records what each scorer answered, not what was persisted.
- **`Binding` retains `context` and `groundTruth` by reference.** Scoring runs
  later, so pass values that do not change.
- **Nothing prunes** `flows_scores` or `flows_score_jobs`.

## License

MIT
