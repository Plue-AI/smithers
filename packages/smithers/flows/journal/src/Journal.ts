/**
 * Logical journal contract with durable lifecycle and lossy telemetry channels.
 *
 * The ownership fence and the lossless `emitDurable` / lossy `emitLossy`
 * split are described at https://journal.smithers.sh/concepts/owner-fence/
 * and https://journal.smithers.sh/concepts/two-channels/.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { Entry, RunId, Seq, SourceSeq } from "./JournalEvent.ts"
import type { Input } from "./JournalEvent.ts"
import type { OwnerId } from "./OwnerId.ts"
import type { Projection } from "./Projection.ts"

/**
 * Defers a fold/cache update until the outermost durable write commits.
 * Returns false without running it when no managed commit is available.
 * Failed savepoints and retried transaction attempts never publish the update.
 *
 * @category transactions
 * @since 1.0.0
 */
export { afterCommit } from "@smthrs/database/DurableWriter"

/**
 * Stable error codes returned by journal operations.
 *
 * `read_failed` identifies a database failure on a durable read path. Callers
 * can distinguish that retryable storage condition from an unclassified
 * `unknown` journal defect.
 *
 * @category models
 * @since 0.1.0
 */
export const JournalErrorCode = Schema.Literals([
  "invalid_event",
  "idempotency_conflict",
  "sequence_conflict",
  "fence_lost",
  "queue_overflow",
  "journal_closed",
  "sink_failed",
  "read_failed",
  "decode_failed",
  "projection_failed",
  "checkpoint_invalid",
  "reader_behind",
  "compacted",
  "unknown"
])

/**
 * Stable error codes returned by journal operations.
 *
 * @category models
 * @since 0.1.0
 */
export type JournalErrorCode = typeof JournalErrorCode.Type

/**
 * Error raised by journal admission, persistence, replay, or projection.
 *
 * `checkpointSeq` is set on the compaction-aware codes: on `compacted` it is
 * the run's compaction floor, the checkpoint sequence a reader must resync
 * from, and on `reader_behind` it is the checkpoint a compaction refused to
 * truncate below.
 *
 * @category errors
 * @since 0.1.0
 */
export class JournalError extends Schema.TaggedError<JournalError>()("@smthrs/journal/JournalError", {
  code: JournalErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  checkpointSeq: Schema.optional(Seq)
}) {}

/**
 * Policy applied when the non-blocking admission queue is full.
 *
 * @category models
 * @since 0.1.0
 */
export const OverflowPolicy = Schema.Literals(["reject", "drop-newest", "drop-oldest"])

/**
 * Policy applied when the non-blocking admission queue is full.
 *
 * @category models
 * @since 0.1.0
 */
export type OverflowPolicy = typeof OverflowPolicy.Type

/**
 * Receipt for a newly admitted event.
 *
 * On the lossy channel, `seq` and `sourceSeq` are allocated synchronously and
 * returned before SQL commits. This `seq` is provisional: the SQL writer
 * moves it above the committed tail if another commit overtakes its reservation.
 * Use committed entries for durable cursors. On the durable channel, the same
 * receipt shape is returned only after the entry commits. `seq` orders the run;
 * `sourceSeq` identifies producer retries and does not change at commit.
 *
 * @category models
 * @since 0.1.0
 */
export const Accepted = Schema.TaggedStruct("Accepted", {
  seq: Seq,
  sourceSeq: SourceSeq,
  evicted: Schema.optionalKey(Schema.Struct({
    policy: Schema.Literal("drop-oldest"),
    count: Schema.Int.check(Schema.isGreaterThan(0))
  }))
})

/**
 * Receipt for a newly admitted event.
 *
 * @category models
 * @since 0.1.0
 */
export type Accepted = typeof Accepted.Type

/**
 * Receipt for an exact retry of an already pending or committed source event.
 *
 * `seq` is the original event's sequence, provisional while pending and
 * canonical after commit. A duplicate does not allocate another sequence or
 * enqueue another write. `status` distinguishes
 * an optimistic retry from one whose original event is already durable.
 *
 * @category models
 * @since 0.1.0
 */
