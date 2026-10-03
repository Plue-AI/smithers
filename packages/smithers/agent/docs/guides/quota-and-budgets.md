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

## Keep sibling models available

`Agent.run` tries `fallbackSeats` after a capacity refusal. A rate limit cools
only the refused model on its route, including aliases of that same model.
Another model on the route, or the same model on another route, stays eligible.
A provider-wide HTTP 529 or `quota_exceeded` refusal defaults to the whole
route. A protocol classifier can state `ModelError.quotaScope` as `"model"` or
`"account"`; this field survives HTTP normalization, redaction, and journal
replay. A `quota_exceeded` refusal with no reset and no `"model"` scope has
no window to wait for: the run skips that route on every later frame instead
of asking it again. A `"model"`-scoped one cools only that model.

This changes the earlier behavior that treated every rate limit as shared.
An unknown scope is not evidence that a sibling model is exhausted: it may be
attempted once and report its own limit. Hosts with a known shared rate limit
should return `quotaScope: "account"`. No model name or scope is inferred from
provider prose. Models sharing a provider quota bucket can each report that
bucket's limit; the engine does not guess model-family membership.

When all seats are cooling, the run waits for the earliest eligible deadline.
Resuming that wait keeps its original deadline and retains other models'
longer cooldowns. A new provider refusal can start a new cooldown. Legacy 0.x
account-disable metadata is not read by this runtime; migrating 0.x still
requires finishing or archiving its runs and starting new 1.0 executions.

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
  usd: { max: 2.5, onExceeded: "park" },
  latency: { maxMillis: 900_000 }
})

// Or straight from what the control plane approved:
const approved = Budget.layerFromEnvelope(envelope)
```

`make`, `layer`, and `layerFromEnvelope` fail acquisition with
`Budget.ConfigurationError` for invalid configuration. Token ceilings are
non-negative safe integers; USD ceilings are finite non-negative dollars and
latency ceilings finite non-negative milliseconds (fractions are allowed for
both). `maxRuns` and `recoveryEntries` must be
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

Evaluator readings the harness takes in a run (the completion judge, run-start
relevance, compaction marks, the supervisor) are charged too, one share per
model priced under that model's id, including a reading that failed after the
provider metered it. A reading is admitted with `admitReading(stepKey)`, not a
forecast: it is far smaller than the primary call a forecast projects, so it
proceeds while any allowance is left and is refused only once the ceiling is
already spent, under the same `onExceeded` policy. A completion whose primary
call spent the whole ceiling is therefore not judged: it fails, parks, or is
skipped. The supervisor's reading runs beside the frame and is charged but not
admitted; the frame's next primary call applies the budget. A reading a cell's
own flow takes (`jev`, memory relevance, test failure attribution) is admitted
and charged the same way through `FlowEngineLike.CallReadings`; once the
ceiling is spent the flow gets a `refused` judge failure and asks nothing.

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

| Setting          | Behavior                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `fail`           | The step fails with `BudgetExceeded { scope, used, max, next }`.                                         |
| `warn`           | A `flows.agent.budget-warning.v1` record is written and the call proceeds.                               |
| `skip-remaining` | The budget latches. Every later model call in the run fails typed `skipped` without asking a provider.   |
| `park`           | The run parks on an approval request for a raised ceiling. Approving it resumes the run under the raise. |

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

## Raise a parked ceiling

A `park` ceiling needs a host with `Budget.Parking`, which `AgentSession`
provides; without one `park` acts as `fail`. The request's envelope carries the
proposed ceiling: the spend, the held forecast, the refused call, and one more
original allowance, in whole tokens and milliseconds or dollars rounded up to
the cent. Its question names it, such as `Raise the USD budget from $1.00 to
$2.20?`.

Approve it from the app's approvals inbox, with `smthrs approvals approve` on
the payload `smthrs approvals list` prints, or with retry on the parked flow
tab in the TUI. Deny is Stop: the run fails before it calls the provider again.
The resumed run recovers the spend it recorded before the park, across a
restart, and spends against the raised ceiling. A flow declares the ceilings in
frontmatter:

```yaml
budget:
  usd: 2.5
  onExceeded: park
```

`smthrs flow start` replaces them for one run with `--budget-tokens`,
`--budget-ms`, `--budget-usd` and `--on-exceeded`.

## Bound a run by a deadline

A deadline is wall-clock time, not spend: the run fails with
`deadline_exceeded` once it passes, whether it is running or parked, and
whatever `onExceeded` says. Declare it at the top level of frontmatter, as a
duration or whole milliseconds:

```yaml
deadline: 30 minutes
```

It travels in the approved envelope as `budget.deadline`, and `smthrs flow start
--deadline "2 hours"` replaces it for one run. The deadline counts from the run's
acceptance, so a resume or a restart honors the original one. The run records
when it passes as `deadlineAt`, which `smthrs runs show`, the app's run card and
the TUI's flow panel show while the run is live.

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

Local hosts sharing a store check control ownership through the child's native
ancestry, including the host recorded when its parent parked. A live parking
host retains its children even when its heartbeat is stale. A different
machine's process table is not available to this check, so an unknown remote
parking host requires an explicit resume; its parked timestamp is not a renewed
lease.

Lease expiry still interrupts work to preserve fencing. If that interruption
releases a child while its control parent remains parked under a live host,
recovery waits for an explicit resume instead of starting the external work
again. Resuming the parent permits a new execution; it does not reconnect an
interrupted external process. An explicit resume from another process, such as
`smthrs runs resume`, does not take the parent from its live parking host: the
host takes the resume up as a delegation that carries the operator's consent,
records the permission, and re-drives the parent itself. After a same-machine parking host exits and the
stale interval passes, a peer can recover a released child whose last owner is
also confirmed dead and settle the parent. Cancellation still reaches children
of a parked parent.

Approval decisions and background wake notifications do not authorize retrying
released children or recovering a quarantined run. Both require an explicit
resume.

Losing a control claim during recovery releases the execution without cancelling
its children; other control failures retain their typed fields in the durable
result.
