---
title: "Troubleshooting"
description: "Every failure code @smthrs/evals raises, what it means, and who fixes it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/troubleshooting.md"
---

Failures arrive as `EvalError` values with a stable `code`, a `message`
written for a CI log, and usually a `path` locating the offending value. The
`code` is the branch point, and each code names one owner for the fix.

## invalid_suite

The suite declaration is wrong. The suite author fixes it.

| Symptom in the message                                            | Path                                                                                                            | Cause                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Suite name must not be empty`, or names a control character      | `name`                                                                                                          | The suite name is blank or holds a control character                                     |
| `Suite must contain at least one case`                            | `cases`                                                                                                         | The `cases` array is empty                                                               |
| `Suite must contain at most 10000 cases`                          | `cases`                                                                                                         | The suite exceeds `Suite.limits.cases`                                                   |
| `Suite concurrency must be a positive safe integer`               | `concurrency`                                                                                                   | Zero, negative, fractional, or `NaN` concurrency                                         |
| `Suite concurrency must be at most 1024`                          | `concurrency`                                                                                                   | The suite exceeds `Suite.limits.concurrency`                                             |
| `Suite case name must not be empty`, or names a control character | `cases[N].name`                                                                                                 | A case name is blank or holds a control character                                        |
| `Duplicate suite case`                                            | `cases[N].name`                                                                                                 | Two cases share a name                                                                   |
| `Suite data must be structured-cloneable`                         | `cases[N].input`, `cases[N].expected`, `bindings[N].sampling`, `bindings[N].groundTruth`, `bindings[N].context` | The value holds a function, a class instance, or anything else `structuredClone` rejects |
| `JSON Lines fixture must be at most 8388608 characters`           | `text`                                                                                                          | The fixture exceeds `Suite.limits.fixtureLength`; it was rejected before parsing         |
| `Invalid JSON on line N`                                          | `line[N]`                                                                                                       | The 1-based fixture line is not JSON                                                     |
| `Invalid suite case on line N`                                    | `line[N]`                                                                                                       | The fixture line is not a `{ name, input, expected? }` case                              |
| `Invalid sampling policy for scorer`                              | `bindings[N].sampling`                                                                                          | The scorers package cannot decide the policy; see the [scorers API](https://scorers.smithers.sh/reference/api/)        |

## invalid_run_options

`Runner.run`'s own options are wrong, not the suite. The caller fixes them.

- `Deterministic runs require a non-empty runId`, at `options.runId`: pass a
  run identity.
- `Deterministic runs require a canonical UTC timestamp such as
  2026-01-01T00:00:00.000Z`, at `options.at`: the value must carry millisecond
  precision and round-trip through parse and re-render.
  `new Date().toISOString()` satisfies the format.

## invalid_baseline

The committed baseline is unreadable or belongs to another suite. Check the
artifact and its ownership before regenerating it from a green run.

- `Baseline is not valid JSON` or `Baseline must be an object`: the file is
  not a baseline artifact. These two carry no `path`.
- `Baseline version must be 1`, at `version`: the artifact was written by a
  different version of the format.
- `Baseline must be at most 16777216 characters`, at `text`: the file exceeds
  `Baseline.limits.length` and was rejected before parsing.
- `Baseline field 'suite' must be a string`, at `suite`: a present top-level
  `suite` has the wrong type.
- `Baseline field 'suite' must not contain the control character U+XXXX`, at
  `suite`: the top-level `suite` holds a control character.
- `Cannot infer baseline suite: legacy artifact has no records`, at `suite`:
  the version-1 artifact has neither a top-level `suite` nor records. Add the
  known owning suite explicitly, or regenerate it from that suite's green run.
- `Cannot infer baseline suite: legacy records name multiple suites`, at
  `suite`: records disagree on ownership. Recover a baseline for the intended
  suite; do not choose the first record's suite for a mixed artifact.
- `Baseline records must be an array`, at `records`.
- A record that is not an object, an identity field that is not a string or
  holds a control character, or a score outside [0, 1]: the record index and
  field are in `path`, as in `records[3].score`.
- `Baseline belongs to suite '<name>', but the run is suite '<name>'`, at
  `baseline.suite` or `baseline.records`: comparison loaded the wrong file.
  Check the path CI reads.

A suite-less version-1 artifact loads when its records are nonempty and all
name the same suite. `Baseline.write` of that loaded value adds the inferred
top-level `suite` and retains the existing scores.

## invalid_tolerance

A comparison tolerance is not a finite non-negative number, at
`tolerances.absolute` or `tolerances.relative`. Fix the call, not the
baseline.

## invalid_trials

A `Trials` call received counts outside their bounds: a run count that is not
a positive integer, a pass count outside `0..n`, or a `k` outside `1..n`. The
`path` names the argument (`n`, `c`, `k`, or `cases['<name>']` for a case with
no runs). Fix the call; `Trials.aggregate` already clamps `k` for a short case.

## executor

The target flow failed for a case, or no executor was available.

- `Target failed for case '<name>': ...`: the executor failed. The run keeps
  the typed error, locates it with the executor's own `path` or with
  `cases['<name>']`, and produces no observations for the case. The rest of
  the suite still ran. Read the retained `cause`.
- `No executor is available for case '<name>'`: the run was provided
  `CaseExecutor.makeNoop()` or `CaseExecutor.layerNoop`. Wire a real executor.

## ambiguous_score_job

Two score jobs share a step key and a scorer, so an order-only batch runner
cannot attribute their results to a case. Give each case its own step key, or
provide a batch runner that implements `runBatchCorrelated`.

## scorer_protocol

A batch runner broke the `runBatch` or `runBatchCorrelated` contract: the
wrong number of results, a duplicate identity, an unknown identity, or an
observation that does not echo its job's `targetStepKey` and `scorerKey`.
Nothing it returned can be trusted. The message names the offending call, as
in `runBatchCorrelated[0]`. Compare the adapter against `Runner.makeInline()`,
the reference implementation of the protocol.

## scorer_unavailable

No batch runner was available to score with. This is `Runner.layerNoop`
working as declared: every bound score becomes an inconclusive observation,
and a gate grades the run undecidable rather than red. When the suite should
score, provide `Runner.layerInline` or a real adapter.

## Failures that are not EvalError

Two wiring mistakes fail outside the `EvalError` channel:

- `CaseExecutor.make` with no callback throws a `TypeError` synchronously.
  Pass a function, or an object with a `run` or `execute` callback.
- `Gate.check` with a threshold outside [0, 1] fails with a `ScoreGateError`,
  code `invalid_threshold`, from [@smthrs/scorers/ScoreGate](https://scorers.smithers.sh/reference/api/). Catch it in
  the error channel and report it.

## Symptoms

- Every score is inconclusive. Read the observation's `reason`. A
  `Scorer execution was inconclusive: ...` reason names a scorer or batch
  runner that failed. `<uncoercible cause>` means its failure could not be
  converted to text. Failure reasons use the scorers package's 1024-byte limit.
  A reason about a score outside [0, 1] or an unusable observation kind names a
  scorer that returned a bad result. A suite provided `Runner.layerNoop` also
  lands here.
- A binding graded nothing. The execution's `target` is not the exact flow
  value the binding's `appliesTo` holds (reference identity, not structure),
  the case failed before scoring, or the sampling policy decided against the
  execution.
- The gate exits 5. The gate could not decide, or it passed with unresolved
  observations. The Markdown report's Case failures, Missing observations, and
  Inconclusive sections name what is missing. Exit 5 is an unusable harness to
  repair, not a result to read.
- The report printed a secret. `Report.json` embeds each case's raw
  `execution.output` and redacts nothing. Keep the report out of readable logs
  when cases carry secrets.
