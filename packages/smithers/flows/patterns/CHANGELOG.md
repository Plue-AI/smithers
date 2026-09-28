# @smthrs/patterns

## [Unreleased]

### Breaking

- `Supervisor.make` and `Supervisor.run` require `maxTasks`, a positive safe
  integer. A boss plan or flow input naming more tasks fails `invalid_input`
  before any worker call, so a model-returned plan cannot multiply worker
  calls without bound.

### Fixed

- `Supervisor`, `Loop`, `ScanFixVerify`, and `DriftDetector` read their stop
  and retry verdicts (`allDone`, `retriable`, `done`, `resolved`, `drifted`)
  as own properties only, as the acceptance vocabulary already did; an
  inherited property no longer ends a loop or supervision.

- An executed declaration now settles to what `run` returns on the same
  members. `DriftDetector.make` branches on the comparison and alerts only on
  drift; `Escalation.make` decides an undecided rung with `defaultEscalate`;
  `TryCatchFinally.make` fails `finalizer_failed` when the finalizer fails
  after success; `MapReduce.make` fails `exhausted`, not `incomplete_graph`,
  on no shards; `Sidecar.make` skips the scorer for a quarantined shadow;
  `MergeQueue.make`, `Runbook.make`, and `Kanban.make` settle to `run`'s
  result record, and `Kanban.make` drops a rejected card from later columns;
  `Supervisor.make` records worker failures as outcomes, re-delegates only
  retriable tasks, and returns `Completed` or `Exhausted`.
  `test/Parity.test.ts` runs both forms of every dual-form pattern and fails a
  pattern with no parity row; `Trellis`, `DelegationChain`, and the Sidecar
  quarantine shape are pinned there as known divergences.
- `PatternError` gains the code `invalid_input` for data a pattern read while
  running: a `Supervisor` or `MapReduce` flow input, the plan a `Supervisor`
  boss returned, a non-finite `Optimizer` or `Sidecar` score, and a malformed
  `Quarantine.settle` entry. Those refusals used `invalid_decorator`, so a
  caller catching by code could not tell a model returning bad data from an
  option out of range. `invalid_decorator` keeps naming declaration faults.
- Every `make`, every `run`, `Trellis.execute`, `WithRetry.retryEffect`, and
  the decorator factories `WithRetry.make`, `WithCache.make`, and
  `WithApproval.make` snapshot their options at the call. The arrays, member
  records, nested bounds, flows, and callbacks the package interprets are
  copied before a `Flow`, `Effect`, or decorator is returned, so a later edit
  to the caller's objects no longer changes a declaration or a run.
  `Pattern.slot` returns a frozen copy of its declaration.
- `MergeQueue.make` and `MergeQueue.run` refuse `failurePolicy: "halt"` above
  concurrency 1 with `PatternError` `invalid_decorator`. A batch starts its
  members before any of them has failed, and `halt` promises that no member
  behind a failure lands.

### Changed

- Every `MakeOptions` accepts an optional `name` and `description` for the
  `Flow` it returns. An unnamed pattern is named after its kind and declared
  bounds, `reviewLoop(maxRounds=3)`, so a plan, a journal, or a decorator over
  it no longer reads `anonymous`.
- `MergeQueue.make` takes its `members` inside the options object, the way
  every other `make` takes one options object and `MergeQueue.run` already
  took them. `MergeQueue.make(members, options)` becomes
  `MergeQueue.make({ members, ...options })`.
- `Optimizer` defaults `onMaxReached` to `"return-last"` in `make` and `run`,
  as `Loop` does.
- `TryCatchFinally.make` names its error filter `catchSchema`. `run` keeps
  `catchErrors` for the predicate, so the two forms no longer share one name
  with two types.
- `Saga`, `ReviewLoop`, and `Escalation` return discriminated settled results,
  the way `Quarantine` and `Supervisor` already did. `Saga` returns
  `{ _tag: "Completed", values }` or `{ _tag: "Compensated", failure }`,
  `ReviewLoop` returns `{ _tag: "Approved", output }` or
  `{ _tag: "Exhausted", output, review }`, and every `Escalation` result
  carries `exhausted`, `false` on a rung that settled. Step values and produced
  values are nested, so a saga whose step ids are `_tag` and `failure`, or an
  approved draft shaped like the exhausted envelope, can no longer be mistaken
  for the settled arm. `DelegationChain` reads the tags instead of duck typing
  the results.
- Every `@see` in the package JSDoc is an absolute `https://smithers.sh` URL.
  The repository paths the source used to name are not part of the npm
  package, so an installed copy could not follow them.
- Documented the identity and ownership contract on the API page: exact,
  case-sensitive, non-normalizing string identity for ids and names, when
  `make`, `run`, and the decorator factories snapshot their options, and which
  values stay the caller's references.
- Documented `TrellisError` and `DelegationError` beside `PatternError` on the
  API page, with their codes, paths, causes, and producing APIs.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added flow slots, envelope-narrowing decoration, retry, cache, approval, and
  bounded composite pattern declarations.
- Added `Bounded`, a width-bounded fan-out that orders members by priority.
- Added `Quarantine`, a join that isolates a failing member from its siblings.
- Added `TryCatchFinally`, an error boundary whose finalizer runs on every
  path.
- Added `Saga`, forward steps whose compensations unwind in reverse on
  failure or interruption.
- Added `Trellis`, which validates, declares, and executes bounded plans
  authored at runtime.
