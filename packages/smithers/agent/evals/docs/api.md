---
title: "API reference"
description: "Every @smthrs/evals export: the pipeline, comparison semantics, failure codes, the batch protocol, and limits."
---

Fixed-suite evaluation, baselines, regression reports, and score gates for
flows.

For how to add the package to a project, see
[Installation](./installation.md).

## The pipeline

One direction, six modules:

1. `Suite` declares the fixed cases and the scorer bindings that grade them.
2. `Runner` executes every case through an injected `CaseExecutor` and grades the
   executions, producing observations.
3. `Baseline` records what a run scored, as a committed artifact.
4. `Regression` compares the next run with that artifact.
5. `Report` renders the comparison as JSON or Markdown.
6. `Gate` turns the comparison into a verdict and a CI exit code.

```ts
import { Flow } from "@smthrs/core"
import { Baseline, CaseExecutor, Gate, Regression, Runner, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { Effect, Layer } from "effect"
import { readFile } from "node:fs/promises"

const greet = Flow.make({ name: "greet" })

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
    name: "smoke",
    cases: [{ name: "hello", input: { name: "Ada" } }],
    bindings: [Binding.make({ scorer: polite, appliesTo: greet })],
    concurrency: 1
  })
  const run = yield* Runner.run(suite, { runId: "nightly-2026-01-01", at: "2026-01-01T00:00:00.000Z" })
  const committed = yield* Baseline.load(
    yield* Effect.promise(() => readFile("baseline.json", "utf8"))
  )
  const comparison = yield* Regression.compare(committed, run)
  return Gate.ciGrade(yield* Gate.check(comparison, { mean: 0.9 }))
}).pipe(Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)))
```

`Runner.run` needs only `CaseExecutor`. Scoring runs in process by default;
provide `Runner.layerInline` to say so explicitly, `Runner.layerNoop` to state
that a suite must not score, or your own adapter through `options.scorer` or
the `Runner` service.

A run executes under the span `Eval.run` (attributes `suite` and `runId`), and
each case under a child span `Eval.case` (attribute `case`), so any tracer the
host provides shows which case a slow or failing run spent its time in.

## How comparison works

Four rules decide what a comparison reports, and none of them are obvious:

- **The step key decides which finding you get.** A score that dropped at a
  _changed_ step key is a `regression`: the target produced different work and it
  graded worse. A score that moved at an _unchanged_ step key is
  `nondeterminism`: the same work graded differently twice. A gate reads both as
  red.
- **`Observation.scorer` is a digest, not a name.** It is the scorer key, derived
  from the scorer's own `{ id, version, config }`, and it is what a baseline
  matches on. `Observation.scorerName` carries the readable name beside it, and a
  Markdown report prints `name (first 8 of the key)`, or the bare key for a
  scorer declared without a name. Report cells, gate summaries, and runner
  diagnostics all use that one label.
- **A binding matches its target by reference identity.** `binding.appliesTo` has
  to be the same flow value the execution reports as its `target`; a structurally
  equal copy grades nothing.
- **A baseline belongs to one suite.** Validated baselines and newly written
  artifacts require a top-level `suite`, even with no records. Every record
  requires its own `suite`. `Baseline.load` accepts a suite-less version-1
  artifact only when its nonempty records all name the same suite, then sets
  the top-level `suite` to that value. Empty or ambiguous legacy artifacts fail
  with `invalid_baseline` at `suite`. Comparison refuses an artifact or any
  record that names a suite other than the run's with `invalid_baseline`.

## Failure codes

`EvalError.code` is the stable branch point.

