---
title: "API reference"
description: "Every public export of @smthrs/triggers: trigger and schedule declarations, the cron wrappers, the overlap and catch-up policies, the durable store contract and its SQL implementation, the scheduler and its runner port, and the channel and webhook declarations."
---

`@smthrs/triggers` exports twelve modules from its root entry point, and each is
also importable from `@smthrs/triggers/<Module>`:

```ts
import { Scheduler, Trigger, TriggerStore } from "@smthrs/triggers"
// or
import * as Scheduler from "@smthrs/triggers/Scheduler"
```

The in-memory store for tests is a thirteenth module at
`@smthrs/triggers/test/TestTriggers`.

Services and tags are Effect constructs: a `Layer` provides a service, and an
Effect reads it from context. Launching goes through
[`@smthrs/control`](/api/control), and persistence through the SQL client and
durable writer of [`@smthrs/database`](/api/database).

The package is not on npm at 1.0.0-rc.0. See [Installation](./installation.md)
for how to get it.

## Example

```ts
import * as Trigger from "@smthrs/triggers/Trigger"

const nightly = Trigger.make({
  id: "nightly-report", flowId: "reports/nightly", input: { channel: "#ops" },
  cron: "0 3 * * *", timezone: "UTC", overlap: "skip", enabled: true
})
```

## Trigger

The trigger declaration: which flow to run, with what input, on what schedule.

### Trigger.Trigger

```ts
const Trigger: Schema.Struct<{
  id: Schema.NonEmptyString
  flowId: Schema.NonEmptyString
  input: Schema.Json
  cron: Schema.NonEmptyString
  timezone: Schema.optional<Schema.NonEmptyString>
  overlap: Schema.Literals<["skip", "buffer-one", "supersede"]>
  catchUp: Schema.Literals<["none", "one", "all"]>
  maxCatchUp: Schema.Int
  enabled: Schema.Boolean
}>
type Trigger = typeof Trigger.Type
```

| Field        | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `id`         | The trigger's identity. Registering the same id replaces the row and bumps its revision. |
| `flowId`     | The flow a launch names. This package never resolves it.                                 |
| `input`      | The flow's input, as JSON.                                                               |
| `cron`       | The cron expression. Validated for satisfiability, not only for shape.                   |
| `timezone`   | An optional IANA timezone name.                                                          |
| `overlap`    | Decoding default `"skip"`.                                                               |
| `catchUp`    | Decoding default `"none"`.                                                               |
| `maxCatchUp` | Decoding default `0`. An integer in `[0, Schedule.maxCatchUpLimit]`.                     |
| `enabled`    | A disabled trigger is listed and never claimed.                                          |

`input` is `Schema.Json` rather than `Schema.Unknown` because the store persists
it with `JSON.stringify` into a `NOT NULL` column. The schema refuses what that
call would drop or rewrite: `undefined`, `NaN`, a `Date`, and a function each
fail as `invalid_trigger` with `TriggerError.path` set to `input`, at the
declaration boundary where the caller can still see which field is wrong.

Enumerable getters are accepted when their values are JSON. They are evaluated
during decoding and again during SQL serialization. SQL registration takes an
eager serialized snapshot before returning its Effect; later changes to the
getter's source do not change that snapshot. Use plain JSON values for stable
input, since a getter can produce different values or throw on a later read.

`Trigger.Overlap` and `Trigger.CatchUp` are re-exports of the schemas and types
of the same names from `Schedule`.

### Trigger.make

```ts
const make: (input: unknown) => Effect.Effect<Trigger, TriggerError>
```

Decodes the declaration, applies the three policy defaults, and validates the
schedule. A shape failure is `invalid_trigger` with `TriggerError.path` naming
the offending field; a schedule failure is `invalid_cron` or
`unsatisfiable_cron`.

## Schedule

The reusable schedule half of a declaration, shared by anything that carries a
cron expression and the two policies.

### Schedule.Schedule

```ts
const Schedule: Schema.Struct<{
  cron: Schema.NonEmptyString
  timezone: Schema.optional<Schema.NonEmptyString>
  overlap: Schema.Literals<["skip", "buffer-one", "supersede"]>
  catchUp: Schema.Literals<["none", "one", "all"]>
  maxCatchUp: Schema.Int
}>
type Schedule = typeof Schedule.Type
```

`Trigger.Trigger` spreads these fields, so the two declarations cannot drift.

### Schedule.Overlap and Schedule.CatchUp

```ts
const Overlap: Schema.Literals<["skip", "buffer-one", "supersede"]>
type Overlap = typeof Overlap.Type

const CatchUp: Schema.Literals<["none", "one", "all"]>
type CatchUp = typeof CatchUp.Type
```

### Schedule.maxCatchUpLimit

```ts
const maxCatchUpLimit: number
```

The greatest catch-up bound a schedule may declare, equal to
`Cron.maxOccurrences`. A schedule may not owe more occurrences than one
occurrence search returns, so the ceiling is the search's own cap.

### Schedule.validate

```ts
const validate: <A extends { readonly cron: string; readonly timezone?: string | undefined }>(
  declaration: A
) => Effect.Effect<A, TriggerError>
```

Refuses a declaration whose cron expression is malformed or which the calendar
never satisfies, and answers with the declaration unchanged otherwise. Every
declaration path runs it, so `0 0 30 2 *` is refused where it is written rather
than at the tick that would have fired it.

### Schedule.make

```ts
const make: (input: unknown) => Effect.Effect<Schedule, TriggerError>
```

Decodes and validates a schedule on its own. A shape failure is
`invalid_schedule`.

## Cron

Typed wrappers around Effect's cron. Every search here is bounded, and every
exhausted search arrives as a typed failure rather than as a defect.

### Cron.Cron

```ts
interface Cron {
  readonly expression: string
  readonly timezone?: string | undefined
  readonly value: EffectCron.Cron
}
```

