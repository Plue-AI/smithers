---
title: "API reference"
description: "Every public export of @smthrs/engine-store, grouped by namespace: services, layers, constructors, options, schemas, constants, and the stable error codes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/api.md"
---

The durable `FlowEngine`. It claims a run before driving it, fences every write
against the current owner, and persists attempts, waits, and terminal results
through [`@smthrs/journal`](https://journal.smithers.sh/reference/api/),
[`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), and
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/). It owns the durable deferred and clock
tables and composes every package's migration set.

```ts
import { EngineStore, StepBoundary } from "@smthrs/engine-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a"
})
```

## Entry point

| Import                 | Source                                                                                                             | Platform         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `@smthrs/engine-store` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/index.ts) | Node and browser |

Every namespace below is also importable from `@smthrs/engine-store/<Module>`.
`@smthrs/engine-store/internal/*`, `@smthrs/engine-store/migrations/*`, and
`@smthrs/engine-store/*/index` are blocked in the export map.

Shared versioned event schemas are public at `@smthrs/journal/EngineEvent`; see
[state and event authority](https://journal.smithers.sh/concepts/state-event-authority/).
Engine adapters `TypedEvents`, `AttemptLifecycle`, and `ResultEnvelope` remain
internal. They are additive contracts: current writers retain their bytes, and
the disclosed attempt projection does not replace executable recovery stores.

### Bundling is not running

This entry point bundles for a browser. The two host reads it once made
directly, `process.pid` and `randomUUID` from `node:crypto`, enter through the
injectable [`OwnerIdentity`](#owneridentity) service, and everything it
composes, `@smthrs/crypto`, `@smthrs/flow`, `@smthrs/journal`,
`@smthrs/run-store`, `@smthrs/step-cache`, `@smthrs/database`,
`@smthrs/kernel`, and `@smthrs/engine`, is browser-bundleable too. A release
that broke the bundle would fail the build before it shipped.

The durable stores accept an injected SQL client and `DurableWriter`. Native
Node.js and Bun compositions use SQLite or the shipped PostgreSQL adapter;
`NodeDatabase.layer` selects PostgreSQL for a PostgreSQL URL, and
`@smthrs/database/postgres/PostgresDatabase` supports direct injection. Browser
bundling does not supply a durable browser driver or qualify browser execution.
PostgreSQL storage alone does not qualify a canonical backend deployment:
artifacts, workspaces, and native process state still need durable host storage.
See [database configuration](https://database.smithers.sh/concepts/sqlite-only/)
and [platform support](https://smithers.sh/docs/reference/api/#platform-support).

## EngineStore

[src/EngineStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/EngineStore.ts)

The production durable composition.

`flow.start`, `flow.ensure`, and `execute` with `discard: true` durably admit
an execution and schedule its drive before returning its id. They do not wait
for the child's action, durable wait, or settlement, including when launched
from inside another action. The driver owns the scheduled drive in its engine
scope; ending the caller's action or round does not interrupt it. A discarded
child records `onParentExit: "detach"`, so normal parent completion leaves it
running. Explicit parent cancellation still cascades to linked children.

Observe progress with `poll(id)`, or await the result with
`execute(payload, { executionId: id })`. Callers that need a durable waiting
row or attempt receipt must await that evidence explicitly. Closing the engine
scope releases ownership and retains durable admission and progress for
recovery by a replacement host. The heartbeat sweep recovers pending admissions
through the same coordinator and fenced claim/activate path;
unregistered flows wait for a host that registers them. Pending recovery scans
at most 64 rows per sweep and rotates registered flows. Each scan cycle has a
fixed creation-time/id upper bound, so new admissions cannot postpone retrying
refused work indefinitely. Recovery only selects admissions older than the stale
heartbeat interval, giving a live admitting host time to claim its own work. Storage
failures remain visible and are retried by the heartbeat sweep.

Cancellation is logical-run scoped: `Flow.interrupt(id)` accepts any round ID
and records intent across its trampoline lineage and linked child lineages in
one transaction. Children attached to an earlier parent round remain included;
time-travel fork ancestry alone is not child ownership. Handoff admission checks
cancellation in that same transaction domain, so a successor cannot escape a
request by racing its creation.

The request commits before local interrupt delivery. Returning from `interrupt`
acknowledges intent, not finished user cleanup or a remote owner's settlement.
Owners on other connections observe durable intent through their cancellation
polls. Completed predecessor history remains unchanged. On normal parent exit,
`onParentExit` belongs to the child's creating round and is retained through its
handoffs; explicit cancellation still cascades to linked children.

| Export                  | Signature                                                                                                           | Meaning                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Options`               | interface                                                                                                           | Construction options. See below.                                                                       |
| `make`                  | `(options: Options) => Effect<FlowRuntime["Service"], never, Requirements>`                                         | Builds the `FlowRuntime` service the port in [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) declares.                     |
| `layer`                 | `(options: Options) => Layer<SnapshotBoundary \| FlowRuntime, never, Requirements>`                                 | Provides both, using the ambient `Jj` for action bodies and engine bookkeeping.                        |
| `layerWithPrivilegedJj` | `(options: Options, privilegedJj: Layer<Jj, E, R>) => Layer<SnapshotBoundary \| FlowRuntime, E, Requirements \| R>` | The same, with a private repository for engine bookkeeping while ambient `Jj` stays for action bodies. |

### EngineStore.Options

| Field                  | Type                                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner.hostId`         | `string`                                               | This engine's stable host identity. Which host a store speaks for is a composition decision, not a host fact.                                                                                                                                                                                                                                                                           |
| `journalSource`        | `string`                                               | The source id every record this engine writes carries.                                                                                                                                                                                                                                                                                                                                  |
| `isAlive`              | `Ownership.LivenessCheck` (optional)                   | Liveness arbitration consulted before stealing a run whose lease expired. Answering `true` refuses the takeover. Defaults to `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`.                                                                                                                                                                                                  |
| `canExecute`           | `(row: RunStore.RunRow) => Effect<boolean>` (optional) | Host admission before claiming, including automatic wakes.                                                                                                                                                                                                                                                                                                                              |
| `canActivate`          | `(row: RunStore.RunRow) => Effect<boolean>` (optional) | Read-only admission fence rechecked inside the native activation transaction. Use the same consent and ownership policy as preflight; keep module loading and external I/O in `canExecute`. A refusal abandons the claim without dispatching the body.                                                                                                                                  |
| `clockFireRetryPolicy` | `Schedule<unknown, unknown>` (optional)                | Redispatch policy for a durable clock whose fire failed. Defaults to exponential from 100ms capped at 30s, forever, the same option shape as the engine's `suspendedRetryPolicy`.                                                                                                                                                                                                       |
| `requestResume`        | `(executionId, reason) => Effect<void>` (optional)     | Called for every wake this engine initiates against a PARKED execution: `"deferred"` (a durable deferred completed), `"clock"` (a durable clock fired), `"parent"` (a child settled under a parent parked on it). An operator's own resume is not reported. A host that refuses to re-enter a parked run nobody asked for reads it to tell an engine wake from its own heartbeat sweep. |

### Required services

`Journal`, `DurableWriter`, `RunStore`, `AttemptStore`, `CacheStore`, Effect's `Crypto`,
`DurableEngineState`, kernel `Jj`, `StepBoundary`, `OwnerIdentity`, and a
`Scope`. A composition failure is an unmet `Requirements` type at compile time,
so there is no run-time composition error to handle.

[`WorkspaceSandbox`](#workspacesandbox) and its `EffectDispatcher` are optional
and are resolved at construction, because `actionExecute` runs on the engine's
own fiber, which does not carry the store's layer context. `StepSandbox`,
`WakeBus`, `ArtifactSync`, `CacheSync`, `Inconsistency`, `Reconciliation`,
[`ReplayOnly`](#replayonly), and `Selection` are optional in the same way.

### Behavior

The engine stores a versioned state envelope in each run row, fences run and
attempt ownership, replays encoded exits, and writes engine decisions to the
journal. Cache addresses are the injected `Sha256` transformation of the step
key, not the raw `key1_...` value.

An action's `CachePolicy.ttlMs` records one age-admission decision per run,
step key, and cached provenance. Resuming that decision preserves its verdict
even when the clock crosses the bound in either direction. A conflicting
journal record proves the opposite verdict only when an exact retry of that
opposite record returns `Duplicate`. An incompatible TTL or copied history
with different lineage metadata instead fails with `JournalError` code
`idempotency_conflict`, before output replay, cache eviction, or body dispatch.
Changing TTL before a decision exists remains allowed. Omitting `ttlMs` is
unbounded only before a durable age verdict exists for this run and step.
Removing `ttlMs` after a recorded verdict fails with `idempotency_conflict`,
even if the cache head was evicted or replaced. Recovery must retain the
original TTL and history identity, or use a new action or run identity as
appropriate. No persisted keys or journal producer identities are rewritten.

Durable cancellation is observed, not just recorded: while a run executes, the
driver polls `cancel_requested_at_ms` on the heartbeat cadence and cancels the
run when another process has called `RunStore.requestCancel`. Terminal
transitions are additionally guarded with `{ cancelRequested: "absent" }` inside
the ownership compare-and-swap.

The driver's periodic sweep re-drives durable shapes on the heartbeat
cadence: pending admissions, parked runs whose cancellation was durably requested,
runs parked with reason `released`, and stale `running` rows left by a hard-killed
owner. Each
re-enters the ordinary claim, steal, and activate path. A wake for a flow the
sweeping process has not registered logs a once-per-run structured warning and
leaves the durable waiting row parked.

Every lifecycle journal write, run decisions, attempt started and finished, hard
violations, snapshot identity, cache provenance, deferred completions, clock
schedules, interruption records, and the `Inconsistency` cache-conflict record,
takes the journal's durable channel (`emitDurable`), so a saturated lossy queue
can never drop one. Attempt lifecycle writes additionally pass the owner: a
reclaimed owner fails with `fence_lost` and self-interrupts instead of
appending.

Full model: [Ownership and fencing](/concepts/ownership-and-fencing/) and
[Attempts and replay](/concepts/attempts-and-replay/).

## DurableEngineState

`PendingRunCursor` contains `{ createdAtMs: number; runId: string }`. Pending
queries return rows after `after` and at or before `through`, ordered by those
fields. An optional `eligibleBeforeMs` limits results to older admissions.
`pendingRunTail` captures the upper bound of a recovery scan cycle.
`pendingCancellationRuns` and `pendingCancellationTail` use the same cursors
for explicitly requested cancellations, independent of registered handlers.
Their partial index excludes settled and unrequested admissions; cleanup has
no admission grace and still requires workspace admission and ownership fencing.
`limit` must be zero or a positive safe integer; other values defect with `RangeError`.

[src/DurableEngineState.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/DurableEngineState.ts)

Durable deferreds, clocks, waiting rows, and the run parent DAG. This package
owns deferred and clock state for 1.0. A successful mutation means the row is
durable, so callers may journal and schedule a wake only after the mutation
returns.

Work that needs both this state and the journal opens `transaction` OUTSIDE
`Journal.transact`, never the other way around. The SQL implementation shares
the journal's writer and cannot tell the difference, but `makeMemory` has a
permit of its own, and taking the journal's writer first while waiting for that
permit deadlocks against a fiber doing the opposite.

| Export                           | Signature                                                      | Meaning                                                                       |
| -------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `DurableEngineState`             | `Context.Service<Service>`                                     | Service tag.                                                                  |
| `Service`                        | interface                                                      | The operations below.                                                         |
| `make`                           | `Effect<Service, never, DurableWriter \| SqlClient>`           | The SQL implementation.                                                       |
| `layer`                          | `Layer<DurableEngineState, never, DurableWriter \| SqlClient>` | Provides it.                                                                  |
| `makeMemory`                     | `(options?: MemoryOptions) => Service`                         | Deterministic in-memory implementation.                                       |
| `layerMemory`                    | `Layer<DurableEngineState>`                                    | Provides it.                                                                  |
| `MemoryOptions`, `MemoryRunView` | interfaces                                                     | Optional `runs` lookup so the memory twin enforces the same ownership fences. |

### Service members

| Member                    | Signature                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deferred`                | `(address: DeferredAddress) => Effect<Option<DeferredRow>>`                                                                                                      |
| `consumeDeferred`         | `(address: DeferredAddress, consumedAtMs: number) => Effect<void>`                                                                                               |
| `completeDeferred`        | `(row: DeferredRow) => Effect<CompleteDeferredOutcome>`                                                                                                          |
| `clock`                   | `(address: ClockAddress) => Effect<Option<ClockRow>>`                                                                                                            |
| `scheduleClock`           | `(row: ClockRow, owner: OwnerId) => Effect<ScheduleClockOutcome>`                                                                                                |
| `completeClock`           | `(address: ClockAddress, completedAtMs: number) => Effect<CompleteClockOutcome>`                                                                                 |
| `dueClocks`               | `(nowMs: number) => Effect<ReadonlyArray<ClockRow>>`                                                                                                             |
| `completeRunClocks`       | `(executionId: string, completedAtMs: number) => Effect<void>`                                                                                                   |
| `pendingClocks`           | `(scope: { executionId?: string; flowName?: string }) => Effect<ReadonlyArray<ClockRow>>`                                                                        |
| `completedDeferreds`      | `(flowName: string) => Effect<ReadonlyArray<DeferredAddress>>`                                                                                                   |
| `park`                    | `(runId: string, waiting: Waiting, owner: OwnerId) => Effect<ParkOutcome>`                                                                                       |
| `wake`                    | `(runId: string) => Effect<WakeOutcome>`                                                                                                                         |
| `waiting`                 | `(runId: string) => Effect<Option<WaitingRow>>`                                                                                                                  |
| `waitingRuns`             | `(filter?: WaitingRunsFilter) => Effect<ReadonlyArray<WaitingRow>>`                                                                                              |
| `waitingTree`             | `(runId: string, options?: WaitingTreeOptions) => Effect<ReadonlyArray<WaitingRow>>`                                                                             |
| `pendingRuns`             | `(flowName: string, limit?: number, after?: PendingRunCursor, through?: PendingRunCursor, eligibleBeforeMs?: number) => Effect<ReadonlyArray<PendingRunCursor>>` |
| `pendingRunTail`          | `(flowName: string, eligibleBeforeMs?: number) => Effect<Option<PendingRunCursor>>`                                                                              |
| `pendingCancellationRuns` | `(limit: number, after?: PendingRunCursor, through?: PendingRunCursor) => Effect<ReadonlyArray<PendingRunCursor>>`                                               |
| `pendingCancellationTail` | `() => Effect<Option<PendingRunCursor>>`                                                                                                                         |
| `staleRunningRuns`        | `(staleBeforeMs: number, limit?: number) => Effect<ReadonlyArray<StaleRunningRow>>`                                                                              |
| `attemptSurvivors`        | `((runId: string, stepKeyDigest: string) => Effect<Option<AttemptSurvivors>>)` (optional)                                                                        |
| `recordRunParent`         | `(childId: string, parentId: string) => Effect<RecordRunParentOutcome, RunParentCycleError>`                                                                     |
| `removeRunParentsForRun`  | `(runId: string) => Effect<void>`                                                                                                                                |
| `runParents`              | `(childId: string) => Effect<ReadonlyArray<RunParentEdge>>`                                                                                                      |
| `runChildren`             | `(parentId: string) => Effect<ReadonlyArray<RunParentEdge>>`                                                                                                     |
| `transaction`             | `<A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>`                                                                                                          |