| Code                  | Raised when                                                                                                                                | Who fixes it              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `invalid_suite`       | The suite declaration is wrong: a name, a case, a concurrency, a fixture line, non-cloneable case data, or an undecidable sampling policy. | The suite author          |
| `invalid_run_options` | `Runner.run`'s own options are wrong: an empty `runId`, or an `at` that is not a canonical UTC instant.                                    | The caller                |
| `invalid_baseline`    | The committed baseline is unreadable, holds a record the schema rejects, or belongs to another suite.                                      | Regenerate the baseline   |
| `invalid_tolerance`   | A comparison tolerance is not a finite non-negative number.                                                                                | The caller                |
| `invalid_trials`      | A `Trials` run, pass, or `k` count is outside its bounds.                                                                                  | The caller                |
| `executor`            | The target flow failed for a case, or no executor was available.                                                                           | The target or the wiring  |
| `ambiguous_score_job` | Two jobs share a step key and scorer, so an order-only runner cannot attribute their results to cases.                                     | The suite or batch runner |
| `scorer_protocol`     | A batch runner returned the wrong number of observations, or observations identifying jobs other than the ones it was given.               | The batch runner          |
| `scorer_unavailable`  | No batch runner was available to score with.                                                                                               | The wiring                |

Most failures carry a `path` locating the offending value: `cases[1].input`,
`records[3].score`, `options.at`, `runBatch[0]`. A case whose target failed keeps
the executor's own path when it named one and is located at `cases['<name>']`
otherwise, so a failed case is always locatable. Only two failures carry no path:
one about an artifact as a whole (`Baseline` is not JSON, or is not an object)
and one about the absence of a runner (`scorer_unavailable`).

## The batch protocol

`Runner.ScoreBatchRunner.runBatchCorrelated` returns each observation with its
job identity. A correlated runner may return results in any order. A run rejects
a duplicate identity, an unknown identity, a missing identity, the wrong result
count, or an observation that does not echo its job's `targetStepKey` and
`scorerKey` with `scorer_protocol`.

`runBatch` remains the order-only protocol for adapters that cannot return job
identities. Its contract is positional:

1. Exactly one observation per job.
2. In the order the jobs were given.
3. Each observation repeats its job's `targetStepKey` and `scorerKey`.

A run verifies all three and fails with `scorer_protocol` when one is broken.
Before calling an order-only runner, it also refuses two jobs that share a step
key and scorer with `ambiguous_score_job`. Give each case its own step key, or
provide a runner that implements `runBatchCorrelated`. A returned score that is
not finite and inside [0, 1] becomes an inconclusive observation naming the
scorer and the offending value; the run's own timestamp, not the adapter's, is
what reaches the observation.

Both adapter methods retain their receiver and receive the suite's concurrency.
Scorer callbacks execute inside their job effects. A callback that throws
synchronously or a batch that fails produces inconclusive observations; failure
text is bounded and safe to convert. Interruption still cancels the run.
`layerNoop` returns identity-correlated inconclusive results, including when
cases share a step key and scorer, without invoking scorer callbacks.

## Determinism and limits

- `Runner.run` takes `runId` and `at` from the caller. `runId` identifies the
  `RunResult` and joins every score job's identity; `at` stamps every
  observation. Given identical executor results, scorer results, metadata, and
  options, two runs produce identical observations and identical `Report.json`
  bytes. Executor and scorer effects run afresh each time, so clocks, models,
  randomness, and external state inside them are the caller's to control.
- When the `Suite.make` effect runs, it snapshots its options, copies case and
  binding data with `structuredClone`, and freezes the arrays it returns. The
  suite cannot change after it is validated.
- `Suite.limits` declares the ceilings: `concurrency` 1024, `cases` 10000,
  `fixtureLength` 8388608 code units for one JSON Lines fixture.
- `Report.json` embeds each case's raw `execution.output`. Strings are capped at
  8192 code units and everything JSON cannot express becomes a named marker
  (`[circular]`, `[depth exceeded]`, `[NaN]`, `[function]`), so the serializer is
  total. Nothing is redacted: a suite whose cases carry secrets must not print
  the report where the log is readable.