The parsed expression is kept beside the text it came from, so a declaration
round-trips through the store unchanged.

### Cron.parse

```ts
const parse: (
  expression: string,
  timezone?: string
) => Effect.Effect<Cron, TriggerError>
```

Parses an expression in an optional timezone. Reports a malformed expression as
`invalid_cron` and one the calendar never satisfies as `unsatisfiable_cron`.
The satisfiability probe searches forward from the current instant, which is
the same search every tick performs.

### Cron.next

```ts
const next: (cron: Cron, from: Date) => Effect.Effect<Date, TriggerError>
```

The first occurrence strictly after `from`.

### Cron.previousAtOrBefore

```ts
const previousAtOrBefore: (cron: Cron, at: Date) => Effect.Effect<Date, TriggerError>
```

The latest occurrence at or before `at`. When `at` itself matches, the answer is
that instant with milliseconds zeroed, so an occurrence is the boundary rather
than the sub-second offset the caller observed it at.

### Cron.occurrencesBetween

```ts
const occurrencesBetween: (
  cron: Cron,
  from: Date,
  to: Date,
  limit?: number | undefined
) => Effect.Effect<ReadonlyArray<Date>, TriggerError>
```

The occurrences in `(from, to]`, in order. `from` is exclusive and `to` is
inclusive.

A stated `limit` caps the result silently and must be a non-negative safe
integer; anything else fails with `invalid_options` and `path: "limit"`, and 0
returns nothing. With no stated limit, the search fails with
`catch_up_bound_exceeded` when the interval holds more than
`Cron.maxOccurrences`. A caller with its own bound passes one more than that
bound and compares the length, the way `CatchUp.occurrences` does.

### Cron.maxOccurrences

```ts
const maxOccurrences: number
```

1000. The greatest number of occurrences one search returns when its caller
      states no limit of its own.

## Overlap

The pure overlap decision, over explicit state.

### Overlap.State and Overlap.Action

```ts
interface State {
  readonly running: boolean
  readonly pending?: number | undefined
  readonly due: number
}

type Action = "fire" | "skip" | "buffer" | "supersede"
```

### Overlap.decide

```ts
const decide: (policy: Trigger.Overlap, state: State) => Action
```

Answers `"fire"` whenever no run is in flight, whatever the policy says.
Otherwise `skip` answers `"skip"`, `buffer-one` answers `"buffer"`, and
`supersede` answers `"supersede"`.

### Overlap.pendingAfter

```ts
const pendingAfter: (state: State) => number
```

The occurrence left buffered after this decision: the later of the currently
pending occurrence and the one now due. The buffer is a coalescing slot, not a
queue.

## CatchUp

The pure catch-up computation.

### CatchUp.occurrences

```ts
const occurrences: (
  policy: Trigger.CatchUp,
  maxCatchUp: number,
  lastFiredAt: Date | undefined,
  now: Date,
  cron: Cron.Cron
) => Effect.Effect<ReadonlyArray<Date>, TriggerError>
```

The occurrences a trigger owes since it last fired, oldest first.

- `none` owes nothing, `one` owes only the most recent, and `all` owes every
  missed occurrence.
- A `lastFiredAt` of `undefined` owes nothing under every policy.
- `maxCatchUp` is validated before any policy branch, so an unusable bound is
  refused even where the policy owes nothing. It must be a non-negative safe
  integer.
- Every policy answers to `maxCatchUp`, `one` included: a bound of zero says no
  occurrence may be caught up, so a missed occurrence under `one` is
  `catch_up_bound_exceeded` exactly as three missed occurrences under `all` are.

The scheduler dispatches these occurrences subject to overlap. A launched
occurrence holds the trigger until its run settles, so `all` with `skip` can
drop work and
`all` with `buffer-one` can coalesce intermediate occurrences. Use a durable
queue or a flow that processes its own interval backlog when every boundary
must be processed.

The scheduler logs a warning annotated with the trigger id and abandons the
backlog when catch-up exceeds its bound. It still dispatches the current
occurrence subject to overlap, on the first poll after a restart and on every
later poll.

## TriggerStore

The durable state contract: registration, listing, the claim protocol, and
results.

### TriggerStore.Registered

```ts
interface Registered extends Trigger {
  readonly revision: number
  readonly lastFiredAt?: number | undefined
}
```

`revision` fences concurrent edits. `lastFiredAt` is the cursor catch-up resumes
from, and is absent until an occurrence is recorded.

### TriggerStore.Fire, ClaimFire, and Claim

```ts
interface Fire {
  readonly triggerId: string
  readonly occurrence: number
}

interface ClaimFire extends Fire {
  readonly expectedRevision: number
  readonly resumeBuffered?: boolean | undefined
}

type Claim =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly action: "skip" | "buffer" }
  | {
    readonly claimed: true
    readonly action: "fire" | "supersede"
    readonly reservationId: string
    readonly activeRunId?: string | undefined
  }
```

An occurrence is addressed by its occurrence number. An unfinished occurrence
can be claimed again after lease expiry or launch compensation; its runner
idempotency key stays the same across attempts.

`ClaimFire` deliberately carries no overlap policy. A claim applies the policy
stored on the trigger row, read inside the same transaction, so a caller holding
a stale snapshot cannot fire a trigger that has since been disabled, cannot
point it at a different flow, and cannot supersede a run the stored declaration
says to leave alone. `expectedRevision` is the fence.

The `Claim` shapes are separate so a caller cannot read a reservation id that
was never written. A claim that hands out work always names its reservation; a
claim that only records a decision names none. A `supersede` claim also names
the run it displaced.

### TriggerStore.Outcome and Result

