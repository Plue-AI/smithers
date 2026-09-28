---
title: "Troubleshooting"
description: "Every failure code @smthrs/triggers reports, plus the behaviors most often mistaken for bugs: a first tick that fires nothing, a buffer that seems stuck, and a catch-up backlog that was abandoned."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/troubleshooting.md"
---

Every failure this package reports is a `TriggerError` carrying a stable `code`.
Branch on the code; never parse the message. `TriggerError.path` names the
offending field when the failure could locate one.

Find your code below, or read the last section if nothing failed and the trigger
still did not do what you expected.

## invalid_cron

**What happened.** Effect's cron parser rejected the expression or the timezone.

**What to change.** Fix the expression. The message is the parser's own, which
names the field it choked on. A timezone must be an IANA name such as
`America/New_York`.

## unsatisfiable_cron

**What happened.** The expression parses and the calendar never satisfies it.
`0 0 30 2 *` is February 30; `0 0 31 4 *` is April 31. The occurrence search
exhausted its bound looking for a date that does not exist.

**What to change.** Fix the expression. The refusal arrives at declaration time,
from `Trigger.make`, `Schedule.make`, or `SqlTriggerStore.register`, rather than
at the tick that would have fired the trigger. That is deliberate: the
satisfiability probe is the same search every tick performs, so an expression
that survives declaration is one the scheduler can keep answering.

## invalid_trigger

**What happened.** The declaration did not decode. Either a field is missing or
the wrong type, or the `input` has no JSON representation.

**What to change.** Read `TriggerError.path`, which names the offending field.
`id`, `flowId`, and `cron` must be non-empty strings; `maxCatchUp` must be an
integer between 0 and 1000; `input` must be JSON, which excludes `undefined`,
`NaN`, a `Date`, and a function.

Enumerable getters are accepted when their values are JSON. They are evaluated
during decoding and again during SQL serialization. SQL registration takes an
eager serialized snapshot before returning its Effect; later changes to the
getter's source do not change that snapshot. Use plain JSON values for stable
input, since a getter can produce different values or throw on a later read.

## invalid_schedule

**What happened.** The same thing, for a declaration decoded through
`Schedule.make` rather than `Trigger.make`.

**What to change.** Read `TriggerError.path` and fix the field.

## invalid_options

**What happened.** One of two contracts was violated.

- A cron occurrence limit was not a non-negative safe integer. `path` is
  `"limit"`, and the message repeats the value it received, including `NaN` and
  `Infinity`.
- A scheduler interval or deadline was not a finite, positive Effect duration.
  `path` is `"pollInterval"`, `"runPollInterval"`, `"startTimeout"`,
  `"inspectTimeout"`, or `"cancelTimeout"`.
- A scheduler `concurrency` was not a positive integer. `path` is
  `"concurrency"`.
- A `TriggerStore.history` limit was not a positive safe integer. `path` is
  `"limit"`. Zero is refused here because a zero-row page can never carry a
  cursor.

**What to change.** Pass a real count, or a real duration. Zero and infinity are
both refused, because zero polls a CPU-tight loop and infinity never completes,
and `Duration.fromInput` accepts both.

## catch_up_bound_exceeded

**What happened.** One of three things, and the message tells them apart.

- `maxCatchUp must be a non-negative safe integer, received ...`: the bound
  itself is unusable. This is checked before any policy branch, so it fires even
  under `catchUp: "none"`.
- `missed N occurrences; maxCatchUp is M`: the trigger owes more than it is
  allowed to replay.
- `interval contains more than 1000 occurrences`: an unbounded
  `Cron.occurrencesBetween` was asked for a window it will not materialize.

**What to change.** For an unusable bound, fix the declaration. For a breached
bound, raise `maxCatchUp`, or accept the abandonment. For an unbounded search,
pass a `limit`.

The scheduler logs a warning annotated with the trigger id and abandons the
backlog when catch-up exceeds its bound. It still dispatches the current
occurrence subject to overlap, on the first poll after a restart and on every
later poll.