- The encoder is bounded in total, not only per branch. A value referenced
  twice is expanded twice, which a shared acyclic graph turns into exponential
  work well below the depth ceiling, so traversal stops after 2000000 values or
  33554432 output code units and every remaining value becomes
  `[budget exceeded]`. The budget is spent in traversal order, which the key
  sort fixes, so one value always truncates at the same place.
- `Report.markdown` neutralizes inline GFM and raw HTML in every cell and the
  suite heading value. It caps each value at 240 escaped UTF-16 code units,
  plus an ellipsis when truncated, without splitting escapes or code points.

## Module reference

The root entry point exports these namespaces; each is also importable from
`@smthrs/evals/<Module>`. `@smthrs/evals/package.json` is exported too;
`internal/*` and nested `*/index` subpaths are not public.

### EvalError

Typed evaluation failures and the stable codes a caller branches on.

```ts
class EvalError extends Schema.TaggedError<EvalError>()("flows/evals/EvalError", {
  code: EvalErrorCode,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}) {}
```

`code` is the stable branch point, `message` is the sentence a CI log shows,
and `path` locates the offending value inside the input the caller supplied
(`records[3].score`, `cases[1].input`, `options.at`). `cause` retains the
original failure; it is never rendered on its own, so a message that matters
to an operator says so itself. `EvalErrorCode` is the schema and type for the
nine codes in the failure table.

### Suite

Fixed suite declarations and their JSON Lines fixture format.

- `Case`: `{ name, input, expected? }`. `input` is handed to the executor and
  `expected` is offered to a bound scorer as ground truth. A declared
  `expected`, including `null`, wins over the binding's `groundTruth`; only an
  absent one defers to the binding. Both are snapshots taken by `make`.
- `Binding`: a scorer binding accepted from [@smthrs/scorers](/api/scorers).
  The binding's `appliesTo` flow is matched against an execution's `target` by
  reference identity.
- `MakeOptions`: `{ name, cases, bindings?, concurrency }`.
- `Suite`: `{ name, cases, bindings, concurrency }`, with `cases` and
  `bindings` frozen and every data field a copy the caller cannot reach.
- `limits`: `{ concurrency: 1024, cases: 10000, fixtureLength: 8388608 }`, the
  declared ceilings a suite is validated against.

```ts
const make = (options: MakeOptions): Effect.Effect<Suite, EvalError>
```

Builds and validates a fixed suite. When the effect runs, it reads every
option, case field, and binding field exactly once, then validates and copies
only what it read, so a getter cannot hand the suite a value validation never
saw. Every case and binding is then copied with `structuredClone`, which is
also the check that the data is inert. Fails with `invalid_suite` for an empty
or control-character name, no cases, more than `limits.cases` cases, a
duplicate case name, or a concurrency that is not a safe integer in
[1, `limits.concurrency`].

```ts
const fromJsonLines = (text: string, options: JsonLinesOptions): Effect.Effect<Suite, EvalError>
```

Loads the `{ name, input, expected? }` JSON Lines fixture format.
`JsonLinesOptions` is `{ name, bindings?, concurrency }`. Blank lines are
skipped, a leading byte-order mark is stripped, and both LF and CRLF terminate
a line. A malformed line fails with `invalid_suite` carrying the 1-based line
number in both the message and the path; a fixture larger than
`limits.fixtureLength` is rejected before any of it is parsed. All ceilings
are inclusive. After 10000 cases, the next non-blank line fails before parsing
or decoding with `invalid_suite` at `cases` and the message
`Suite must contain at most 10000 cases, got 10001`; later lines are not decoded.

### CaseExecutor

The injectable boundary that executes one case against a target flow. A suite
says what to run; this service says how.

- `Execution`: `{ output, stepKey, latencyMs, target }`. `target` is the flow
  value the case actually executed, matched against each binding's `appliesTo`
  by reference identity, so it has to be the declared flow itself rather than
  a copy of it.