```ts
type Outcome = "launched" | "completed" | "skipped" | "buffered" | "superseded" | "failed"

type Result =
  & Fire
  & { readonly error?: string | undefined }
  & (
    | { readonly outcome: "launched"; readonly runId: string; readonly reservationId: string }
    | {
      readonly outcome: Exclude<Outcome, "launched">
      readonly runId?: string | undefined
      readonly reservationId?: string | undefined
    }
  )
```

A launched result requires a non-empty `runId` and the exact `reservationId`
returned by its claim. Missing, empty, or whitespace-only run ids fail with
`invalid_options` at `runId`. Launches commit only while that reservation owns
an unfinished fire (`null` or `buffered`). Stale ownership or an impermissible
fire transition fails with `stale_owner` without changing the ledger, cursor,
lease, or active run. Terminal results may omit `runId` to settle the run
already recorded for that occurrence. Before launch, pass `reservationId` to
fence settlement to a particular attempt. Repeated terminal results and
claim decisions leave the existing row unchanged.

`resultRefusal(result, fire, activeRunId)` returns a `TriggerError` for invalid
or stale results, or `undefined` for a permissible transition. Store adapters
call this helper inside their atomic write before mutating state.

### TriggerStore.Service

```ts
interface Service {
  readonly register: (trigger: Trigger) => Effect.Effect<Registered, TriggerError>
  readonly get: (triggerId: string) => Effect.Effect<Option.Option<Registered>, TriggerError>
  readonly list: () => Effect.Effect<ReadonlyArray<Listed>, TriggerError>
  readonly listEnabled: () => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly claimFire: (fire: ClaimFire) => Effect.Effect<Claim, TriggerError>
  readonly claimPending: (fire: {
    readonly triggerId: string
    readonly expectedRevision: number
  }) => Effect.Effect<Option.Option<{ readonly occurrence: number; readonly claim: Claim }>, TriggerError>
  readonly recordResult: (result: Result) => Effect.Effect<void, TriggerError>
  readonly restorePending: (fire: Fire & { readonly reservationId: string }) => Effect.Effect<void, TriggerError>
  readonly setPending: (fire: Fire) => Effect.Effect<void, TriggerError>
  readonly activeRun: (triggerId: string) => Effect.Effect<Option.Option<string>, TriggerError>
  readonly activeOccurrence: (
    triggerId: string,
    runId: string
  ) => Effect.Effect<Option.Option<number>, TriggerError>
  readonly clearActive: (triggerId: string, runId: string) => Effect.Effect<void, TriggerError>
  readonly history: (query?: HistoryQuery) => Effect.Effect<HistoryPage, TriggerError>
  readonly pruneFires: (options: { readonly olderThan: number }) => Effect.Effect<number, TriggerError>
  readonly inspect: (triggerId: string) => Effect.Effect<Held, TriggerError>
  readonly heartbeat: (host: string) => Effect.Effect<void, TriggerError>
  readonly lastHeartbeat: () => Effect.Effect<Option.Option<Heartbeat>, TriggerError>
}
```

| Method             | Contract                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register`         | Upsert. A first write is revision 1; every replacement increments. Re-validates the declaration.                                                                                                                   |
| `get`              | One trigger, or `None`.                                                                                                                                                                                            |
| `list`             | Every trigger, ordered by id, as `Listed` rows. This is what a scheduler tick polls. A row that cannot be decoded carries the failure instead of the declaration, so one corrupt row cannot fail the listing.      |
| `listEnabled`      | Every enabled trigger, ordered by id. Not a due-time query: due-ness is the scheduler's cron computation.                                                                                                          |
| `claimFire`        | The claim protocol for one occurrence.                                                                                                                                                                             |
| `claimPending`     | Reads the buffered occurrence, applies the same claim rules, and clears the buffer only when the decision consumes it, in one transaction.                                                                         |
| `recordResult`     | Records how one occurrence ended and settles the trigger's active run and cursor.                                                                                                                                  |
| `restorePending`   | Atomically restores pending work and releases the matching unfinished reservation. Retains a predecessor only if its fire is still launched. Stale tokens fail with `stale_owner`; failed writes retain the lease. |
| `setPending`       | Buffers an occurrence, coalescing with any already pending.                                                                                                                                                        |
| `activeRun`        | The run id or launch reservation the trigger currently holds. Expires a stale reservation as a side effect.                                                                                                        |
| `activeOccurrence` | The occurrence owned by one active run or reservation. `lastFiredAt` cannot answer this, because later skipped and buffered occurrences advance that cursor while an older run remains active.                     |
| `clearActive`      | Compare-and-swap release of one run id.                                                                                                                                                                            |
| `history`          | The fire ledger, newest occurrence first, filtered and paged by a `HistoryQuery`. A limit that is not a positive safe integer is refused with `invalid_options` and `path` `"limit"`.                              |
| `pruneFires`       | Deletes settled ledger rows older than `olderThan` and answers how many. Keeps the buffered occurrence and the row naming the active run. A cutoff that is not a safe integer is refused with `invalid_options`.   |
| `inspect`          | The run or reservation and the buffered occurrence one trigger holds, read as the row has them. Expires nothing; `activeRun` is the read that expires a stale reservation.                                         |
| `heartbeat`        | Records that `host` polled the store at the store clock's current time. One row per host; a later poll overwrites.                                                                                                 |
| `lastHeartbeat`    | The newest heartbeat across every host, or `None` when no scheduler has ever polled. Equal times fall to the lower host name so the answer is one row.                                                             |

A claim, result, pending-state, or active-run method fails with
`unknown_trigger` when the row it addresses does not exist. `get` answers
`None` for an absent row and `register` creates one. `clearActive` is a
compare-and-swap that cannot tell a missing trigger from a run id that no
longer matches, so it stays a no-op for both. `history`, `pruneFires`,
`heartbeat`, and `lastHeartbeat` address the whole store.

Nothing else in the store deletes from the fire ledger: every claim inserts a
row and every result updates it. The scheduler calls `pruneFires` at most once
an hour with its `fireRetention`; a host that runs no scheduler and never calls
it keeps one row per occurrence for as long as the database lives.

### TriggerStore.FireRecord, HistoryQuery, HistoryPage, Held, Listed, and Heartbeat

```ts
interface FireRecord extends Fire {
  readonly outcome: Outcome | null
  readonly runId?: string | undefined
  readonly error?: string | undefined
}