The trap worth naming: `maxCatchUp` defaults to 0, and a declaration that sets
`catchUp: "one"` without raising it owes one occurrence it is not allowed to
replay. Whenever `catchUp` is not `none`, set `maxCatchUp` to at least 1. See
[Choose an overlap and catch-up policy](/guides/choose-a-policy/).

## unknown_trigger

**What happened.** An operation named a trigger id with no row behind it. Every
method addressing one trigger reports this, except `clearActive`.

**What to change.** Register the trigger first. If the id is right, check that
you are pointed at the database you think you are: `SqlTriggerStore.layer`
creates its tables on the SQL client it is given, so a second in-memory database
looks exactly like a missing trigger.

## trigger_disabled

**What happened.** A claim read the trigger row inside its transaction and found
`enabled` false.

**What to change.** Nothing, usually. This is the correct refusal for a
scheduler that computed an occurrence before somebody disabled the trigger. Note
that the check is on the stored row, not on the caller's snapshot, so a claim
built from a stale copy is refused rather than obeyed.

## revision_mismatch

**What happened.** The claim's `expectedRevision` differs from the revision on
the row. Somebody re-registered the trigger between the read and the claim.

**What to change.** Re-read the trigger and decide again. The scheduler already
does this: it refreshes once and recomputes what is due from the refreshed
declaration rather than retrying the occurrence the old one produced, which is
enough because the next tick reads again anyway.

## verification_failed

**What happened.** A webhook request did not authenticate. Either the signature
did not match, the header was absent or empty, `SignatureConfig.expected`
returned zero bytes, or the credential could not be resolved. Nothing was
decoded and no Control operation ran. The message does not say which: a
refusal from `Webhook.ingest` always reads `webhook <name> did not verify the
request`, and one from the signature verifier itself always reads
`webhook signature in <header> did not verify`. A failure raised by `expected`
is the verifier refusal's `cause`, so read it there, on the host side, rather
than expecting it in the message a sender receives.

**What to change.** Check three things in order.

1. The header name in `SignatureConfig.header`. The verifier looks it up first
   in lowercase and then exactly as written, so a casing mismatch is not the
   cause, but a wrong name is.
2. The bytes `SignatureConfig.expected` returns. They are compared against the
   UTF-8 encoding of the header value, so an implementation that returns raw
   HMAC bytes where the provider sends hex will never match. Return the encoded
   form the provider actually sends. A zero-length result is refused outright,
   because it means the secret resolved to the empty string rather than that
   every request is valid.
3. The credential. `Webhook.Config.credential` is required, and a failure inside
   `expected` while resolving it surfaces here as a typed failure rather than as
   a defect.

## runner

**What happened.** The scheduler could not plan, launch, inspect, or cancel a
run, or a plan never got approved.

**What to change.** Read the message.

- `Control plan <id> is still parked awaiting approval after 8 attempts`: the
  flow needs an approval nobody gave. The runner re-offers the same idempotent
  request with a delay that doubles from one second, so it gives up a little
  over two minutes in. Approve the plan, or stop scheduling a flow that requires
  an interactive approval.
- `Control rejected the scheduled run: ...`: Control answered `Conflict`. The
  message is Control's.
- `Control <tag> receipt did not include a run id`: an accepted launch came back
  without the id the scheduler needs to monitor it.
- `Control could not ...`: the underlying Control call failed. The cause carries
  the original error.

A run inspection error retains the active owner and overlap protection. The
monitor logs the cause and retries three times with doubling delays starting
at `runPollInterval`, capped at one minute. Exhaustion detaches the monitor;
subsequent ticks inspect the retained owner again. Restore Control access to
resume completion detection. The default run poll interval is fifteen seconds.
An inspection outage does not record a failed run or cancel it.

## runner_timeout

**What happened.** One `Runner.start`, `inspect`, or `cancel` call exceeded
`startTimeout`, `inspectTimeout`, or `cancelTimeout`. The defaults are four
minutes, thirty seconds, and thirty seconds. The call was interrupted.

