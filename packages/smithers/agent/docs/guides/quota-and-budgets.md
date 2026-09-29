---
title: "Park on quota refusals and limit model admission"
description: "Turn provider rate limits into durable waits with QuotaPolicy, and coordinate soft token forecasts and latency admission with Budget."
sidebar:
  order: 3
---

Two injected policies decide how a run treats the provider's limits.
`QuotaPolicy` reads a refusal and answers when to come back. `Budget`
accumulates what a run has spent and refuses past its ceiling. Both are
required by `Agent.layer`: a composition that binds none is a type error, and
each policy has an explicit opt-out layer for a host that means to enforce
nothing.

## Classify a refusal as a wait

A `rate_limited`, `quota_exceeded`, or HTTP 529 overload answer is not a defect report: the
provider is saying when to come back. `QuotaPolicy.layerDefault()` installs the
classifier:

```ts
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"

const quota = QuotaPolicy.layerDefault({ maxWaitMillis: 900_000 })
```

The classifier answers one question, whether this refusal is a wait and until
when, in order of how much the provider actually said:

1. `resetAtEpochMillis`, the instant the provider named.
2. `retryAfterMillis`, the delay it named.
3. A delay parsed out of the message text, for the providers that put it only
   there.
4. `Config.defaultWaitMillis` (60,000), when the refusal names nothing.

A deadline beyond `Config.maxWaitMillis` (3,600,000) is not a wait at all: the
classifier answers `None` and the original `ModelError` propagates, because a
run parked for a day is indistinguishable from a run that hung. A deadline
already past is a park of zero: the provider said the window has reopened.
`QuotaPolicy.layerUnclassified()` explicitly keeps every refusal as a failure.

## What a park does

`AgentAction` is what parks on a classified refusal. The park is a real durable
wait:

- The decision is a recorded step, so a replay waits out the deadline the first
  pass chose instead of computing a new one, and the wake time and its source
  sit in the run's own evidence where an operator reads them.
- `annotateWaiting({ reason: "quota", wakeAt })` and `DurableClock.sleep`
  suspend the run, so a supervisor sees a parked run with a wake time and
  `waitingRuns({ reason: "quota" })` finds it.
- The retry runs under `Action.retry`, so the re-issued model call is a new
  attempt of the same step rather than a replay of the one the provider
  refused, and the step's correction budget is untouched: a quota wait is not a
  failed attempt.
- `Host.maxQuotaParks` bounds the waits one ask may take, defaulting to
  `QuotaPolicy.defaultMaxParks` (8). The bound is per ask: a step that parks,
  answers, and is corrected starts its next ask with a full allowance.

Each park writes a `flows.agent.quota-parked.v1` record naming the action, the
session, the wake time, and the deadline's source.

## The refusal that is never recorded

One thing changes at the engine port, and it applies whichever classifier is
composed. `FlowEngineLike` normally records a provider failure as the sealed
step's result, which is right for every failure except a capacity refusal: the
same bytes succeed a minute later, so recording the refusal under a content key
would pin "this prompt is refused" into the shared cache and make the wake
pointless. The port therefore fails every capacity refusal it normalizes
(`rate_limited`, `quota_exceeded`, `provider_internal`, and any refusal
carrying HTTP 429, 503, 504, or 529), which records an attempt rather than a
result. Policy decides what happens on top of that floor; no policy weakens it.

## Limit admission using a spending forecast

`Sandbox.Limits` bounds one cell and `Agent.Options.maxFrames` bounds one loop.
Neither accumulates usage across a run. `Budget` records that usage and gates
new model calls against the plan's allowance:

```ts
import * as Budget from "@smthrs/agent/Budget"

const budget = Budget.layer({
  tokens: { max: 200_000, onExceeded: "fail" },
  latency: { maxMillis: 900_000 }
})

// Or straight from what the control plane approved:
const approved = Budget.layerFromEnvelope(envelope)
```