interface HistoryQuery {
  readonly triggerId?: string | undefined
  readonly runId?: string | undefined
  readonly outcome?: Outcome | undefined
  readonly cursor?: Fire | undefined
  readonly limit?: number | undefined
}

interface HistoryPage {
  readonly items: ReadonlyArray<FireRecord>
  readonly nextCursor?: Fire | undefined
}

interface Held {
  readonly activeRunId?: string | undefined
  readonly pendingAt?: number | undefined
}

interface Listed extends Held {
  readonly triggerId: string
  readonly trigger: Result.Result<Registered, TriggerError>
}

const listed: (trigger: Registered, held?: Held) => Listed

interface Heartbeat {
  readonly host: string
  readonly tickedAt: number
}
```

A `FireRecord` is one row of the fire ledger. Its `outcome` is `null` between a
claim and its `recordResult`, the window in which a launch is reserved but not
yet reported. Every `HistoryQuery` filter narrows; `cursor` is the last record
of the previous page, so the page after it holds only older records; with no
`limit` the whole ledger answers in one page. `nextCursor` is present only when
the limit cut the page short. `Held.activeRunId` may be a launch reservation;
`isReservation` tells the two apart.

A `Listed` row is what `list` answers. `trigger` is an `effect/Result`: narrow
it with `Result.isFailure` before reading the declaration, because a row whose
stored input cannot be decoded is isolated there rather than failing the whole
listing. The held state travels with the row so a scheduler tick reads it once
instead of asking per trigger for a reservation and a buffered occurrence that
are not there. `listed(trigger, held)` builds a decoded row.

### TriggerStore history helpers

```ts
const historyLimit: (limit: number | undefined) => Effect.Effect<number | undefined, TriggerError>
const compareNewestFirst: (left: Fire, right: Fire) => number
const isAfterCursor: (record: Fire, cursor: Fire) => boolean
const historyPage: (records: ReadonlyArray<FireRecord>, limit: number | undefined) => HistoryPage
```

Both stores apply these, so swapping one for the other cannot change which
queries are refused, how equal occurrences of different triggers order
(descending trigger id, so a cursor names one position), or where a page ends.

### TriggerStore.TriggerStore

```ts
class TriggerStore extends Context.Service<TriggerStore, Service>()("flows/triggers/TriggerStore") {}
```

### TriggerStore reservation helpers

```ts
const reservationLeaseMs: number
const reservationPrefix: string
const reservationId: (triggerId: string, occurrence: number, attempt?: string) => string
const isReservation: (runId: string | undefined) => boolean
const reservationOccurrence: (runId: string) => number | undefined
```

`reservationPrefix` is `trigger-reservation:`, and `reservationId` appends the
trigger id, optional attempt, and occurrence. Store claims supply a fresh UUID
for each attempt, including retries. Use the token returned by the claim; do
not reconstruct it. The two-argument helper reads and constructs legacy ids.
`reservationLeaseMs` is 300,000 milliseconds, or
5 minutes, and both store implementations use it so swapping one for the other
cannot change recovery timing.

### TriggerStore.makeNoop and layerNoop

```ts
const makeNoop: (overrides?: Partial<Service>) => Service
const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<TriggerStore>
```

Fails every method with `store` and a message naming the method. Overrides
replace individual methods, for a composition that must reach exactly one of
them.

## SqlTriggerStore

The SQLite implementation of `TriggerStore.Service`, with every write going
through the durable writer.

### SqlTriggerStore.make and layer

```ts
const make: Effect.Effect<
  TriggerStore.Service,
  TriggerError,
  DurableWriter | SqlClient.SqlClient
>

const layer: Layer.Layer<
  TriggerStore.TriggerStore,
  TriggerError,
  DurableWriter | SqlClient.SqlClient
>
```

Construction applies the package's migrations, so a host runs nothing itself. A
migration the migrator raises as a defect is caught and reported as `store`,
because the constructor's signature promises a `TriggerError`.

## Scheduler

The Clock-driven poll loop and the launcher port it fires through.

### Scheduler.StartInput and RunnerService

```ts
interface StartInput {
  readonly flowId: string
  readonly input: unknown
  readonly idempotencyKey: string
}

type RunState = "active" | "completed" | "failed" | "cancelled" | "missing"

interface RunnerService {
  readonly start: (input: StartInput) => Effect.Effect<string, TriggerError>
  readonly inspect: (runId: string) => Effect.Effect<RunState, TriggerError>
  readonly cancel: (runId: string) => Effect.Effect<void, TriggerError>
}
```

`inspect` says what the runtime knows about one run. `active` keeps the monitor
polling. `completed` is recorded as a `completed` fire. `failed`, `cancelled`,
and `missing` (the runtime has no record of the run) are recorded as `failed`,
with the state in the fire's error.

`idempotencyKey` is `<triggerId>:<occurrence ISO instant>`, so two hosts that
notice the same boundary derive the same key.

Scheduled dispatch makes at-least-once launch attempts. `RunnerService.start`
must durably deduplicate by `idempotencyKey` and return the same run identity on
replay, including across host restarts.
The runner may have accepted a launch before the store persists its `launched`
result. A crash, result-write failure, or expired reservation can cause another
attempt with that key, even while the earlier attempt is in flight.

### Scheduler.Runner and its constructors

```ts
class Runner extends Context.Service<Runner, RunnerService>()("flows/triggers/Scheduler/Runner") {}

