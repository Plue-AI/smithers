---
title: "API reference"
description: "Every public export of @smthrs/journal: the Journal service and its operations, the event envelope, the SQL layer options, redaction, projections, metrics, migrations, and the two test entry points."
---

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Layer from "effect/Layer"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.db" })
)

const journal = SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, database))
)
```

## Entry points

| Import                             | Source                                                                                                                              | Platform |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `@smthrs/journal`                  | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/journal/src/index.ts)                       | any      |
| `@smthrs/journal/test/TestJournal` | [src/test/TestJournal.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/journal/src/test/TestJournal.ts) | Node     |
| `@smthrs/journal/test/Notifying`   | [src/test/Notifying.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/journal/src/test/Notifying.ts)     | any      |

Every module in the root is also importable from `@smthrs/journal/<Module>`.
The root holds the journal and its contracts, written against the
driver-neutral `@smthrs/database` service, and it bundles for the browser. The
test doubles are kept out of it and live under explicit subpaths; of the two,
only `TestJournal` binds a Node SQLite database, which is what the platform
column above records. See
[platform support](/docs/reference/api/#platform-support).

## Journal

`Journal.Journal` is the service tag; `Journal.Service` is its interface.
Fallible journal operations use `JournalError` with a stable `code`.

### Operations

| Method                | Signature                                                                                          | Behavior                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitLossy`           | `(input: Input) => Effect<EmitReceipt, JournalError>`                                              | bounded non-blocking queue; may return `Dropped`                                                                                                                            |
| `emitDurable`         | `(input: Input, owner: OwnerId) => Effect<DurableReceipt, JournalError>`                           | allocates and commits inside the write transaction, fenced on `owner`                                                                                                       |
| `emitDurableUnfenced` | `(input: Input) => Effect<DurableReceipt, JournalError>`                                           | the same commit with no fence, for a genuinely ownerless admission                                                                                                          |
| `transact`            | `<A, E, R>(effect: Effect<A, E, R>) => Effect<A, E \| JournalError, R>`                            | runs a state projection and its `emitDurable` calls in one transaction                                                                                                      |
| `whenCommitted`       | `(update: Effect<void>) => Effect<boolean>`                                                        | accepts a short, non-failing update after managed commit, or runs it immediately outside a transaction; returns `false` without publishing when commit ownership is unknown |
| `stream`              | `(options: StreamOptions) => Stream<Entry, JournalError>`                                          | durable history, then committed changes; never completes                                                                                                                    |
| `entries`             | `(options: EntriesOptions) => Effect<EntriesPage, JournalError>`                                   | paged read                                                                                                                                                                  |
| `changes`             | `Effect<PubSub.Subscription<Entry>, never, Scope>`                                                 | post-commit publication, bounded and sliding                                                                                                                                |
| `project`             | `<S, E, R>(projection: Projection<S, E, R>, options: StreamOptions) => Stream<S, JournalError, R>` | folds `stream` through a deterministic reducer                                                                                                                              |
| `flush`               | `Effect<void, JournalError>`                                                                       | barrier for the lossy queue                                                                                                                                                 |
| `checkpoint`          | `(options: CheckpointOptions, owner: OwnerId) => Effect<Checkpoint, JournalError>`                 | durably captures replay state at a committed sequence, in `transact`'s discipline                                                                                           |
| `latestCheckpoint`    | `(runId: RunId) => Effect<Option<Checkpoint>, JournalError>`                                       | the resync point for a compacted run                                                                                                                                        |
| `compact`             | `(options: CompactOptions, owner: OwnerId) => Effect<Compacted, JournalError>`                     | truncates strictly below a checkpoint, atomically with the floor advance                                                                                                    |
| `generation?`         | `(runId: RunId) => Effect<{ generation: number; afterSeq: number }, JournalError>`                 | optional durable rewind generation and archive boundary; omission means generation zero                                                                                     |

`whenCommitted` returning `true` means accepted, possibly deferred. Failed
savepoints and transaction retries discard their registrations. See
[commit state and its entry together](./guides/commit-state-and-entry.md).

`owner` is mandatory on `emitDurable`, `checkpoint`, and `compact`. The insert,
the checkpoint replacement, and the truncation join the `Consensus` strategy's
`guard` inside their write transaction and land only while the strategy still
records that owner as holding the run, and otherwise fail `fence_lost`. An owner that is missing, null, or not an `OwnerId` at all fails
`invalid_event` instead: that is a caller contract violation, and reporting it
as `fence_lost` would send the caller hunting a race that never happened.
`emitDurableUnfenced` is the one sanctioned ownerless path, for an import or a
repair tool that owns no run. Reaching for it to dodge `fence_lost` writes
exactly the zombie entry the fence exists to reject.