- `Run`: `(suiteCase: Suite.Case) => Effect.Effect<Execution, EvalError>`.
- `Service`: `{ run: Run }`.
- `CaseExecutor`: the `Context.Service` tag, `flows/evals/CaseExecutor`.

```ts
const make = (run: Run): Service
```

Builds an executor from its one callback. Throws a `TypeError` when `run` is
not a function: an executor that
silently degraded would turn one wiring mistake into a whole suite of cases
failing with `executor`, which reads as a broken target rather than a missing
one.

`makeNoop()` builds an executor that fails every case with a typed `executor`
error, and `layerNoop` provides it.

### Runner

Deterministic suite execution and bound scorer evaluation.

- `Observation`: one score observation emitted by a suite run. Every
  observation carries `case`, `scorer`, `stepKey`, and `at`, plus an optional
  `scorerName`; a `score` observation adds `score` in [0, 1] with an optional
  `reason`, and an `inconclusive` observation adds a required `reason`. Both
  kinds may carry `meta`. `at` is the run's timestamp, not the scorer's: a
  run's observations all carry one instant so a baseline stays reproducible.
- `ScoreRequest`: a request sent to the scorers batch runner, joining the
  case, the step key, the binding, and the scorer input (`input`, `output`,
  optional `groundTruth` and `context`, `latencyMs`).
- `ScoreJob`: a blocking scorer job, matching the `Runner` module in
  [@smthrs/scorers](/api/scorers): an `identity`, an `observation` seed with
  `targetStepKey` and `scorerKey`, the `score` effect, and `at` in
  milliseconds.
- `ScoreObservation`: a score result aligned with a `ScoreRequest`.
- `BatchResult`: `{ identity, observation }`, a batch result tagged with the
  identity of the job that produced it.
- `CaseResult`: `{ case, execution?, error?, observations }`, the per-case
  result retained by the runner.
- `RunResult`: `{ runId, suite, cases, observations }`, the stable result of a
  suite run.
- `RunOptions`: `{ scorer?, runId, sampleId?, at }`.
- `Runner`: the `Context.Service` tag, `flows/evals/Runner`, for an injectable
  batch runner. `run` does not require it: a run scores with `options.scorer`
  when one is passed, otherwise with this service when one is provided,
  otherwise in process through `makeInline`.
- `ScoreBatchRunner`: the structural adapter described in the batch protocol
  section.

```ts
const run = (
  suite: Suite,
  options: RunOptions
): Effect.Effect<RunResult, EvalError, CaseExecutor>
```

Runs a fixed suite with bounded execution and declaration-order results. Cases
run through the provided `CaseExecutor` at the suite's concurrency. Every
execution is graded by the bindings whose `appliesTo` is the flow the
execution reports as its target, matched by reference identity. A case whose
target failed keeps its typed error and produces no observations; a scorer
that failed produces an inconclusive observation. The run itself fails only
with `invalid_run_options` for a non-canonical run identity or timestamp,
`invalid_suite` for an unusable sampling policy, `ambiguous_score_job` when an
order-only runner cannot distinguish two jobs, or `scorer_protocol` for a
batch runner that broke the `ScoreBatchRunner` contract.

```ts
const makeInline = (): ScoreBatchRunner
```

Builds the in-process batch runner a run scores with by default. Each job's
scorer runs in the current process, its result is checked by the scorers
package's own `Scorer.validate`, and a scorer that fails becomes an
inconclusive observation naming its cause rather than failing the run.
`layerInline` provides it as the `Runner` service.

`layerNoop` provides a batch runner that is never available. Every bound score
under it becomes an inconclusive observation, which a gate grades as an
undecidable run rather than a red. Provide it to state that a suite must not
score.

### Baseline

Committed baselines: what a suite used to score.

- `version`: `1`, the current committed baseline artifact version.
- `BaselineRecord`: `{ suite, case, scorer, scorerName?, stepKey, score }`,
  one successful score retained by a baseline.