const makeRunner: (implementation: RunnerService) => RunnerService
const makeNoopRunner: (overrides?: Partial<RunnerService>) => RunnerService
const layerNoopRunner: (overrides?: Partial<RunnerService>) => Layer.Layer<Runner>
```

The no-op launcher returns the idempotency key as a terminal run: `start`
answers with the key, `inspect` with `"completed"`, and `cancel` with nothing.

### Scheduler.layerControlRunner

```ts
const layerControlRunner: Layer.Layer<Runner, never, Control.Control>
```

The production launcher, backed by the Control plan, run, list, and cancel API.
A parked plan waits for approval and retries the same idempotent run request a
bounded number of times. This adapter never approves a plan and never
reconstructs an execution envelope. The start input is forwarded to `Control.plan`;
every `Control.run` attempt uses the returned plan ID, digest, and envelope with
the original start idempotency key.

Cancellation sends ``{ runId, idempotencyKey: `trigger-cancel:${runId}` }`` to
`Control.cancel`. Only `Accepted`, `AlreadyApplied`, and `Terminal` receipts
acknowledge cancellation. `Conflict` and `Parked` fail with `TriggerError` code
`runner`, so supersession retains the predecessor and queues the replacement.

`inspect` answers each settled status `cancelled`, `completed`, and `failed` as
itself, `missing` for a run Control does not list, and `active` for every other
status, so a status Control adds later is treated as live until this package
says otherwise.

### Scheduler.parkedAttempts

```ts
const parkedAttempts: number
```

8. How many times a parked plan is re-offered before the launch is abandoned.
   The delay doubles from one second, so the eighth attempt lands a little over two
   minutes in, and the launch then fails with `runner`.

### Scheduler.Options and Service

```ts
interface Options {
  readonly pollInterval?: Duration.Input | undefined
  readonly runPollInterval?: Duration.Input | undefined
  readonly concurrency?: number | undefined
  readonly startTimeout?: Duration.Input | undefined
  readonly inspectTimeout?: Duration.Input | undefined
  readonly cancelTimeout?: Duration.Input | undefined
  readonly host?: string | undefined
  readonly fireRetention?: Duration.Input | undefined
}

interface Service {
  readonly runOnce: Effect.Effect<void, TriggerError>
}

const defaultHost: string
const defaultConcurrency: number
const defaultFireRetention: Duration.Duration
const durationBoundaries: ReadonlyArray<number>
```

`pollInterval` defaults to one minute and paces the tick loop.
`runPollInterval` defaults to fifteen seconds and paces a launched run's monitor.
Both must be finite, positive Effect durations; zero polls a CPU-tight loop and
an infinite interval never completes, and both are refused with
`invalid_options` and `TriggerError.path` naming the field.

`concurrency` is how many triggers one tick processes at the same time. It
defaults to `defaultConcurrency`, which is 4, and must be a positive integer;
anything else is refused with `invalid_options` at `concurrency`. Triggers are
independent once claimed, because the store fences every claim on its own row.
A tick never waits for a launch: the claim is durable, the launch runs on its
own fiber, and a plan parked awaiting approval holds only its own trigger. Each
trigger reads the clock when its own processing starts,
not once for the tick.

`startTimeout`, `inspectTimeout`, and `cancelTimeout` bound one `Runner.start`,
`Runner.inspect`, and `Runner.cancel` call. They default to four minutes,
thirty seconds, and thirty seconds, must be finite, positive Effect durations,
and are refused with `invalid_options` naming the field. The start default
outlasts `layerControlRunner`'s bounded parked-approval retries and stays below
the five-minute reservation lease, so an abandoned launch still owns its
reservation. A deadline above the lease is allowed; a start that answers after
its lease is reconciled as a late launch. A call that exceeds its deadline is
interrupted and fails with `runner_timeout`:

- A start that times out is ambiguous, because the runtime may hold the run.
  The occurrence is neither failed nor forgotten: the reservation is released
  and the occurrence stays pending, so the next tick retries it under the same
  `idempotencyKey` and the runtime's durable deduplication answers with the
  same run. The tick waits at most `startTimeout` for one launch.
- An inspection that times out is an inspection failure: the monitor retries
  and then detaches, retaining the durable owner.
- A cancellation that times out fails the supersede: the prior run is restored
  as active and the replacement is queued.

`host` is the name every tick records its heartbeat under through
`TriggerStore.heartbeat`, so a listing can say which host last polled the
store. It defaults to `defaultHost`, which is `"local"`. The heartbeat is
observability, not dispatch: a store that cannot record it is logged with the
host annotated and the tick goes on, so a listing's "nothing is listening" can
never be caused by the row that reports it.

`fireRetention` is how long settled fire ledger rows are kept. It defaults to
`defaultFireRetention`, thirty days, and must be a finite, positive Effect
duration. A tick calls `TriggerStore.pruneFires` with the cutoff at most once
an hour; a prune that fails is logged and the tick goes on.

`runOnce` holds a semaphore permit, so concurrent calls on one scheduler
serialize.

The scheduler traces `Scheduler.runOnce` (attribute `host`),
`Scheduler.processTrigger` (attribute `triggerId`), and `Scheduler.launch`
(attributes `triggerId` and `occurrence`), and records three metrics:

| Metric                                 | Kind      | Meaning                                              |
| -------------------------------------- | --------- | ---------------------------------------------------- |
| `smithers.triggers.fires`              | counter   | Fire results recorded, with the attribute `outcome`. |
| `smithers.triggers.tick_duration_ms`   | histogram | Duration of one `runOnce`.                           |
| `smithers.triggers.launch_duration_ms` | histogram | Duration of one `Runner.start`, the launch latency.  |

Both histograms use `durationBoundaries`.

### Scheduler.make, makeNoop, layer, and layerNoop

```ts
const make: (
  options?: Options
) => Effect.Effect<Service, TriggerError, Runner | Scope.Scope | TriggerStore.TriggerStore>