- Added `DelegationChain`, the fixed refine, plan, derisk, execute, review,
  and settle chain.
- Added `Loop`, bounded do-then-check iteration with declaration and runtime
  forms.
- Added `Optimizer`, iterative candidate generation with scoring and a
  best-so-far result.
- Added `ScanFixVerify`, bounded scan, parallel fix, verification, and rescan
  rounds.
- Added `DriftDetector`, one capture-and-compare pass with an optional alert.
- Added `Sidecar`, concurrent primary and quarantined shadow execution with
  score comparison.
- Added `Kanban`, ordered columns that move items with bounded concurrency.
- Added `CheckSuite`, bounded checks reduced under configurable verdict
  strategies.
- Added `MergeQueue`, deterministic priority ordering with halt or quarantine
  failure policy.
- Added `Supervisor`, task planning, bounded worker rounds, review, retry, and
  finalization.
- Added `Runbook`, ordered risk-aware steps with approval gates.
- Added `Intervene`, read, propose, optionally approve and apply, then report.

### Changed

- `WithRetry` accepts a `backoff` ladder and `nonRetryable` error tags, both
  folded into declaration identity.
- `WithApproval` declares the exact approval request schema with `input`,
  `reason`, and `scope`, and reports precise schema incompatibilities.
- `Panel` has a runtime form with per-panelist roles and a concurrency bound;
  role validation uses own properties and supports prototype-shaped names.
- `Escalation`, `ReviewLoop`, and `DelegationChain` share the acceptance
  vocabulary `true`, `"approved"`, `{ approved: true }`, and
  `{ accepted: true }`, using own properties only.
- Empty `Escalation` ladders report `invalid_decorator`; declarations reserve
  every rung when no acceptance flow is available, and runtime snapshots its
  rungs before work starts.
- `Escalation` accepts per-rung `escalateIf` flows and a `fallback` rung,
  and reports the rung that settled as `{ level, result }`.
- `Escalation.run` returns `Exhausted<A>` when every rung escalates and no
  fallback is declared.
- `Bounded.run` refuses priorities for unknown members and non-finite
  per-member priorities before work starts, while safely supporting
  prototype-shaped member names.
- `Debate.run` gives each callback a frozen transcript snapshot.
- `CheckSuite` treats inherited rows as missing and safely materializes
  declaration records with prototype-shaped check ids.
- `Kanban` rejects empty runtime item lists and duplicate column names,
  snapshots columns, supports prototype-shaped names, evaluates `until` on
  the final allowed pass, requires `maxIterations` whenever `until` is
  supplied, and runs `onComplete` exactly once after settlement.
- `MergeQueue` uses `id` in declaration call payloads and quarantine markers
  to match runtime, and safely handles prototype-shaped member ids.
- `Optimizer.run` refuses non-finite evaluator scores before continuing.
- Pattern composition reports the input or output side and schema AST tags for
  compatibility failures, distinct from JSON Schema conversion failures. A
  refusal between schemas with the same AST tag names the first differing JSON
  Schema path, and object-key declaration order no longer decides
  compatibility.
- `PatternError` carries an optional `cause` for the error or errors it
  reports.
- `Quarantine` settles both success and failure in explicit `Succeeded` and
  `Quarantined` envelopes, eliminating collisions with user values of any
  shape. It supports prototype-shaped names and preserves member errors in the
  `settle` failure cause.
- `Runbook.run` snapshots steps and safely records outputs for
  prototype-shaped step ids.
- `Saga.run` snapshots steps, safely records prototype-shaped ids, and reports
  the original failure plus sorted compensation residue in
  `compensation_failed` causes, including compensation defects.
- `Trellis.Plan` is an exact closed grammar; validation stops descending after
  a fanout breach, and runtime forms validate envelopes and concurrency before
  callbacks, honor the shared concurrency bound, and stop on empty
  continuations.
- `TryCatchFinally` refuses `catchErrors` without a catch arm before the body
  runs and preserves the finalizer failure in `PatternError.cause`.
- `DelegationChain.run` validates optional concurrency before invoking any
  callback.
- A decorator wrapping an unnamed flow now reads `anonymous` rather than an
  empty slot, so `WithRetry`, `WithCache`, `WithApproval`, and
  `Pattern.decorate` no longer produce names such as `withRetry(, attempts=2)`
  or the empty string.

### Fixed

- `DelegationError` carries an optional `cause`, and exhausted delegation
  ladders preserve per-tier execution errors, review rejections, or an escaped
  `PatternError`.
- `MergeQueue` and `Bounded` reject every non-safe-integer effective member
  priority before sorting, declaring, or running work.
- `Supervisor.run` validates and snapshots non-empty task plans before worker,
  review, or finalize callbacks run.
- `TryCatchFinally.run` and empty-shard `MapReduce.run` defer callback
  construction until execution and rebuild it on every execution.
- `Recursion` validates parent envelopes, rejects non-array child collections,
  and recognizes branch fields only when they are own properties.
- `Debate.run` freezes each transcript turn wrapper so later participants
  cannot rewrite prior rounds.
- `Sidecar.delta` and `Sidecar.run` reject non-finite scores and overflowing
  score differences.
- `TrellisError` carries an optional `cause`, and mid-trampoline refusals
  preserve completed rounds and remaining fuel.

[Unreleased]: https://github.com/smithersai/smithers/compare/v1.0.0-rc.0...HEAD
[1.0.0-rc.0]: https://github.com/smithersai/smithers/releases/tag/v1.0.0-rc.0