- `Baseline`: `{ version, suite, records }`. `suite` records artifact
  ownership even when `records` is empty.
- `limits`: `{ length: 16777216 }`, the longest baseline JSON text `load`
  parses, in UTF-16 code units.

```ts
const fromRun = (run: RunResult): Effect.Effect<Baseline, EvalError>
```

Builds and validates a baseline from a run's successful observations.
Inconclusive observations are dropped: a baseline records what was measured,
and an inconclusive observation measured nothing.

```ts
const make = (
  baseline: Omit<Baseline, "version"> & { readonly version?: typeof version }
): Effect.Effect<Baseline, EvalError>
```

Validates an in-memory baseline. Every known field is read once, records are
rebuilt from the validated values, and the array is frozen. Fails with
`invalid_baseline` carrying the record index and field name in `path` for a
wrong version, a non-array `records`, a record that is not an object, an
identity field that is not a string or holds a control character, or a score
that is not finite in [0, 1]. A control character is any of the C0 controls (U+0000 through U+001F), DEL (U+007F), C1 controls (U+0080
through U+009F), and the bidirectional controls U+061C, U+200E, U+200F,
U+202A through U+202E, and U+2066 through U+2069.
A top-level `suite` holding a control character fails at `path: "suite"`.

```ts
const write = (baseline: Baseline): string
const load = (text: string): Effect.Effect<Baseline, EvalError>
```

`write` serializes a baseline with recursively sorted keys and stable numbers,
records ordered by an injective encoding of `(suite, case, scorer, stepKey)`,
ending with a newline and always including the top-level `suite`. `load`
parses and validates baseline JSON, failing with `invalid_baseline`. For a
version-1 artifact without a top-level `suite`, it derives ownership only when
all records name the same suite. Empty or ambiguous legacy artifacts fail at
`path: "suite"` with an explicit reason. A present non-string `suite` is invalid.
Text longer than `limits.length` fails at `path: "text"` before any of it is
parsed.
Writing the loaded baseline retains its scores and adds the inferred `suite`.

### Regression

Step-key-aware comparison of a run against a baseline.

- `Tolerances`: `{ absolute?, relative? }`. A move is reported only when it
  exceeds both tolerances, so either one alone is enough to silence it. Both
  default to 0, which reports every move.
- `Regression`: `{ case, scorer, baseline, actual, drop }`, a score drop at a
  changed step key.
- `Nondeterminism`: `{ case, scorer, baseline, actual, delta }`, a changed
  score at the same step key.
- `MissingObservation`: `{ side, case, scorer, scorerName?, stepKey }`. `side`
  names the side the observation is missing from: `"run"` for a baseline
  record the run never reproduced, `"baseline"` for a score no baseline record
  accounts for.
- `Report`: `{ suite, baseline, run, regressions, nondeterminism, missing,
  samples, inconclusive }`, the complete comparison. `samples` and
  `inconclusive` are in-memory views filtered out of `run.observations` by
  `kind`; `Report.json` recomputes rather than serializes them.

```ts
const compare = (
  baseline: Baseline,
  run: RunResult,
  tolerances?: Tolerances
): Effect.Effect<Report, EvalError>
```

Compares a run to a baseline, preserving missing and inconclusive
observations. Records and observations are grouped by `(case, scorer)` and
then paired by step key, so a scorer that ran several times against one case
is compared pairwise instead of by array position. Fails with
`invalid_tolerance` when a tolerance is not finite and non-negative, and with
`invalid_baseline` when the artifact or any of its records belongs to a suite
other than the one the run reports.

### Report

Canonical JSON and Markdown renderings of a comparison.