`SqlJournal.layer` fences through [`SqlConsensus`](#sqlconsensus), whose lease
table this package's own migrations create; `SqlJournal.layerWith` fences
through any injected [`Consensus`](#consensus).

### Errors

`JournalError` is a `Schema.TaggedError` with the tag
`"@smthrs/journal/JournalError"` and the fields `code`, `message`, optional
`cause`, and optional `checkpointSeq`.

| Member          | Type                 | Meaning                                                                                                                                                                    |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`          | `JournalErrorCode`   | the stable classification                                                                                                                                                  |
| `message`       | `string`             | a human-readable description                                                                                                                                               |
| `cause`         | `unknown` (optional) | the underlying failure, for storage codes                                                                                                                                  |
| `checkpointSeq` | `Seq` (optional)     | on `compacted`, the run's floor; on `reader_behind`, the checkpoint a compaction refused to truncate below; on `checkpoint_invalid`, the floor that refused the checkpoint |

`JournalErrorCode` is one of `invalid_event`, `idempotency_conflict`,
`sequence_conflict`, `fence_lost`, `queue_overflow`, `journal_closed`,
`sink_failed`, `read_failed`, `decode_failed`, `projection_failed`,
`checkpoint_invalid`, `reader_behind`, `compacted`, and `unknown`. Each one is
diagnosed in [Troubleshooting](./troubleshooting.md).

### Receipts

| Export           | Shape                                | Returned when                                                                    |
| ---------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `Accepted`       | `{ _tag, seq, sourceSeq, evicted? }` | a new event was admitted; `evicted` counts what a `drop-oldest` policy displaced |
| `Duplicate`      | `{ _tag, seq, sourceSeq, status }`   | an exact producer retry; `status` is `"pending"` or `"committed"`                |
| `Dropped`        | `{ _tag, seq, sourceSeq, policy }`   | a `drop-newest` policy discarded the event                                       |
| `EmitReceipt`    | `Accepted \| Duplicate \| Dropped`   | the lossy channel's union                                                        |
| `DurableReceipt` | `Accepted \| Duplicate`              | the durable channel's union; a dropped lifecycle event is unrepresentable        |

### Options and models

| Export              | Shape                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OverflowPolicy`    | `"reject" \| "drop-newest" \| "drop-oldest"`                                                                                                                                                                   |
| `StreamOptions`     | `{ runId, afterSequence? }`                                                                                                                                                                                    |
| `EntriesOptions`    | `{ runId, after?, eventTypes?, limit }`, `limit` in `1..maxEntriesLimit`; optional nonempty list of up to 64 exact types is filtered before pagination. Cursors stay canonical; compaction checks still apply. |
| `EntriesPage`       | `{ entries: ReadonlyArray<Entry>, hasMore: boolean }`                                                                                                                                                          |
| `CheckpointOptions` | `{ runId, seq, state }`                                                                                                                                                                                        |
| `Checkpoint`        | `{ runId, seq, state, createdAtMs, compactedAtMs }`, the last null until a compaction truncated below it                                                                                                       |
| `CompactOptions`    | `{ runId, upTo? }`, defaulting to the run's latest checkpoint                                                                                                                                                  |
| `Compacted`         | `{ runId, checkpointSeq, deleted }`, `deleted: 0` for a retried compaction                                                                                                                                     |
| `maxEntriesLimit`   | `10_000`, the largest page `entries` reads                                                                                                                                                                     |

### Constructors and layers

| Export      | Signature                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `make`      | `(implementation: Service) => Service`                                                           |
| `makeNoop`  | `(overrides?: Partial<Service>) => Service`, every un-overridden method failing `journal_closed` |
| `layerNoop` | `(overrides?: Partial<Service>) => Layer<Journal>`                                               |

The closed stub's `transact` runs its effect directly, because a stub with no
sink has no transaction to open. A double that models rollback overrides it.

## JournalEvent

The durable event envelope. Event types and values remain an open envelope on
purpose: the durable core never closes them into an interpreter-specific union.

| Export                | Kind                                     | Meaning                                                                                                  |
| --------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `RunId`               | branded schema and type                  | one durable run                                                                                          |
| `SourceId`            | branded schema and type                  | one event producer                                                                                       |
| `Seq`                 | branded schema and type                  | canonical per-run replay order                                                                           |
| `SourceSeq`           | branded schema and type                  | producer-local sequence, the idempotency key                                                             |
| `Dedupe`              | `"content" \| "identity"`                | what a re-emitted producer identity means                                                                |
| `Input`               | `Schema.Class`                           | `{ runId, sourceId, sourceSeq?, dedupe?, eventType, payload, meta? }`                                    |
| `Entry`               | `Schema.Class`                           | `{ runId, seq, eventId, sourceId, sourceSeq, emittedAtMs, eventType, payload, meta }`                    |
| `makeEventId`         | `(runId, sourceId, sourceSeq) => string` | the deterministic durable id, length-prefixed so a separator in an identifier cannot forge another tuple |
| `maxIdentifierLength` | `1024`                                   | the identifier ceiling                                                                                   |
| `companionRunId`      | `(stream, runId) => RunId`               | the id of the run's companion stream named `stream`                                                      |
| `companionPrefix`     | `"flows.companion/"`                     | the reserved prefix of every companion stream id                                                         |
| `isCompanionRunId`    | `(runId) => boolean`                     | whether a run id names a companion stream                                                                |

`RunId`, `SourceId`, and both an `Input`'s and a committed `Entry`'s
`eventType` are non-empty, at most `maxIdentifierLength` UTF-16 code units,
free of unpaired UTF-16 surrogates, and free of NUL. SQLite binds a lone
surrogate as U+FFFD, so two ill-formed identifiers that differ only in their
surrogates would land on one persisted key: the second run's first event would
dedupe into the first run's row, and a read by either id would return the same
history. SQLite's `length()` stops at the first NUL, so a NUL-bearing
identifier fails the column's own non-empty check and the caller is told the
sink failed about an identifier it had just supplied. Valid astral text is
ordinary text and round-trips exactly.

`Seq` and `SourceSeq` stop below `Number.MAX_SAFE_INTEGER`, so the journal can
always allocate the next sequence.

A companion stream carries one store's facts about a run beside the run's own
stream: an ordinary stream with its own sequence clock, named
`flows.companion/<stream>/<sha-256 of the run id>` so the id fits the
identifier ceiling for every run id. A consumer that reads the run's stream by
position never sees a companion fact, and a rewind or compaction of the run's
stream never truncates one. Each fact names its run in its payload.
`@smthrs/run-store` records ownership transitions on the `run-store` companion
stream, and refuses to create a run whose id begins with `companionPrefix`.

`entries`, `stream`, `checkpoint`, `latestCheckpoint`, and `compact` decode the
same schemas, so an identifier the writer refuses is refused on every read with
`invalid_event` rather than answered with an empty page.

## SqlJournal

`SqlJournal.layer(options)` provides the bounded telemetry writer and the
inline durable writer over `DurableWriter`.

```ts
declare const layer: (
  options: SqlJournalOptions
) => Layer.Layer<Journal, JournalError, DurableWriter | SqlClient.SqlClient>
```

| Option             | Type                 | Default             | Meaning                                                                                                      |
| ------------------ | -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `capacity`         | `number`             | required            | entries held in the lossy admission queue and in the sliding `changes` buffer                                |
| `overflow`         | `OverflowPolicy`     | required            | what a full admission queue does                                                                             |
| `batchSize`        | `number`             | `min(capacity, 64)` | entries the queued writer commits per transaction; `stream` reads pages of `min(batchSize, maxEntriesLimit)` |
| `sourceEventCache` | `number`             | `4096`              | upper bound on the in-process producer-idempotency index                                                     |
| `maxEntryBytes`    | `number`             | unset               | largest single entry, in UTF-8 bytes of encoded `payload` plus `meta`                                        |
| `redact`           | `Redaction.Redactor` | `Redaction.make()`  | scrub applied before encoding                                                                                |
| `compaction`       | `CompactionPolicy`   | unset               | automatic checkpoint-and-compact policy                                                                      |

`CompactionPolicy` is `{ entryThreshold: number, capture: (runId: RunId, upTo: Seq) => Effect<unknown, unknown> }`.
Once a run's committed entry count reaches `entryThreshold`, the journal asks
`capture` for the caller's replay state at the run's durable tail, writes it as
a checkpoint at that sequence, and compacts below it. A capture is interrupted
after 30 seconds, and a failed or refused attempt is logged at warning, damped
for `entryThreshold` further committed entries, and never surfaced to the emit
that triggered it. The policy drives the internal unfenced channel, so it needs
no owner.

`capacity` bounds entries, never bytes. `maxEntryBytes` is checked after
encoding and before any sequence is allocated, so an entry over the bound fails
`invalid_event` and leaves no gap. It is unset by default because a running
engine may legitimately write large payloads and a cap introduced under one
would refuse writes that used to succeed.

`sourceEventCache` bounds a cache, never the authority: the database unique
constraint on `(run_id, source_id, source_seq)` stays authoritative, so a miss
changes the receipt, not the durable answer. Resident memory and startup decode
are proportional to this bound rather than to total history. See
[Producer identity and idempotency](./concepts/idempotency.md).

## OwnerId

`OwnerId.OwnerId` is the fencing token the durable channel accepts:
`{ hostId: string, pid: number, nonce: string }`, where `pid` is a
non-negative integer.

It lives here rather than with the ownership arbitration in
[`@smthrs/run-store`](/api/run-store) because the journal is what it fences.
That package's `Ownership` re-exports it alongside `LivenessEvidence`,
`LivenessProbe`, and the heartbeat constants.

## Consensus

The injectable strategy that arbitrates who holds a run. The journal owns the
rules — one writer per run, fenced and unfenced appends, commit-time
admission, the generation fence, steal only on staleness plus liveness
evidence, and ownership transitions as events — and a strategy chooses where
the lease lives and how the fence is checked at commit time.

| Export                                                                                          | Signature                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Consensus`                                                                                     | `Context.Service<Consensus, Service>`                                                                                                          |
| `Service.claim`                                                                                 | `(runId, claimant: OwnerId, nowMs) => Effect<ClaimOutcome, ConsensusError>`                                                                    |
| `Service.activate`                                                                              | `(runId, owner: OwnerId, grantedAtMs, nowMs) => Effect<ActivateOutcome, ConsensusError>`                                                       |
| `Service.heartbeat`                                                                             | `(runId, owner: OwnerId, nowMs) => Effect<HeartbeatOutcome, ConsensusError>`                                                                   |
| `Service.release`                                                                               | `(runId, owner: OwnerId) => Effect<void, ConsensusError>`                                                                                      |
| `Service.steal`                                                                                 | `(runId, claimant: OwnerId, nowMs, evidence: LivenessEvidence) => Effect<ClaimOutcome, ConsensusError>`                                        |
| `Service.recover`                                                                               | `(runId, staleClaimant: OwnerId, grantedAtMs, observer: OwnerId, nowMs, evidence: LivenessEvidence) => Effect<RecoverOutcome, ConsensusError>` |
| `Service.guard`                                                                                 | `(runId, owner: OwnerId) => Effect<void, ConsensusError>`; fails `fence_lost` unless `owner` holds the run                                     |
| `ClaimOutcome`                                                                                  | `Claimed { grantedAtMs }` or `Rejected { reason }`                                                                                             |
| `ActivateOutcome`                                                                               | `Activated` or `Lost`                                                                                                                          |
| `HeartbeatOutcome`                                                                              | `Renewed { heartbeatAtMs }` or `Lost`                                                                                                          |
| `RecoverOutcome`                                                                                | `Recovered` or `Rejected { reason }`                                                                                                           |
| `RejectionReason`                                                                               | `already_claimed`, `owner_held`, `owner_live`, `evidence_invalid`, `claim_fresh`, `claim_changed`, `unavailable`                               |
| `ConsensusError`                                                                                | `{ code: "fence_lost" \| "persistence_failed", message, cause? }`                                                                              |
| `LivenessEvidence`                                                                              | `{ expectedOwner: OwnerId, checkedAtMs, kind }` with `kind` one of `same-host-pid-dead`, `cross-host-unreachable-stale`, `lease-expired`       |
| `matchesEvidence`, `sameOwner`                                                                  | The evidence and identity predicates every strategy applies                                                                                    |
| `heartbeatInterval`, `heartbeatStaleAfter`, `heartbeatSkewAllowance`, `heartbeatWriteTolerance` | The lease durations every strategy judges staleness against                                                                                    |
| `make`, `makeNoop`, `makeLocal`, `layerNoop`, `layerLocal`                                      | Constructors and layers; `layerLocal` is the in-memory single-process strategy                                                                 |

The claim lifecycle is two-phase: `claim` (or `steal`, its evidence-gated
form) reserves the run and returns the grant timestamp, `activate` presents
that grant to take ownership, and `release` clears whichever of the caller's
claim or ownership still stands. `recover` clears a third party's stale claim
after its claimant was proven dead. Every operation takes the caller's clock
reading, so staleness is judged against the reading the caller observed.
Heartbeats and lease state never enter the journal.

`layerLocal` keeps its leases per layer build and outside any database
transaction: provide one instance to every service that must agree, and
prefer `SqlConsensus` wherever a database is present.

## SqlConsensus

The default database-backed strategy. Its lease is the `flows_consensus_leases`
row this package's migration `0006_consensus` creates, holding the owner tuple,
the two-phase claim columns, the grant timestamp, and the heartbeat. `guard`
is a plain SELECT inside the caller's write transaction, and every mutating
operation runs through `DurableWriter.write`, joining an enclosing transaction
as a savepoint, so a rolled-back ownership write rolls its lease back too.

| Export  | Signature                                                      |
| ------- | -------------------------------------------------------------- |
| `make`  | `Effect<Consensus.Service, never, DurableWriter \| SqlClient>` |
| `layer` | `Layer<Consensus, never, DurableWriter \| SqlClient>`          |

The migration backfills a lease for every `flows_runs` row that was running
or claimed when the table is already present, so an owner driving a run
before the upgrade keeps its fence afterwards.

## Redaction

The scrub applied to every `payload` and `meta` before persistence.

| Export                | Signature                                        | Meaning                                                                 |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `make`                | `(options?: Options) => Redactor`                | builds a redactor over a rule set                                       |
| `makeNoop`            | `() => Redactor`                                 | the identity redactor, for persisting verbatim by choice                |
| `redact`              | `(value: unknown, options?: Options) => unknown` | the scrub itself                                                        |
| `redactJsonString`    | `(json: string, redactor: Redactor) => string`   | scrubs an already-encoded column at a display surface                   |
| `isSensitiveKey`      | `(key: string) => boolean`                       | whether a field name names a credential                                 |
| `Redactor`            | `(value: unknown) => unknown`                    | the function type the journal consumes                                  |
| `Rule`                | `{ id, pattern, replace?, rewrite? }`            | one textual rule; `rewrite` for a value a regex cannot bound            |
| `Options`             | `{ rules?, onTooDeep? }`                         | `onTooDeep` is `"throw"` (default) or `"name"`                          |
| `defaultRules`        | `ReadonlyArray<Rule>`                            | the built-in credential shapes                                          |
| `diagnosticRules`     | `ReadonlyArray<Rule>`                            | `defaultRules` plus the spellings too broad for a durable row           |
| `redactDiagnostic`    | `(value: unknown) => unknown`                    | `redact` with `diagnosticRules`, naming a too-deep value                |
| `lineRedactor`        | `(rules?: ReadonlyArray<Rule>) => LineRedactor`  | redacts a stream line by line, holding a value open across lines        |
| `LineRedactor`        | `{ line, flush }`                                | `line` returns the lines safe to emit; `flush` ends the stream          |
| `maxHeldLines`        | `256`                                            | lines a `LineRedactor` holds for one open value before withholding      |
| `placeholder`         | `"[REDACTED]"`                                   | the substitution                                                        |
| `maxDepth`            | `256`                                            | container edges traversed before a payload is refused                   |
| `RedactionDepthError` | `{ code: "depth_exceeded", maxDepth, message }`  | what `onTooDeep: "throw"` throws past `maxDepth`; a tagged error        |
| `binaryWalkLimit`     | `65_536`                                         | bytes, and own members, before a binary view is named instead of walked |
| `binaryMarker`        | `"[Binary]"`                                     | a named binary view                                                     |
| `functionMarker`      | `"[Function]"`                                   | a named function                                                        |
| `symbolMarker`        | `"[Symbol]"`                                     | a named symbol                                                          |
| `depthMarker`         | `"[Deep]"`                                       | a value past `maxDepth`, under `onTooDeep: "name"`                      |

Built-in text rules cover credential assignments around `:`, `=` or `=>`, in
every value shape `util.inspect` and escaped JSON write, credential flags such
as `--password value`, Basic and Bearer authorization, bare JWTs, private-key
PEM and PGP blocks (including OpenSSH, and a block with no footer), and
cookie/session assignments. Structured
credential suffixes also include `secretAccessKey`, `passphrase`, `sshKey`,
`session`, `signature`, and `auth`. See the full
[redaction rules](./concepts/redaction.md).

Rows are permanent and are replayed verbatim to sync subscribers and
time-travel consumers, so redaction on write is the only place it can be
enforced once. The rule set is a best-effort textual net over shapes seen in
real reports, not a proof: a value that must never persist belongs in a
`Redacted` field of the caller's own schema.

Redaction stops at the journal. It is an observability concern, and journal
rows exist to be read. The stores in [`@smthrs/run-store`](/api/run-store) and
[`@smthrs/step-cache`](/api/step-cache) hold executable state and are
deliberately not redacted; neither takes a `redact` option at all. A journal
`Checkpoint`'s `state` is executable state for the same reason and is not
redacted either.

`redactJsonString` returns a string that does not parse untouched, because
validation is the caller's. Once parsing succeeds it fails closed: a throwing
redactor or an encoding failure returns the JSON string `"[REDACTED]"`, never
the original text.

Full behavior, including the bounds on hostile input, is in
[Redaction](./concepts/redaction.md).

## RedactedLogger

The same rules applied to log output.

| Export             | Signature                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `layer`            | `(options?: Redaction.Options) => Layer<never>`                                                              |
| `wrap`             | `<Message, Output>(logger: Logger<Message, Output>, options?: Redaction.Options) => Logger<Message, Output>` |
| `isRedacted`       | `(logger: Logger<any, any>) => boolean`                                                                      |
| `redactArgument`   | `(value: unknown, redactor: Redaction.Redactor) => unknown`                                                  |
| `redactingConsole` | `(target: Console, redactor: Redaction.Redactor) => Console`                                                 |
| `TypeId`           | `unique symbol`, the marker `wrap` sets                                                                      |

`layer` replaces the active logger set with redacting wrappers of the same
loggers, so an operator keeps the format they had. `wrap` redacts the log event
itself, the message, the cause, and the annotations, and hands the wrapped
logger a fiber whose `Console` is redacting. Both halves are load-bearing:
`Logger.tracerLogger` reads the event and never touches `Console`.

`wrap` defaults `onTooDeep` to `"name"`, because a throw in a logger costs the
operator the whole line. A caller's own `onTooDeep` still wins. Wrapping is
idempotent.

See [Keep credentials out of log output](./guides/redact-log-output.md).

## Projection

| Export                | Signature                                                                           |
| --------------------- | ----------------------------------------------------------------------------------- |
| `Projection<S, E, R>` | `{ name: string, initial: S, reduce: (state: S, entry: Entry) => Effect<S, E, R> }` |
| `make`                | `<S, E, R>(projection: Projection<S, E, R>) => Projection<S, E, R>`                 |

Projections have no independent durable state. Replaying the same entries
through the same reducer must reproduce the same result. `Journal.project`
emits `initial` first, then one state per entry, and follows the run's tail
without completing. See
[Fold a run into a projection](./guides/fold-a-projection.md).

## JournalMetrics

| Export        | Type                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `writes`      | the `flows_journal_writes` counter, dimensioned by `channel` and `receipt`  |
| `durable`     | `writes` views keyed by `"Accepted" \| "Duplicate"`                         |
| `lossy`       | `writes` views keyed by `"Accepted" \| "Duplicate" \| "Dropped"`            |
| `lostEntries` | the `flows_journal_lost` counter, dimensioned by `channel` and error `code` |
| `lost(code)`  | the `lostEntries` view for one `JournalError` code                          |

`SqlJournal` updates these once per emission receipt, so they measure
admissions on the hot path rather than rows read back. A durable emission
counts when its receipt is produced; under `transact` that is still inside the
caller's transaction, so a receipt that later rolls back has already counted.
The counter is throughput evidence, not commit evidence.

`lostEntries` moves by the number of admitted lossy entries the writer failed
to commit, when it gives them up, whether or not a `flush` is waiting. The
writer also logs a warning naming the error code, the count, and the runs. A
final flush that fails while the journal closes logs a warning too.

No exporter ships in this package. Provide one, for example
[`@smthrs/observability`](/api/observability), and these counters appear in it.

## Migrations

| Export  | Signature                                                                  |
| ------- | -------------------------------------------------------------------------- |
| `set`   | `DatabaseMigrations.MigrationSet`, namespace `"journal"`, id block `0`     |
| `run`   | `Effect<ReadonlyArray<[id, name]>, MigrationError \| SqlError, SqlClient>` |
| `layer` | `Layer<never, MigrationError \| SqlError, SqlClient>`                      |

`0001_initial` creates `flows_journal_events` and its event-type index;
`0002_checkpoints` creates `flows_journal_checkpoints`;
`0003_startup_index` indexes the timestamp/run/sequence ordering used by the
bounded startup query. `run` and `layer` install this package's full set.
The migration composer also applies the new index to an installed journal
block when another package has already advanced the global migration cursor.

Every other durable table belongs to the package that reads it.
`@smthrs/database`'s `Migrations` composes several sets over one
`flows_migrations` table, namespacing each package's ids into a reserved block
so two packages' `0001_initial` cannot collide.
`@smthrs/engine-store/Migrations` exports `sets`, the composed list a durable
engine installs. No version shipped before `1.0.0-rc.0`, so each package
carries one authoritative initial schema rather than compatibility migrations
for schemas no published release ever used.

## Test entry points

`@smthrs/journal/test/TestJournal` provides the production SQL journal over a
migrated in-memory database:

| Export               | Signature                                                   |
| -------------------- | ----------------------------------------------------------- |
| `layer`              | `(options?: TestJournalOptions) => Layer<Journal, ...>`     |
| `TestJournalOptions` | `SqlJournalOptions` with `capacity` and `overflow` optional |

`TestJournalOptions` is the production option type, so every field forwards to
`SqlJournal.layer` unchanged and a new production option is reachable here the
day it is added. The defaults are `capacity: 1024` and `overflow: "reject"`.
This bundle creates the journal's tables, the consensus lease table included,
so a suite exercising a fenced call takes the run through `Consensus.claim`
and `activate`, or takes `@smthrs/engine-store/test/TestStores`, which
provides the journal, run, attempt, and cache services over one database.

`@smthrs/journal/test/Notifying` wraps a record-of-Effect-methods service so a
hook fires around every operation:

| Export  | Signature                                                                             |
| ------- | ------------------------------------------------------------------------------------- |
| `Order` | `"before" \| "after"`                                                                 |
| `Hook`  | `(op: string, order: Order, args: ReadonlyArray<unknown>) => Effect<void>`            |
| `wrap`  | `<S extends object>(service: S, hook: Hook) => S`                                     |
| `layer` | `<Id, S extends object>(tag: Context.Key<Id, S>, hook: Hook) => Layer<Id, never, Id>` |

The hook runs in the calling fiber, so a hook that dies, interrupts, or awaits
a `Latch` injects crashes, fence loss, and exact sequencing at any durable
transition point. The `after` firing only happens when the operation succeeds.
Effect-returning methods and plain `Effect` properties are hooked; non-Effect
members, such as `stream` and `project`, delegate untouched.

See [Test against a real journal](./guides/testing.md).

## Sequence allocation

`emitDurable` allocates both sequences inside the writer's transaction
(`MAX(seq) + 1`, taking the in-memory clock as a floor) and inserts the row
before returning, so the returned `seq` is already committed. Use it wherever a
caller acts on the returned sequence: lifecycle finalization, cross-process
supervisors, or any deployment where a second writer may open the same run. A
durable boundary must not advance the run or expose its result until this
commit returns.

`Seq` is canonical per-run replay order and `SourceSeq` identifies producer
retries. Rejected and dropped admissions may consume either sequence, so gaps
are valid: allocation is `MAX(seq) + 1` and replay is `ORDER BY seq`, so
neither reads a gap as anything.

## Idempotency equality

`(runId, sourceId, sourceSeq)` is the producer identity, unique in the database
and addressed by the deterministic `makeEventId`. Two emissions under one
identity are the same event when their event type and their canonically
encoded, redacted `payload` and `meta` match. The encoding sorts object keys,
so key order does not change the answer. An exact producer retry returns
`Duplicate` with `status: "committed"`; a reused producer sequence carrying
different content fails `idempotency_conflict` unless the input declares
`dedupe: "identity"`.

The persisted bytes are `JSON.stringify` semantics with object keys sorted: a
`Date` is its ISO string, an `undefined` member is dropped, `NaN` is `null`.
Sorting happens over the encoded JSON, never over the raw value, so
canonicalization cannot destroy anything the encoder would have kept.

Two consequences follow from comparing the persisted, redacted bytes. Two
different secrets that redact to the same placeholder are the same event to the
journal, and `NaN` and `null` are the same value. Comparing the pre-redaction
value instead would keep unredacted secrets resident in the in-process index,
which is the leak this package exists to prevent, and the durable re-check at
insert can only read the persisted bytes.

## transact

Committing an entry makes that entry durable; it does not by itself make a
host's whole view crash-consistent, because the executable state lives in the
neighboring stores: `RunStore` and `AttemptStore` in
[`@smthrs/run-store`](/api/run-store), `CacheStore` in
[`@smthrs/step-cache`](/api/step-cache), and `DurableEngineState` in
[`@smthrs/engine-store`](/api/engine-store). `transact` closes that seam: those stores write through the same `DurableWriter`, so their
writes join this transaction as savepoints and the row and its lifecycle entry
either both commit or both roll back.

Three properties matter to callers:

- **Publication follows COMMIT.** Inside a transaction, `emitDurable` returning
  means a savepoint was released. The `changes` and `stream` publish and the
  in-process producer index update are parked until the outermost transaction
  commits, so a subscriber never sees an entry that later rolls back, and a
  rolled-back producer identity stays re-emittable instead of deduplicating
  against a sequence that does not exist.
- **Only storage work belongs inside.** The transaction is held for its whole
  body: no flow bodies, host calls, or `flush`, which waits on the lossy writer
  and would deadlock against the open transaction.
- **Nesting is a savepoint.** An inner `transact` defers its settlements to the
  outermost commit.

A crash before COMMIT still loses the whole unit, so work that had already run,
an action body for instance, re-executes on the next drive. And no local
transaction makes a remote effect atomic, so external effects still need
idempotency keys, fencing tokens, or compensation. The transaction can also be
replayed by the database package's write retry, which is a second reason a body
must tolerate running more than once; see
[Commit state and its entry together](./guides/commit-state-and-entry.md#a-note-on-retries).

## Failure and loss

The two channels fail independently, and neither failure is permanent. A batch
the optimistic writer cannot persist is lost and reported: to the `flush`
waiters that covered it, to live `stream` consumers that were following when it
happened, and, if nobody was waiting, to the next `flush`. The writer fiber
survives it. Each loss is reported once; a later `flush` with nothing
outstanding succeeds, while entries queued behind the lost batch stay
outstanding, so a subsequent `flush` still waits for them instead of vouching
for unpersisted work. `emitDurable` was never gated by the queue: it opens its
own transaction inline, so the lossless lifecycle channel keeps working as soon
as the database is healthy again.

`changes` is a bounded sliding buffer sized by the layer's `capacity`: a slow
subscriber loses entries with no error and no gap signal. `stream` is the
lossless follower. Entries published to `changes` are frozen, so one subscriber
cannot mutate another's view.

Reads below a run's compaction floor fail with `compacted`. See
[Checkpoints and compaction](./concepts/compaction.md) and the
[`@smthrs/journal` error codes](/docs/reference/errors/#smthrsjournal).

## Resource limits

| Limit                                | Value                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- |
| admission queue and `changes` buffer | `capacity` entries                                                     |
| one entry                            | `maxEntryBytes` UTF-8 bytes of `payload` plus `meta`, unset by default |
| run ids, source ids, event types     | 1,024 UTF-16 code units                                                |
| `Seq`, `SourceSeq`                   | below `Number.MAX_SAFE_INTEGER`                                        |
| one `entries` page                   | `maxEntriesLimit`, 10,000 entries                                      |
| producer-idempotency index           | `sourceEventCache` entries, default 4,096                              |
| redaction traversal                  | `maxDepth`, 256 container edges                                        |
| binary view walk                     | `binaryWalkLimit`, 65,536 bytes or own members                         |

A payload deeper than `Redaction.maxDepth` fails `invalid_event` rather than
overflowing the stack, and the canonical encoder carries the same ceiling for a
caller who disables redaction.

## See also

- [State and event authority](./concepts/state-event-authority.md): shared
  bounded identities, `EngineEvent` schemas, constructors and consumer decoders.
- [Durable execution](/docs/concepts/durable-execution/) and
  [Execution IDs and ownership](/docs/concepts/ownership/).
- [`@smthrs/engine-store`](/api/engine-store), which composes this package with
  the run store and the step cache.
- [`@smthrs/chain`](/api/chain) has a journal of its own with a different
  contract; see [the chain journal](/pkg/chain/concepts/journal).

### Journal generations

`Journal.Service.generation?(runId)` returns an Effect of
`{ generation: number, afterSeq: number }` with `JournalError` failures.
Append-only adapters may omit it (generation zero). A truncating adapter must
advance it atomically with truncation so followers detect reused sequences.
`SqlJournal.layer` persists it in `flows_journal_generations`, installed through
`JournalGeneration.initialize`; a fresh run reports `{ generation: 0, afterSeq: -1 }`.

`JournalGeneration.forget(runIds)` invalidates live journal source identities and
allocation floors after a committed truncation, for every journal sharing the
SQL client. It requires `SqlClient`; it changes no durable rows. Producers must
be quiescent and pending lossy admissions flushed before truncation.
`JournalGeneration.onTruncate(callback)` registers an invalidator for the current
scope. `SqlJournal` registers automatically, and `SqlTimeTravelStore.archiveAndTruncate`
notifies after commit for the parent and attached descendants. Re-emitting an
archived lossy source identity is then admitted against the retained history.

## Native execution facts and human waits

`ExecutionFact.fold` verifies native run-local sequence/generation evidence and
reconstructs root identity, current trampoline lifecycle, and attached descendant
human waits. Current observations include the additive `treeVersion: 1`,
`parentPolicy`, and redacted `waiting.request`/`waiting.point` metadata. Detached
subtrees do not roll their questions into an ancestor's status. A settled wait
leaves the derived open-wait set.

`Provenance.humanWaits` distinguishes covered events from legacy or unverified
observations. Old version-1 facts lacking these fields cannot establish tree-wait
coverage. `humanWaitSources` records separate generation and baseline sequence
bounds for each native execution in the derived tree, so upgrading an old stream
does not claim question history before the extension first appeared. A missing
child stream, explicit gap, incompatible metadata, or question that differs from
the coherent observed tree refuses that coverage. The wait set compares by
execution identity and exact semantic values; adapter enumeration order does not
change coverage. The derived list orders by depth, creation time, and lexical ID.
The root/current semantic provenance also declines a complete event claim when
the requested tree comparison fails.

The fact is display evidence. Its token digest does not authorize a signal or
reconstruct an opaque resolver token. The gateway joins a verified question to
a currently observed wait with the same execution identity and digest, then
uses that current wait's existing submission envelope. A historical question
alone cannot make a gate answerable after the live wait has ended.