const makeNoop: () => Service

const layer: (
  options?: Options
) => Layer.Layer<Scheduler, TriggerError, Runner | TriggerStore.TriggerStore>

const layerNoop: Layer.Layer<Scheduler>
```

`make` builds the service in the current scope and forks nothing; the caller
decides when a tick happens. `layer` additionally forks a supervisor fiber that
ticks and sleeps forever. The supervisor sleeps only through the Effect Clock,
so scope closure interrupts it, and it recovers from the whole cause of a failed
tick rather than the typed error alone.

Scope closure detaches every run monitor and cancels nothing. The runs are
durable and outlive the process; the next incarnation re-attaches to them from
the store. Cancellation happens only through a `supersede` claim.

An inspection failure logs its cause and retries three times. Retry delays
start at `runPollInterval`, double each time, and are capped at one minute.
After exhaustion the monitor detaches, retaining the durable active owner and
local entry. Later ticks inspect that owner again. Only an inspection that
reports the run stopped permits a completed result; inspection and completion
write failures never become failed run outcomes.

A launch runs on its own fiber and compensates its own failures: a start that
failed outright records `failed`, an ambiguous one (timed out, or answered but
not persisted) re-arms the occurrence as pending, and a buffered occurrence is
re-armed. Every failure other than interruption is logged with the trigger id.
Interrupting the fiber detaches it; the reservation lease re-arms the
occurrence.

## DispatchReader

The [`@smthrs/control`](/api/control) `DispatchReader` port served from a
`TriggerStore`. `Control.list` answers `{ _tag: "triggers" }` and
`{ _tag: "fires" }` through that port. The port is declared in control because
this package depends on control; the adapter lives here because only this
package can read the store. A host composes the two by providing
`DispatchReader.layer` over the same store its scheduler writes; without it,
`Control.list` refuses both variants with `InvalidInput` naming the missing
store.

### DispatchReader.make and layer

```ts
const make: Effect.Effect<Port.Service, never, TriggerStore.TriggerStore>
const layer: Layer.Layer<Port.DispatchReader, never, TriggerStore.TriggerStore>
```

`list` answers every trigger the store holds as a control `TriggerSummary`:
the declaration, `lastFiredAtMs`, `pendingAtMs`, `activeRunId` for a launched
run (a launch reservation is not a run the runtime knows about and is reported
as no active run), the next `nextOccurrenceCount` occurrences after the store
clock, and `schedulerLastTickMs` from the newest heartbeat when any scheduler
has polled. `fires` pushes the request's `triggerId`, `runId`, and `outcome`
filters into `TriggerStore.history` with a limit of the page's offset cursor
plus its size plus one, so it reads only the rows the requested page needs,
and answers them newest first; `Control.list` applies the filters again and
pages. A store failure is a
control `PersistenceError` whose `operation` names the listing, `triggers` or
`fires`.

### DispatchReader.nextOccurrences, toTriggerSummary, toFireSummary, and nextOccurrenceCount

```ts
const nextOccurrenceCount: number
const nextOccurrences: (
  trigger: Pick<TriggerStore.Registered, "cron" | "timezone">,
  now: number
) => Effect.Effect<ReadonlyArray<number>, TriggerError>
const toTriggerSummary: (
  trigger: TriggerStore.Registered,
  held: TriggerStore.Held,
  nextOccurrencesMs: ReadonlyArray<number>,
  schedulerLastTickMs: Option.Option<number>
) => TriggerSummary
const toFireSummary: (record: TriggerStore.FireRecord) => FireSummary
```

`nextOccurrenceCount` is 5. `nextOccurrences` lists that many occurrences
strictly after `now`, ascending, as epoch milliseconds.

## Channel

The authority-free inbound channel declaration.

### Channel.RawInbound

```ts
interface RawInbound {
  readonly body: Uint8Array
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly idempotencyKey: IdempotencyKey
}
```

Opaque inbound transport data. Verification inspects this value before any
payload decoding occurs.

### Channel.Start, Signal, and Inbound

```ts
interface Start {
  readonly start: { readonly flowId: string; readonly input: unknown }
}

interface Signal {
  readonly signal: {
    readonly runId: string
    readonly stepId: string
    readonly value: unknown
  }
}