```ts
const version: 1
interface Data {
  readonly reportVersion: 1
  readonly suite: string
  readonly baseline: Baseline.Baseline
  readonly run: { runId, suite, cases: ReadonlyArray<Case>, observations: ReadonlyArray<Runner.Observation> }
  readonly regressions: ReadonlyArray<Omit<Regression.Regression, "actual"> & { actual: number }>
  readonly nondeterminism: ReadonlyArray<Omit<Regression.Nondeterminism, "actual"> & { actual: number }>
  readonly missing: ReadonlyArray<Regression.MissingObservation>
}
const data = (report: Regression.Report): Data
const json = (report: Regression.Report): string
const markdown = (report: Regression.Report): string
```

`Data` is the serialized wire shape and `version` is the format version
stamped on it as `reportVersion`. It versions the comparison independently of
the nested `Baseline.version`: the wire shape can change without the committed
baseline artifact changing.

`run.observations` is the observation table. Every observation the report
mentions appears in it exactly once and everything else refers to one by
index: `run.cases[i].observations` is a list of indexes, and a regression or
nondeterminism entry's `actual` is a single index. `samples` and
`inconclusive` are absent, because both are filters of `run.observations` by
`kind` and a reader recomputes them. An in-memory `Regression.Report` holds
the same observation in up to four of those places, so encoding it directly
repeated every `reason` and every `meta` that many times.

`data` projects a comparison into that shape. Observations are pooled by
identity, not by value, so two distinct objects that happen to be equal stay
two rows. The table starts as `run.observations` and grows to hold any
observation reached only through a case or a comparison entry, so a hand-built
report whose case lists are not flattened still serializes every reference.

`json` serializes a regression report as stable, sorted-key `Data` JSON. The
report embeds each case's raw `execution.output`, which comes from an
arbitrary target flow, so the encoding is total rather than trusting: keys are
sorted by code unit, embedded strings are capped, total traversal is bounded,
and anything JSON cannot express becomes a named marker instead of a
`RangeError` or a silent `null`. Two identical runs therefore produce
byte-identical JSON. Nothing redacts the embedded output.