**What to change.** Nothing is lost. A start that timed out leaves the
occurrence pending, so the next tick retries it under the same `idempotencyKey`
and a runtime that did start the run answers with the same run id. An
inspection that timed out is retried like any inspection failure. A
cancellation that timed out restores the prior run as active and queues the
replacement. If the runtime is healthy and merely slow, raise the deadline in
`Scheduler.Options`; a parked plan needs a `startTimeout` above the two minutes
`parkedAttempts` allows.

## store

**What happened.** A persistence operation failed, or a `TriggerStore.makeNoop`
method was called.

**What to change.** Read the message.

- `<method> is unavailable`: the composition provided `TriggerStore.layerNoop`
  and something reached a method it did not override. Provide a real store, or
  override that method.
- `could not run trigger migrations`: the database refused the schema. Check
  that the SQL client points at a writable database.
- `could not decode trigger row`: a row's `input_json` did not parse, or the
  row fails the declaration schema `register` enforces (an empty id, flow, or
  cron, or a `maxCatchUp` above the limit). Something outside this package
  wrote the row; the cause names the field.
- `trigger input is not JSON-serializable`: the input contained a cycle.
- `trigger store read failed` or `trigger store write failed`: the underlying
  SQL call failed, and its error is the cause.

## The trigger did not fire, and nothing failed

First ask whether anything is polling. `store.lastHeartbeat()` answers `None`
when no scheduler has ever ticked against this store, and a `TriggerSummary`
from `Control.list` carries no `schedulerLastTickMs` in the same case. A
heartbeat older than `pollInterval` by a wide margin means the scheduler's scope
closed. Then, four behaviors are correct and surprising.

**A trigger with no durable cursor fires nothing on its first tick.** A trigger with no
`lastFiredAt` establishes a watermark at the latest boundary on first sight and
starts from the next one. Registering a weekly trigger on a Sunday evening does
not fire it for the Monday six days gone. Run a second tick after a boundary has
passed, or seed a `lastFiredAt` by recording a result.

**A boundary was skipped while a run was in flight.** That is `overlap: "skip"`,
the default. The occurrence is recorded as `skipped` and the cursor advances.
Choose `buffer-one` if one coalesced follow-up is enough.

**A buffered occurrence has not run yet.** The buffer drains on the next tick
after the active run settles, and it holds exactly one occurrence: a run that
overran four boundaries leaves one pending occurrence, the newest.
`store.activeRun(triggerId)` tells you whether something is still holding the
trigger.

**A backlog disappeared after downtime.** Either `catchUp` is `none`, which
replays no missed boundary, or the backlog exceeded `maxCatchUp` and was
abandoned with a warning annotated with the trigger id. Check the logs for
`A trigger abandoned catch-up work beyond its bound`. The current occurrence
still fires in both cases.

## The trigger fired twice

Check that both launches carry the same `idempotencyKey`. The key is
`<triggerId>:<occurrence ISO instant>`, so two hosts noticing the same boundary
produce the same key. Two different keys identify different occurrences or
trigger ids.

Scheduled dispatch makes at-least-once launch attempts. `RunnerService.start`
must durably deduplicate by `idempotencyKey` and return the same run identity on
replay, including across host restarts.
The Control-backed adapter forwards this key to Control. Custom runners must
provide the same durable deduplication contract.

The same database can issue another launch-capable claim after lease expiry or
launch compensation. A launch may have been accepted before its `launched`
result was persisted; a crash or result-write failure in that window causes a
retry. An expired lease can also overlap an earlier in-flight attempt. Repeated
`start` calls with one key are expected during recovery. If they produce
different run identities, check the runner's durable idempotency records and
whether the hosts share that deduplication state.

## A run is stuck holding the trigger

A trigger whose `activeRun` never clears is holding either a run the runner
still calls active, or a launch reservation from a process that died. A
reservation looks like `trigger-reservation:<triggerId>:<occurrence>`, and
`TriggerStore.isReservation` says so.

A reservation releases itself when its 5-minute lease expires, at which point
the store restores the unfinished occurrence to pending work. Wait out the
lease. A real run id that never clears is a run the control plane still reports
as live, which is a question for the run, not for the trigger.
