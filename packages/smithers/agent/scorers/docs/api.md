---
title: "API reference"
description: "Every public export of @smthrs/scorers: the scorer declaration contract, the sampling vocabulary, the durable store, the runners, and the eight stable failure codes."
---

`@smthrs/scorers` declares scorers, attaches them to target flows, decides
replay-stable sampling, and persists the resulting observations. It does not
decide what to score or when: [`@smthrs/evals`](/api/evals) does that.

The root entry point re-exports every module as a namespace. Each module named
in the export map is also importable directly as `@smthrs/scorers/<Module>`.
The `internal/*`, `migrations/*`, and nested `*/index` subpaths are blocked and
the map lists no `Migrations` subpath, so the four migrations are reachable
only through the root `Migrations` namespace. For the import forms, see
[Installation](./installation.md#import-forms).

Every export is listed once in the contract table at the end of this page,
and once with its kind and a one-line summary in
[Exported members](./exports.md).

```typescript
import { Runner, RunnerLive, Scorer, ScoreStore, SqlScoreStore } from "@smthrs/scorers"
import { Effect, Layer } from "effect"

const quality = Scorer.make({
  id: "my-package/scorers/quality",
  version: "1",
  name: "quality",
  score: ({ output }) => Effect.succeed({ score: output === "expected" ? 1 : 0 })
})

const program = Effect.gen(function*() {
  const runner = yield* Runner.Runner
  return yield* runner.runBatch([{
    identity: Runner.jobIdentity(["run-1", "step-7", quality.scorerKey]),
    observation: { targetStepKey: "step-7", scorerKey: quality.scorerKey },
    score: quality.score({ input: "ask", output: "expected" }),
    at: Date.now()
  }])
})

const live = RunnerLive.layer({ concurrency: 4 }).pipe(Layer.provide(SqlScoreStore.layer))
const inert = RunnerLive.layer().pipe(Layer.provide(ScoreStore.layerNoop))
```

For a runnable composition including the database layers, see the
[Quickstart](./quickstart.md).

## ScoreGate

`ScoreGate` is the pure grading contract shared by runtime evaluations and the
`@smthrs/testing/ScoreGate` facade. Import it from `@smthrs/scorers/ScoreGate`
or the root `ScoreGate` namespace. It needs only Effect, with no store, runner,
or test framework. [Grade fixed samples](./guides/grade-fixed-samples.md)
documents every member, verdict rule, and error field. The fixed-suite test
runner remains in testing.

## A scorer is a declaration, not a flow body

`Scorer.make` returns a flow value carrying `Input` and `Result` as its declared
schemas, plus `score` and `scorerKey`. `score` is the only implementation:
`MakeOptions` omits `input`, `output`, `body`, `model`, and `flows`, so a scorer
cannot declare two implementations that disagree, and calling the flow itself
raises `FlowError{code: "missing_body"}` as any body-less flow does. `make`
rejects `body` and the dynamic-body options `model` and `flows` at construction,
including options whose value is `undefined`.

`scorerKey` is `sha256(canonical({id, version, config}))`, 64 lowercase hex
characters, and it is the durable identity written into every stored
observation. The `score` closure does not participate, so refactoring an
implementation leaves stored observations attributable. For what that identity
covers, see [Scorer identity](./concepts/scorer-identity.md).

`make` is a plan-time constructor and it throws. Every throw is a `ScorerError`
with code `invalid_declaration`:

- a non-string or blank `id` or `version`, named individually;
- a `body`, `model`, or `flows` option, even if `undefined`;
- a `config` carrying a member canonical JSON would drop (a function, a
  symbol, an `undefined` member, a symbol-keyed property, a cycle, or a
  non-finite number), or a non-enumerable own property, reported as a path and
  never as the value;
- a `config` nested more than 1,000 levels, reported at the bounded path;
- a `config` defining `toJSON`, including a `Date`, reported at its path;
- a `config` the canonical encoder refuses outright: a `Map`, a `Set`, a class
  instance, a typed array, or a `RegExp`.

Canonical JSON hashes the value returned by `toJSON`, so anything that
replacement loses is absent from the durable identity. Refusal is the only
decidable answer: inspecting the replacement would execute caller code a
second time with no promise that both calls agree.

The dropped-member rule exists because `scorerKey` is
`sha256(canonical({id, version, config}))` and canonical JSON mirrors
`JSON.stringify`. Without it, `{rubric: fn}` and `{}` would be one scorer
forever in the store.

`Scorer.Input` carries `input`, `output`, and the optional `groundTruth`,
`context`, and `latencyMs`. `Scorer.Result` carries a finite `score` in the
inclusive `[0, 1]` range plus an optional `reason` and `meta`.
`Scorer.validate` decodes a result against that contract and fails with
`invalid_score`, naming the offending score without retaining the whole result.

## Sampling

`Sampling` is `"all"`, `"none"`, or `{ratio, seed}` with `ratio` in the **open**
interval `(0, 1)` and a non-empty `seed`. Sample everything with `"all"` and
nothing with `"none"`; `0` and `1` are rejected, so each intent has one
spelling. The bound is in the schema, so an unusable policy cannot be
constructed and carried into a run.

`decide(sampling, targetStepKey, scorerKey)` is deterministic across processes
and replays. The material is length-prefixed and the FNV-1a hash runs over
UTF-8 bytes. Both rules are load-bearing, and golden vectors freeze them:
hashing UTF-16 code units collapsed every astral character in a
1024-code-point block onto one value, and joining components with `":"` gave
`("a:b", "c", "d")` and `("a", "b:c", "d")` one decision.
Changing either moves every sampling decision already taken downstream.

## Bindings

`Binding.make` attaches a scorer to a target flow with an optional
`groundTruth`, an optional `context`, and a sampling policy that defaults to
`"all"`. The target value is retained unchanged, so binding never alters its
step key. Nothing in this package calls `Sampling.decide` on a binding's
behalf; a host does, once per candidate step.

A binding is the error boundary: `Binding.scorer` is `Scorer<unknown>`, so a
scorer declared with its own typed failure binds without a cast and one list
holds scorers that fail in unrelated ways. Nothing is lost by erasing the type
here, because a binding never runs its scorer and the runner already accepts an
unknown scorer failure, recording it as an inconclusive observation.

## Failures

`ScorerError.code` is stable and its `cause` is preserved. No failure retains
the whole input; a schema issue names the offending path and a bound names the
offending field.

| Code                  | Raised by                                                                               |
| --------------------- | --------------------------------------------------------------------------------------- |
| `invalid_declaration` | `Scorer.make`, thrown at plan time.                                                     |
| `invalid_score`       | `Scorer.validate`, for a result outside the result contract.                            |
| `invalid_sampling`    | `Sampling.decide`, for a policy outside the vocabulary.                                 |
| `invalid_observation` | `ScoreStore.record` / `recordOnce`, for an observation it refuses to store.             |
| `invalid_request`     | A blank or oversized job identity, or a page bound out of range.                        |
| `inconclusive`        | Carried on an inconclusive observation whose scorer neither scored nor was interrupted. |
| `constraint`          | A database refusal that retrying cannot fix.                                            |
| `store`               | Any other persistence failure, including transient ones.                                |

Each code's symptom and fix is in [Troubleshooting](./troubleshooting.md).

## Runners

`Runner.Service` has three entry points and one execution path. `submit` queues
a job and returns: it does not wait for the scorer to run, but it backpressures
once `capacity` queued jobs are outstanding, so it is not safe on a
latency-critical path. `runBatchCorrelated` runs jobs at the configured
concurrency and returns an `Outcome` for each one. Each outcome carries the job
identity and reports `persisted`, `duplicate`, or `failed` for the durable
write. `runBatch` is derived from it and returns only the observations, in job
order.

Both are governed by one rule: a scorer failure becomes an inconclusive
observation and never fails the target or the batch. Batch interruption
propagates. Each queued job runs in its own scoped fiber: its interruption or
defect cannot stop the workers or cancel other jobs. Closing the layer scope
still interrupts running jobs. A score-store failure is logged as a warning
with `identity`, `targetStepKey`, and `scorerKey` annotations and the structured
store error, and does not fail the batch either. `runBatch` records what each
scorer _answered_, while `runBatchCorrelated` also records what the store did. A `duplicate` outcome
means the identity was already claimed; it does not claim that the returned
observation is the one already in the store.

`RunnerLive.layer` coerces a `concurrency` or `capacity` that is not a positive
safe integer to its default (1 and 1024) rather than failing, because the
layer's error channel is `never`. The layer is scoped: it forks its workers
into the scope that builds it, so a job still queued when that scope closes is
never scored.

`Runner.layerNoop` and `ScoreStore.layerNoop` are the explicit absences.
Neither fails; the runner accepts every job and runs nothing, and the store
accepts every write and reads back nothing.

## Stores

`ScoreStore.Service` has five methods. `record` appends an observation.
`recordOnce(identity, observation)` claims the identity and appends in one
transaction. `observations(targetStepKey, scorerKey?, page?)` reads a bounded
page ordered by `(at, insertion)`. `aggregate(targetStepKey, scorerKey?)`
reports `{count, mean, min, inconclusive}` over that target, or `undefined`
when it has no observations of either kind.
`prune({ olderThan })` deletes observations whose `at`, and job claims whose
creation time, is older than the cutoff and answers `{ observations, jobs }`.
Nothing else deletes from the store, so a host that scores live runs should
call it on a schedule. A pruned claim no longer suppresses a duplicate, so
prune only past the oldest job the host may still replay.

Four documented bounds govern the write and read paths, each exported as a
constant: an observation `reason` is at most `maxReasonBytes` (1,024) UTF-8
bytes, encoded `meta` at most `maxMetadataBytes` (65,536), a job identity at
most `maxIdentityBytes` (512), and an observation page at most
`maxObservations` (1,000) rows, which is also its default.

`SqlScoreStore.layer` implements the service over the SQL client and durable
writer from [`@smthrs/database`](/api/database), and applies this package's
four migrations when it is built. What it guarantees across a restart is in
[Durability](./durability.md).

## Snapshotting

Three handoffs decide what a later mutation can still change, and each one has
one answer.

`submit` copies a job's scalar fields and nested observation keys synchronously
when called, before its returned Effect runs. The score Effect and its captures
stay shared. Batch methods snapshot each job when that job starts executing;
keep batch inputs stable until then.

`record` and `recordOnce` copy and fully encode an observation when they are
_called_, not when the Effect they return is run. Building `record(observation)`, mutating the
object, and then running the Effect stores the observation as it stood at the
call.

`Binding` does **not** copy `context` or `groundTruth`. It is the one deliberate
exception: a ground truth is frequently a value with no JSON representation, and
refusing those at binding time would be the larger break. The reasoning is on
the `Binding` interface's own JSDoc. Pass values that do not change, or copy
before binding.

## Job identity

`recordOnce(identity, observation)` claims `identity` in
`flows_score_jobs` and writes the observation in the same transaction, so a
retried job records once. The identity must be non-empty, at most
`maxIdentityBytes` UTF-8 bytes, and stable across a restart. Build it with
`Runner.jobIdentity([...parts])`, which length-prefixes each component: joining
parts with a delimiter lets two different tuples produce one identity, and one
shared identity drops every observation after the first.
The claim must report exactly zero or one affected row. Zero is a duplicate;
one proceeds to the observation insert; any other driver result fails and rolls
the transaction back.

## Migrations

`Migrations.run` applies all four score-store migrations against the provided
SQL client, recording them in this package's own ledger table
`flows_scorers_migrations`. `Migrations.layer` applies them when the layer is
constructed. `SqlScoreStore.make` already runs them, so a composition that
builds the store needs neither.

## Reference

Every public export, once.

| Export                               | Category     | Summary                                                                           |
| ------------------------------------ | ------------ | --------------------------------------------------------------------------------- |
| `ScorerError.ScorerErrorCode`        | models       | The eight stable failure codes, as a schema and a type.                           |
| `ScorerError.ScorerError`            | errors       | A typed declaration, execution, or persistence failure.                           |
| `Scorer.Input`                       | schemas      | Input supplied to a scorer flow.                                                  |
| `Scorer.Result`                      | schemas      | Successful scorer output, carrying the inclusive `[0, 1]` score bound.            |
| `Scorer.Scorer`                      | models       | A declaration-only flow with an independent durable identity.                     |
| `Scorer.MakeOptions`                 | models       | Options for `Scorer.make`, minus `input`, `output`, `body`, `model`, and `flows`. |
| `Scorer.make`                        | constructors | Declares a scorer and derives its `scorerKey`. Throws at plan time.               |
| `Scorer.validate`                    | validation   | Decodes a scorer result against `Result`.                                         |
| `Binding.Binding`                    | models       | A `Scorer<unknown>`, ground truth, context, and sampling attached to a flow.      |
| `Binding.make`                       | constructors | Creates a binding, defaulting to sampling every target step.                      |
| `Sampling.Sampling`                  | schemas      | `"all"`, `"none"`, or a `{ratio, seed}` policy over the open interval `(0, 1)`.   |
| `Sampling.decide`                    | predicates   | Decides a sample from stable target, scorer, and seed material.                   |
| `ScoreStore.maxReasonBytes`          | models       | Maximum stored size of an observation `reason`, in UTF-8 bytes.                   |
| `ScoreStore.maxMetadataBytes`        | models       | Maximum encoded size of an observation `meta`, in UTF-8 bytes.                    |
| `ScoreStore.maxIdentityBytes`        | models       | Maximum size of a `recordOnce` job identity, in UTF-8 bytes.                      |
| `ScoreStore.maxObservations`         | models       | Largest page `observations` returns, and its default.                             |
| `ScoreStore.ObservationBase`         | models       | Fields shared by successful and inconclusive observations.                        |
| `ScoreStore.ScoreObservation`        | models       | A successful score retained by the store.                                         |
| `ScoreStore.InconclusiveObservation` | models       | A scorer failure retained without failing its target.                             |
| `ScoreStore.Observation`             | schemas      | The durable observation contract, as a runtime schema and a type.                 |
| `ScoreStore.Aggregate`               | models       | Count, mean, and minimum over successful scores, plus the inconclusive count.     |
| `ScoreStore.Page`                    | models       | Page bounds for `observations`: `limit`, `offset`, and the `before` filter.       |
| `ScoreStore.Service`                 | services     | The durable score store implementation.                                           |
| `ScoreStore.Pruned`                  | models       | Rows one `prune` call removed: `observations` and `jobs`.                         |
| `ScoreStore.ScoreStore`              | services     | Context service for durable scorer observations.                                  |
| `ScoreStore.makeNoop`                | constructors | Constructs an inoperative score store.                                            |
| `ScoreStore.layerNoop`               | layers       | Provides the inoperative score store.                                             |
| `ScoreStore.validate`                | validation   | Decodes an observation against `Observation` before it is persisted.              |
| `SqlScoreStore.make`                 | constructors | Builds the SQL-backed store and applies its migrations.                           |
| `SqlScoreStore.layer`                | layers       | Provides the SQL-backed score store.                                              |
| `Runner.Job`                         | models       | One scorer execution request and its durable idempotency key.                     |
| `Runner.BatchOptions`                | models       | Batch execution options.                                                          |
| `Runner.Recorded`                    | models       | Whether a batch observation was persisted, duplicated, or failed.                 |
| `Runner.Outcome`                     | models       | A batch observation tagged with its job identity and durable write result.        |
| `Runner.Service`                     | services     | The runtime scorer runner implementation.                                         |
| `Runner.Runner`                      | services     | Context service for live and batch scorer execution.                              |
| `Runner.makeNoop`                    | constructors | Constructs an inoperative scorer runner.                                          |
| `Runner.layerNoop`                   | layers       | Provides the inoperative scorer runner.                                           |
| `Runner.jobIdentity`                 | constructors | Builds a length-prefixed `Job.identity` from its components.                      |
| `Runner.inconclusive`                | converting   | Converts a scorer failure into a typed inconclusive observation.                  |
| `RunnerLive.Options`                 | models       | Live runner worker configuration.                                                 |
| `RunnerLive.layer`                   | layers       | Provides the scoped queue and the blocking batch runner.                          |
| `Migrations.run`                     | migrations   | Applies all score-store migrations.                                               |
| `Migrations.layer`                   | layers       | Applies score-store migrations when the layer is constructed.                     |

### ScoreGate export index

| Export                         | Kind      | Category     | Contract                                                                |
| ------------------------------ | --------- | ------------ | ----------------------------------------------------------------------- |
| `ScoreGate.ScoreGateCode`      | const     | codes        | The five stable grading and misuse codes.                               |
| `ScoreGate.InvalidScoreSample` | const     | codes        | Schema naming a rejected score observation.                             |
| `ScoreGate.ScoreGateError`     | class     | errors       | Typed grading misuse with optional threshold, actual, and samples.      |
| `ScoreGate.ScoreSample`        | type      | models       | One fixed score or inconclusive observation.                            |
| `ScoreGate.Verdict`            | type      | models       | Passed, Failed, or Inconclusive with findings and faults kept separate. |
| `ScoreGate.validateSamples`    | const     | gates        | Reject every non-finite or out-of-range score.                          |
| `ScoreGate.combine`            | const     | grading      | Compose findings and unresolved observations in first-seen order.       |
| `ScoreGate.grade`              | const     | grading      | Map a verdict to exit code 0, 1, or 5 and its full summary.             |
| `ScoreGate.ScoreExpectation`   | interface | constructors | Mean, minimum, and per-case threshold gates.                            |
| `ScoreGate.expectScores`       | const     | constructors | Build gates over caller-owned fixed samples.                            |

## Checks

`Checks` holds pure, synchronous text and action checks. Each returns a
`Check`, `{ id, pass, detail }`, where `detail` names what was found and never
exceeds 200 characters. `all` folds checks into the fraction passing, and
`scorer` declares a scorer whose score is that fraction and whose `meta` is
`{ pass, checks }`.

```typescript
import { Checks } from "@smthrs/scorers"

const style = Checks.scorer({
  id: "my-package/scorers/style",
  version: "1",
  config: { max: 120 },
  checks: ({ output }) => [
    Checks.length(String(output), { max: 120 }),
    Checks.opener(String(output), ["on it", "got it"]),
    Checks.truncated(String(output))
  ]
})
```

Links are read in three forms: Slack `<url|label>` and `<url>`, markdown
links (a bracketed label followed by the URL in parentheses), and bare
`http(s)://` URLs. `words`, `questions`, `barePaths`,
and `linkedReferences` read link labels as prose and skip link URLs.
`includes`, `excludes` and `leakage` match whole words and phrases
case-insensitively, so "No" is not found in "not"; an entry written `renew*`
is a stem whose last word may continue ("renewal"), and one written
`/source/flags` is a regular expression. `requiredLinks` ignores
scheme and host case, a trailing slash, and a fragment, and accepts a found URL
that extends the required one with a path or query. `linkedReferences` accepts
`/pull/` for a template containing `/issues/`. `count` defaults to at least one
call when no bound is set.

### Checks export index

| Export                    | Kind      | Category     | Summary                                                                        |
| ------------------------- | --------- | ------------ | ------------------------------------------------------------------------------ |
| `Checks.Check`            | interface | models       | `{ id, pass, detail }`; `detail` names what was found, at most 200 characters. |
| `Checks.Link`             | interface | models       | A found link: `url` and an optional `label`.                                   |
| `Checks.Reference`        | interface | models       | A reference `pattern` and the `url` template, with `$1`, it must link to.      |
| `Checks.Action`           | interface | models       | One recorded tool call: `tool` and `input`.                                    |
| `Checks.CountSpec`        | interface | models       | Tool, `where` field filter, bounds, and id for `count`.                        |
| `Checks.Emission`         | interface | models       | Text written to one named sink.                                                |
| `Checks.Summary`          | interface | models       | Fraction passing, whether all passed, and the failed checks.                   |
| `Checks.ScorerOptions`    | interface | models       | Scorer id, version, name, config, and the checks function.                     |
| `Checks.words`            | const     | measuring    | Counts words, reading link labels and skipping link URLs.                      |
| `Checks.length`           | const     | checks       | Word count within inclusive `min` and `max`.                                   |
| `Checks.includes`         | const     | checks       | Every whole word, phrase, or `/regex/flags` present; an array is any-of.       |
| `Checks.excludes`         | const     | checks       | No forbidden whole word, phrase, or `/regex/flags` match.                      |
| `Checks.opener`           | const     | checks       | The message does not open with a listed phrase.                                |
| `Checks.truncated`        | const     | checks       | No cut-off word, trailing ellipsis, or unclosed code fence.                    |
| `Checks.links`            | const     | extracting   | Slack, markdown, and bare links, deduplicated by URL.                          |
| `Checks.requiredLinks`    | const     | checks       | Every required URL or any-of group linked.                                     |
| `Checks.linkedReferences` | const     | checks       | Every reference in the prose linked to its template URL.                       |
| `Checks.pathExtensions`   | const     | models       | File extensions `barePaths` treats as naming a file.                           |
| `Checks.barePaths`        | const     | checks       | No file-system path outside link syntax.                                       |
| `Checks.questions`        | const     | measuring    | Counts sentences ending in `?`.                                                |
| `Checks.count`            | const     | checks       | Matching tool calls within inclusive bounds.                                   |
| `Checks.leakage`          | const     | checks       | No marker in any sink; names sink and marker only.                             |
| `Checks.all`              | const     | combinators  | Folds checks into a score and a pass flag.                                     |
| `Checks.scorer`           | const     | constructors | Declares a scorer over a list of checks.                                       |

## Rubric

`Rubric` declares an LLM rubric judge as a scorer without a model dependency:
the caller supplies the `Judge`, a function from `{ system, prompt }` to the
reply text. Each criterion is scored 1 to 5 against its `low` and `high`
anchors. The score is `(mean - 1) / 4`, `meta` is the `Verdict`, and `pass`
follows the `Rule`, by default every score at least 3 and the mean at least
3.8.

```typescript
import { Rubric } from "@smthrs/scorers"
import { Effect } from "effect"

const judge: Rubric.Judge<never> = ({ system, prompt }) => Effect.succeed(callYourModel(system, prompt))

const tone = Rubric.make({
  id: "my-package/scorers/tone",
  version: "1",
  criteria: [{ id: "plain", question: "Is it plain language?", low: "Dense jargon", high: "Anyone could follow it" }],
  judge
})
```

`Scorer.Input.input` is the context string or `{ context, focus? }`, and
`output` the text judged. `render` fences each piece of content in a fence
longer than any backtick run inside it. `parse` reads the first JSON object in
the reply, fenced or not, and requires an integer from 1 to 5 for every
criterion. An unparsable reply fails with code `invalid_score`; a rubric with
no criteria or duplicate ids throws `invalid_declaration`. Criteria, examples,
rule, and instructions are the scorer's `config`, so changing the rubric
changes the `scorerKey`. `agreement` measures a judge against human labels.

### Rubric export index

| Export                 | Kind      | Category     | Summary                                                          |
| ---------------------- | --------- | ------------ | ---------------------------------------------------------------- |
| `Rubric.Request`       | interface | models       | One judge request: `system` and `prompt`.                        |
| `Rubric.Judge`         | type      | models       | The caller-supplied model call: a request in, the raw reply out. |
| `Rubric.Criterion`     | interface | models       | A criterion id, question, and the anchors for 1 and 5.           |
| `Rubric.Example`       | interface | models       | A labelled calibration transcript and why it passes or fails.    |
| `Rubric.Judgement`     | interface | models       | Parsed scores per criterion and the judge's reason.              |
| `Rubric.Verdict`       | interface | models       | A judgement and whether it passes the rule.                      |
| `Rubric.Rule`          | interface | models       | `minEach` and `minMean` pass thresholds.                         |
| `Rubric.defaultRule`   | const     | models       | `{ minEach: 3, minMean: 3.8 }`.                                  |
| `Rubric.RenderOptions` | interface | models       | Criteria, examples, context, focus, output, and instructions.    |
| `Rubric.MakeOptions`   | interface | models       | Scorer identity, rubric, rule, instructions, and the judge.      |
| `Rubric.Agreement`     | interface | models       | Judge-versus-human agreement counts and accuracy.                |
| `Rubric.render`        | const     | rendering    | Builds the judge request with fenced, inert content.             |
| `Rubric.parse`         | const     | parsing      | Reads the first JSON object of a reply into a `Judgement`.       |
| `Rubric.decide`        | const     | predicates   | Applies a `Rule` to scores.                                      |
| `Rubric.make`          | const     | constructors | Declares a rubric scorer over a caller-supplied judge.           |
| `Rubric.agreement`     | const     | calibration  | Counts judge agreement with human labels.                        |