`scheduleClock` requires the execution's ownership token. Creation succeeds
only while the run is running under that owner. An existing clock wins unchanged,
even after ownership is lost. If no clock exists and the ownership fence fails,
the effect self-interrupts.

`recordRunParent` allocates `MAX(seq) + 1` in the serialized write transaction.
Migration 0007 indexes `seq` so allocation does not scan retained parent history.

`completeRunClocks` closes every uncompleted clock row of one run in a single
statement, which a terminal transition does in its own transaction.
`pendingClocks` and `completedDeferreds` never list a row whose run has settled,
so a registration sweep re-arms timers and replays completions for runs that can
still make progress and for no others. `completedDeferreds` also excludes
completions marked observed by `consumeDeferred`. The engine marks a completion
before `deferredResult` serves it; `deferred` remains a read-only lookup and keeps
returning the original result for replay. Duplicate completion writes do not
clear the marker. Migration 0008 leaves existing completions unconsumed until
the upgraded engine first serves them.

`attemptSurvivors` is optional because
only storage that can range-scan `flows_attempts` implements it; when absent the
engine falls back to per-attempt point reads against `AttemptStore`.

Every list read (`dueClocks`, `pendingClocks`, `completedDeferreds`,
`waitingRuns`, `runParents`, and `runChildren`) skips a row that will not decode
and logs a storage-integrity warning naming its primary key, so one corrupt row
costs its own row and nothing else. The point reads `deferred`, `clock`, and
`waiting` still die on such a row: reporting "no row" for a completion or
deadline that is durably recorded but unreadable would re-run work whose side
effects already ran.

`recordRunParent` performs its cycle check inside the same write transaction as
the insert, so a rejected edge leaves no durable trace and, of two concurrent
writers whose edges jointly close a cycle, exactly one fails. `transaction`
makes several store operations atomic; nested store writes become savepoints.
Serialized write transactions are a documented requirement of the
`DurableWriter.write` contract, not a SQLite artifact. The shipped PostgreSQL
adapter uses READ COMMITTED transactions with a transaction-scoped advisory lock
keyed by schema, acquired before domain reads to serialize writes across pools
and processes; nested writes use savepoints. A bare PostgreSQL READ COMMITTED
client without equivalent serialization is insufficient. The in-memory twin
serializes every store operation behind one permit, snapshots its state on
entry, rolls back to that snapshot when the effect fails or dies, and treats a
nested call on the same fiber as a savepoint. It is not durable: a process crash loses the whole
in-memory state, not only the uncommitted part.

When engine state and the journal participate together, `StateTransaction`
takes the engine-state boundary first and the journal writer inside it. Native
lifecycle admission, direct cancellation, deferred completion and clock
scheduling share this order. A refused park or owner transition rolls both
stores back, including a preexisting memory waiting marker. The memory commit
callback releases its gate at SQL commit, before post-commit subscribers or
compaction capture can read it. Failure after publication starts cannot undo
committed state.

`ExecutionFacts` captures the semantic native lifecycle inside the same write.
Its additive `treeVersion: 1` metadata includes parent attachment policy and a
redacted waiting question plus its named point. Opaque wake tokens remain in
the operational waiting row; the fact carries only their digest. The native
fact fold derives attached descendant human waits and compares them with a
coherent executor observation. Old v1 facts without the tree extension retain
legacy tree-wait provenance. Raw waiting request JSON is available through the
protected execution snapshot reader, independently of its redacted event view.

### Addresses, rows, and outcomes

| Export                    | Shape                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `DeferredAddress`         | `{ flowName, executionId, deferredName }`                                                            |
| `DeferredRow`             | the address plus `exit: unknown` and optional `metadata`                                             |
| `ClockAddress`            | `{ flowName, executionId, clockName }`                                                               |
| `ClockRow`                | the address plus `deferredName`, an absolute due time, and `completedAtMs: number \| null`           |
| `Waiting`                 | `{ reason, wakeAt?, token?, request?: string }`                                                      |
| `WaitingRow`              | `{ runId, reason, wakeAt: number \| null, token: string \| null, request?: Json }`                   |
| `StaleRunningRow`         | `{ runId, heartbeatAtMs }`: a stale `running` row and the lease heartbeat it froze on                |
| `WaitingReason`           | a non-empty string; the open taxonomy the driver writes (`timer`, `event`, `released`, `quarantine`) |
| `WaitingRunsFilter`       | `{ reason?, dueBeforeMs?, cancelRequested? }`                                                        |
| `RunParentEdge`           | `{ childId, parentId, seq }`, where `seq` is ordering only                                           |
| `AttemptSurvivors`        | `{ earliestAttempt, earliestStartedAtMs, latest }`                                                   |
| `CompleteDeferredOutcome` | `Completed` or `Existing`                                                                            |
| `ScheduleClockOutcome`    | `Scheduled` or `Existing`                                                                            |
| `CompleteClockOutcome`    | `Completed`, `AlreadyCompleted`, or `NotFound`                                                       |
| `ParkOutcome`             | `Parked` or `NotFound`                                                                               |
| `WakeOutcome`             | `Woken`, `NotWaiting`, or `NotFound`                                                                 |
| `RecordRunParentOutcome`  | `Recorded` or `Existing`                                                                             |
| `RunParentCycleError`     | tagged error carrying `path`, the execution ids from the child back to itself                        |

Both implementations answer one behavior contract, so a test written against
the memory twin holds for the SQL one. See
[Test against a durable store](/guides/testing/).

Full model: [Durable waits](/concepts/durable-waits/).

### EngineStateFault

`DurableEngineState.EngineStateFault` is a tagged defect with optional `field`
and `cause`. JSON encoding and decoding failures use `value_not_serializable`
and `value_not_decodable`; `field` identifies the value or column.
`deferred_completion_missing` and `run_parent_edge_missing` identify missing
first-writer transaction rows. The tag is
`@smthrs/engine-store/EngineStateFault`; these remain defects, not recoverable
failures in the service error channel.

## StepBoundary

[src/StepBoundary.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/StepBoundary.ts)

The declared read and write sets of a step, measured before and after it runs.
The declaration itself, `FileBoundary` with `readSet`, `writeSet`, `removes`,
and `boundaryMode` of `hard` or `expected`, lives in
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s `Action` namespace.

```ts
interface Service {
  readonly prepare: (descriptor: FileBoundary) => Effect<PreparedBoundary, UnsupportedBoundary, Crypto>
  readonly settle: (prepared: PreparedBoundary) => Effect<
    BoundaryEvidence,
    UndeclaredWrite | MissingDeclaredOutput | SurvivingDeclaredRemoval | UnsupportedBoundary | BoundaryCorruption,
    Crypto
  >
  readonly replayOutputs: (evidence: BoundaryEvidence) => Effect<
    void,
    UnsupportedBoundary | BoundaryCorruption | MissingArtifact,
    Crypto
  >
}
```