`make`, `layer`, and `layerFromEnvelope` fail acquisition with
`Budget.ConfigurationError` for invalid configuration. Token ceilings are
non-negative safe integers; latency ceilings are finite non-negative
milliseconds (fractions are allowed). `maxRuns` and `recoveryEntries` must be
positive safe integers. Omit a ceiling to leave it unbounded; infinity and
`NaN` are errors, not opt-outs. Acquisition snapshots the validated policy,
so mutating the original object afterward cannot change a live budget.

Enforcement sits at the model boundary in `FlowEngineLike`, which every model
call passes through, so a step that assembles its own loop cannot evade a
budget declared for the run. Five rules make it usable:

- **The accumulator is per run, keyed by the model step's content key, and
  projected from the journal.** Every accounted call writes a
  `flows.agent.usage.v1` record on the durable channel, and the run's first
  decision writes its latency clock zero as a `flows.agent.budget-started.v1`
  record. A skip-remaining refusal writes `flows.agent.budget-latched.v1`.
  A budget entering a resumed run folds all three back before it decides
  anything, because the engine resumes from recorded results and never
  re-enters a settled step: an in-memory accumulator would hand a resumed run
  a second full allowance.
- **One instance serves every run.** Provide `Budget` above the engine, so the
  tally is keyed by execution id. `Budget.usageOf(runId)` reads one run's
  spend, from its live accumulator when the run is here and from its records
  when it is not. `Budget.defaultMaxRuns` (256) bounds how many tallies are
  held in memory, and `Budget.layer(policy, { maxRuns })` sets it.
- **Admission reserves a projection.** `reserve(stepKey)` atomically counts
  actual spend plus estimates for all in-flight calls. The estimate is the
  largest observed call; larger completed calls raise outstanding estimates.
  `record` replaces a reservation's estimate with actual usage. Scope exit,
  including failure or cancellation, releases its reservation.
- **An unmeasured call holds capacity.** Until a positive cost is known, one
  call holds the full token allowance. Zero refuses new calls unless `warn`
  explicitly permits them. Concurrent duplicates of the same sealed key share
  capacity, and every holder must finish before that reservation is released.
- **The accounting fails closed.** A record that could not be written, a
  ledger that could not be read, and a ledger longer than one recovery reads
  (`Budget.defaultRecoveryEntries`, overridable with
  `Budget.layer(policy, { recoveryEntries })`) all raise
  `Budget.AccountingUnavailable` rather than answering. Each of them is a run
  whose spend is unknown, and a budget that read an unknown as zero would hand
  a resumed run its whole allowance back. The step that made the call fails;
  its sealed model step replays from the recorded answer, so a re-dispatch
  pays the ledger again and not the provider.

A step the ledger has already counted proceeds whatever the ceiling says: its
replay costs nothing, and a run killed after its last model call must not come
back dead on arrival.

Usage reported before a capacity refusal or stream interruption is also spend.
The model boundary flushes that last reported usage on exit under a distinct
unsealed-invocation receipt, not the sealed step key. A later provider retry
therefore requires fresh admission and adds its own spend. Cumulative usage
updates count once per attempt, and reported usage from earlier transport
retries remains included. Partial model text from failed attempts is not
replayed. `Usage.calls` includes these charged unsealed invocations.

This is a **soft spending forecast, not a hard provider billing cap**. An
admitted call can cost more than its estimate, including the first call.
Providers can bill work for which they never report usage, and a hard process
kill cannot run an exit finalizer; this ledger is not invoice reconciliation.
Concurrent admission is coordinated only within one shared `Budget` instance;
it is not a distributed quota service. Provide one instance for all concurrent
calls of a run and rely on durable execution ownership to exclude competing
hosts. `check(stepKey)` is an advisory preview, not permission to dispatch
concurrently. Custom model boundaries must use `reserve` inside a scope that
lasts through the provider call and its `record`.