export const Duplicate = Schema.TaggedStruct("Duplicate", {
  seq: Seq,
  sourceSeq: SourceSeq,
  status: Schema.Literals(["pending", "committed"])
})

/**
 * Receipt for an exact producer retry.
 *
 * @category models
 * @since 0.1.0
 */
export type Duplicate = typeof Duplicate.Type

/**
 * Receipt for an event discarded by an explicit dropping policy.
 *
 * A dropped admission still consumes its synchronously allocated `seq` and
 * `sourceSeq`, so sequence gaps are expected.
 *
 * @category models
 * @since 0.1.0
 */
export const Dropped = Schema.TaggedStruct("Dropped", {
  seq: Seq,
  sourceSeq: SourceSeq,
  policy: Schema.Literal("drop-newest")
})

/**
 * Receipt for an event discarded by policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Dropped = typeof Dropped.Type

/**
 * Receipt union for admission that may use the lossy queue.
 *
 * @category models
 * @since 0.1.0
 */
export const EmitReceipt = Schema.Union([Accepted, Duplicate, Dropped])

/**
 * Receipt union for the lossy channel.
 *
 * @category models
 * @since 0.1.0
 */
export type EmitReceipt = typeof EmitReceipt.Type

/**
 * Result of a synchronously durable journal admission.
 *
 * A durable admission is never dropped: it either commits, returns the
 * committed sequence of an exact producer retry, or fails.
 *
 * @category models
 * @since 0.1.0
 */
export const DurableReceipt = Schema.Union([Accepted, Duplicate])

/**
 * Receipt union for the durable channel.
 *
 * @category models
 * @since 0.1.0
 */
export type DurableReceipt = typeof DurableReceipt.Type

/**
 * Cursor used to replay a run and then follow its committed tail.
 *
 * @category models
 * @since 0.1.0
 */
export const StreamOptions = Schema.Struct({
  runId: RunId,
  afterSequence: Schema.optionalKey(Seq)
})

/**
 * Cursor used to replay a run and follow its committed tail.
 *
 * @category models
 * @since 0.1.0
 */
export type StreamOptions = typeof StreamOptions.Type

/**
 * Largest page `entries` will read.
 *
 * A page is decoded into memory in full before the caller sees its first
 * entry, so an unbounded limit lets one call materialize a whole run. The
 * largest page any caller in this repository asks for is 512, so this
 * ceiling refuses only a limit that was going to be a memory incident.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxEntriesLimit = 10_000

/**
 * Cursor and page size for durable journal reads.
 *
 * `limit` is at most `maxEntriesLimit` (10,000 entries). Optional `eventTypes`
 * selects a nonempty list of at most 64 exact types before pagination; cursors remain canonical run
 * sequences and `hasMore` describes matching entries. Omit it for the full run.
 * Filtering does not bypass the run's compaction floor.
 *
 * @category models
 * @since 0.1.0
 */
export const EntriesOptions = Schema.Struct({
  runId: RunId,
  after: Schema.optionalKey(Seq),
  eventTypes: Schema.optionalKey(
    Schema.Array(Entry.fields.eventType).check(Schema.isMinLength(1), Schema.isMaxLength(64))
  ),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxEntriesLimit))
})

/**
 * Cursor and page size for durable journal reads.
 *
 * @category models
 * @since 0.1.0
 */
export type EntriesOptions = typeof EntriesOptions.Type

/**
 * One page of canonical durable journal entries.
 *
 * @category models
 * @since 0.1.0
 */
export const EntriesPage = Schema.Struct({
  entries: Schema.Array(Entry),
  hasMore: Schema.Boolean
})

/**
 * One page of durable journal entries.
 *
 * @category models
 * @since 0.1.0
 */
export type EntriesPage = typeof EntriesPage.Type