| Export              | Signature                                                                                                | Meaning                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `StepBoundary`      | `Context.Service<Service>`                                                                               | Service tag.                                                                                                                  |
| `make`              | `(service: Service) => Service`                                                                          | Brands an implementation, so a wrong shape is reported where it is written.                                                   |
| `makeFileSystem`    | `(fs: FileSystem, path: Path, artifacts: ArtifactStore.Service, options?: FileSystemOptions) => Service` | The production boundary.                                                                                                      |
| `layer`             | `Layer<Service, never, FileSystem \| Path \| ArtifactStore>`                                             | Provides it, confining replay to the kernel `Workspace` root when one is in context. Resolves that root with the host `Path`. |
| `layerTest`         | `(options?: TestOptions) => Layer<Service>`                                                              | Deterministic in-memory boundary.                                                                                             |
| `exactReads`        | `(descriptor: FileBoundary) => ReadonlyArray<FileInput>`                                                 | Exact read inputs, ignoring declarations that still need expansion.                                                           |
| `readSetMatches`    | `(prepared: PreparedBoundary) => boolean`                                                                | Whether the measured snapshot still matches the declaration.                                                                  |
| `referencedDigests` | `(evidence: BoundaryEvidence) => ReadonlyArray<ArtifactStore.Digest>`                                    | The digests the evidence references rather than inlines. Evidence from a foreign implementation yields the empty list.        |

### Schemas

| Export                      | Shape                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreparedBoundary`          | `{ descriptor, readSnapshot }`. The snapshot is what the host actually measured, and is the evidence the declared digests still describe reality. |
| `BoundaryEvidence`          | `{ declaredOutputs, diffIdentity, wholeTreeWritesVerified?, hermeticReadsVerified?, deviation? }`                                                 |
| `ExpectedSetDeviation`      | `{ paths, diffIdentity }`, writes outside the declared write set                                                                                  |
| `MissingOutputDeviation`    | `{ paths, diffIdentity }`, declared writes never produced                                                                                         |
| `SurvivingRemovalDeviation` | `{ paths, diffIdentity }`, declared removals left in place                                                                                        |
| `BoundaryDeviation`         | the union of the three                                                                                                                            |

### FileSystemOptions

| Field                 | Default | Meaning                                                                                                                      |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `maxInlineBytes`      | 1 MiB   | The largest single output inlined into the evidence. Anything larger is stored by digest reference.                          |
| `maxTotalInlineBytes` | 8 MiB   | The largest aggregate inline payload one settle may fold in. Past it, an output is spilled even though it individually fits. |
| `root`                | cwd     | The root replay confines writes and removals to. A filesystem already confined to a root keeps its own.                      |

`replayOutputs` writes and deletes what the evidence names, so it confines its
own mutations instead of trusting the composition. Every write, removal, probe,
and tree prune goes through `@smthrs/kernel/FileSystem`'s `confined` view:
one descriptor-relative, no-follow request per call against the pinned root. A
symlink on a replayed path (a parent, the final component, or a member of a
replayed tree) refuses with `UnsupportedBoundary`, and so does a host with no
descriptor-relative executor or isolation attestation, before any host call.
`prepare` and `settle` only read and keep the caller's filesystem.

### TestOptions

`failure`, `deviation`, `readSnapshot`,
`declaredOutputs`, `diffIdentity`, `supported`, `wholeTreeWriteDetection`,
`hermeticReadDetection`, and `onReplay`. Defaults describe a well-behaved,
fully-supported host. Failures and deviations are returned verbatim; use the real
filesystem layer to test classification. `wholeTreeWriteDetection` defaults to `true`, which is a
fixture claim rather than a proof: the real whole-tree observation comes from
[`WorkspaceSandbox`](#workspacesandbox).

### Errors

| Error                      | `code`                       | Fields                                     |
| -------------------------- | ---------------------------- | ------------------------------------------ |
| `UndeclaredWrite`          | `undeclared_write`           | `paths`, `diffIdentity`                    |
| `MissingDeclaredOutput`    | `missing_declared_output`    | `paths`, `diffIdentity`                    |
| `SurvivingDeclaredRemoval` | `surviving_declared_removal` | `paths`, `diffIdentity`                    |
| `UnsupportedBoundary`      | `unsupported_boundary`       | `message`, optional `cause` carried whole  |
| `BoundaryCorruption`       | `boundary_corruption`        | `path`, `recordedDigest`, `measuredDigest` |
| `MissingArtifact`          | `missing_artifact`           | `path`, `digest`                           |

Full model: [Step boundaries](/concepts/step-boundaries/).

## StepSandbox

[src/StepSandbox.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/StepSandbox.ts)

Scope-safe acquisition of one isolated workspace per step.

| Export           | Signature                                                                          | Meaning                                                                  |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `StepSandbox`    | `Context.Service<Service>`                                                         | Service tag.                                                             |
| `Service`        | `{ open: Effect<WorkspaceSandbox.Service, UnsupportedBoundary> }`                  | Acquires the workspace.                                                  |
| `make`           | `(workspace: WorkspaceSandbox.Service) => Service`                                 | Wraps a transaction backend.                                             |
| `layer`          | `Layer<Service, WorkspaceError, FileSystem \| Path \| ArtifactStore \| Workspace>` | The filesystem-backed sandbox. Refuses a path-based host at build.       |
| `layerTest`      | `(initialFiles?: InitialFiles) => Layer<Service, WorkspaceError, Crypto>`          | Deterministic in-memory sandbox.                                         |
| `layerNoop`      | `Layer<Service>`                                                                   | Fails closed with `UnsupportedBoundary`, for a host that cannot sandbox. |
| `UndeclaredRead` | tagged error, `code: "undeclared_read"`, fields `paths` and `diffIdentity`         | A hermetic body read outside its declared read set.                      |

## WorkspaceSandbox

[src/WorkspaceSandbox.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/WorkspaceSandbox.ts)

The functional workspace transaction: a sealed action's body runs in an isolated
workspace and returns its writes rather than performing them.

```ts
interface Service {
  readonly execute: <Output, Error>(
    execution: Execution<Output, Error>
  ) => Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto>
  readonly materialize: <Output>(
    accepted: Accepted<Output>
  ) => Effect<void, MaterializationConflict | WorkspaceError, Crypto>
}
```

`materialize` checks digests and retained bytes before changing files. Every
copy-back host call is one descriptor-relative, no-follow request against the
root pinned for that commit (`@smthrs/kernel/FileSystem`'s `confined`), so a
symlink on a change's path, including one swapped in mid-commit, fails with
`path_escapes_workspace` and is never followed. The host must carry the
kernel's atomic executor (`@smthrs/platform-node`'s `AtomicFileSystem`), an
isolation attestation, or be the kernel-guarded filesystem for the same root. The filesystem host serializes cooperating commits through preflight,
apply, and rollback, using a workspace-root semaphore and the
`.smithers-workspace-lock` lease file (`@smthrs/artifacts/FileLease`: heartbeat
every 10 seconds, stale after 60 seconds, acquisition deadline 2 minutes). The
lock and its children are reserved, as are the `.flows` engine state directory
and every `reservedPaths` entry, under any write set or boundary mode. A change
that targets or lies beneath a reserved path fails with `host_unavailable`.
Reserved names match after Unicode NFKC normalization and case folding, so
`.FLOWS` or `.ﬂows`, which open `.flows` on default APFS and NTFS volumes, are
refused on every volume. An NTFS 8.3 short-name shape, such as `FLOWS~1`, is
refused wherever a reserved segment stands, because an NTFS volume with short
names on opens the long name through it, including from WSL or SMB.
Hosts must support exclusive `wx` file creation, `stat` with an mtime,
`utimes`, `rename`, and `remove`; writers that ignore the lock are outside this
guarantee.

Rollback uses in-memory file pre-images. Copy-back is not crash-atomic, and
rollback can fail. A compound cause preserves the apply failure plus a
`WorkspaceError` (`host_unavailable`) carrying the rollback cause. The caller
must reconcile host files after a crash or failed rollback before resuming.
A crashed holder's lock is reclaimed once its heartbeat is 60 seconds old. A
commit that cannot take the lock within 2 minutes fails with
`commit_lock_timeout` and changes nothing. Lock waits are interruptible.

| Export                      | Signature                                                                                                                          | Meaning                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceSandbox`          | `Context.Service<Service>`                                                                                                         | Service tag.                                                                                                                                          |
| `make`                      | `(service: Service) => Service`                                                                                                    | Brands an implementation.                                                                                                                             |
| `layer`                     | `(service: Service) => Layer<Service>`                                                                                             | Provides one.                                                                                                                                         |
| `makeHosted`                | `(host: Host) => Service`                                                                                                          | The transaction itself, over a `Host`.                                                                                                                |
| `makeMemory`                | `(initialFiles?: InitialFiles) => Effect<MemorySandbox, WorkspaceError, Crypto>`                                                   | Deterministic, browser-safe, and the conformance implementation. Seeds the whole tree, so an undeclared read is observable.                           |
| `makeFileSystem`            | `(fs: FileSystem, path: Path, artifacts: ArtifactStore.Service, workspaceRoot: string, options?: FileSystemOptions) => Service`    | The production host.                                                                                                                                  |
| `layerFileSystem`           | `(options?: FileSystemOptions) => Layer<Service, WorkspaceError, FileSystem \| Path \| ArtifactStore \| Workspace>`                | Provides it, taking the root from the kernel `Workspace` and resolving it with the host `Path`. Fails with `host_unavailable` over a path-based host. |
| `Workspace`                 | `Context.Service<Workspace>`                                                                                                       | The in-transaction filesystem and effect outbox, available only inside `execute`.                                                                     |
| `EffectDispatcher`          | `Context.Service<Dispatcher>`                                                                                                      | The post-copy-back dispatch stage. Optional.                                                                                                          |
| `layerDispatcher`           | `(dispatcher: Dispatcher) => Layer<Dispatcher>`                                                                                    | Provides one.                                                                                                                                         |
| `violations`                | `(descriptor: FileBoundary, base: ReadonlyMap<string, Uint8Array>, provenance: Provenance) => ReadonlyArray<DeclarationViolation>` | Everything the declaration failed to predict, deduplicated.                                                                                           |
| `isMaterializationConflict` | `(error: unknown) => boolean`                                                                                                      | Recognizes both the live class and the persisted schema form.                                                                                         |

### Models

| Export                     | Shape                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Resource`                 | `{ kind, id }`. This implementation records `kind: "file"`.                                                                                                                                                                                    |
| `InputObservation`         | `{ resource, digest }`                                                                                                                                                                                                                         |
| `OutputObservation`        | `{ resource, operation: "write" \| "remove", digest }`                                                                                                                                                                                         |
| `Provenance`               | `{ baseRevision, inputs, outputs }`                                                                                                                                                                                                            |
| `FileChange`               | `{ path, beforeDigest, afterDigest, after? }`. `beforeDigest` is a materialization precondition, not a hint.                                                                                                                                   |
| `QueuedEffect`             | `{ protocol, idempotencyKey, payload }`                                                                                                                                                                                                        |
| `WorkflowResult<Output>`   | `{ output, files, provenance, effects }`                                                                                                                                                                                                       |
| `Execution<Output, Error>` | `{ descriptor, cacheKey?, workflow }`                                                                                                                                                                                                          |
| `DeclarationViolation`     | `{ kind: "undeclared-read" \| "undeclared-write", resource }`                                                                                                                                                                                  |
| `CacheOutcome`             | `disabled`, `miss`, or `hit`. A run-local memo, not the cross-run cache.                                                                                                                                                                       |
| `Accepted<Output>`         | `{ _tag: "Accepted", result, cache, violations }`                                                                                                                                                                                              |
| `Invalidated`              | `{ _tag: "Invalidated", provenance, violations }`. No accessor for the candidate output, files, or queued effects.                                                                                                                             |
| `ExecutionResult<Output>`  | `Accepted<Output> \| Invalidated`                                                                                                                                                                                                              |
| `Host`                     | `{ snapshot, baseline, retain, commit, root }`                                                                                                                                                                                                 |
| `MemorySandbox`            | `{ service, files }`, where `files` observes host state, changed only by `materialize`                                                                                                                                                         |
| `HostFile`                 | `{ path, content }`                                                                                                                                                                                                                            |
| `InitialFiles`             | `Readonly<Record<string, string \| Uint8Array>>`                                                                                                                                                                                               |
| `FileSystemOptions`        | `{ maxInlineBytes?, reservedPaths? }`. `maxInlineBytes` defaults to 1 MiB, matching `StepBoundary`'s evidence bound. `reservedPaths` lists root-relative engine state paths copy-back refuses, beyond `.smithers-workspace-lock` and `.flows`. |

### Errors

| Error                     | Fields                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceError`          | `code` of `invalid_path`, `not_found`, `host_unavailable`, `path_escapes_workspace`, or `commit_lock_timeout`; `message`; optional `cause` carried whole |
| `MaterializationConflict` | `paths` (at most 1,024, each at most 4,096 characters) and `message`                                                                                     |