Usage must be finite and non-negative. New admission waits behind a usage
write while that write is active, then uses the committed spend. This shares
the existing per-run admission permit; unrelated runs remain independent.
A paid record waiting for that permit can be cancelled, but its unrecorded
spend remains pending and blocks new spending. A record already inside a
journal transaction uses that transaction directly instead of waiting behind
an outside writer that may itself need the transaction to commit.
Recover the account before opening that transaction; the model boundary's
scoped reservation already does this before dispatch.
A failed or interrupted usage write remains pending. For a sealed result,
retry that step with the same usage to finish the write. An unsealed invocation has no replayable model result;
retrying the provider is not a repair for its failed usage write. New,
uncounted steps fail closed while writes remain pending. A successful savepoint is
not a durable commit; pending usage clears only after the outer transaction
commits. Repeating a step with a different cost is an accounting error.
Initial recovery must run outside a journal transaction: it flushes and reads
committed history. Attempting recovery while holding a transaction fails
before the flush, avoiding a writer deadlock or a speculative latency zero.

The live tally conservatively includes actual usage whose write is pending.
Active operations, pending writes, and accounts without a journal cannot be
evicted to meet `maxRuns`. If no slot is safe to evict, new run admission fails
with `AccountingUnavailable`. Retry pending writes, let active operations
finish, or provision a larger bound; memory-only operation cannot safely
forget an old run's allowance.

## Choose what running out means

`onExceeded` is the composition's choice, defaulting to `fail`:

| Setting          | Behavior                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `fail`           | The step fails with `BudgetExceeded { scope, used, max, next }`.                                       |
| `warn`           | A `flows.agent.budget-warning.v1` record is written and the call proceeds.                             |
| `skip-remaining` | The budget latches. Every later model call in the run fails typed `skipped` without asking a provider. |

The skip-remaining decision is written durably before the refusal returns.
Recovery after restart or cache eviction restores the first decision and its
original numbers independently of usage and transient reservations. A peer
reservation can trigger the latch without recording any usage; releasing that
reservation does not reopen admission. Already counted steps may still replay.
The latch write must run outside a journal transaction so rollback cannot erase
a returned decision. Failed writes and unreadable latch records raise
`Budget.AccountingUnavailable`.

A latched refusal is its own failure, `Budget.Skipped`, carrying the
`BudgetExceeded` it latched on. The distinction is what an operator needs: one
step broke the budget and every other step was stopped by it. `Skipped` names a
verdict no retry can change, so build retry policies through
`Budget.neverRetrySkipped`:

```ts
import { RetryPolicy } from "@smthrs/flow"

const policy = Budget.neverRetrySkipped(RetryPolicy.defaultRetryPolicy)
```

## Cap a day across runs

A per-run budget cannot see a loop that spawns runs. `Budget.make({ daily: { max } }, { ledger })`
adds a per-UTC-day token cap summed over every run recorded in a `Budget.Ledger`. It
is checked at the same model boundary as the run cap, always fails
(`BudgetExceeded { scope: "daily" }`, never parks or skips), and needs a
ledger: building it without one is a `ConfigurationError`. Steps the run already
counted still replay after the cap is crossed.

A `Ledger` is `total(day)`, `record(entry)` (idempotent in `runId` and `stepKey`),
and `run(runId)`. `Budget.memoryLedger()` is the in-process adapter; the TUI
keeps a JSONL file per day. A run without a journal also recovers its own spend
from `ledger.run(runId)`, so raising a cap and building a new budget over the
same ledger resumes with the spend intact. A ledger write that fails leaves the
usage pending and refuses new calls until it commits.

## Inspect the spend

`Budget.usageOf(runId)` reads one run's `{ tokens, calls, largestCall }`,
whether or not this process is driving it: a supervisor reads the spend of a
run that is parked, finished, or owned by another host. `Budget.usage` reads
the current run's. Calls recorded outside any run tally under
`Budget.looseRunId`.

For the runnable demonstration of all three policies across an engine restart,
see [`examples/src/39-agent-policies.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/39-agent-policies.ts):
the provider refuses, the run parks, the engine is killed while it waits, and a
second engine over the same file waits out the recorded deadline, spends a
correction, and finishes with the provider called three times in all.