/**
 * A durable checkpoint: the caller-captured state that replays a run from
 * `seq` without the entries before it.
 *
 * `state` is the caller's own replay snapshot and round-trips verbatim: the
 * journal never interprets it, and redaction deliberately does not apply,
 * exactly as it does not apply to executable state. A checkpoint at `seq`
 * must subsume every entry with a sequence at or below `seq`: replay is
 * `state` plus `stream({ runId, afterSequence: seq })`.
 *
 * `compactedAtMs` is `null` until a compaction has truncated the entries
 * strictly below `seq`. The largest compacted `seq` for a run is its
 * compaction floor.
 *
 * Prior art: Temporal's mutable state, a durable snapshot pinned to a
 * history offset, with history below it never replayed
 * (`reference/temporal/common/persistence/data_interfaces.go`,
 * `WorkflowSnapshot`).
 *
 * @category models
 * @since 0.1.0
 */
export class Checkpoint extends Schema.Class<Checkpoint>("@smthrs/journal/Journal/Checkpoint")({
  runId: RunId,
  seq: Seq,
  state: Schema.Unknown,
  createdAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  compactedAtMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
}) {}

/**
 * Arguments for writing a checkpoint.
 *
 * `seq` must name a committed entry of the run: the surviving row is what
 * keeps the run's durable `MAX(seq)` allocation floor at or above the
 * compaction boundary, so a process restarted after compaction can never
 * re-allocate a truncated sequence.
 *
 * @category models
 * @since 0.1.0
 */
export const CheckpointOptions = Schema.Struct({
  runId: RunId,
  seq: Seq,
  state: Schema.Unknown
})

/**
 * Arguments for writing a checkpoint.
 *
 * @category models
 * @since 0.1.0
 */
export type CheckpointOptions = typeof CheckpointOptions.Type

/**
 * Arguments for compacting a run.
 *
 * `upTo` selects the checkpoint to truncate below; omitted, the run's latest
 * checkpoint is used.
 *
 * @category models
 * @since 0.1.0
 */
export const CompactOptions = Schema.Struct({
  runId: RunId,
  upTo: Schema.optionalKey(Seq)
})

/**
 * Arguments for compacting a run.
 *
 * @category models
 * @since 0.1.0
 */
export type CompactOptions = typeof CompactOptions.Type

/**
 * Receipt for a completed compaction.
 *
 * `deleted` is `0` when the checkpoint was already the compaction floor, a
 * retried compaction is idempotent.
 *
 * @category models
 * @since 0.1.0
 */