`markdown` renders the report an operator reads in a CI log. Every count in
the summary that is not zero has a section naming its rows: the regressions
and the nondeterminism a gate reads as red, and the case failures, missing
observations, and inconclusive observations that leave a gate undecided.
Every cell and the suite heading value replace each control character (see
[Baseline](#baseline)) with a space. Backslashes, pipes, backticks, asterisks,
underscores, brackets, angle brackets, exclamation marks, hashes, tildes,
ampersands, dots, colons, and at signs are backslash-escaped. This preserves
literal text instead of interpreting table delimiters, inline GFM formatting,
links, images, raw HTML, entities, or URL/email autolinks. Each value is capped
at 240 escaped UTF-16 code units, followed by an ellipsis when truncated;
escapes and Unicode code points remain whole.

### Gate

Score thresholds and the CI exit grade a comparison earns.

- `Options`: `{ mean?, min?, perCase? }`. `mean` gates the arithmetic mean of
  every score observation, `min` gates the lowest one, and `perCase` gates
  each named case's lowest score. With none of them set the gate still runs,
  as `mean(0)`, so a run with no score at all is undecidable rather than a
  pass.

```ts
const check = (report: Regression.Report, options?: Options): Effect.Effect<Verdict, ScoreGateError>
```

Checks thresholds through the shared ScoreGate arithmetic in
[@smthrs/scorers/ScoreGate](/api/scorers). The threshold gates always run: an
unobserved case cannot excuse the cases that were observed. Regressions and
nondeterminism are findings and force a `Failed` verdict; failed cases and
missing observations are environment faults and travel beside the verdict. A
threshold outside [0, 1] fails in the error channel with a `ScoreGateError`,
code `invalid_threshold`.

```ts
const ciGrade = (verdict: Verdict): { readonly exitCode: 0 | 1 | 5; readonly summary: string }
```

Maps a gate verdict to the shared CI convention: a finding is exit code 1, an
undecidable run is exit code 5, and a clean pass is exit code 0. A pass that
carries unresolved observations exits 5 as well: the gates it met were met
over fewer observations than the suite declared. The summary is one log line:
every control character in it is replaced with a space, so a step key or a
target failure that reached a verdict reason cannot print its own line or a
terminal escape.

### Trials

Repeated-run statistics for live model evaluations. A case that runs `n`
times and passes `c` of them is summarized at `k`.

```ts
const passAtK = (n: number, c: number, k: number): number
const passHatK = (n: number, c: number, k: number): number
```

`passAtK` is the unbiased estimator `1 - C(n - c, k) / C(n, k)` (Chen et al.,
2021): the chance at least one of `k` runs passes. `passHatK` is
`C(c, k) / C(n, k)`: the chance all `k` pass, the consistency measure of
tau-bench. Both are computed as products, so large `n` stays exact. Counts must
be integers with `0 <= c <= n` and `1 <= k <= n`; anything else throws an
`EvalError` with code `invalid_trials`.

```ts
const summarize = (outcomes: ReadonlyArray<boolean>, k: number): Summary
const aggregate = (cases: Readonly<Record<string, ReadonlyArray<boolean>>>, k: number): Aggregate
```

- `Summary`: `{ n, passes, rate, passAt1, passAtK, passHatK, stderr }`.
  `stderr` is `sqrt(rate * (1 - rate) / n)`, and 0 for one run.
- `Aggregate`: `{ cases, passAt1, passAtK, passHatK, allPass, perCase }`. The
  rates are means over cases; `allPass` is the fraction of cases whose every
  run passed. A case with fewer than `k` runs is summarized at `k = n`, and no
  cases aggregate to zeros. A case with no runs throws `invalid_trials`.

## Export index

| Export                          | Category      | Summary                                                                         |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `EvalError.EvalErrorCode`       | models        | Stable evaluation failure codes.                                                |
| `EvalError.EvalError`           | errors        | A typed failure raised while loading or executing an evaluation.                |
| `Suite.Binding`                 | models        | A scorer binding accepted from `@smthrs/scorers`.                               |
| `Suite.Case`                    | models        | One immutable fixed-suite case.                                                 |
| `Suite.MakeOptions`             | models        | Options for constructing a suite.                                               |
| `Suite.Suite`                   | models        | A validated, named collection of fixed cases and scorer bindings.               |
| `Suite.limits`                  | models        | The declared ceilings a suite is validated against.                             |
| `Suite.make`                    | constructors  | Builds and validates a fixed suite.                                             |
| `Suite.JsonLinesOptions`        | models        | Options used when decoding JSON Lines.                                          |
| `Suite.fromJsonLines`           | constructors  | Loads the `{ name, input, expected? }` JSON Lines fixture format.               |
| `CaseExecutor.Execution`        | models        | The result of executing one target-flow case.                                   |
| `CaseExecutor.Run`              | models        | The one callback a case executor is.                                            |
| `CaseExecutor.Service`          | services      | Runtime shape for an injectable target-flow executor.                           |
| `CaseExecutor.CaseExecutor`     | services      | Injectable execution boundary for a target flow.                                |
| `CaseExecutor.make`             | constructors  | Builds an executor from its one callback.                                       |
| `CaseExecutor.makeNoop`         | constructors  | Builds an executor that fails every case with a typed executor error.           |
| `CaseExecutor.layerNoop`        | layers        | Provides the unavailable executor.                                              |
| `Runner.Observation`            | models        | One score observation emitted by a suite run.                                   |
| `Runner.ScoreRequest`           | models        | A request sent to the scorers batch runner.                                     |
| `Runner.ScoreJob`               | models        | A blocking scorer job, matching the `Runner` module of `@smthrs/scorers`.       |
| `Runner.ScoreBatchRunner`       | services      | Structural adapter for `@smthrs/scorers`' blocking batch runner.                |
| `Runner.ScoreObservation`       | models        | A score result aligned with a `ScoreRequest`.                                   |
| `Runner.BatchResult`            | models        | A batch result tagged with the identity of the job that produced it.            |
| `Runner.CaseResult`             | models        | Per-case result retained by the deterministic runner.                           |
| `Runner.RunResult`              | models        | Stable result of a suite run.                                                   |
| `Runner.RunOptions`             | models        | Options for a deterministic suite run.                                          |
| `Runner.Runner`                 | services      | Injectable batch-runner service used when a caller wants a reusable adapter.    |
| `Runner.makeInline`             | constructors  | Builds the in-process batch runner a run scores with by default.                |
| `Runner.layerInline`            | layers        | Provides the in-process batch runner built by `makeInline`.                     |
| `Runner.run`                    | constructors  | Runs a fixed suite with bounded execution and declaration-order results.        |
| `Runner.layerNoop`              | layers        | Provides a batch runner that is never available.                                |
| `Baseline.version`              | models        | Current committed baseline artifact version.                                    |
| `Baseline.BaselineRecord`       | models        | One successful score retained by a baseline.                                    |
| `Baseline.Baseline`             | models        | Canonical committed evaluation baseline.                                        |
| `Baseline.limits`               | models        | The declared ceilings a committed baseline is validated against.                |
| `Baseline.fromRun`              | constructors  | Builds and validates a baseline from a run's successful observations.           |
| `Baseline.make`                 | constructors  | Validates an in-memory baseline.                                                |
| `Baseline.write`                | serialization | Serializes a baseline with recursively sorted keys and stable numbers.          |
| `Baseline.load`                 | serialization | Loads and validates canonical baseline JSON.                                    |
| `Regression.Tolerances`         | models        | Tolerances used for score comparisons.                                          |
| `Regression.Regression`         | models        | A score drop at a changed step key.                                             |
| `Regression.Nondeterminism`     | models        | A changed score at the same step key, indicating nondeterminism.                |
| `Regression.MissingObservation` | models        | An observation present on only one side of a comparison.                        |
| `Regression.Report`             | models        | Complete regression comparison.                                                 |
| `Regression.compare`            | constructors  | Compares a run to a baseline, preserving missing and inconclusive observations. |
| `Report.version`                | serialization | Current serialized report format version.                                       |
| `Report.Data`                   | serialization | The serialized shape of a regression report.                                    |
| `Report.data`                   | serialization | Projects a comparison into its serialized form.                                 |
| `Report.json`                   | serialization | Serializes a regression report as stable, sorted-key JSON.                      |
| `Report.markdown`               | rendering     | Renders a concise stable Markdown regression report.                            |
| `Gate.Options`                  | models        | Thresholds accepted by a CI score gate.                                         |
| `Gate.check`                    | constructors  | Checks thresholds through `@smthrs/scorers`' shared ScoreGate arithmetic.       |
| `Gate.ciGrade`                  | grading       | Maps a gate verdict to the shared CI convention.                                |
| `Trials.Summary`                | models        | Repeated-run statistics for one case.                                           |
| `Trials.Aggregate`              | models        | Repeated-run statistics averaged over cases.                                    |
| `Trials.passAtK`                | statistics    | The unbiased pass@k estimator.                                                  |
| `Trials.passHatK`               | statistics    | The chance all `k` of `n` recorded runs pass.                                   |
| `Trials.summarize`              | statistics    | Summarizes one case's run outcomes at `k`.                                      |
| `Trials.aggregate`              | statistics    | Summarizes every case at `k` and averages over cases.                           |

## A worked suite

[`evals/agent`](https://github.com/smithersai/smithers/tree/main/evals/agent)
is a suite built on these modules that evaluates the Smithers agent from
[@smthrs/agent](/api/agent). Each case is a whole agent run against a scripted
model with no network access, reduced to one observation, and two scorers grade
it: one asks whether the run did what the case declares, the other asks whether
the observation is well formed at all. The run is gated on a committed
baseline. For the shape of that pipeline in your own code, see
[Gate a run in CI](./guides/gate-a-run-in-ci.md).