It is a deterministic transaction model, not a security boundary. A body
reaching the host through a service the transaction does not seed is outside it;
denying that ambient access is the VM and `SandboxProvider` story in
[`@smthrs/sandbox`](https://sandbox.smithers.sh/reference/api/). The human diff-review gate is not implemented
and a settled bundle is applied without it, a known limitation of this release,
and the transaction's `FileSystem` surface is deliberately partial.

Full model: [Workspace transactions](/concepts/workspace-transactions/).

## PlanScheduler

Every declared effect tier is schedulable. Sealed dispatches retain their
content-derived keys and cache-admission requirements. Compensable and
irreversible dispatches use run-local plan/node/declaration scopes, retain
their tier in attempt metadata, and never publish shared-cache results. A
`clean` settlement means no executor ran: it includes both same-run durable
replay and eligible shared-cache hits. Compensable retries restore the supplied
snapshot; the generic executor has no irreversible idempotency contract and
therefore refuses uncertain recovery or retry of those effects. Irreversible
conflicts fail without automatic rebase or merge elaboration.

[src/PlanScheduler.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/PlanScheduler.ts)

Drives a persisted [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) plan to completion.

```ts
interface Service {
  readonly record: (plan: Plan) => Effect<PlanStore.RecordResult, SchedulerError, PlanStore | Journal | Crypto>
  readonly append: (plan: Plan) => Effect<void, SchedulerError, PlanStore | Journal | Crypto>
  readonly run: (plan: Plan) => Effect<Report, SchedulerError, Requirements>
}
```

| Export          | Signature                                                                    | Meaning                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlanScheduler` | `Context.Service<Service>`                                                   | Service tag.                                                                                                                                                      |
| `make`          | `(options: Options) => Service`                                              | Builds a scheduler bound to one run.                                                                                                                              |
| `layer`         | `(options: Options) => Layer<PlanScheduler>`                                 | Provides it.                                                                                                                                                      |
| `NodeExecutor`  | `Context.Service<Executor>`                                                  | The DI seam that turns a node into work.                                                                                                                          |
| `layerExecutor` | `(executor: Executor) => Layer<NodeExecutor>`                                | Provides one.                                                                                                                                                     |
| `recertify`     | `(input: { plan, deferringRunId, options }) => Effect<RecertifyResult, ...>` | Re-drives a plan guess-free under a fresh run, then reports remaining debt.                                                                                       |
| `Requirements`  | type                                                                         | `AttemptStore`, `CacheStore`, `Crypto`, `Jj`, `Journal`, `NodeExecutor`, `PlanStore`, `PlanInputStore`, `PlanMergeStore`, `RunStore`, and `StepBoundary.Service`. |

### Options

| Field                | Meaning                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`              | The run this scheduler drives.                                                                                                                                                   |
| `owner`              | The `OwnerId` its writes are fenced with.                                                                                                                                        |
| `sourceId`           | The journal source id.                                                                                                                                                           |
| `environment`        | Runtime identity copied at construction and bound durably before dispatch; changing it requires a new run. Omission preserves action keys but is a distinct environment binding. |
| `concurrency.steps`  | Caps leaf execution. Defaults to unbounded; zero is refused.                                                                                                                     |
| `concurrency.agents` | Caps the agent subset within it. Same defaults.                                                                                                                                  |
| `rebaseLimit`        | How many times a `delay-rebase` node may re-measure and re-key before reconciliation is asked.                                                                                   |
| `selection.changed`  | Changed paths the belief edges are matched against.                                                                                                                              |
| `selection.beliefs`  | The `BeliefSnapshot` pinned before planning.                                                                                                                                     |
| `selection.policy`   | Deferral policy; `deferBelow` defaults to zero, which defers nothing.                                                                                                            |
| `selection.full`     | Treat every verdict as `Admit`, journaled.                                                                                                                                       |

Both concurrency caps must be positive safe integers and `rebaseLimit` a
non-negative one; invalid bounds are rejected at construction.

### Models

| Export            | Shape                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `Outcome`         | `built`, `clean`, `failed`, `skipped`, or `deferred`                                                          |
| `ResolvedInput`   | `{ from, path, value }`, the settled output of `from` projected along `path`                                  |
| `NodeInput`       | `{ node, attempt, boundary, inputs }`                                                                         |
| `Executor`        | `{ execute: (input: NodeInput) => Effect<unknown, unknown> }`                                                 |
| `Settlement`      | `{ nodeId, planKey, dispatchKey, outcome, attempts, rebases }`                                                |
| `Report`          | `{ planId, digest, settlements, results, verdicts, appended }`                                                |
| `RecertifyResult` | `{ runId, report, remaining }`                                                                                |
| `SchedulerError`  | `code` of `invalid_plan`, `boundary_unavailable`, `key_uncomputable`, `elaboration_failed`, or `store_failed` |

Ready nodes dispatch through the same persistence path every action uses, so
the shared step cache,
[`WorkspaceSandbox`](#workspacesandbox)'s execute-then-materialize transaction,
attempt rows, and the fenced journal all apply unchanged. A sealed dispatch key
folds the node's own declaration, measured file digests and projected material
inputs. It does not fold upstream plan keys, so unchanged consumed content can
reuse a result even when an upstream declaration changed.

Skyframe's `AbstractParallelEvaluator` is the prior art. A private, rebuildable
`RuntimeGraph` maintains forward/reverse adjacency, dependency counts and ready
frontiers. Reverse indexes propagate settled outcomes and readiness only;
content addressing still governs reuse, with no cache-invalidation visitor.
The coordinator reconciles each completion before admitting dependents, while
unrelated work can remain in flight. Retry/rebase attempts are not additional
node settlements. Appended indexes become visible after durable admission.

The existing scheduling policy ranks the current ready frontier by priority
plus capacity-constrained admission passes waited, with exact arithmetic and
compiled plan order for ties. It retains independent step and agent caps.
Readiness no longer scans the entire plan after each settlement; admission
still considers and re-ranks all ready candidates to preserve aging.

Read versions are relative to each reader's predecessors. A path with no
preceding writer is a source input, even when that reader or a later node writes
it. Source paths and source-glob membership are pinned before the first dispatch
(new generations are observed at append time); preceding producers' outputs are
measured after settlement. Later writers do not widen a read glob's membership.
A rebase re-observes preceding outputs, not source inputs.

`PlanInputStore` records those observations before dispatch and restores them on
reopen, without re-enumerating source globs or measuring source files again.
Each run binds one plan ID and approved base digest; a different approved
graph or plan ID needs a new run. New runs observe the current world independently and may
reuse eligible shared-cache results. These rules do not freeze external state
or replace boundary enforcement when an unfinished action actually executes.

`Options.environment` is copied at scheduler construction and bound durably
before source observation or dispatch. Recovery requires the same normalized
identity for all compiled effect tiers. Layer order and duplicates matter;
capability-pattern order and duplicates do not. Omission, declared-empty, and
undeclared/run-scoped identities are distinct. A changed environment returns
`store_failed` with a typed input/merge-store cause of `incompatible_state`, without
executing or replacing the old binding. Recover with the original environment,
or explicitly reconcile unfinished effects before starting a new run. This
checks supplied identities, not undeclared changes in implementation behavior.

Ready work is ordered by declared
`priority` plus one point per round waited, so priority changes latency without
permitting starvation.

Full guide: [Drive a plan to completion](/guides/drive-a-plan/).

`stop-merge` records its stopped-attempt decision in `PlanMergeStore`. Recovery
preserves `skipped` without repeating that attempt, and commits each generated
merge with its plan extension, source observations, and durable append event.
Generated IDs avoid occupied user names. `skipped` does not mean no executor
ever ran: stopped attempts retain their attempt count. `Report.appended` lists
new appends by this invocation, not merges recovered from prior invocations.

## PlanMergeStore

Authoritative scheduler decisions, separate from action failure evidence and
redacted journal projections. Compose `layer` over the same `SqlClient` and
`DurableWriter` as `PlanInputStore`, `PlanStore`, and `Journal`, with `Crypto`;
run migrations first. `TestStores.layer` and `layerAt` include it.

| Export                                          | Contract                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Identity`                                      | `{ runId, planId, baseDigest, environmentDigest }`.                                                                              |
| `Intent`                                        | Version 1; stopped node/key, dispatch key, attempts/rebases, and exact eligible peers.                                           |
| `Completion`                                    | Version 1; appended generation, parent/result digests, merge ID/key, and winning peers.                                          |
| `Decision`                                      | Intent and optional committed completion.                                                                                        |
| `list(identity, owner)`                         | Committed decisions; refuses enclosing SQL transactions.                                                                         |
| `intend(identity, intent, owner)`               | First writer wins; joins an outer transaction when provided. Await its commit before exposing the stopped decision.              |
| `complete(identity, nodeId, completion, owner)` | Requires the caller's plan/input append transaction. Repeated identical completion converges; a different completion is refused. |
| `make`, `layer`, `PlanMergeStore`               | SQL constructor, layer, and service tag.                                                                                         |
| `maximumDecisionCharacters`                     | 16 Mi JavaScript string code units per encoded decision.                                                                         |

All operations check current ownership, cancellation, and the admitted plan and
environment. Rows are versioned, checksummed, immutable, and retained until run
collection; checksums detect corruption, not malicious database writes. The
scheduler additionally reconstructs approved generation digests and validates
stopped-node policy before dispatch. It can recover recorded merge-only
extensions from the original base, but requires supplied approved intervening
manual generations rather than inventing missing work.

`PlanMergeError.code` distinguishes `invalid_input`, `corrupt_state`,
`incompatible_state`, `fence_lost`, `transaction_open`, `transaction_required`,
and `persistence_failed`. The scheduler interrupts on fence loss and otherwise
reports `SchedulerError` with `store_failed` and the typed cause. Migration
`3005` leaves existing observation heads' merge-state version unknown and
refuses recovery under this runtime. Finish on the prior runtime or reconcile
unfinished effects before starting a new run; never infer authority from
merge-like names/bodies or backfill an unknown version by guessing.

## PlanInputStore

Authoritative, append-only source observations for compiled plan execution.
Compose `PlanInputStore.layer` over the **same** `SqlClient` and `DurableWriter`
as the run, attempt, plan, and journal stores, with `Crypto`. The layer does not
run migrations. `TestStores.layer` and `layerAt` include it.

| Export                             | Contract                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Address`                          | `{ runId, planId, baseDigest, environmentDigest, generation }`; derive the environment digest with `StepKey.environmentIdentity(environment)`.                   |
| `Snapshot`                         | Version 1; generation; node IDs/keys and each read declaration's frozen source paths; newly pinned `{ path, digest }` entries.                                   |
| `get(address, owner)`              | Returns the recorded snapshot or `None` for the next generation. Refuses enclosing SQL transactions so execution cannot consume speculative state.               |
| `record(address, snapshot, owner)` | First-writer-wins; returns the winning snapshot. Consecutive generations only. Can join a transaction, whose outer commit the caller must await before dispatch. |
| `make`, `layer`, `PlanInputStore`  | SQL constructor, layer, and service tag. No memory/cache fallback.                                                                                               |
| `maximumSnapshotCharacters`        | 16 Mi JavaScript string code units per encoded generation, checked before persisted JSON is decoded.                                                             |

Reads and writes validate ownership and absent cancellation within the owning
write transaction. Snapshot rows are checksummed, versioned, schema-validated,
and immutable; the scheduler additionally checks node declarations, file-version
selection, and pin consistency before using them. Checksums detect corruption,
not unauthorized database modification. Rows are retained until their owning
run is collected; they are not subject to cache eviction or journal redaction.

`PlanInputError.code` distinguishes `invalid_input`, `corrupt_state`,
`incompatible_state`, `fence_lost`, `transaction_open`, and `persistence_failed`.
The scheduler self-interrupts on fence loss and otherwise exposes the typed
cause through `SchedulerError` with `store_failed`.

Migration `engine-store/0003_plan_inputs` marks runs that already had attempts
before durable observations existed. Such runs cannot safely enter the new
compiled scheduler: their original sources may have been overwritten. Finish
them on the previous runtime before upgrading, or make an explicit operator
recovery decision and start new work under a new run ID. Do not delete the
legacy marker or retry an uncertain irreversible effect blindly.

Migration `engine-store/0004_plan_environment` adds the environment binding.
Existing observation heads keep an unknown (`NULL`) environment and are refused;
the migration never guesses from the current process. New heads require a
non-empty, immutable fingerprint. Earlier snapshots and attempts remain intact.

## Reconciliation

[src/Reconciliation.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Reconciliation.ts)

The pluggable seam for when the world disagrees with the declaration. It is the
first consumer `flows.engine.expected-set-deviation` has had.

```ts
interface Service {
  readonly onDeviation: (deviation: Deviation) => Effect<Verdict>
  readonly onConflict: (conflict: Conflict) => Effect<Verdict>
}
```

| Export                  | Signature                                     | Meaning                             |
| ----------------------- | --------------------------------------------- | ----------------------------------- |
| `Reconciliation`        | `Context.Service<Service>`                    | Service tag.                        |
| `make`                  | `(service: Service) => Service`               | Names an implementation.            |
| `layer`                 | `(service: Service) => Layer<Reconciliation>` | Installs one.                       |
| `makeDefault`           | `() => Service`                               | The deterministic verdict function. |
| `layerDefault`          | `Layer<Reconciliation>`                       | Installs it.                        |
| `Deviation`, `Conflict` | schemas                                       | What the scheduler reports.         |
| `Verdict`               | schema                                        | `Fail`, `Reorder`, or `FactorOut`.  |

`layerDefault` answers in one order of preference: `Reorder` when every
undeclared path is one another plan node declares it writes, `FactorOut` when
another node in the same run deviated on exactly the same paths, and `Fail`
otherwise. A conflict the runtime strategy could not absorb always fails, because
choosing a winner between two landings is a semantic judgement this default does
not have the material to make.

The scheduler attributes every deviation on a journal page before judging any of
it, so two steps that produced the same undeclared paths both see each other.
Pluggability is dependency injection at the owning seam; there is no hook
kernel. A model-backed reconciler is a different `Layer` and lives in the agent
packages: this package has no model dependency and must not grow one.

## Selection

[src/Selection.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Selection.ts)

The advisory scheduler seam. It may return `Admit`, `Defer`, or `Propose`
verdicts for sink candidates and missing flows, and never changes a step key, a
cache row, or a correctness decision.

| Export                             | Signature                                                                                  | Meaning                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `Selection`                        | `Context.Service<Service>`                                                                 | Service tag.                                |
| `Service`                          | `{ select: (input: Input) => Effect<ReadonlyArray<Selected>> }`                            | One verdict per candidate.                  |
| `make`                             | `(service: Service) => Service`                                                            | Names an implementation.                    |
| `layer`                            | `(service: Service) => Layer<Selection>`                                                   | Installs one.                               |
| `makeNoop` / `layerNoop`           |                                                                                            | Admits everything. The behavioral default.  |
| `makeHeuristic` / `layerHeuristic` |                                                                                            | Pure glob matching over live edges.         |
| `debt`                             | `(runId: string, options?: DebtOptions) => Effect<ReadonlyArray<DebtEntry>, ..., Journal>` | Folds the journal for unpaid deferrals.     |
| `risk`                             | `(input: { changed, beliefs }) => Risk`                                                    | A pure annotation, never a gate.            |
| `card`                             | `(input: CardInput) => ReadonlyArray<string>`                                              | Renders the plan card, one string per line. |
| `proposeReadSet`                   | `(input: { beliefs, flow, paths }) => ReadonlyArray<string>`                               | The `boundaryMode: "expected"` feeder.      |

### Schemas and models

| Export               | Shape                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `SuspectedEdge`      | `{ scope, affects, confidence, validFromMs, evidence }`                                   |
| `BeliefSnapshot`     | `{ pinnedAtMs, edges }`                                                                   |
| `Verdict`            | `Admit`, `Defer { edge, likelihood }`, or `Propose { flow, edge, confidence }`            |
| `Policy`             | `{ deferBelow }`. Zero defers nothing; a likelihood exactly at the threshold is admitted. |
| `Candidate`          | `{ nodeId, planKey, stats? }`                                                             |
| `Input`              | `{ changed, sinks, present, beliefs, policy }`                                            |
| `Selected`           | `{ nodeId, verdict }`                                                                     |
| `DebtEntry`          | `{ planId, nodeId, planKey, edge, likelihood, seq }`                                      |
| `DebtOptions`        | `{ repaidBy? }`                                                                           |
| `Risk`               | `{ level: "low" \| "medium" \| "high", reasons }`                                         |
| `CardInput`          | `{ settlements, deferrals, proposals, cadence, risk? }`                                   |
| `NonNegativeSafeInt` | the epoch and counter schema both public schemas and SQLite accept                        |

`layerHeuristic` matches live edges (`validFromMs <= pinnedAtMs`): a matching
edge supplies the likelihood, a sink can defer only when a live edge names it,
and a `Candidate.stats` failure ratio raises the likelihood so flaky sinks stay
inline. Stats alone never defer. A model-backed layer is out of scope, because
`engine-store` must not depend on a model.

`risk` returns `high` at confidence at or above 0.7, `medium` at or above 0.4,
otherwise `low`, with each reason named `<scope> -> <affects> (<confidence>)`.
`card` row strings are stable: `clean` renders as `cached` and `built` as
`run`.

Out of scope here: CLI verbs, approval routing, auto-appending proposals, and
the recertification cadence, which is a product concern rather than a store
primitive.

Full guide: [Defer work with selection beliefs](/guides/defer-work-with-selection/).

## SelectionStore

[src/SelectionStore.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/SelectionStore.ts)

The durable suspected-edge store, tagged `@smthrs/engine-store/SelectionStore`.

| Export                | Signature                                                                                                          | Meaning                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `SelectionStore`      | `Context.Service<Service>`                                                                                         | Service tag.                                    |
| `make`                | `Effect<Service, never, DurableWriter \| SqlClient>`                                                               | Builds it through this package's migration set. |
| `layer`               | `Layer<SelectionStore, never, DurableWriter \| SqlClient>`                                                         | Provides it.                                    |
| `maxEvidenceEntries`  | `128`                                                                                                              | Newest evidence entries retained per edge.      |
| `TrainingOutcome`     | `"hit" \| "miss"`                                                                                                  |                                                 |
| `TrainingObservation` | `{ scope, affects, outcome }`                                                                                      |                                                 |
| `SelectionStoreError` | `code` of `invalid_input`, `decode_failed`, or `persistence_failed`, plus optional `scope`, `affects`, and `cause` |                                                 |

`upsert(edges)` inserts or replaces by `(scope, affects)`. `list()` returns
every edge. `snapshot()` pins the injected clock's current time, never
`Date.now()`. `train(observations)` updates only matching edges in one
transaction, ignores unknown pairs, appends every observation to evidence, and
applies the asymmetric rule: a hit becomes `confidence + 0.05 * (1 -
confidence)`, a miss becomes `confidence * 0.5`. Training never creates edges
and never writes journal records.

## ArtifactSync

[src/ArtifactSync.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/ArtifactSync.ts)

The two-tier artifact protocol, and the seam a shared-cache composition injects
into.

| Export                      | Signature                                                                                               | Meaning                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ArtifactSync`              | `Context.Service<Service>`                                                                              | Service tag.                                                                             |
| `makeLocal`                 | `() => Service`                                                                                         | Publish is a no-op; hydrate reports nothing arrived. The default when the tag is absent. |
| `layerLocal`                | `Layer<ArtifactSync>`                                                                                   | Provides it.                                                                             |
| `make`                      | `(options: { local, remote, downloadPolicy? }) => Service`                                              | The two-tier protocol.                                                                   |
| `layer`                     | `(remote: Effect<ArtifactStore.Service, E, R>, options?) => Layer<ArtifactSync, E, ArtifactStore \| R>` | Takes the local tier from the `ArtifactStore` tag and the shared tier from the effect.   |
| `DownloadPolicy`            | `RemoteArtifacts.DownloadPolicy`                                                                        | `all`, `toplevel`, or `minimal`.                                                         |
| `ArtifactPublicationFailed` | `code: "artifact_publication_failed"`, fields `digests`, `message`, optional `cause`                    |                                                                                          |

`publish(digests)` runs `findMissing` on the shared tier, uploads what is
missing, and re-probes to confirm. The engine calls it immediately before the
transaction that records the cache entry, and never inside it: this
is Bazel's REAPI ordering constraint, because a result accessed before its blobs
are present cannot be validated. A publication that cannot make the artifacts
durable fails and the shared entry is withheld.

`hydrate(digests)` establishes that this host can resolve every referenced
artifact and reports whether the replay is now worth retrying. It never fails a
run: a shared tier that is down must not stop work that can simply be done.

The two tiers cannot both be layers, because they inhabit the same tag and
composing them would shadow one with the other.

### DownloadPolicy

Declared on the shared tier as `RemoteArtifacts.Options.downloadPolicy` and read
from the store `make` was handed, so one deployment setting reaches both seams.
An explicit `downloadPolicy` on `make` or `layer` overrides it.

| Policy          | `hydrate` behavior                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all` (default) | Downloads every referenced artifact into this host's store while admitting the replay. Every later read is local, and a shared tier that goes down afterwards costs nothing.                    |
| `toplevel`      | Downloads nothing. One batched `findMissing` establishes that the shared tier can serve what is missing, and `CombinedArtifacts.get` fetches and writes back the blobs a reader actually reads. |
| `minimal`       | The same probe and the same zero downloads; `CombinedArtifacts.get` then serves without writing back, so this host never accumulates other machines' artifacts.                                 |

The two lazy policies are sound only when the store the replay reads through can
reach the shared tier, which means `CombinedArtifacts` with the same remote
tier. A tier that refuses the probe is indistinguishable from one that holds
nothing, so the replay is refused either way and the step executes.

## CacheSync

[src/CacheSync.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/CacheSync.ts)

The second half of the ordering constraint: the shared step-result tier's `put`,
run after the transaction that made the local row durable.

| Export       | Signature                                                                                        | Meaning                                                             |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `CacheSync`  | `Context.Service<Service>`                                                                       | Service tag.                                                        |
| `Service`    | `{ publishEntry: (entry: CacheStore.CacheEntry) => Effect<Option<CacheStore.CacheStoreError>> }` | `none` means shared, `some(error)` means not, and why.              |
| `makeLocal`  | `() => Service`                                                                                  | The single-tier implementation. The default when the tag is absent. |
| `layerLocal` | `Layer<CacheSync>`                                                                               | Provides it.                                                        |
| `make`       | `(options: { remote: CacheStore.Service }) => Service`                                           | Publishes to a shared store, typically `RemoteCacheStore`.          |
| `layer`      | `(remote: Effect<CacheStore.Service, E, R>) => Layer<CacheSync, E, R>`                           | Provides it.                                                        |

It is a separate seam from the `CacheStore` tag because of where the local row
is written. The engine commits the cache row and the journal record explaining
it in one `DurableWriter` transaction, and nothing that is not
storage work may be held across one: a `CacheStore` whose `put` also wrote a
shared HTTP tier would put a network round trip inside that transaction,
blocking every other writer for its duration and rolling the local row back
whenever a shared cache was unreachable. Compose it with `CombinedCacheStore` in
`"deferred"` publication mode; lookups stay read-through either way.

A `Conflict` from the shared tier is not reported: it means another machine
recorded the key first, which is the first-writer-wins outcome the shared tier
exists to arbitrate.

Neither publication step can fail a run. Both run after `attempts.finish`, so
the result is already durably recorded on this host. A refusal withholds the
shared copy, never the local row, and journals a `cache-provenance` record with
`action: "unpublished"` carrying the stage (`artifacts` or `entry`) and the
reason.

## ArtifactGc

[src/ArtifactGc.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/ArtifactGc.ts)

Explicit mark and sweep collection of unreferenced blobs. Collection never runs
automatically; [`smthrs gc`](https://smithers.sh/docs/reference/cli/gc/) runs it after retention.

| Export             | Signature                                                                                     | Meaning                                                 |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ArtifactGc`       | `Context.Service<Service>`                                                                    | Service tag.                                            |
| `Service`          | `{ gc: (options?: GcOptions) => Effect<GcReport, ArtifactGcError> }`                          | Marks the live set from the durable roots, then sweeps. |
| `make`             | `(options?: MakeOptions) => Effect<Service, never, SqlClient \| ArtifactSweep>`               | Builds the collector.                                   |
| `layer`            | `(options?: MakeOptions) => Layer<ArtifactGc, never, SqlClient \| ArtifactSweep>`             | Provides it.                                            |
| `layerFileSystem`  | `(options?: MakeOptions & SweepOptions) => Layer<ArtifactGc, never, SqlClient \| FileSystem>` | Provides it over a filesystem objects directory.        |
| `ArtifactGcPolicy` | `Context.Service<Policy>`                                                                     | The opt-in collection policy.                           |
| `layerPolicy`      | `(policy: Policy) => Layer<ArtifactGcPolicy>`                                                 | Installs it.                                            |
| `defaultGraceMs`   | 14 days                                                                                       | Git's `gc.pruneExpire` default.                         |
| `ArtifactGcError`  | `code` of `invalid_options`, `mark_failed`, or `sweep_failed`                                 |                                                         |

| Type          | Fields                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MakeOptions` | `pageSize`, rows per mark-phase page. Defaults to 500.                                                             |
| `Policy`      | `graceMs?`, and `pins?` as an `Effect<ReadonlyArray<string>>` resolved fresh on every collection.                  |
| `GcOptions`   | `graceMs?`, `pins?`, `dryRun?`. Explicit options override the installed policy; the policy overrides the defaults. |
| `GcReport`    | `scannedBlobs`, `liveDigests`, `sweptDigests`, `reclaimedBytes`, `keptByGrace`, `dryRun`                           |

The mark is fail-safe: a root row carrying boundary evidence this build cannot
decode aborts the collection rather than contributing nothing. Attempt
checkpoints are also live roots, with digest-shaped strings retained
conservatively. The live set is computed before the inventory, so a root
recorded during the sweep can only be missed, never half seen, and the blob such
a root references is protected by the mtime fence anyway.

Full guide: [Collect unreferenced artifacts](/guides/collect-unreferenced-artifacts/).

## StepCacheFold

[src/StepCacheFold.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/StepCacheFold.ts)

`flows_step_cache` heads as a fold of the journal. Drop the heads and
`rebuild` writes them back from the retained `cache-provenance` entries.

| Export            | Signature                                                                                                   | Meaning                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `rebuild`         | `() => Effect<Rebuilt, JournalError \| CacheStoreError \| SqlError, Journal \| SqlClient \| DurableWriter>` | Folds every run's retained entries and replaces the heads. |
| `reduce`          | `(state: State, entry: JournalEvent.Entry) => State`                                                        | Folds one entry.                                           |
| `initial`         | `State`                                                                                                     | The empty fold.                                            |
| `projection`      | `Projection<State>`                                                                                         | The same fold for `Journal.project` over one run.          |
| `candidates`      | `(state: State) => ReadonlyArray<CacheStore.RecordedRef>`                                                   | The head each key may be rebuilt with.                     |
| `refId`           | `(ref: CacheStore.RecordedRef) => string`                                                                   | A recorded row's stable identity.                          |
| `eventType`       | `"flows.engine.cache-provenance"`                                                                           | The entries the fold reads.                                |
| `retiringActions` | `["expired", "stale_read_set", "replay_failed"]`                                                            | Provenance actions that retire the row they name.          |

| Type      | Fields                                                              |
| --------- | ------------------------------------------------------------------- |
| `State`   | `admitted` and `retired`: the rows `put` inserted, the ones evicted |
| `Rebuilt` | `runs`, `compacted`, `rewound`, `admitted`, `retired`, `heads`      |

A `put` that inserts a head journals an `admitted` entry naming its row in the
same transaction. A duplicate or a losing conflict writes a ledger row but no
`admitted` entry. These entries retire the row they name:

| Entry                       | Why the row cannot serve                           |
| --------------------------- | -------------------------------------------------- |
| `expired`, `stale_read_set` | The engine evicted it.                             |
| `replay_failed`             | The engine may have quarantined it for corruption. |

A producer slot keeps the first `replay_failed` reason it journalled, so a
corruption can hide behind an earlier host failure; the fold retires the row on
any reason, and a row whose replay failed only on the host is a miss.

A key with one admitted row that no entry retired gets that row back as its
head. A key with several gets no head: one of them left without a journal
entry, such as by `sweepExpired`, and the journal cannot say which one the
store held. The journal holds provenance, not results: the result stays in the
ledger row the entry addresses, because the journal is redacted and replayed
to sync subscribers.

A rebuild writes a subset of the live heads. It drops heads with no local
entry, such as shared-tier write-backs. A store with a compacted run, or one where
any run was ever rewound, gets no heads, because compaction and rewind may have
deleted the eviction that retired a row. Retention is not yet covered: it
deletes a run's entries and compaction floor, so a rebuild after retention can
restore a row a deleted run evicted. A single admitted row that `sweepExpired`
or an operator `evict` removed also returns; every restored hit still passes
the engine's age, read-set, and digest checks. Run it on a
quiescent store: a write between the journal read and the rewrite is missed.

## Retention

[src/Retention.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Retention.ts)

Explicit deletion of finished run state. Nothing schedules any of it.

| Export             | Signature                                                                                      | Meaning                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `Retention`        | `Context.Service<Service>`                                                                     | Service tag.                                                             |
| `Service`          | `{ retain: (options: RetainOptions) => Effect<RetainReport, RetentionError \| JournalError> }` | One bounded pass inside one `journal.transact`.                          |
| `make`             | `Effect<Service, never, SqlClient \| Journal>`                                                 | Builds it.                                                               |
| `layer`            | `Layer<Retention, never, SqlClient \| Journal>`                                                | Provides it.                                                             |
| `collect`          | `(options: Options) => Effect<Report, SqlError \| RetentionError, SqlClient>`                  | The host-facing pass, over one database file.                            |
| `eligible`         | `(olderThanMs: number, limit?: number) => Effect<ReadonlyArray<string>, SqlError, SqlClient>`  | The candidate run ids, oldest first.                                     |
| `defaultLimit`     | `1000`                                                                                         | Runs deleted by one pass when the caller names no bound.                 |
| `terminalStatuses` | `["completed", "failed", "cancelled"]`                                                         | The statuses a run can never leave.                                      |
| `runScopedTables`  | `ReadonlyArray<RunScopedTable>`                                                                | Every table a deleted run leaves rows in, and the column naming the run. |
| `RetentionError`   | `code` of `scan_failed` or `delete_failed`                                                     |                                                                          |

| Type                      | Fields                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetainOptions`           | `olderThanMs` (a duration: how long a run must have been finished), `limit?`, `dryRun?`. A negative `olderThanMs` is read as zero; a `limit` that is not a non-negative safe integer is read as zero.                                                      |
| `RetainReport`            | `cutoffMs`, `runIds`, `retainedForLiveDescendants`, `retainedForLiveAncestors`, `runs`, `attempts`, `clockDeadlines`, `deferredCompletions`, `journalEntries`, `journalCheckpoints`, `journalIdentities`, `archiveEntries`, `timeTravelReceipts`, `dryRun` |
| `Options` (for `collect`) | `olderThanMs` (an absolute epoch millisecond threshold), `dryRun?`, `database?`, `limit?`, `pins?`                                                                                                                                                         |
| `Report` (from `collect`) | `database`, `olderThanMs`, `runs`, `deleted` (empty under a dry run), `dryRun`                                                                                                                                                                             |

A run is a candidate only when its status is terminal and it finished before the
cutoff, and it is retained whenever a live run stands above or below it in the
lineage, over both the `flows_run_parents` edge a spawned child records and the
`parent_run_id` column a trampoline lineage is chained through. `collect` runs
the same deletion and the same guard, and drops the edge-table half of the walk
for a database that does not carry it, such as the control plane's.

Both passes select children before parents, so a trampoline lineage longer
than `limit` still loses at least one run every pass.

`collect` is the pass [`smthrs gc`](https://smithers.sh/docs/reference/cli/gc/) runs over one database file.

Full guide: [Delete old run history](/guides/delete-old-run-history/).

The host-facing `collect` also accepts `pins`, a list of run IDs required by
live ancestry in another store. Pinned runs and their continuation ancestors
are excluded before the bounded candidate window, so protected history cannot
starve collection of unrelated terminal runs.

## ExecutionSnapshot

Execution snapshot reads validate the batch source and safe non-negative revisions,
return exactly one row per requested ID in request order (including duplicates),
and require every row to share the batch source and have a revision no greater
than the batch watermark. Incoherent batches fail with `RunStoreError` and
`persistence_failed`; malformed stored fields retain `decode_failed`.

The engine-owned read port, exported from the root and
`@smthrs/engine-store/ExecutionSnapshot`. Its `make()` and `layer` require
`SqlClient` with the engine migrations applied.

| Export                                   | Contract                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionSnapshot`, `Service`           | Service tag and its `read` and `related` operations.                                                                                                                                  |
| `Service.read(runIds)`                   | Coherent `Batch` for up to `maximumBatchSize` (200) IDs, preserving request order and duplicates.                                                                                     |
| `withReadTransaction(sql, effect)`       | Reserves a read transaction without writer admission: deferred on SQLite and repeatable-read, read-only on PostgreSQL. An existing transaction retains its caller-selected isolation. |
| `Service.related(options)`               | Bounded `RelatedPage` of direct durable children or lineage rounds, with the requested anchor.                                                                                        |
| `Position`                               | Durable database `source` and monotonic `revision`.                                                                                                                                   |
| `Snapshot`, `Observed`, `Missing`        | Explicit observed execution or absence, including deletion evidence.                                                                                                                  |
| `Waiting`                                | Timer, signal, approval, quota, human, or other reason, with wake time and SHA-256 `tokenDigest`.                                                                                     |
| `Batch`, `RelatedOptions`, `RelatedPage` | Source watermark, scoped results, relation selector, and optional continuation.                                                                                                       |
| `isNewer(incoming, stored)`              | True only for the same source with a greater revision.                                                                                                                                |

The requested run's lifecycle remains round scoped. Intent and the first owner's
cancellation acknowledgement are separate fields. Observation failures use
`RunStoreError` with causes preserved. `withReadTransaction` also preserves SQL
transaction admission errors; interruption releases the read transaction.

## RunChangeFeed

Exported from the root and `@smthrs/engine-store/RunChangeFeed`. `make()` and
`layer` require a migrated `SqlClient`; `RunChangeFeed` is the service tag.

`Service.current` reads a `Position`.
`Service.changesSince({ source, revision, limit })` returns a `Page` containing
`Change` entries, the observed source watermark, `nextRevision`, and `hasMore`.
The allowed limit is 1 through `maximumPageSize` (1,000). Changes are coalesced
per run ID and ordered by revision. Tombstones persist indefinitely, including
after ordinary run retention, so an offline consumer can resume its checkpoint.
Source replacement or an ahead-of-source checkpoint fails with `invalid_run`.

## RunCatalogRead

[src/RunCatalogRead.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/RunCatalogRead.ts)

Bounded execution pages and the preserved polling run set for a
[`@smthrs/sync`](https://smithers-sync.smithers.sh/reference/api/) `RunCatalog`.

| Export                       | Signature                                                                                                       | Meaning                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `RunCatalogRead`             | `Context.Service<Service>`                                                                                      | Service tag.                                       |
| `Service`                    | `listRunIds(options?)`, `listRuns(options?)`                                                                    | Polling IDs or a coherent filtered execution page. |
| `make`                       | `() => Effect<Service, never, SqlClient>`                                                                       | Builds it over `flows_runs`.                       |
| `layer`                      | `Layer<RunCatalogRead, never, SqlClient>`                                                                       | Provides it.                                       |
| `ListOptions`                | `{ limit? }`                                                                                                    | Defaults to `defaultLimit`.                        |
| `defaultLimit`               | `10000`                                                                                                         |                                                    |
| `Filters`                    | Schema and type for status, flow, effective parent, lineage/root, waiting reason, and inclusive creation range. | All predicates run in SQL before pagination.       |
| `ListRunsOptions`, `RunPage` | `{ filters?, cursor?, limit? }`, page results and source watermark                                              | Versioned source-bound keyset continuation.        |
| `maximumPageSize`            | `200`                                                                                                           | `listRuns` defaults to 100, without a total count. |
| `RunCatalogError`            | `invalid_options`, `invalid_cursor`, `source_changed`, `list_failed`                                            | Typed failures preserve causes.                    |

`listRunIds` reads a set rather than a cursor tail, so retention of a run removes it from
a follower's view. Rows come back newest first by rowid and are returned oldest
first. Nothing here polls: the interval belongs to `RunCatalog.makePolling`.

`listRuns` orders by immutable creation time plus run ID. It decodes only the
selected page plus one lookahead, with indexed ancillary reads scoped to those
rows. Numeric offsets are rejected. Successive pages use live keyset semantics;
each response is coherent at its own engine revision. Control-only admissions
and the control projection are a separate integration.

Full observation, listing, lag, retention, and cursor contract:
[Observe executions and page runs](/guides/observe-executions/).

## DisasterRecovery

[src/DisasterRecovery.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/DisasterRecovery.ts)

Hot backup, verification, restore, and restore-time fencing.

| Export            | Signature                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `backup`          | `(options: BackupOptions<R, E>) => Effect<BackupManifest, DisasterRecoveryError \| E, SqlClient \| FileSystem \| Crypto \| R>`  |
| `verify`          | `(backupDirectory: string, options?: FileSizeOptions) => Effect<BackupManifest, DisasterRecoveryError, FileSystem \| Crypto>`   |
| `restore`         | `(options: RestoreOptions) => Effect<RestoredStore, DisasterRecoveryError, FileSystem \| Crypto>`                               |
| `fence`           | `(manifest: BackupManifest) => Effect<FenceSummary, DisasterRecoveryError, SqlClient \| DurableWriter>`                         |
| `restoreAndFence` | `(options: RestoreAndFenceOptions<R, E>) => Effect<FencedRestoredStore, DisasterRecoveryError \| E, FileSystem \| Crypto \| R>` |

| Constant                  | Value                                                                  |
| ------------------------- | ---------------------------------------------------------------------- |
| `databaseFileName`        | `store.sqlite3`                                                        |
| `manifestFileName`        | `manifest.json`, written last, so its presence marks a complete backup |
| `objectsDirectoryName`    | `objects`                                                              |
| `restoredMarkerFileName`  | `restored.json`                                                        |
| `defaultMaxFileSizeBytes` | 512 MiB                                                                |

| Type                           | Fields                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FileSizeOptions`              | `maxFileSizeBytes?`, a finite non-negative safe integer                                                                                                                                                            |
| `BackupOptions<R, E>`          | `directory`, `objectsDirectory?`, `snapshotDatabaseLayer`, plus `FileSizeOptions`                                                                                                                                  |
| `RestoreOptions`               | `backupDirectory`, `targetDirectory`, plus `FileSizeOptions`                                                                                                                                                       |
| `RestoreAndFenceOptions<R, E>` | `RestoreOptions` plus `databaseLayer`                                                                                                                                                                              |
| `RestoredStore`                | `{ databaseFile, objectsDirectory, manifest }`                                                                                                                                                                     |
| `FencedRestoredStore`          | `RestoredStore` plus `fence: FenceSummary`                                                                                                                                                                         |
| `FenceSummary`                 | `{ clearedClaims, suspendedRuns }`                                                                                                                                                                                 |
| `BackupManifest`               | `{ formatVersion: 1, createdAtMs, database: { file, sha256, sizeBytes, migrations }, artifacts }`                                                                                                                  |
| `AppliedMigration`             | `{ migrationId, name }`                                                                                                                                                                                            |
| `ArtifactEntry`                | `{ digest, sizeBytes }`                                                                                                                                                                                            |
| `DisasterRecoveryError`        | `code` of `invalid_options`, `not_empty`, `invalid_manifest`, `missing_file`, `digest_mismatch`, `artifact_corruption`, `snapshot_incomplete`, `schema_mismatch`, `io`, or `sql`, plus the `method` that raised it |

The database is snapshotted with `VACUUM INTO`, a read transaction under WAL, so
live writers are never blocked. The artifact walk runs after it, because results
reference artifacts only after publication. With an `objectsDirectory` the whole
capture holds the cross-process artifact backup lease; without one no lease is
taken, and a frozen snapshot that references any artifact digest fails with
`snapshot_incomplete` instead of reporting success.

Host access arrives through Effect's `FileSystem` and `SqlClient` tags and
hashing through the injected `Crypto` service, so the module carries no platform
binding. The SQL dialect is SQLite; a non-SQLite backend fails with the `sql`
code rather than pretending to snapshot.

Full guide: [Back up and restore the store](/guides/back-up-and-restore/).

## Inconsistency

[src/Inconsistency.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Inconsistency.ts)

The receiver for cache conflicts and corrupt evidence.

```ts
interface Service {
  readonly note: (event: CacheConflict) => Effect<InconsistencyVerdict, JournalError>
  readonly noteCorruption: (event: BlobCorruption) => Effect<InconsistencyVerdict, JournalError>
}
```

| Export          | Signature                                                            | Meaning                                                                                     |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Inconsistency` | `Context.Service<Service>`                                           | Service tag.                                                                                |
| `make`          | `(options: MakeOptions) => Service`                                  | Journals every conflict under the run that attempted the write and returns a fixed verdict. |
| `makeNoop`      | `(overrides?: Partial<Service>) => Service`                          | Notes nothing and tolerates.                                                                |
| `layerNoop`     | `(overrides?: Partial<Service>) => Layer<Inconsistency>`             | Provides it.                                                                                |
| `layerStrict`   | `(owner: Ownership.OwnerId) => Layer<Inconsistency, never, Journal>` | Journals and fails. The default for engine wiring.                                          |
| `layerTolerant` | `(owner: Ownership.OwnerId) => Layer<Inconsistency, never, Journal>` | Journals and continues, preserving the first-recorded row.                                  |

| Type                   | Fields                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `InconsistencyVerdict` | `"fail"` or `"tolerate"`                                                                                |
| `MakeOptions`          | `{ journal, verdict, owner }`. The owner is required: every composer of this receiver is a run's owner. |
| `CacheConflict`        | `{ key, existing, attempted }`                                                                          |
| `BlobCorruption`       | `{ runId, keyDigest, path, recordedDigest, measuredDigest, recordedRunId?, recordedEventSeq? }`         |

The record goes through the journal's durable channel, so a `tolerate` verdict
cannot silently drop its only record. For `noteCorruption`, `"fail"` fails the
dispatch and `"tolerate"` lets it fall back to a real execution, which
re-captures and heals the corrupt address.

## ReplayOnly

[src/ReplayOnly.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/ReplayOnly.ts)

An engine composed with this service replays recorded work and executes none.
`smthrs runs verify` drives a copy of a run's store with it to report which
recorded steps the current code would replay and which step it would execute
again.

```ts
interface Service {
  readonly observe: (dispatch: Dispatch) => Effect<void>
}
```

| Export         | Signature                                                  | Meaning                                                      |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `ReplayOnly`   | `Context.Service<Service>`                                 | Service tag, resolved when the engine is composed.           |
| `layer`        | `(observe: Service["observe"]) => Layer<ReplayOnly>`       | Provides it.                                                 |
| `WouldExecute` | `TaggedError<{ runId, stepKeyDigest, attempt, action }>`   | The defect a dispatch dies with instead of running a body.   |
| `Dispatch`     | `{ runId, stepKeyDigest, attempt, action, tier, outcome }` | `outcome` is `"replayed"`, `"resumes"` or `"would-execute"`. |

A dispatch served from a durable record, a recorded failure included, reports
`replayed`. The first dispatch that would run a body dies before its attempt
row, snapshot, boundary, or body: it reports `resumes` when it would re-enter a
recorded attempt that never finished, such as a step parked inside its body,
and `would-execute` when no record matches its key. The defect is never
retried, so the run settles `failed` instead of spinning in its retry policy.
Replays still write the journal rows a resume converges on, so drive a copy of
the store, never the original.

## OwnerIdentity

[src/OwnerIdentity.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/OwnerIdentity.ts)

Mints the `OwnerId` an incarnation fences its writes with.

| Export            | Signature                                               | Meaning                                                             |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `OwnerIdentity`   | `Context.Service<Service>`                              | Service tag.                                                        |
| `Service`         | `{ ownerId: (hostId: string) => Effect<OwnerId> }`      | The host supplies the incarnation; the caller supplies the host id. |
| `make`            | `(service: Service) => Service`                         | Brands an implementation.                                           |
| `makeIncarnation` | `(pid: number \| undefined, crypto: Crypto) => Service` | The standard source over an explicitly supplied process id.         |
| `layer`           | `Layer<OwnerIdentity, never, Crypto>`                   | The platform default.                                               |
| `layerConstant`   | `(owner: OwnerId) => Layer<OwnerIdentity>`              | Pins the whole token.                                               |

The process id is read off `globalThis` rather than through a bare `process`
reference, so the module carries no Node binding: a browser bundle sees
`undefined` and draws an incarnation number from `Random` instead. The read
happens at layer construction, so importing the module touches nothing. The
nonce is a UUIDv4 from the injected `Crypto` service.

## WakeBus

[src/WakeBus.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/WakeBus.ts)

Edge-triggered in-process wakes, with durable polling as the miss-tolerant
fallback.

| Export       | Signature                                          | Meaning                                     |
| ------------ | -------------------------------------------------- | ------------------------------------------- |
| `WakeBus`    | `Context.Service<Service>`                         | Service tag.                                |
| `Service`    | `{ wake, awaitWake, waiters }`                     | See below.                                  |
| `makeUnsafe` | `() => Service`                                    | Constructs a bus. Nothing is durable.       |
| `make`       | `Effect<Service>`                                  | The same, as an effect.                     |
| `layer`      | `Layer<WakeBus>`                                   | Provides a fresh bus.                       |
| `makeNoop`   | `(overrides?: Partial<Service>) => Service`        | Wakes are dropped and waiters park forever. |
| `layerNoop`  | `(overrides?: Partial<Service>) => Layer<WakeBus>` | Provides it.                                |

`wake(executionId)` resumes every waiter parked on that execution; with no
waiters the wake is dropped. `awaitWake(executionId)` parks until the next one,
and registration is removed when the waiting fiber is interrupted, so an
abandoned wait leaks nothing. The wait is keyed by execution id alone, because
execution ids are unique across flows. `waiters(executionId)` is observability
for tests and diagnostics, not a coordination primitive.

An engine composition resolves the bus optionally, so providing `layer` is how a
host shares one bus between the engine and its own wake sources. Cross-process
delivery stays store-driven.

## EngineStoreMetrics

[src/EngineStoreMetrics.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/EngineStoreMetrics.ts)

Metric handles and observation combinators for the engine hot paths. Exporters
remain host-owned.

| Export                                                                  | Kind                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ExitTag`                                                               | `"Success" \| "Failure" \| "Interrupt"`                                                                                       |
| `exitTag`                                                               | `<A, E>(exit: Exit<A, E>) => ExitTag`                                                                                         |
| `observe`                                                               | `(instruments: { timer, counter }) => <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>`                                  |
| `dispatches`, `dispatchDuration`, `dispatch`                            | counter, timer, and views keyed by `ExitTag`                                                                                  |
| `schedulerAdmissions`, `schedulerDispatchDuration`                      | counter and timer                                                                                                             |
| `schedulerNodes`, `node`                                                | counter and views keyed by `PlanScheduler.Outcome`                                                                            |
| `sandboxExecutions`, `sandboxExecutionDuration`, `sandboxExecution`     | counter, timer, and views keyed by `ExitTag`                                                                                  |
| `sandboxMaterializations`, `materializationDuration`, `materialization` | counter, timer, and views keyed by `ExitTag`                                                                                  |
| `materializationConflicts`                                              | counter                                                                                                                       |
| `boundarySettlements`, `boundarySettlement`                             | counter and views keyed by `Clean`, `Deviation`, `Violation`, `Refused`                                                       |
| `stepCacheDecisions`, `stepCacheDecision`                               | counter and views keyed by `VerifiedHit`, `Miss`, `UnverifiableEvidence`, `Unmeasurable`, `StaleReadSet`, `ReplayFailed`      |
| `claims`, `claim`                                                       | counter and views keyed by `Activated`, `Terminal`, `HeartbeatFresh`, `StealRefusedOwnerAlive`, `ClaimLost`, `ActivationLost` |

Outcome tags are rewritten as snake case attribute values, so `HeartbeatFresh`
is recorded as `heartbeat_fresh`. `observe` composes `Effect.trackDuration` with
an exit counter update and a span annotation, and propagates the instrumented
effect's exit byte-identically.

Full guide: [Observe engine metrics](/guides/observe-engine-metrics/).

## Migrations

[src/Migrations.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Migrations.ts)

| Export  | Signature                     | Meaning                                                                                                                    |
| ------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `set`   | `MigrationSet`                | This package's own set, namespace `engine-store`, migration id block `3000`.                                               |
| `sets`  | `ReadonlyArray<MigrationSet>` | The complete durable engine schema in dependency order: journal, run store, step cache, this package, then the plan store. |
| `run`   | the migration effect          |                                                                                                                            |
| `layer` | `Layer`                       | Installs the complete schema before exposing the database to any durable service.                                          |

This package's own set creates deferred/clock state, selection beliefs, and the
`flows_plan_input_heads`, `flows_plan_input_generations`, and
`flows_plan_input_legacy_runs` recovery tables. The plan set's block (`4000`)
comes last. The database loader supports forward additions to an already
installed lower block, so migrations `3003` and `3004` also run on existing installations
whose global cursor reached `4003`; earlier holes remain refusals. See
[`@smthrs/database`](https://database.smithers.sh/reference/api/) for how namespaced sets compose without
colliding.

## RunState

[src/RunState.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/RunState.ts)

The versioned state envelope stored in each run row.

| Export         | Shape                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `RunState`     | `{ version: 1, flowName, payload, parentExecutionId?, onParentExit?, maxRounds?, result?, cancellation? }` |
| `OnParentExit` | `"cancel"` or `"detach"`                                                                                   |

`ReleaseCause` is why a driver released a run it still owned, recorded as the
optional `cause` of its `interrupt-released` run decision:
`{ kind: "lease-lapsed", unconfirmedMs }` when the host went that long without
confirming its run lease, or `{ kind: "interrupted" }` for any other
non-cancel interruption, usually a host shutdown. `releaseCauseOf(decision)`
reads it and answers `undefined` for decisions recorded before the field
existed.

`parentExecutionId` is present only on a child run. `onParentExit` is recorded
at first admission, including independent runs that a later caller may join as
a child: the parent's terminal transition reads it to decide whether the child
ends with it. The policy is recorded on the child rather than on the edge,
because it is a property of how the child was started and because a child with
two parents must answer the question once. Missing policies on legacy rows
default to `"cancel"`. A later caller awaiting or ensuring the run does not
rewrite its recorded policy.

## Errors

[src/Errors.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/Errors.ts)

The stable error contract. Every `code` literal here is public API: consumers
may switch on `code` or `_tag`, and the strings will not change without a major
version.

| Export                                    | `code`                                                               | Fields                                                             |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `AttemptSuspended`                        | `attempt_suspended`                                                  | `runId`, `keyDigest`, `attempt`                                    |
| `AttemptAdmissionRejected`                | `attempt_admission_rejected`                                         | `keyDigest`, `outcome`                                             |
| `AttemptEvidenceQuarantined`              | `attempt_evidence_quarantined`                                       | `keyDigest`, `attempt`, `path`, `recordedDigest`, `measuredDigest` |
| `CacheConflictDetected`                   | `cache_conflict_detected`                                            | `keyDigest`, `recordedRunId`                                       |
| `CacheCorruptionDetected`                 | `cache_corruption_detected`                                          | `keyDigest`, `path`, `recordedDigest`, `measuredDigest`            |
| `RetentionError`, `RetentionErrorCode`    | `scan_failed`, `delete_failed`                                       |                                                                    |
| `RunCatalogError`, `RunCatalogErrorCode`  | `invalid_options`, `invalid_cursor`, `source_changed`, `list_failed` | `cause` when a decode or store operation failed.                   |
| `IrreversibleRetryRequiresIdempotencyKey` | re-exported from [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s `Action`              |                                                                    |
| `FlowCycleDetected`                       | re-exported from [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s `FlowRuntime`         |                                                                    |

Each failure, with its cause and its fix, is in
[Troubleshooting](/troubleshooting/).

## test/TestStores

[src/test/TestStores.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/src/test/TestStores.ts)

Every durable engine service over one database, migrated.

| Export              | Signature                                                       | Meaning                                                                                                                                            |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer`             | `(options?: TestStoresOptions) => Layer<...>`                   | The private in-memory bundle: journal, run, attempt, cache, plan, and plan-input stores plus `OwnerIdentity.layer`, keeping `SqlClient` to itself. |
| `layerAt`           | `(filename: string, options?: TestStoresOptions) => Layer<...>` | The same over a named database, with the connection and `DurableEngineState` re-exported.                                                          |
| `database`          | `Layer`                                                         | The migrated in-memory database alone, as `SqlClient` and `DurableWriter`.                                                                         |
| `databaseAt`        | `(filename: string) => Layer`                                   | The same over a named file.                                                                                                                        |
| `TestStoresOptions` | `{ capacity?, overflow?, batchSize? }`                          | Forwarded to the journal.                                                                                                                          |

Use `layerAt` with a real file to point two independently constructed bundles at
one database: two connections, two engines, no shared object graph, which is
what a second process actually has. `:memory:` gives each connection its own
private database, so it cannot prove anything durable across compositions.

Full guide: [Test against a durable store](/guides/testing/).

## Cache admission

The engine admits a cache record only when the action is sealed, the boundary is
hard, no deviation occurred, and the evidence explicitly carries
`wholeTreeWritesVerified: true`. Older evidence and boundaries that observe
declared paths only are conservatively refused. Only a content-key record has an
address another run can reproduce; an ordinal-key record remains run-local.

A cache hit is verified before it is served: the store calls `prepare` and
compares the descriptor's declared `readSet` against the `readSnapshot` the host
measured. Reuse happens only when every declared read still matches. Reads the
host reports but the declaration never claimed are ignored, while a declared
path that is missing or has a different digest refuses the hit, journals a
`cache-provenance` record with `action: "stale_read_set"`, and falls through to a
real execution. That is Skyframe's dirty-check invariant: the key alone detects a
changed declaration, not a stale one.

A verified hit calls `replayOutputs` before returning the stored result. When
that refuses with `MissingArtifact`, the dispatch hydrates from the shared tier
and retries the replay exactly once before falling through to a real execution.
A replay refused for confinement (a symlink on a replayed path, or a host that
cannot be confined) journals `replay_failed` and executes the step for real;
it never writes through the link.

Replaying a succeeded attempt row also converges the cache: if a crash landed
between `attempts.finish` and `cache.put`, the restarted executor re-records the
sealed completion with fresh cache provenance. A divergent first-recorded row
surfaces through the [`Inconsistency`](#inconsistency) receiver, strict by
default.

A persisted `failed` attempt row replays by rethrowing the persisted domain
failure, never by readmission, so `AttemptAdmissionRejected` marks only
genuinely mid-flight rows. The `Fail` errors were schema-encoded before
persistence, so their `_tag` survives the JSON round trip and `RetryPolicy`
non-retryable matching applies on replay. The composition also implements the
engine's `actionLatestAttempt` and degrades `actionRetryOrigin` to the earliest
surviving attempt row when a retention job pruned attempt 1.

Full model: [Cache admission](/concepts/cache-admission/). See also
[Run durably over SQLite](https://smithers.sh/docs/tutorials/first-flow/#6-run-durably-over-sqlite)
and [Content addressing](https://smithers.sh/docs/concepts/content-addressing/).
