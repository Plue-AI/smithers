# @smthrs/evals

## [Unreleased]

### Added

- `Trials`: repeated-run statistics for live evaluations. `passAtK` is the
  unbiased pass@k estimator, `passHatK` the pass^k consistency measure, and
  `summarize` and `aggregate` report both per case and across cases. Bad
  counts throw the new `EvalError` code `invalid_trials`.

- `Runner.run` executes under the `Eval.run` span and each case under
  `Eval.case`.

- Added `Report.Data`, `Report.data`, and `Report.version`: the serialized
  report shape, the projection that builds it, and the format version stamped
  on it as `reportVersion`. It versions the wire independently of the nested
  `Baseline.version`.

### Changed

- Report cells, gate summaries, and runner diagnostics share one scorer label.
  A scorer declared without a name now labels as its key in runner
  diagnostics, the way report cells and gate summaries already labelled it,
  rather than as `scorer (first 8 of the key)`. One unnamed scorer no longer
  appears under two spellings in one report.

- **Breaking:** `CaseExecutor.make(run)` takes only the callback. The
  `{ run }` and `{ execute }` object forms and `CaseExecutor.Implementation`
  are gone; pass the function itself. `CaseExecutor.CaseInput` is gone too;
  use `Suite.Case`. 1.0.0-rc.0 retired the `execute` spelling from
  `CaseExecutor.Service` but kept it as a `make` alias, so the package still
  had three spellings for one callback.

- **Breaking:** `Report.json` serializes `Report.Data` rather than the
  in-memory `Regression.Report` graph. `run.observations` is now the
  observation table and everything else refers to a row by index:
  `run.cases[i].observations` is a list of indexes and a regression or
  nondeterminism entry's `actual` is a single index. `samples` and
  `inconclusive` are gone from the wire because both are filters of
  `run.observations` by `kind`. The graph carried each observation in up to
  four places, so the artifact was about five times one copy of the
  observations; a run at the declared case ceiling produced 49.2 MiB of JSON
  for 9.9 MiB of observations. `Regression.Report` itself is unchanged, so a
  gate still reads `samples` and `inconclusive` in memory.

### Fixed

- Bound the canonical encoder's total traversal at 2000000 values and 33554432
  output code units, leaving `[budget exceeded]` where a budget runs out. The
  cycle detector tracks ancestors only, so a value referenced twice is expanded
  twice: 24 nested two-child wrappers over one shared leaf are 25 objects at
  depth 24, far below the depth ceiling of 64, and expanded to a multi-megabyte
  artifact in 16 seconds. The budget is spent in traversal order, which the key
  sort fixes, so one value always truncates at the same place.

- Load version-1 baselines without a top-level `suite` when every record names
  the same suite. Reject empty or ambiguous legacy artifacts with an explicit
  `invalid_baseline` reason at `suite`.
- Compute each baseline record's serialization sort key once per write.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added fixed suites, deterministic evaluation runs, baselines, regression
  reports, and score gates.
- Added `Runner.makeInline` and `Runner.layerInline`, the in-process batch runner
  a run now scores with by default, so a suite with pure scorers no longer has to
  hand-copy an adapter.
- Added `Suite.limits`, the declared ceilings on concurrency, case count, and
  JSON Lines fixture size.
- Added `Observation.scorerName` and `BaselineRecord.scorerName`, so a report can
  be read without grepping for a scorer digest.
- Added `Runner.BatchResult` and the optional `ScoreBatchRunner.runBatchCorrelated`,
  which tags each observation with its job identity. A run correlates by identity
  when a runner implements it, so results may come back in any order.
- Added `Baseline.suite`, which records artifact ownership even when the baseline
  holds no records. It is required in validated baselines and newly written
  artifacts. `Baseline.load` accepts older version-1 artifacts without it only
  when their nonempty records all name the same suite.
- Added package-owned documentation in `docs/`, gated by `test/docs.test.ts`.

### Changed

- **Breaking:** `Runner.run` requires only `CaseExecutor`. It resolved the
  `Runner` service with `Effect.serviceOption` while declaring it in its
  requirements, which made the in-process scoring path unreachable.
- **Breaking:** `CaseExecutor.Service` is one `run` callback. The twin
  `run`/`execute` pair could diverge, and `make` with neither silently degraded
  to the unavailable executor; it now throws a `TypeError`.
- **Breaking:** `Baseline.Record` is `Baseline.BaselineRecord`, so the global
  `Record` utility type is usable again.
- **Breaking:** `Regression.MissingObservation.stepKey` is required, and
  `Regression.Report`'s `samples` and `inconclusive` are narrowed to the
  observation kinds they actually hold.
- Verify the batch-runner protocol instead of trusting array position. A runner
  that returns the wrong number of observations, or observations identifying
  other jobs, now fails the run with `scorer_protocol` rather than attributing
  one case's score to another. `(targetStepKey, scorerKey)` alone is not a job
  identity: two cases graded by one scorer at one step key still permuted
  silently, so an order-only runner now fails with the new `ambiguous_score_job`
  code before it is called, and a correlated runner is paired by job identity.
- Decode a batch observation's whole shape rather than spot-checking its score.
  An inconclusive observation with no reason produced an `Observation` that
  violated its own type and made `Report.markdown` throw a `TypeError`.
- Turn a batch score that is not finite and inside `[0, 1]` into an inconclusive
  observation naming the scorer and the offending value.
- Fail `Regression.compare` with `invalid_baseline` when the artifact or any of
  its records belongs to another suite. `Baseline.load` derives ownership for
  older suite-less version-1 artifacts only when all records agree on one suite;
  it rejects empty or ambiguous legacy artifacts. Comparisons with the wrong
  suite used to report zero findings.
- Snapshot and freeze suite cases and bindings, including a binding's sampling
  policy, and reject data that cannot be structured-cloned, so a run stays
  reproducible from the validated suite. `Suite.make` validated at call time and
  copied at execution time, so the two could see different data.
- Read every option, case, binding, and baseline record field exactly once.
  Reading a field twice let a getter return the value that passed validation and
  then a different one into the suite or the committed artifact.
- Serialize reports and baselines through one bounded, cycle-safe canonical
  encoder. A cyclic case output used to throw a `RangeError` out of a function
  typed `string`, and a hostile proxy still threw out of the encoder that
  replaced it.
- Render an `Error` as an object carrying its own enumerable fields, so
  `EvalError.code` and `EvalError.path` survive into `Report.json`. The previous
  `[Name: message]` string dropped the stable branch point a caller reads.
- Preserve the executor's own code and message on a failed case, and print the
  code in the gate summary, which used to read as a tautology.
- Name every missing, inconclusive, and failed case in `Report.markdown` instead
  of only counting them, and escape, flatten, and cap every rendered cell.
- Encode every tuple key injectively instead of joining on `U+0000`, and reject
  control characters in suite and case names.
- Print the scorer as `name (first 8 of the key)` in gate messages as well as in
  the Markdown report. A missing observation used to name a 64-character digest
  with no way back to the scorer.
- Split the error vocabulary so a caller can branch on it: added
  `invalid_run_options`, `invalid_tolerance`, `ambiguous_score_job`,
  `scorer_protocol`, and `scorer_unavailable`; added `EvalError.path`; removed
  the unraised `missing_ground_truth`.
- Raised coverage thresholds to 100% on branches, functions, lines, and
  statements.