type Inbound = Start | Signal
```

The only two operations an inbound channel may request. Neither supplies
capabilities, grants, or an alternate execution envelope.

### Channel.Verify

```ts
type Verify = (
  raw: RawInbound,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<void, TriggerError>
```

The credential arrives as a redacted reference rather than a secret, and per
request rather than at declaration time, so a verifier resolves it through the
host's resolver when it needs the bytes.

### Channel.Channel and Config

```ts
interface Channel<Payload, Run = never, Outbound = never> {
  readonly name: string
  readonly verify: Verify
  readonly inbound: (payload: Payload) => Inbound
  readonly outbound?: ((run: Run) => Outbound) | undefined
}

interface Config<Payload, Run = never, Outbound = never> extends Channel<Payload, Run, Outbound> {
  readonly schema: Schema.Schema<Payload>
}
```

### Channel.make

```ts
const make: <Payload, Run = never, Outbound = never>(
  config: Channel<Payload, Run, Outbound>
) => Channel<Payload, Run, Outbound>
```

Declares a channel without adding authority or execution behavior.

## Webhook

A verified webhook door whose only dispatch path is the Control channel
coordinator.

### Webhook.constantTimeEqual

```ts
const constantTimeEqual: (expected: Uint8Array, supplied: Uint8Array) => boolean
```

Compares two byte strings without returning early on a mismatch. The loop runs
exactly `expected.length` times, so its iteration count is fixed by the secret
side of the comparison and never by the caller's. The length difference is
folded into the result, so inputs of unequal length always disagree.

### Webhook.SignatureConfig and makeSignatureVerifier

```ts
interface SignatureConfig {
  readonly header: string
  readonly expected: (
    body: Uint8Array,
    credential: Redacted.Redacted<CredentialRef>
  ) => Effect.Effect<Uint8Array, TriggerError>
}

const makeSignatureVerifier: (config: SignatureConfig) => Channel.Verify
```

`expected` receives a private copy of the request bytes and the redacted
credential reference, and answers with the signature bytes the request must
carry in `header`. It returns an Effect so the secret is resolved through the
host's resolver per request, and so a resolution or HMAC failure arrives as a
typed `verification_failed` instead of a defect.

Every refusal the verifier raises has the message
`webhook signature in <header> did not verify`, whether the header was absent,
the signature mismatched, `expected` answered with zero bytes, or `expected`
failed. A failure raised by `expected` is kept only in the refusal's `cause`,
so a resolver's own message never travels toward the sender.

### Webhook.Config and Webhook

```ts
interface Config<Payload, Outbound = never> extends Channel.Config<Payload, RunSummary, Outbound> {
  readonly credential: Redacted.Redacted<CredentialRef>
}

interface Webhook {
  readonly name: string
  readonly register: Effect.Effect<void, never, ControlChannels.Channels>
  readonly ingest: (
    raw: Channel.RawInbound
  ) => Effect.Effect<Receipt, ControlError | TriggerError, ControlChannels.Channels>
}
```

`credential` is required, and nothing is inferred from the channel's name. Two
declarations that differ only in credential are two different doors, so a door
has to name the credential it verifies against.

### Webhook.make

```ts
const make: <Payload, Outbound = never>(config: Config<Payload, Outbound>) => Webhook
```

Builds the door. It exposes `name`, `register`, and `ingest`, and no direct
execution method.

When verification fails, `ingest` fails with a `verification_failed`
`TriggerError` whose message is always `webhook <name> did not verify the
request`, whatever the declared `verify` reported. The Control `Unauthorized`
it wrapped is the `cause`. A custom `verify` may say why it refused, but that
reason stays on the host side of the Control boundary.

## test/TestTriggers

### TestTriggers.layer

```ts
const layer: Layer.Layer<TriggerStore.TriggerStore>
```

An in-memory `TriggerStore` with real claim and overlap semantics and no
database. It applies the same claim decision as the SQL store, so it returns the
same refusal codes in the same order, holds the same reservation lease, and
reclaims an expired reservation the same way. Registration validates the
declaration and serializes its input at the call boundary, `list` and
`listEnabled` order by id, and every reading is an independent value.

It holds one process's state, so it never reports a `store` failure from a
write, never shows contention between connections, and applies no migrations.
A test about a schema or a row shape needs `SqlTriggerStore`.

## Failure codes

`TriggerError.code` is stable. Branch on the code instead of parsing the
message.

| Code                      | Raised when                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_trigger`         | A claim, result, pending-state, active-run, or inspect operation requires a trigger row that does not exist. `get` answers `None` instead, and `register` creates the row. |
| `trigger_disabled`        | A claim reads a disabled trigger inside its transaction.                                                                                                                   |
| `stale_owner`             | A result or compensation no longer owns a permissible fire transition.                                                                                                     |
| `revision_mismatch`       | `ClaimFire.expectedRevision` differs from the revision read by the claim transaction.                                                                                      |
| `invalid_schedule`        | `Schedule.make` cannot decode the schedule declaration.                                                                                                                    |
| `invalid_trigger`         | `Trigger.make` cannot decode a trigger, or registration receives input with no JSON representation.                                                                        |
| `invalid_options`         | A cron occurrence limit, a history page limit, or a scheduler interval, deadline, or concurrency violates its contract.                                                    |
| `invalid_cron`            | The Effect cron parser rejects an expression or timezone.                                                                                                                  |
| `unsatisfiable_cron`      | A next, previous, or interval occurrence search exhausts its search bound.                                                                                                 |
| `verification_failed`     | Webhook verification fails, including a signature mismatch or typed credential-resolution failure.                                                                         |
| `catch_up_bound_exceeded` | `maxCatchUp` is invalid, catch-up exceeds its bound, or an unbounded interval exceeds the package cap.                                                                     |
| `runner`                  | The scheduler cannot plan, launch, inspect, cancel, or finish approval retries for a run.                                                                                  |
| `runner_timeout`          | A `Runner.start`, `inspect`, or `cancel` call exceeded `startTimeout`, `inspectTimeout`, or `cancelTimeout`.                                                               |
| `store`                   | A migration, persistence, or row-decoding operation fails, or a no-op store method is unavailable.                                                                         |

`TriggerError.path` optionally identifies the offending declaration or option
as a dotted field path. Schema and option failures set it when they can locate
the field.

`TriggerError` is a `Schema.TaggedError` tagged `flows/triggers/TriggerError`,
carrying `code`, `message`, an optional `path`, and an optional `cause`. Its
`cause` for a decode failure is the rendered issue tree, which names the
expectation and the path only, so a secret submitted in a declaration reaches
neither the message nor the cause.

`TriggerError.fromSchemaError(code, summary, error)` is the constructor behind
those failures. It walks the issue tree for the first offending path, sets
`path` when it finds one, and prefixes `message` with a summary naming what was
being decoded.

For symptom-first guidance, see [Troubleshooting](./troubleshooting.md).

## Claim protocol and watermarks

`ClaimFire.expectedRevision` fences a claim on the declaration used to compute
the occurrence. `ClaimFire` does not carry an overlap policy. The SQL store
reads `overlap`, `enabled`, and `revision` from the trigger row inside the claim
transaction. A stale revision fails with `revision_mismatch`; a disabled row
fails with `trigger_disabled`.

A launch-capable claim writes a reservation before it starts a run.
`TriggerStore.reservationPrefix` is `trigger-reservation:`, and
`TriggerStore.reservationId` appends the trigger ID, optional attempt, and occurrence;
`TriggerStore.reservationOccurrence` reads that occurrence back. The
`TriggerStore.reservationLeaseMs` lease is 300,000 milliseconds, or 5
minutes. Both store implementations reclaim an expired
reservation and restore its unfinished occurrence to pending work, whether the
lease expires during an active-run read or a later claim. A supersede
reservation also retains the predecessor run ID: recovery re-attaches to that
run and cancels it before launching the pending replacement.

`TriggerStore.claimPending` reads the buffered occurrence, applies the same
claim rules as `claimFire`, and clears the buffer only when the decision
consumes it, inside one transaction. A refused claim leaves the buffer intact,
and a concurrent active run that buffers it again keeps it pending. If a
process dies after claiming ordinary or buffered work but before launching it,
expiration of that launch reservation restores the occurrence. After a failed
buffered launch, `restorePending` restores the pointer and releases the matching
reservation in one transaction. Compensation failures are logged and retain the
lease for recovery. Cancellation failures use the same operation to restore a
still-launched predecessor with its pending replacement.

A launched result carries the claim token and a non-empty run id. The store
checks ownership and unfinished fire state in the transaction that publishes
the run. A delayed result cannot overwrite a newer owner or revive a terminal
fire. The scheduler logs `stale_owner` and cancels a losing accepted run unless a retry of that occurrence has adopted it.

The persisted `last_fired_at_ms` watermark only moves forward. A completed
skip or buffer advances it inside the claim transaction; a fire or supersede
reservation does not advance it until the launched run ID is durable. SQL
updates use the greater of the stored value and the completed occurrence. A
late terminal result with no run ID is fenced to the run recorded for its own
occurrence, so it cannot clear a newer active run. The scheduler's in-process
watermark advances only past occurrences that it finished dispatching. It
leaves a failed occurrence available to a later poll.

On its first poll, a newly registered trigger with no prior fire establishes a
watermark at the latest boundary without firing that boundary. It fires from
the next boundary instead of replaying a stale occurrence from before
registration.

The reasoning behind these rules is in
[The claim protocol](./concepts/claim-protocol.md).

## Cron, catch-up, and scheduler limits

`Cron.occurrencesBetween` fails with `catch_up_bound_exceeded` when the caller
omits `limit` and the interval holds more than `Cron.maxOccurrences`, currently
1000. An explicit `limit` silently caps the result and must be a non-negative
safe integer; zero returns no occurrences. `Schedule.maxCatchUpLimit` equals
the same cap, so a schedule cannot declare a larger catch-up bound.

`maxCatchUp` defaults to 0. `CatchUp.occurrences` validates the bound before it
selects `none`, `one`, or `all`, and every policy answers to the bound. In
particular, `one` fails with `catch_up_bound_exceeded` when it owes an
occurrence and `maxCatchUp` is 0.

`Scheduler.Options.pollInterval`, `runPollInterval`, `startTimeout`,
`inspectTimeout`, and `cancelTimeout` must be finite, positive Effect
durations, and `concurrency` must be a positive integer. Invalid values fail
with `invalid_options` and identify the field in `TriggerError.path`.
`Scheduler.parkedAttempts` is 8. If the eighth Control attempt remains parked
awaiting approval, the launch fails with `runner`.

A bound breach logs a warning and abandons the backlog. The current occurrence
is still dispatched subject to overlap, on the first poll after a restart
included. See [Overlap and catch-up](./concepts/policies.md).

## Webhook verification and input ownership

The signature verifier looks up `SignatureConfig.header` in `RawInbound.headers`
first as lowercase and then exactly as written. It encodes the supplied header
value as UTF-8 with `TextEncoder` and compares those bytes with the bytes
returned by `SignatureConfig.expected`. An absent or empty header is refused
before `expected` runs, and an `expected` that answers with zero bytes is
refused after it. Constant-time equality agrees on two empty byte strings, so
without those guards a request carrying no signature at all would authenticate
against a credential that resolved to the empty string.

`Webhook.constantTimeEqual` iterates exactly `expected.length` times. It folds
the length difference into the accumulated result, so unequal lengths fail
without making the caller-controlled length determine the iteration count.

`Webhook.Config.credential` is required. The channel forwards it to
`Channel.Verify` and to `SignatureConfig.expected` on every request. The
`expected` function returns an Effect, so implementations can resolve the
secret through the host resolver per request and report resolver or HMAC
failures as typed `verification_failed` values. The declaration does not need
to capture a secret in a closure.

`Webhook.ingest` snapshots `body`, `headers`, and `idempotencyKey` before any
consumer reads them. The signature verifier receives another copy of `body`.
Verification, delivery fingerprinting, and decoding therefore read one private
snapshot even if the caller or verifier mutates its own bytes. Both copies are
taken with `Uint8Array.from`, never with the input's own `slice`: a Node
`Buffer` is a `Uint8Array` whose `slice` returns a view over the same memory,
so a `Buffer` body is copied the same way as a plain array, an offset view is
copied over its viewed range only, and a `SharedArrayBuffer`-backed view is
copied out of shared memory.

`ingest` does not register a channel. Run the separate `register` effect before
accepting traffic.

## Package boundaries

Migrations are internal. The export map null-maps
`@smthrs/triggers/migrations/*`. Use `SqlTriggerStore.layer`; it applies
`0001_triggers`, `0002_reservation_lease`, `0003_heartbeat`, and
`0004_fire_run_index` in order. The package exports
`@smthrs/triggers/package.json`. It does not export `internal/*` or nested
`*/index` subpaths.