export const Compacted = Schema.Struct({
  runId: RunId,
  checkpointSeq: Seq,
  deleted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * Receipt for a completed compaction.
 *
 * @category models
 * @since 0.1.0
 */
export type Compacted = typeof Compacted.Type

/**
 * Journal operations.
 *
 * There are two sequence domains:
 *
 * - `seq` is reserved synchronously per run. A lossy reservation is provisional;
 *   the SQL writer moves it above the committed tail if overtaken. The committed
 *   sequence is the canonical order for replay, paging, streams, and projections.
 * - `sourceSeq` is assigned synchronously per `(runId, sourceId)`, or supplied
 *   by the producer, and is the idempotency key for producer retries.
 *
 * Rejected or dropped admissions consume both allocations, so gaps are valid.
 * A retry the in-process index still holds returns `Duplicate` with the
 * original `seq` (provisional while pending) and consumes neither allocation.
 *
 * A retry it no longer holds is admitted optimistically and settled by
 * `UNIQUE (run_id, source_id, source_seq)` at the insert: admission issues no
 * dedup read, so the receipt is `Accepted`, the entry collapses onto the
 * committed row instead of doubling it, and a reused identity carrying
 * different bytes surfaces its `idempotency_conflict` through `flush` rather
 * than through the emit. The read is deliberately absent. `emitLossy` exists
 * to be callable from inside somebody else's open write transaction, and a
 * SELECT there waits on the writer that is waiting on the caller: the agent
 * executor's exit flush deadlocked exactly so. What a producer keeps in
 * exchange is the choice of what a collision means, through `Input.dedupe`.
 *
 * This table is Smithers' logical (domain) write-ahead log and is intended to
 * become the authoritative state history. The storage engine's own WAL
 * underneath it is a durability substrate only and is never consumed as the
 * application event API. A durable boundary must not advance a run or expose
 * its result until its lifecycle entry is committed. No local commit makes a
 * remote effect atomic, so external effects still need idempotency keys,
 * fencing tokens, or compensation.
 *
 * `emitDurable` allocates `seq` inside the writer's SQL transaction, so the
 * returned sequence is already committed and independent writers never fork
 * the per-run clock.
 *
 * Caveat on scope: the stores above this log (`RunStore`, `AttemptStore`,
 * `CacheStore`, and engine-store's `DurableEngineState`) hold the executable
 * authoritative state, and no state is derived from these entries today.
 * `transact` is what keeps the two halves consistent anyway: a state
 * transition and the lifecycle entry describing it are appended in ONE write
 * transaction, so a crash can never leave durable state the journal does not
 * explain (or an entry for a transition that never landed).
 *
 * The surface is split into two channels:
 *
 * - The lifecycle channel, `emitDurable`, returns `DurableReceipt`, so a
 *   dropped lifecycle event is unrepresentable: the write commits, dedupes, or
 *   fails with a typed error.
 * - The lossy channel, `emitLossy`, keeps the optimistic queue and its
 *   overflow policies for telemetry, where `Dropped` receipts and
 *   `drop-oldest` evictions are acceptable.
 *
 * `emitDurable` is fenced on the run's persisted ownership: the caller hands
 * over its `OwnerId`, the durable insert only commits while `flows_runs`
 * still records that owner, and a reclaimed run fails the write with a
 * `fence_lost` error. The fence is mandatory on the lifecycle channel: a
 * lifecycle write is what advances a run, and a zombie owner must not advance
 * anything. The one escape is {@link Service.emitDurableUnfenced}, for the
 * rare admission that is genuinely ownerless.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * The durable rewind generation and its archive boundary. An append-only
   * adapter may omit this operation, which means generation zero forever.
   * Rewinding adapters must advance the generation atomically with truncation.
   */
  readonly generation?:
    | ((runId: RunId) => Effect.Effect<{
      readonly generation: number
      readonly afterSeq: number
    }, JournalError>)
    | undefined
  readonly emitLossy: (input: Input) => Effect.Effect<EmitReceipt, JournalError>
  readonly emitDurable: (input: Input, owner: OwnerId) => Effect.Effect<DurableReceipt, JournalError>
  /**
   * The unfenced durable write: same durability and receipt contract as
   * {@link Service.emitDurable}, with no ownership fence.
   *
   * This exists ONLY for admissions that are genuinely ownerless: writes
   * whose correctness does not depend on who currently owns the run because
   * they are first-writer-wins by design. The canonical case is the
   * external-trigger admission: a deferred completion or clock-schedule
   * record delivered by a sweeper that owns nothing, where the dedup index,
   * not the fence, is the idempotency mechanism. A caller that holds an
   * `OwnerId` must use `emitDurable`; reaching for this channel to dodge a
   * `fence_lost` is exactly the zombie write the fence exists to reject.
   */
  readonly emitDurableUnfenced: (input: Input) => Effect.Effect<DurableReceipt, JournalError>
  /**
   * Runs `effect`, a state projection plus the `emitDurable` calls describing
   * it, inside ONE write transaction.
   *
   * This is the seam that makes the logical WAL crash-consistent with
   * executable state. The stores above the journal (`RunStore`,
   * `AttemptStore`, `CacheStore`, `DurableEngineState`) write through the same
   * `DurableWriter`, so their writes join this transaction as savepoints: either
   * the transition and its lifecycle entry both commit, or neither does. It is
   * the local analogue of Temporal closing mutable state into a mutation plus
   * event batches and submitting them as one persistence request
   * (`reference/temporal/service/history/workflow/transaction_impl.go`).
   *
   * A `Duplicate` receipt is unaffected: an exact producer retry still
   * collapses onto the already-committed sequence.
   *
   * Two consequences a caller must plan for:
   *
   * - Publication (`changes`, `stream`, and the in-process source-event index)
   *   is deferred until the transaction commits, so a subscriber never
   *   observes an entry that later rolls back, and a rolled-back producer
   *   identity stays re-emittable rather than deduplicating against a
   *   sequence that does not exist.
   * - Everything inside runs while a write transaction is open. Keep it to
   *   storage work: no flow bodies, no host calls, no waits.
   *
   * Nesting is safe: an inner `transact` becomes a savepoint of the outer
   * one and defers its publication to the outermost commit.
   */
  readonly transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | JournalError, R>
  /**
   * Publishes a short, non-failing process-local update after the current
   * transaction commits, or immediately when no transaction is open.
   *
   * Returns false without publishing inside a raw SQL transaction whose
   * commit this journal cannot observe. A true result can mean deferred, not
   * already run. Failed savepoints and retries discard their registrations.
   * Test doubles that implement transactions must preserve this contract.
   */
  readonly whenCommitted: (update: Effect.Effect<void>) => Effect.Effect<boolean>
  /**
   * Replays the run's durable history from `afterSequence`, then follows it.
   *
   * This is the lossless follower. It pages the history rather than
   * materializing it, so the first entry arrives after one page rather than
   * after the whole run; it reports a sink loss that happens while it is
   * following; and a cursor below the run's compaction floor fails with
   * `compacted` and the sequence to resync from, never a silently shortened
   * history.
   */
  readonly stream: (options: StreamOptions) => Stream.Stream<Entry, JournalError>
  /**
   * Reads one page of the run's durable history in sequence order.
   *
   * `hasMore` reports whether another page follows. A cursor below the run's
   * compaction floor fails with `compacted`, exactly as `stream` does, so a
   * poller and a follower cannot disagree about what history exists.
   */
  readonly entries: (options: EntriesOptions) => Effect.Effect<EntriesPage, JournalError>
  /**
   * Subscribes to entries this process commits, across every run.
   *
   * This is a bounded SLIDING buffer sized by the layer's `capacity`: a slow
   * consumer silently loses entries, with no error and no gap signal. Use it
   * for a local tail or a UI feed, and use `stream` wherever a missing entry
   * would be a correctness bug, because that is the lossless path and the one
   * that reports sink losses.
   *
   * Only this process's commits arrive here. Another writer on the same
   * database publishes into its own buffer, which is the second reason
   * `stream` exists: it rechecks the durable tail.
   *
   * Published entries are deeply frozen, so one subscriber cannot mutate the
   * value another subscriber is about to read.
   */
  readonly changes: Effect.Effect<PubSub.Subscription<Entry>, never, Scope.Scope>
  readonly project: <S, E, R>(
    projection: Projection<S, E, R>,
    options: StreamOptions
  ) => Stream.Stream<S, JournalError, R>
  readonly flush: Effect.Effect<void, JournalError>
  /**
   * Durably records the state that replays the run from `options.seq`.
   *
   * The write shares `transact`'s discipline: it runs through the same
   * `DurableWriter`, so inside an open `transact` it joins the caller's
   * transaction as a savepoint and rolls back with it. `options.seq` must
   * name a committed entry and must lie above the run's compaction floor;
   * otherwise the write fails with `checkpoint_invalid`. Re-checkpointing an
   * uncompacted `seq` replaces its state: last writer wins.
   *
   * The write is fenced on the run's persisted ownership, exactly as
   * `emitDurable` is: a reclaimed run fails with `fence_lost`. The fence is
   * mandatory: a zombie owner must not replace replay state behind a live
   * successor.
   */
  readonly checkpoint: (options: CheckpointOptions, owner: OwnerId) => Effect.Effect<Checkpoint, JournalError>
  /**
   * Reads the run's most recent checkpoint, compacted or not.
   *
   * A reader that fails with `compacted` resyncs here: apply
   * `checkpoint.state`, then continue from
   * `stream({ runId, afterSequence: checkpoint.seq })`.
   */
  readonly latestCheckpoint: (runId: RunId) => Effect.Effect<Option.Option<Checkpoint>, JournalError>
  /**
   * Deletes the run's entries strictly below a checkpoint, atomically with
   * advancing the run's compaction floor.
   *
   * Refusals are typed: `checkpoint_invalid` when the run has no checkpoint
   * to truncate below, `reader_behind` when a live in-process stream still
   * needs a sequence the truncation would delete, and `fence_lost` when the
   * supplied `owner` no longer holds the run. The fence is mandatory, so a
   * zombie owner can never truncate history behind a live successor. Readers
   * this process cannot see (pollers of `entries` and followers in other
   * processes) are protected by the read-side guard instead: any read whose cursor starts
   * below the floor fails with `compacted` and the floor to resync from,
   * never a silently shortened history.
   */
  readonly compact: (options: CompactOptions, owner: OwnerId) => Effect.Effect<Compacted, JournalError>
}

/**
 * Context service for durable lifecycle evidence and lossy telemetry.
 *
 * @category services
 * @since 0.1.0
 */
export class Journal extends Context.Service<Journal, Service>()("@smthrs/journal/Journal") {}

/**
 * Constructs a journal service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => Journal.of(implementation)

const unavailable = (method: string): JournalError =>
  new JournalError({
    code: "journal_closed",
    message: `${method} is unavailable`
  })

/**
 * Constructs a closed journal stub, optionally overriding individual methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const service: Service = {
    emitLossy: Effect.fn("Journal.emitLossy")(() => Effect.fail(unavailable("emitLossy"))),
    emitDurable: Effect.fn("Journal.emitDurable")(() => Effect.fail(unavailable("emitDurable"))),
    emitDurableUnfenced: Effect.fn("Journal.emitDurableUnfenced")(() =>
      Effect.fail(unavailable("emitDurableUnfenced"))
    ),
    /**
     * The closed stub has no sink and therefore no transaction to open, so it
     * runs the effect directly, the same posture as
     * `DurableEngineState`'s in-memory twin, whose `transaction` has no crash
     * window to close. A test double that models rollback overrides it.
     */
    transact: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | JournalError, R> => effect,
    whenCommitted: (update) => Effect.as(update, true),
    stream: (options) =>
      Stream.unwrap(
        Effect.fn("Journal.stream")((_options: StreamOptions) => Effect.succeed(Stream.fail(unavailable("stream"))))(
          options
        )
      ),
    entries: Effect.fn("Journal.entries")(() => Effect.fail(unavailable("entries"))),
    changes: Effect.acquireRelease(
      PubSub.sliding<Entry>(1),
      PubSub.shutdown
    ).pipe(Effect.flatMap(PubSub.subscribe)),
    project: (projection, options) =>
      Stream.unwrap(
        Effect.fn("Journal.project")(
          <S, E, R>(_projection: Projection<S, E, R>, _options: StreamOptions) =>
            Effect.succeed(Stream.fail(unavailable("project")))
        )(projection, options)
      ),
    flush: Effect.fn("Journal.flush")(() => Effect.fail(unavailable("flush")))(),
    checkpoint: Effect.fn("Journal.checkpoint")(() => Effect.fail(unavailable("checkpoint"))),
    latestCheckpoint: Effect.fn("Journal.latestCheckpoint")(() => Effect.fail(unavailable("latestCheckpoint"))),
    compact: Effect.fn("Journal.compact")(() => Effect.fail(unavailable("compact")))
  }
  return Journal.of({ ...service, ...overrides })
}

/**
 * Provides a closed journal stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Journal> =>
  Layer.succeed(Journal)(makeNoop(overrides))
