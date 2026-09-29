/**
 * SQLite-backed logical journal with durable and lossy channels.
 *
 * Lossy telemetry events remain optimistic until the single scoped writer
 * commits them, so a process crash can lose accepted-but-unwritten telemetry.
 * Lifecycle events use `emitDurable` and return after commit, except inside
 * `transact`, where their savepoint completes before the outer commit.
 *
 * Governing design: `packages/smithers/flows/journal/docs/concepts/two-channels.md`.
 * Prior-art decision: `packages/smithers/flows/sync/docs/concepts/replay-then-follow.md`.
 *
 * The replay-then-follow stream follows Effect's `EventJournal` and OpenCode's
 * upstream event stream design. The bounded send queue deliberately deviates
 * from their synchronous durable writes by reserving a provisional per-run
 * sequence before admission. Both channels finalize canonical order at commit.
 * SQLite retry and transaction behavior comes through `@smthrs/database`.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { afterCommit, DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import { Consensus } from "./Consensus.ts"
import {
  Checkpoint,
  CheckpointOptions,
  type Compacted,
  CompactOptions,
  type DurableReceipt,
  type EmitReceipt,
  EntriesOptions,
  type EntriesPage,
  Journal,
  JournalError,
  make as makeJournal,
  maxEntriesLimit,
  type OverflowPolicy,
  type Service,
  StreamOptions
} from "./Journal.ts"
import {
  type Dedupe,
  Entry,
  Input,
  makeEventId,
  RunId,
  type Seq,
  type SourceId,
  type SourceSeq
} from "./JournalEvent.ts"
import * as JournalGeneration from "./JournalGeneration.ts"
import * as JournalMetrics from "./JournalMetrics.ts"
import { OwnerId } from "./OwnerId.ts"
import type { Projection } from "./Projection.ts"
import * as Redaction from "./Redaction.ts"
import * as SqlConsensus from "./SqlConsensus.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * Automatic checkpoint-and-compact policy for the SQL journal.
 *
 * Disabled unless set on {@link SqlJournalOptions}. Once a run's committed
 * entry count reaches `entryThreshold`, the journal asks `capture` for the
 * caller's replay state at the run's durable tail, writes it as a checkpoint
 * at that sequence, and compacts the entries strictly below it.
 *
 * Both channels run the policy after their allocation permit is free. Lossy
 * commits fork scoped maintenance so the sole queue consumer keeps draining;
 * durable emits await their attempt. `flush` awaits registered maintenance.
 * `capture` may read or emit without blocking unrelated allocation. A capture is interrupted
 * after 30 seconds so caller code cannot wedge journal admission indefinitely.
 *
 * A failed or refused attempt (a live stream behind the boundary, a capture
 * failure) is logged at warning, damped for `entryThreshold`
 * further committed entries, and never surfaced to the emit that triggered
 * it.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompactionPolicy {
  readonly entryThreshold: number
  readonly capture: (runId: RunId, upTo: Seq) => Effect.Effect<unknown, unknown>
}

/**
 * SQL journal queue and batching options.
 *
 * @category models
 * @since 0.1.0
 */
export interface SqlJournalOptions {
  /**
   * Bound on the number of ENTRIES held in two places at once: the lossy
   * admission queue, where `overflow` decides what happens when it is full,
   * and the sliding `changes` buffer, where a slow subscriber silently loses
   * the entries that fall out of it.
   *
   * It bounds entries, not bytes. Set {@link SqlJournalOptions.maxEntryBytes}
   * to bound the size of one entry as well; with it unset a handful of very
   * large payloads is still the memory bill.
   */
  readonly capacity: number
  /** Policy applied when the lossy admission queue is full. */
  readonly overflow: OverflowPolicy
  /** Entries the queued writer commits per transaction. */
  readonly batchSize?: number | undefined
  /**
   * Upper bound on the in-process source-event index, the map that answers
   * producer idempotency from memory.
   *
   * The index is a cache, never the authority, and a MISS costs a receipt, not
   * correctness. On a miss for an explicit producer sequence the entry is
   * admitted optimistically without any read: `emitLossy` returns `Accepted`
   * where a resident entry would have returned `Duplicate`, and the insert
   * collapses onto the committed row through the unique index
   * `(run_id, source_id, source_seq)` rather than doubling it. A CHANGED retry
   * behind an evicted entry therefore surfaces `idempotency_conflict` from
   * `flush`, not from the emit. See `admitFromIndex` for why the read is gone:
   * `emitLossy` is called from inside other write transactions, and the
   * pre-admission SELECT deadlocked `@smthrs/agent`'s exit flush against the
   * engine's own writer, measured at over 120 s versus about half a second
   * without it.
   *
   * Bounding the cache keeps startup decode and resident memory O(bound) rather
   * than O(total events ever written), mirroring Temporal's refusal to hold
   * unbounded history in a shard (`service/history`). The separate
   * sequence-floor maps start empty and grow only with runs and producers this
   * layer instance touches; they are lazy, not governed by this bound.
   *
   * Idempotency compares canonical persisted JSON after redaction. Two inputs
   * that redact to the same value are therefore the same event, and JSON's
   * encoding intentionally treats `NaN` and `null` as the same `null` value.
   */
  readonly sourceEventCache?: number | undefined
  /**
   * Largest single entry the journal admits, measured in UTF-8 bytes of the
   * encoded `payload` plus `meta`.
   *
   * Unset by default, which means unbounded: `capacity` bounds how MANY entries
   * the admission queue and the `changes` buffer hold, never how large one is,
   * so without this a handful of multi-megabyte payloads is the memory bill,
   * and every one of them is replayed to each sync subscriber and time-travel
   * consumer on every read. Set it where the journal is fed by untrusted or
   * unbounded producers.
   *
   * The bound is checked after encoding and BEFORE any sequence is allocated or
   * anything is queued, so a refused entry costs no sequence and leaves no gap.
   * An entry over the bound fails `invalid_event`.
   */
  readonly maxEntryBytes?: number | undefined
  /**
   * Scrub applied to every `payload` and `meta` before it is encoded for
   * persistence.
   *
   * Journal rows are permanent and are replayed verbatim to sync subscribers
   * and time-travel consumers, so a credential that reaches `payload_json` is
   * a durable, broadly readable leak. Redaction therefore defaults to
   * `Redaction.make()`; pass `Redaction.makeNoop()` to persist payloads
   * verbatim by choice.
   */
  readonly redact?: Redaction.Redactor | undefined
  /**
   * Automatic checkpoint-and-compact policy. Off by default: without it the
   * journal never deletes an entry, and checkpointing stays a caller-driven
   * `checkpoint` / `compact` call.
   */
  readonly compaction?: CompactionPolicy | undefined
}

/** Default retained window of the source-event index. */
const defaultSourceEventCache = 4096

/** Bounds caller-supplied compaction capture work before the attempt is damped. */
const compactionCaptureTimeout = "30 seconds"

interface QueuedEntry {
  readonly runId: RunId
  readonly seq: Seq
  readonly eventId: string
  readonly sourceId: SourceId
  readonly sourceSeq: SourceSeq
  readonly emittedAtMs: number
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
  /** The producer's reading of a collision on this entry's identity. */
  readonly dedupe: Dedupe
}

interface JournalRow {
  readonly run_id: string
  readonly seq: number
  readonly event_id: string
  readonly source_id: string
  readonly source_seq: number
  readonly emitted_at_ms: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

interface CheckpointRow {
  readonly run_id: string
  readonly seq: number
  readonly state_json: string
  readonly created_at_ms: number
  readonly compacted_at_ms: number | null
}

interface Prepared {
  readonly validated: Input
  readonly payloadJson: string
  readonly metaJson: string
}

type Commit =
  | { readonly entry: Entry; readonly inserted: true }
  | { readonly entry: Pick<Entry, "seq">; readonly inserted: false }

interface SettledCommit {
  readonly queued: QueuedEntry
  readonly commit: Commit
}

interface EntryLoss {
  readonly queued: QueuedEntry
  readonly cause: JournalError
}

interface BatchOutcome {
  readonly commits: ReadonlyArray<SettledCommit>
  readonly losses: ReadonlyArray<EntryLoss>
}

interface RunBarrier {
  /**
   * Serializes one run's admission decisions against the moment a compaction
   * closes the run, so "read the gate, then admit" is one critical section.
   *
   * Never held across a wait on the database outside a transaction the holder
   * already owns; `admitFromIndex` in `SqlJournal.layer` states the lock order
   * between this permit and the writer transaction.
   */
  readonly semaphore: Semaphore.Semaphore
  /**
   * Serializes compactions of one run inside their SQL transactions. Never
   * held during the drain or while requesting a database connection.
   */
  readonly compactionLock: Semaphore.Semaphore
  /**
   * Serializes the compaction policy's per-run bookkeeping.
   *
   * A third lock rather than a reuse of either one above: the bookkeeping ends
   * by running a compaction, and a compaction takes `compactionLock` and
   * `semaphore` through `withCompactionBarrier`, so counting under either of
   * those would deadlock against the work it schedules. No admission path takes
   * this one.
   */
  readonly maintenance: Semaphore.Semaphore
  /** Holders and waiters that can still use this exact barrier. */
  users: number
  /** Open while a compaction owns the run; every admission awaits it. */
  compaction: Deferred.Deferred<void> | undefined
}

type RunAdmission<A> =
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Wait"; readonly gate: Deferred.Deferred<void> }

interface SourceEvent {
  readonly seq: Seq
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
  readonly status: "pending" | "committed"
}

type Status = "open" | "closing" | "closed"

interface State {
  status: Status
  /**
   * The most recent batch the optimistic writer lost. It is a *report*, not a
   * latch: the writer survives a failed batch, so a transient outage must not
   * revoke the lossy channel, and with it the durable delivery paths that call
   * `flush`, for the rest of the process's life.
   *
   * Each loss is reported to whoever was waiting on it (`flushWaiters`, live
   * streams) and, via `lossEpoch`, to at most one later `flush` and to every
   * live stream that had not yet observed it. After that the report is spent
   * and the journal is usable again the moment the database is.
   */
  sinkFailure: JournalError | undefined
  /** Incremented on every lost batch; identifies an unreported loss. */
  lossEpoch: number
  /** The highest `lossEpoch` already reported to a `flush` caller. */
  flushedLossEpoch: number
  pending: number
  readonly pendingByRun: Map<RunId, Set<QueuedEntry>>
  readonly sequences: Map<RunId, number>
  readonly sourceSequences: Map<string, number>
  readonly sourceEvents: Map<string, SourceEvent>
  readonly flushWaiters: Set<Deferred.Deferred<void, JournalError>>
}

const error = (code: JournalError["code"], message: string, cause?: unknown): JournalError =>
  new JournalError({
    code,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const sourceKey = (runId: RunId, sourceId: SourceId): string => `${runId.length}:${runId}${sourceId.length}:${sourceId}`

const sourceEventKey = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `${sourceKey(runId, sourceId)}:${sourceSeq}`

/**
 * Sorts a PARSED JSON tree so two encodings of one value compare equal.
 *
 * The argument is always `JSON.parse` output. That precondition is the whole
 * safety argument: parse output has no prototype `toJSON`, no cycle, and no
 * leaf JSON cannot represent, so this walk needs none of the handling
 * {@link Redaction.redact} carries. Running it over a raw value instead is
 * what broke: it rebuilt objects from `Object.keys`, so `{ at: new Date(...) }`
 * persisted as `{"at":{}}` under `Redaction.makeNoop()` while the default
 * redactor persisted the ISO string, and a redactor returning a cycle
 * recursed until the stack gave out and killed the emit with a defect instead
 * of a `JournalError`.
 *
 * `@smthrs/canonical` is the repository's general-purpose implementation, but
 * journal cannot add that dependency while this release's lockfiles are frozen.
 */
const canonicalizeFingerprint = (value: unknown, depth: number): unknown => {
  if (depth > Redaction.maxDepth) {
    throw new RangeError(`journal value nests deeper than ${Redaction.maxDepth} containers`)
  }
  if (Array.isArray(value)) return value.map((element) => canonicalizeFingerprint(element, depth + 1))
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalizeFingerprint(record[key], depth + 1)])
  )
}

/**
 * Encodes a value as JSON, reporting anything the encoder refuses as a typed
 * failure.
 *
 * The encoder's failure channel covers every value it declines, a `BigInt` and
 * a cycle included, so nothing here has to catch a throw. What used to reach
 * the emit as a `Die` came from the canonicalizer running BEFORE this, over a
 * raw value it was never given the guards for; {@link encodeFingerprint} runs
 * it after.
 */
const encodeJson = (value: unknown, field: string): Result.Result<string, JournalError> =>
  Schema.encodeUnknownResult(UnknownFromJsonString)(value).pipe(
    Result.mapError((cause) => error("invalid_event", `${field} must be JSON-serializable`, cause))
  )

/**
 * The persisted bytes of one field: JSON, with object members in a stable key
 * order.
 *
 * Encoding happens FIRST and canonicalization runs over the parsed result, so
 * the bytes keep exactly the `JSON.stringify` semantics they had before
 * idempotency became key-order independent: a `Date` is its ISO string, an
 * `undefined` member is dropped, `NaN` is `null`. Canonicalizing the raw value
 * instead silently destroyed every one of those.
 *
 * Nesting is bounded at `Redaction.maxDepth`, the same ceiling the default
 * redactor enforces one step earlier, so a value that reaches this walk through
 * `Redaction.makeNoop()` is refused as `invalid_event` rather than exhausting
 * the stack as a defect.
 */
const encodeFingerprint = (value: unknown, field: string): Result.Result<string, JournalError> =>
  Result.flatMap(encodeJson(value, field), (json) =>
    Result.try({
      try: () => JSON.stringify(canonicalizeFingerprint(JSON.parse(json), 0)),
      catch: (cause) => error("invalid_event", `${field} could not be canonicalized`, cause)
    }))

/**
 * Whether one write is fenced on a run's persisted ownership.
 *
 * The journal used to pass `OwnerId | undefined` and fence only when the value
 * happened to be present, so an untyped caller that omitted the argument
 * silently selected the unfenced path on three public methods. The tag makes
 * the choice explicit: only `emitDurableUnfenced` and the internal
 * auto-compaction path construct `unfenced`, and they say so at the call site.
 */
type Fence =
  | { readonly _tag: "Owned"; readonly owner: OwnerId }
  | { readonly _tag: "Unfenced" }

/** The one unfenced write posture, named so a call site cannot mean it by accident. */
const unfenced: Fence = { _tag: "Unfenced" }

const decodeOwner = Schema.decodeUnknownResult(OwnerId)

/**
 * Decodes the mandatory owner of a fenced method.
 *
 * A missing, null, or malformed owner is a caller contract violation, not a
 * lost race: reporting it as `fence_lost` would tell the caller another
 * process owns the run and send it looking for a conflict that never
 * happened.
 */
const requireFence = (owner: unknown, method: string): Result.Result<Fence, JournalError> =>
  Result.match(decodeOwner(owner), {
    onFailure: (cause) => Result.fail(error("invalid_event", `${method} requires a well-formed owner fence`, cause)),
    onSuccess: (value) => Result.succeed<Fence>({ _tag: "Owned", owner: value })
  })

const decodeInput = Schema.decodeUnknownResult(Input)
const decodeEntry = Schema.decodeUnknownEffect(Entry)
/**
 * The read and maintenance boundaries decode the schemas they publish.
 *
 * `EntriesOptions`, `StreamOptions`, `CheckpointOptions`, `CompactOptions` and
 * `RunId` already carry every invariant these methods need, and hand-checking a
 * subset of them here let the read side disagree with the write side about what
 * an identifier is.
 */
const decodeEntriesOptions = Schema.decodeUnknownResult(EntriesOptions)
const decodeStreamOptions = Schema.decodeUnknownResult(StreamOptions)
const decodeCheckpointOptions = Schema.decodeUnknownResult(CheckpointOptions)
const decodeCompactOptions = Schema.decodeUnknownResult(CompactOptions)
const decodeRunId = Schema.decodeUnknownResult(RunId)

const decodeRow = (row: JournalRow): Effect.Effect<Entry, JournalError> =>
  Effect.all({
    payload: Schema.decodeUnknownEffect(UnknownFromJsonString)(row.payload_json),
    meta: Schema.decodeUnknownEffect(UnknownFromJsonString)(row.meta_json)
  }).pipe(
    Effect.map(({ meta, payload }) => ({
      runId: row.run_id as RunId,
      seq: Number(row.seq),
      eventId: row.event_id,
      sourceId: row.source_id,
      sourceSeq: Number(row.source_seq),
      emittedAtMs: Number(row.emitted_at_ms),
      eventType: row.event_type,
      payload,
      meta
    })),
    Effect.flatMap(decodeEntry),
    Effect.mapError((cause) => error("decode_failed", "could not decode a durable journal row", cause))
  )

const decodeCheckpoint = Schema.decodeUnknownEffect(Checkpoint)

const decodeCheckpointRow = (row: CheckpointRow): Effect.Effect<Checkpoint, JournalError> =>
  Schema.decodeUnknownEffect(UnknownFromJsonString)(row.state_json).pipe(
    Effect.flatMap((state) =>
      decodeCheckpoint({
        runId: row.run_id,
        seq: Number(row.seq),
        state,
        createdAtMs: Number(row.created_at_ms),
        compactedAtMs: row.compacted_at_ms === null ? null : Number(row.compacted_at_ms)
      })
    ),
    Effect.mapError((cause) => error("decode_failed", "could not decode a durable checkpoint row", cause))
  )

/** Freezes the one object graph shared by every changes subscriber. */
const freezePublished = <A>(value: A): A => {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    /* v8 ignore next -- decoded JSON and Entry instances are acyclic, but this guard keeps the walk total */
    if (seen.has(node)) return
    seen.add(node)
    for (const key of Reflect.ownKeys(node)) {
      walk((node as Record<PropertyKey, unknown>)[key])
    }
    Object.freeze(node)
  }
  walk(value)
  return value
}

interface ValidatedOptions {
  readonly batchSize: number
  readonly sourceEventCache: number
  readonly maxEntryBytes: number | undefined
  readonly redact: Redaction.Redactor
}

/**
 * UTF-8 size of the bytes an entry persists.
 *
 * `TextEncoder` rather than `Buffer.byteLength` because this module has no
 * other `node:` import and the journal's browser-facing consumers bundle it.
 */
const encodedBytes = (encoder: TextEncoder, payloadJson: string, metaJson: string): number =>
  encoder.encode(payloadJson).length + encoder.encode(metaJson).length

const validateOptions = (options: SqlJournalOptions): Effect.Effect<ValidatedOptions, JournalError> =>
  Effect.suspend(() => {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      return Effect.fail(error("invalid_event", "capacity must be a positive safe integer"))
    }
    const batchSize = options.batchSize ?? Math.min(options.capacity, 64)
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      return Effect.fail(error("invalid_event", "batchSize must be a positive safe integer"))
    }
    const sourceEventCache = options.sourceEventCache ?? defaultSourceEventCache
    if (!Number.isSafeInteger(sourceEventCache) || sourceEventCache <= 0) {
      return Effect.fail(error("invalid_event", "sourceEventCache must be a positive safe integer"))
    }
    if (
      options.maxEntryBytes !== undefined &&
      (!Number.isSafeInteger(options.maxEntryBytes) || options.maxEntryBytes <= 0)
    ) {
      return Effect.fail(error("invalid_event", "maxEntryBytes must be a positive safe integer"))
    }
    if (
      options.compaction !== undefined &&
      (!Number.isSafeInteger(options.compaction.entryThreshold) || options.compaction.entryThreshold <= 0)
    ) {
      return Effect.fail(error("invalid_event", "compaction.entryThreshold must be a positive safe integer"))
    }
    return Effect.succeed({
      batchSize,
      sourceEventCache,
      maxEntryBytes: options.maxEntryBytes,
      redact: options.redact ?? Redaction.make()
    })
  })

const isJournalError = Schema.is(JournalError)

/**
 * Constructs the SQL journal over the context's SQL client, durable writer,
 * and consensus strategy.
 *
 * `emitLossy` validates and admits telemetry to the non-blocking queue;
 * `emitDurable` allocates and commits inside the database transaction, fenced
 * through `Consensus.guard` in that same transaction.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (
  options: SqlJournalOptions
): Effect.Effect<Service, JournalError, Consensus | DurableWriter | SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function*() {
    const { batchSize, maxEntryBytes, redact, sourceEventCache } = yield* validateOptions(options)
    // `batchSize` sizes the writer's transactions. `stream` pages the durable
    // tail through `entries`, whose `limit` is bounded by `maxEntriesLimit`,
    // so a larger batch must not leak into the read boundary: a layer that
    // was accepted with `batchSize: 16384` streamed nothing but
    // `invalid_event` before this clamp.
    const readPageSize = Math.min(batchSize, maxEntriesLimit)
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter
    const consensus = yield* Consensus
    yield* JournalGeneration.initialize.pipe(
      Effect.mapError((cause) => error("read_failed", "could not initialize journal generations", cause))
    )
    /** One encoder for the layer: constructing one per emit measured slower. */
    const byteCounter = new TextEncoder()

    // Hash the same encoded content the ordinary dedup check compares.
    // A JSON tuple keeps boundaries unambiguous without retaining payloads.
    const contentFingerprint = (eventType: string, payloadJson: string, metaJson: string) =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle.digest("SHA-256", byteCounter.encode(JSON.stringify([eventType, payloadJson, metaJson]))),
        catch: (cause) => error("sink_failed", "could not fingerprint journal content", cause)
      }).pipe(
        Effect.map((digest) =>
          Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
        )
      )

    const queue = yield* Queue.dropping<QueuedEntry>(options.capacity)
    const changes = yield* PubSub.sliding<Entry>(options.capacity)
    const wakes = new Map<RunId, Set<PubSub.PubSub<void>>>()
    /**
     * The durable cursor of every live in-process stream, per run: the
     * highest committed sequence the stream has read from the store, or its
     * starting `afterSequence`. `compact` refuses to truncate below a
     * registered cursor, so a live follower's next durable page is never
     * deleted out from under it. Readers this process cannot see, pagers
     * of `entries`, followers in other processes, are covered by the
     * read-side `compacted` guard instead.
     */
    const readers = new Map<RunId, Set<{ cursor: number }>>()
    /**
     * Only the most recent `sourceEventCache` events are decoded at startup.
     * Older events stay durable-only: their idempotency is enforced by the
     * writer's `(run_id, source_id, source_seq)` re-check, so the process
     * never has to hold the whole history to stay correct.
     */
    const sourceEventRows = yield* sql<JournalRow>`
        SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        FROM flows_journal_events
        ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC
        LIMIT ${sourceEventCache}
      `.pipe(
      Effect.mapError((cause) => error("sink_failed", "could not initialize journal source events", cause))
    )
    const durableEntries = yield* Effect.forEach(sourceEventRows, decodeRow)
    const initialized = yield* Effect.fromResult(
      Result.gen(function*() {
        // The two allocation floors start EMPTY and are filled one run at a
        // time by `ensureFloors`. They used to be seeded by two unbounded
        // `GROUP BY` aggregations, one entry per run that ever wrote an
        // event, one per `(run_id, source_id)` pair, so layer construction
        // scanned the whole table and built a map proportional to total
        // history, which is exactly what the bound below exists to avoid.
        const sequences = new Map<RunId, number>()
        const sourceSequences = new Map<string, number>()
        const sourceEvents = new Map<string, SourceEvent>()
        // Seeded oldest-first so the map's insertion order stays the
        // eviction order once `retain` starts adding newer events.
        for (const entry of [...durableEntries].reverse()) {
          if (
            !Number.isSafeInteger(entry.seq) ||
            !Number.isSafeInteger(entry.sourceSeq) ||
            entry.seq === Number.MAX_SAFE_INTEGER ||
            entry.sourceSeq === Number.MAX_SAFE_INTEGER
          ) {
            return yield* Result.fail(
              error("decode_failed", "durable event sequence is outside the allocatable safe integer range")
            )
          }
          sourceEvents.set(sourceEventKey(entry.runId, entry.sourceId, entry.sourceSeq), {
            seq: entry.seq,
            eventType: entry.eventType,
            payloadJson: yield* encodeFingerprint(entry.payload, "payload"),
            metaJson: yield* encodeFingerprint(entry.meta, "meta"),
            status: "committed"
          })
        }
        return {
          sequences,
          sourceSequences,
          sourceEvents
        }
      })
    )
    const state: State = {
      status: "open",
      sinkFailure: undefined,
      lossEpoch: 0,
      flushedLossEpoch: 0,
      pending: 0,
      pendingByRun: new Map(),
      sequences: initialized.sequences,
      sourceSequences: initialized.sourceSequences,
      sourceEvents: initialized.sourceEvents,
      flushWaiters: new Set()
    }
    // The permit protects only synchronous in-memory reservation. It must
    // never be held while waiting on SQLite: an enclosing `transact` owns a
    // database transaction, so DB -> allocator and allocator -> DB ordering
    // would otherwise deadlock concurrent lifecycle writers.
    const allocation = yield* Semaphore.make(1)
    // Close this scope AFTER the journal's flushing finalizer. Dynamically
    // forking directly into the layer scope would register interruption
    // finalizers ahead of the flush that must await these attempts.
    const maintenanceScope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(maintenanceScope, exit))
    let pendingMaintenance = 0
    const compactionCounts = new Map<RunId, number>()
    const compactingRuns = new Set<RunId>()
    const runBarriers = new Map<RunId, RunBarrier>()
    const runDrainWaiters = new Map<RunId, Set<Deferred.Deferred<void>>>()
    const activeWritesByRun = new Map<RunId, number>()

    const barrierFor = (runId: RunId): RunBarrier => {
      const existing = runBarriers.get(runId)
      if (existing !== undefined) return existing
      const created: RunBarrier = {
        semaphore: Semaphore.makeUnsafe(1),
        compactionLock: Semaphore.makeUnsafe(1),
        maintenance: Semaphore.makeUnsafe(1),
        users: 0,
        compaction: undefined
      }
      runBarriers.set(runId, created)
      return created
    }

    /** A waiter owns a reference too, before it can yield on any permit. */
    const withRunBarrier = <A, E, R>(
      runId: RunId,
      use: (barrier: RunBarrier) => Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const barrier = barrierFor(runId)
        barrier.users += 1
        return use(barrier).pipe(Effect.ensuring(Effect.sync(() => {
          barrier.users -= 1
        })))
      })

    /** Flush is the retirement boundary; allocation floors remain monotonic. */
    const retireQuiescentRuns = (): void => {
      for (const [runId, barrier] of runBarriers) {
        if (
          barrier.users > 0 || barrier.compaction !== undefined ||
          state.pendingByRun.has(runId) || activeWritesByRun.has(runId) ||
          runDrainWaiters.has(runId) || readers.has(runId) || wakes.has(runId) ||
          compactingRuns.has(runId)
        ) continue
        runBarriers.delete(runId)
        compactionCounts.delete(runId)
      }
    }

    /** Blocks new admissions while a compaction owns the run. */
    const withRunAdmission = <A, E, R>(
      runId: RunId,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      withRunBarrier(runId, (barrier) =>
        barrier.semaphore.withPermit(
          Effect.suspend((): Effect.Effect<RunAdmission<A>, E, R> => {
            const gate = barrier.compaction
            return gate === undefined
              ? Effect.map(effect, (value): RunAdmission<A> => ({ _tag: "Done", value }))
              : Effect.succeed<RunAdmission<A>>({ _tag: "Wait", gate })
          })
        ).pipe(
          Effect.flatMap((attempt): Effect.Effect<A, E, R> =>
            attempt._tag === "Done"
              ? Effect.succeed(attempt.value)
              : Deferred.await(attempt.gate).pipe(
                Effect.andThen(withRunAdmission(runId, effect))
              )
          )
        ))

    /** Acquires batch run permits in stable order so mixed-run batches cannot deadlock. */
    const withRunPermits = <A, E, R>(
      runIds: ReadonlyArray<RunId>,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> => {
      const ordered = [...new Set(runIds)].sort()
      const acquire = (index: number): Effect.Effect<A, E, R> =>
        index === ordered.length
          ? effect
          : withRunBarrier(ordered[index]!, (barrier) => barrier.semaphore.withPermit(acquire(index + 1)))
      return acquire(0)
    }

    const admitRunPending = (queued: QueuedEntry): void => {
      const pending = state.pendingByRun.get(queued.runId) ?? new Set<QueuedEntry>()
      pending.add(queued)
      state.pendingByRun.set(queued.runId, pending)
    }

    const completeRunDrain = (runId: RunId): void => {
      if ((state.pendingByRun.get(runId)?.size ?? 0) + (activeWritesByRun.get(runId) ?? 0) > 0) return
      const waiters = runDrainWaiters.get(runId)
      runDrainWaiters.delete(runId)
      for (const waiter of waiters ?? []) {
        Deferred.doneUnsafe(waiter, Effect.void)
      }
    }

    const settleRunPending = (batch: ReadonlyArray<QueuedEntry>): void => {
      for (const queued of batch) {
        // Every batched entry was counted by `admitRunPending` when it was
        // admitted, so the run always has a count to settle here.
        const pending = state.pendingByRun.get(queued.runId)!
        pending.delete(queued)
        if (pending.size > 0) continue
        state.pendingByRun.delete(queued.runId)
        completeRunDrain(queued.runId)
      }
    }

    const endRunWrite = (runId: RunId): void => {
      // `withActiveRunWrite` counted this write in before running it, and
      // releases through here exactly once.
      const remaining = activeWritesByRun.get(runId)! - 1
      if (remaining > 0) {
        activeWritesByRun.set(runId, remaining)
        return
      }
      activeWritesByRun.delete(runId)
      completeRunDrain(runId)
    }

    /**
     * Register only INSIDE the writer transaction, after SQL acquisition.
     * A parked writer has touched neither SQL nor the allocation floors, so
     * the SQL lock orders it after the compactor's commit. It then allocates
     * its canonical seq above the surviving checkpoint/tail. An explicit
     * sourceSeq chosen earlier is an identity, not a replay cursor; the
     * insert still checks that identity against rows and retained tombstones.
     * No SQL owner may drain a writer parked on that owner's connection.
     */
    const withActiveRunWrite = <A, E, R>(
      runId: RunId,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      withRunBarrier(runId, () =>
        Effect.suspend(() => {
          activeWritesByRun.set(runId, (activeWritesByRun.get(runId) ?? 0) + 1)
          return effect.pipe(Effect.ensuring(Effect.sync(() => endRunWrite(runId))))
        }))

    const awaitRunDrained = (runId: RunId): Effect.Effect<void> =>
      Effect.suspend(() => {
        if ((state.pendingByRun.get(runId)?.size ?? 0) + (activeWritesByRun.get(runId) ?? 0) === 0) {
          return Effect.void
        }
        const waiter = Deferred.makeUnsafe<void>()
        const waiters = runDrainWaiters.get(runId) ?? new Set()
        waiters.add(waiter)
        runDrainWaiters.set(runId, waiters)
        // No cleanup on the way out: `completeRunDrain` deletes the whole
        // set as it completes it, and an interrupted waiter is a Deferred
        // nobody awaits that the next drain of this run discards. Deleting
        // it here would only add an unreachable branch.
        return Deferred.await(waiter)
      })

    /**
     * Top-level compaction drains with admission OPEN, acquires SQL before
     * either run lock or the gate, then rechecks the drain. Raced work makes
     * it release SQL and retry. No connection owner waits on work needing SQL.
     *
     * An enclosing managed OR raw SQL transaction cannot release its SQL by
     * returning from our savepoint. Skip both drains there and persist this
     * run's pending entries inline, using the batch insert path under the
     * same transaction and gate. The pending set includes entries already
     * taken by the batch fiber but still waiting for SQL. Keep them queued
     * and counted until that fiber settles: rollback must leave its work
     * intact, and after commit it collapses onto the inline inserts by identity.
     * Publication is owned by the outer commit, exactly as for durable emits.
     * Raw SQL has no managed publication boundary; replay remains authoritative.
     *
     * A reservation allocated before compaction is NOT a committed cursor.
     * The inline insert raises its canonical seq above the durable tail,
     * even if its reservation is below the checkpoint being compacted. Thus
     * it survives replay after that checkpoint with its source identity and
     * content checks unchanged. Leaving it queued without inserting would
     * instead let the new floor reject the old reservation as `compacted`.
     * Already compacted reservations retain that existing loss behavior.
     *
     * The final drain check and gate closure share a short admission permit,
     * released before SQL work. Cold floor reads hold no run permit. Durable
     * writes register only after SQL acquisition. Concurrent compactors also
     * acquire SQL before their compaction lock. All gates/locks unwind before
     * retry or cancellation; no run lock or closed gate waits for SQL.
     */
    const withCompactionBarrier = <A, E, R>(
      runId: RunId,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R> =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (enclosing) =>
        withRunBarrier(runId, (barrier) => {
          const nested = Option.isSome(enclosing)
          const attempt: Effect.Effect<A, Exclude<E, SqlError.SqlError> | DatabaseError, R> =
            (nested ? Effect.void : awaitRunDrained(runId)).pipe(
              Effect.andThen(writer.write(
                barrier.compactionLock.withPermit(Effect.uninterruptibleMask((restore) =>
                  barrier.semaphore.withPermit(Effect.sync(() => {
                    if (
                      !nested && (state.pendingByRun.get(runId)?.size ?? 0) + (activeWritesByRun.get(runId) ?? 0) > 0
                    ) {
                      return undefined
                    }
                    const gate = Deferred.makeUnsafe<void>()
                    barrier.compaction = gate
                    return gate
                  })).pipe(Effect.flatMap((gate) =>
                    gate === undefined ?
                      Effect.succeed(Option.none<A>()) :
                      restore(Effect.gen(function*() {
                        if (nested) {
                          const outcome = yield* insertBatch([...state.pendingByRun.get(runId) ?? []])
                          // The batch still owns loss reporting and pending
                          // settlement; neither may escape an outer rollback.
                          for (const { queued, commit } of outcome.commits) {
                            yield* settleCommit(queued, commit, restore)
                          }
                        }
                        return yield* Effect.asSome(effect)
                      })).pipe(Effect.ensuring(Effect.sync(() => {
                        barrier.compaction = undefined
                        Deferred.doneUnsafe(gate, Effect.void)
                      })))
                  ))
                ))
              )),
              Effect.flatMap((result) =>
                Option.isSome(result) ? Effect.succeed(result.value) : attempt
              )
            )
          return attempt
        }))

    /**
     * Raises the in-process seq allocation floor for a run.
     *
     * Both emit paths call this at the moment they allocate, so the floor
     * never names a seq some writer has already taken. It used to move only
     * in `rememberCommitted`, which `settleCommit` parks until the outermost
     * COMMIT, so a durable emit inside an open `transact` left the floor
     * behind, `emitLossy` allocated the same seq from it, and the lossy
     * INSERT hit `PRIMARY KEY (run_id, seq)`.
     *
     * The floor only ever rises. `insertOne` can settle on a raced duplicate
     * whose row was written by another process at a higher seq, and that
     * still has to raise the floor here.
     */
    const raiseSequenceFloor = (runId: RunId, seq: number): void => {
      state.sequences.set(runId, Math.max(state.sequences.get(runId) ?? 0, seq + 1))
    }

    /** Raises the in-process producer-sequence allocation floor. */
    const raiseSourceSequenceFloor = (runId: RunId, sourceId: SourceId, sourceSeq: number): void => {
      const key = sourceKey(runId, sourceId)
      state.sourceSequences.set(key, Math.max(state.sourceSequences.get(key) ?? 0, sourceSeq + 1))
    }

    /**
     * Adds an entry to the bounded source-event index, evicting the
     * least-recently added *committed* entry when the bound is exceeded.
     *
     * Uncommitted entries are never evicted: they are not in the database
     * yet, so memory is the only place their identity exists. Committed ones
     * are always re-derivable from `flows_journal_events`, which is what
     * makes the bound safe.
     */
    const retain = (identity: string, event: SourceEvent): void => {
      state.sourceEvents.delete(identity)
      state.sourceEvents.set(identity, event)
      if (state.sourceEvents.size <= sourceEventCache) {
        return
      }
      for (const [candidate, retained] of state.sourceEvents) {
        if (retained.status !== "committed" || candidate === identity) {
          continue
        }
        state.sourceEvents.delete(candidate)
        return
      }
    }

    const completeFlushWaiters = (exit: Effect.Effect<void, JournalError>): void => {
      const waiters = Array.from(state.flushWaiters)
      state.flushWaiters.clear()
      for (const waiter of waiters) {
        Deferred.doneUnsafe(waiter, exit)
      }
    }

    const flushInternal: Effect.Effect<void, JournalError> = Effect.suspend(() => {
      // A loss that happened while nothing was registered still has to reach
      // a caller, so the first flush after it reports it, once. A later
      // flush has nothing to do with the lost batch and must succeed, or a
      // single transient outage would stall every durable delivery that
      // flushes (`DeferredPersistence.completeDeferred`, `recordClockScheduled`)
      // for the process's lifetime.
      if (state.sinkFailure !== undefined && state.lossEpoch > state.flushedLossEpoch) {
        state.flushedLossEpoch = state.lossEpoch
        return Effect.fail(state.sinkFailure)
      }
      if (state.status === "closed") {
        return Effect.fail(error("journal_closed", "journal is closed"))
      }
      if (state.pending === 0 && pendingMaintenance === 0) {
        return Effect.void
      }
      const waiter = Deferred.makeUnsafe<void, JournalError>()
      state.flushWaiters.add(waiter)
      return Deferred.await(waiter).pipe(
        Effect.ensuring(Effect.sync(() => {
          state.flushWaiters.delete(waiter)
        }))
      )
    }).pipe(Effect.ensuring(Effect.sync(retireQuiescentRuns)))

    const prepare = (input: Input, emittedAtMs: number): Result.Result<Prepared, JournalError> =>
      Result.gen(function*() {
        if (state.status !== "open") {
          return yield* Result.fail(error("journal_closed", "journal is closed"))
        }
        // `RunId`, `SourceId`, and `Input.eventType` carry the non-empty and
        // well-formed-UTF-16 checks themselves, so decode is the whole
        // identifier contract. The service used to re-check emptiness here,
        // which let a caller hold an identifier that decoded and then failed
        // at the write.
        const validated = yield* Result.mapError(
          decodeInput(input),
          (cause) => error("invalid_event", "event violates the journal input contract", cause)
        )
        if (!Number.isSafeInteger(emittedAtMs) || emittedAtMs < 0) {
          return yield* Result.fail(
            error("invalid_event", "emittedAtMs must be a non-negative safe integer")
          )
        }
        // Redaction happens here, at the single point every channel funnels
        // through, so no write path can bypass it (issue #46). A redaction
        // failure carries no cause: whatever the redactor or a hostile getter
        // threw can quote the unredacted value, and that value never reached
        // the journal, so the error must not be the place it leaks from.
        const redactedPayload = yield* Result.try({
          try: () => redact(validated.payload),
          catch: () => error("invalid_event", "payload could not be redacted")
        })
        const redactedMeta = yield* Result.try({
          try: () => redact(validated.meta ?? null),
          catch: () => error("invalid_event", "meta could not be redacted")
        })
        const payloadJson = yield* encodeFingerprint(redactedPayload, "payload")
        const metaJson = yield* encodeFingerprint(redactedMeta, "meta")
        // Measured on the encoded bytes, and here rather than at admission,
        // so a refused entry costs no sequence and leaves no gap in the run.
        if (maxEntryBytes !== undefined) {
          const bytes = encodedBytes(byteCounter, payloadJson, metaJson)
          if (bytes > maxEntryBytes) {
            return yield* Result.fail(
              error(
                "invalid_event",
                `event is ${bytes} bytes, over the ${maxEntryBytes}-byte maxEntryBytes bound`
              )
            )
          }
        }
        return { validated, payloadJson, metaJson }
      })

    const compareSourceEvent = (
      prepared: Prepared,
      sourceSeq: SourceSeq,
      existing: SourceEvent
    ): Result.Result<EmitReceipt, JournalError> => {
      const { metaJson, payloadJson, validated } = prepared
      if (
        validated.dedupe !== "identity" && (
          existing.eventType !== validated.eventType ||
          existing.payloadJson !== payloadJson ||
          existing.metaJson !== metaJson
        )
      ) {
        return Result.fail(error(
          "idempotency_conflict",
          `source event ${validated.sourceId}:${sourceSeq} for run ${validated.runId} was reused with different content`
        ))
      }
      return Result.succeed({
        _tag: "Duplicate",
        seq: existing.seq,
        sourceSeq,
        status: existing.status
      })
    }

    /**
     * Answers an explicit producer identity from memory alone, before
     * anything is allocated.
     *
     * This performs NO read. That is the whole point of it: `emitLossy` is
     * the channel a producer reaches for precisely because it may be called
     * from inside somebody else's open write transaction, and this used to
     * issue a SELECT here for every explicit sequence. The executor's exit
     * flush in `@smthrs/agent` runs inside the engine's write transaction,
     * so that read waited on the writer that was waiting on the flush and
     * the run stalled at 0% CPU: measured, that case did not finish in
     * 120 s with the read and takes about half a second without it. What the
     * read used to answer, a producer identity that is already durable but
     * no longer in the bounded index, the unique index
     * `(run_id, source_id, source_seq)` answers at insert time instead: the
     * queued insert runs first and reads only the row it actually collided
     * with, inside the writer's own transaction where a read cannot
     * deadlock against it.
     *
     * A cache miss therefore admits optimistically. The receipt is
     * `Accepted` where it would once have been `Duplicate`, which the lossy
     * channel already allows for: `Accepted` is admission to the queue, not
     * a commit, and the entry still collapses onto the committed row rather
     * than doubling it.
     *
     * Lock order: lossy admission checks cached identities without SQL,
     * reads cold allocation floors outside run permits on a miss, then
     * rechecks the identity and reserves sequences under
     * the permit using max(read floor, in-memory floor). Durable writers
     * raise those caches at allocation time and take no run permit. Batches
     * take the writer transaction before run permits, so their SQL already
     * owns the connection. Compaction drains with admission open, acquires
     * SQL before its run locks, then rechecks the drain and closes the gate.
     * At top level, raced work makes it release SQL and drain again. Inside
     * an enclosing transaction it persists pending entries inline instead;
     * draining there would wait on work needing its own connection. Durable
     * writes register as active only after acquiring SQL. No permit or
     * closed gate ever waits for a SQL connection, and
     * a transaction-owning producer cannot encounter a compactor's gate or
     * permit: that compactor cannot acquire SQL until the producer commits.
     *
     * Reading floors under a permit would invert the batch's order: a new
     * producer waits on the batch's connection while the batch waits on its
     * permit. Moving batch permits before the transaction would instead
     * block even readless admission from inside an enclosing transaction.
     * Keep floor reads outside permits and collision reads inside the
     * writer transaction. `ensureFloors` documents cache lifetime, including
     * the quiescent truncation contract that permits floor invalidation.
     */
    const admitFromIndex = (prepared: Prepared): Result.Result<EmitReceipt | undefined, JournalError> => {
      const { validated } = prepared
      const sourceSeq = validated.sourceSeq
      if (sourceSeq === undefined) return Result.succeed(undefined)
      if (
        !Number.isSafeInteger(sourceSeq) ||
        sourceSeq < 0 ||
        sourceSeq === Number.MAX_SAFE_INTEGER
      ) {
        return Result.fail(
          error("invalid_event", "journal sequence is outside the allocatable safe integer range")
        )
      }
      const cached = state.sourceEvents.get(sourceEventKey(validated.runId, validated.sourceId, sourceSeq))
      return cached === undefined ? Result.succeed(undefined) : compareSourceEvent(prepared, sourceSeq, cached)
    }

    /**
     * The in-memory half of a lossy admission: the identity check, the
     * allocation, and the queue offer. It runs under the run permit and
     * performs no I/O there; `admitFromIndex` documents the lock order that
     * keeps.
     */
    const admitQueued = (
      prepared: Prepared,
      floors: { readonly seq: number; readonly sourceSeq: number },
      emittedAtMs: number
    ): Effect.Effect<EmitReceipt, JournalError> =>
      Effect.suspend(() => {
        // Preparation precedes the floor read and admission waits. Check
        // closure and the identity again only after acquiring the permit,
        // before allocating or returning a cached duplicate.
        if (state.status !== "open") {
          return Effect.fail(error("journal_closed", "journal is closed"))
        }
        return Effect.flatMap(
          Effect.fromResult(admitFromIndex(prepared)),
          (indexed) =>
            indexed !== undefined
              ? Effect.succeed(indexed)
              : allocation.withPermit(Effect.fromResult(
                Result.gen(function*() {
                  const { metaJson, payloadJson, validated } = prepared
                  const key = sourceKey(validated.runId, validated.sourceId)
                  const nextSourceSeq = Math.max(
                    floors.sourceSeq,
                    state.sourceSequences.get(key) ?? 0
                  )
                  // An explicit producer sequence was validated by
                  // `admitFromIndex`, and an implicit one is the floor
                  // `ensureFloors` already proved to be a non-negative
                  // safe integer. Only exhaustion is left: the allocator
                  // cannot advance past MAX_SAFE_INTEGER, and neither can
                  // the identity that follows it.
                  const sourceSeq: SourceSeq = validated.sourceSeq ?? (nextSourceSeq as SourceSeq)
                  if (sourceSeq === Number.MAX_SAFE_INTEGER) {
                    return yield* Result.fail(
                      error(
                        "invalid_event",
                        "journal sequence is outside the allocatable safe integer range"
                      )
                    )
                  }
                  const nextSeq = Math.max(
                    floors.seq,
                    state.sequences.get(validated.runId) ?? 0
                  )
                  if (nextSeq === Number.MAX_SAFE_INTEGER) {
                    return yield* Result.fail(
                      error(
                        "invalid_event",
                        "journal sequence is outside the allocatable safe integer range"
                      )
                    )
                  }
                  const seq = nextSeq as Seq
                  raiseSequenceFloor(validated.runId, seq)
                  state.sourceSequences.set(key, Math.max(nextSourceSeq, sourceSeq + 1))

                  const queued: QueuedEntry = {
                    runId: validated.runId,
                    seq,
                    eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                    sourceId: validated.sourceId,
                    sourceSeq,
                    emittedAtMs,
                    eventType: validated.eventType,
                    payloadJson,
                    metaJson,
                    dedupe: validated.dedupe ?? "content"
                  }
                  let evicted: QueuedEntry | undefined
                  if (Queue.sizeUnsafe(queue) >= options.capacity && options.overflow === "drop-oldest") {
                    const exit = Queue.takeUnsafe(queue)
                    /* v8 ignore next -- size and take run synchronously while the journal and queue are open */
                    if (exit === undefined || !Exit.isSuccess(exit)) {
                      return yield* Result.fail(
                        error("journal_closed", "journal admission queue is unavailable")
                      )
                    }
                    evicted = exit.value
                    const evictedIdentity = sourceEventKey(
                      evicted.runId,
                      evicted.sourceId,
                      evicted.sourceSeq
                    )
                    state.sourceEvents.delete(evictedIdentity)
                    state.pending = Math.max(0, state.pending - 1)
                    settleRunPending([evicted])
                  }
                  const accepted = Queue.offerUnsafe(queue, queued)
                  if (!accepted) {
                    if (options.overflow === "reject") {
                      return yield* Result.fail(
                        error("queue_overflow", "journal admission queue is full")
                      )
                    }
                    return {
                      _tag: "Dropped",
                      seq,
                      sourceSeq,
                      policy: "drop-newest"
                    } satisfies EmitReceipt
                  }

                  retain(sourceEventKey(validated.runId, validated.sourceId, sourceSeq), {
                    seq,
                    eventType: validated.eventType,
                    payloadJson,
                    metaJson,
                    status: "pending"
                  })
                  state.pending += 1
                  admitRunPending(queued)
                  if (evicted !== undefined) {
                    return {
                      _tag: "Accepted",
                      seq,
                      sourceSeq,
                      evicted: {
                        policy: "drop-oldest",
                        count: 1
                      }
                    } satisfies EmitReceipt
                  }
                  return {
                    _tag: "Accepted",
                    seq,
                    sourceSeq
                  } satisfies EmitReceipt
                })
              ))
        )
      })

    const queuedEmit: Service["emitLossy"] = Effect.fn("Journal.emitLossy")((input: Input) =>
      Effect.annotateCurrentSpan({
        runId: input.runId,
        sourceId: input.sourceId,
        eventType: input.eventType
      }).pipe(
        Effect.andThen(Clock.currentTimeMillis.pipe(Effect.map(Math.floor))),
        Effect.flatMap((emittedAtMs) =>
          Effect.flatMap(
            withRunAdmission(
              input.runId,
              Effect.suspend(() =>
                Effect.fromResult(Result.gen(function*() {
                  const prepared = yield* prepare(input, emittedAtMs)
                  const indexed = yield* admitFromIndex(prepared)
                  return { prepared, indexed }
                }))
              )
            ),
            ({ prepared, indexed }) =>
              // A cached duplicate needs neither allocation floor, including
              // after startup when the identity index is warm but floors are
              // cold. On a miss, release the permit before reading SQL, then
              // recheck identity and allocation under a fresh admission.
              indexed !== undefined ? Effect.succeed(indexed) : Effect.flatMap(
                ensureFloors(prepared.validated),
                (floors) => withRunAdmission(prepared.validated.runId, admitQueued(prepared, floors, emittedAtMs))
              )
          )
        ),
        Effect.tap((receipt) => Metric.update(JournalMetrics.lossy[receipt._tag], 1))
      )
    )

    /**
     * The run's compaction floor: the largest checkpoint sequence whose
     * lower entries have been truncated, or `undefined` while the run has
     * never been compacted.
     */
    const compactionFloor = (runId: RunId): Effect.Effect<number | undefined, SqlError.SqlError> =>
      Effect.map(
        sql<{ readonly floor: number | null }>`
            SELECT MAX(seq) AS floor FROM flows_journal_checkpoints
            WHERE run_id = ${runId} AND compacted_at_ms IS NOT NULL
          `,
        (rows) => {
          const floor = rows[0]?.floor
          return floor === null || floor === undefined ? undefined : Number(floor)
        }
      )

    const readPage: Service["entries"] = Effect.fn("Journal.entries")((pageOptions) =>
      Effect.gen(function*() {
        // Snapshot the caller-owned list before the first suspension so its
        // validated bound is also the bound passed to the SQL client.
        const options = {
          ...pageOptions,
          ...(Array.isArray(pageOptions.eventTypes)
            ? { eventTypes: [...pageOptions.eventTypes] } :
            {})
        }
        yield* Effect.annotateCurrentSpan({
          runId: options.runId,
          limit: options.limit,
          ...(options.eventTypes === undefined ? {} : { eventTypes: options.eventTypes }),
          ...(options.after === undefined ? {} : { after: options.after })
        })
        // `EntriesOptions` already carries every one of these invariants: a
        // well-formed non-empty `runId`, a `Seq` cursor, and a `limit`
        // between 1 and `maxEntriesLimit`. Hand-checking them here let the
        // read boundary disagree with the write boundary, and it did: a
        // lone-surrogate run id was refused at `emit` and answered with an
        // empty page at `entries`.
        yield* Effect.fromResult(Result.mapError(
          decodeEntriesOptions(options),
          (cause) => error("invalid_event", "entries options violate the journal read contract", cause)
        ))
        const after = options.after ?? -1
        // With several types SQLite can prefer the run/sequence index to
        // avoid sorting, scanning every unrelated event instead. Require
        // the journal-owned type index; only matching rows may be sorted.
        const rows = yield* (options.eventTypes === undefined ?
          sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${options.runId} AND seq > ${after}
            ORDER BY seq ASC
            LIMIT ${options.limit + 1}
          ` :
          sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events ${Dialect.indexHint(sql, "flows_journal_events_run_event_type_idx")}
            WHERE run_id = ${options.runId} AND ${sql.in("event_type", options.eventTypes)} AND seq > ${after}
            ORDER BY seq ASC
            LIMIT ${options.limit + 1}
          `).pipe(
            Effect.mapError((cause) => error("read_failed", "durable journal read failed", cause))
          )
        // The floor is read AFTER the page. Truncation and the floor
        // advance commit atomically, so any deletion that could have
        // shortened the page above is visible in this floor read, and a
        // cursor at or above `floor - 1` therefore read a complete page.
        // The converse order would let a compaction commit between the two
        // reads and hand back a silently gapped history.
        const floor = yield* compactionFloor(options.runId).pipe(
          Effect.mapError((cause) => error("read_failed", "durable journal read failed", cause))
        )
        if (floor !== undefined && after < floor - 1) {
          return yield* Effect.fail(
            new JournalError({
              code: "compacted",
              message: `run ${options.runId} is compacted through sequence ${floor}; resync from its checkpoint`,
              checkpointSeq: floor as Seq
            })
          )
        }
        const page = rows.slice(0, options.limit)
        const entries = yield* Effect.forEach(page, decodeRow)
        return {
          entries,
          hasMore: rows.length > options.limit
        } satisfies EntriesPage
      })
    )

    const subscribeRun = (runId: RunId) =>
      Effect.gen(function*() {
        const wake = yield* PubSub.sliding<void>(1)
        const subscription = yield* PubSub.subscribe(wake)
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const subscribers = wakes.get(runId) ?? new Set()
            subscribers.add(wake)
            wakes.set(runId, subscribers)
          }),
          () =>
            Effect.sync(() => {
              const subscribers = wakes.get(runId)
              subscribers?.delete(wake)
              if (subscribers?.size === 0) {
                wakes.delete(runId)
              }
            }).pipe(Effect.andThen(PubSub.shutdown(wake)))
        )
        return subscription
      })

    const stream = (streamOptions: StreamOptions): Stream.Stream<Entry, JournalError> =>
      Stream.unwrap(
        Effect.fn("Journal.stream")(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: streamOptions.runId,
            ...(streamOptions.afterSequence === undefined ? {} : { afterSequence: streamOptions.afterSequence })
          })
          yield* Effect.fromResult(Result.mapError(
            decodeStreamOptions(streamOptions),
            (cause) => error("invalid_event", "stream options violate the journal read contract", cause)
          ))
          const wake = yield* subscribeRun(streamOptions.runId)
          // The cursor lives in a registered box for the stream's lifetime
          // so `compact` can see how far every live follower has read.
          const reader = { cursor: streamOptions.afterSequence ?? -1 }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const registered = readers.get(streamOptions.runId) ?? new Set()
              registered.add(reader)
              readers.set(streamOptions.runId, registered)
            }),
            () =>
              Effect.sync(() => {
                const registered = readers.get(streamOptions.runId)
                registered?.delete(reader)
                if (registered?.size === 0) {
                  readers.delete(streamOptions.runId)
                }
              })
          )
          // A live consumer is told about losses that happen while it is
          // following, and only about those: a loss it never overlapped is
          // already spent by the time it subscribes.
          const subscribedLossEpoch = state.lossEpoch
          const readPages = (initialCursor: number): Stream.Stream<Entry, JournalError> =>
            Stream.paginate(initialCursor, (cursor) =>
              Effect.suspend(() =>
                state.sinkFailure !== undefined && state.lossEpoch > subscribedLossEpoch
                  ? Effect.fail(state.sinkFailure)
                  : readPage({
                    runId: streamOptions.runId,
                    ...(cursor < 0 ? {} : { after: cursor as Seq }),
                    limit: readPageSize
                  })
              ).pipe(
                Effect.map((page) => {
                  const last = page.entries.at(-1)
                  if (last !== undefined) {
                    // Both channels append above the committed tail, so no
                    // pending reservation can later commit below this cursor.
                    reader.cursor = last.seq
                  }
                  return [
                    page.entries,
                    page.hasMore ? Option.some(reader.cursor) : Option.none<number>()
                  ] as const
                })
              ))
          const historical = readPages(reader.cursor)
          // PubSub is only a local fast path. Another journal process cannot
          // publish into it, so a bounded poll must recheck both the durable
          // tail and the compaction floor while the follower is otherwise idle.
          // One raced wake keeps the live tail in the consumer fiber instead
          // of merging two background streams, which also preserves a plain
          // interruption cause when the consumer is cancelled.
          const live = Stream.fromEffectRepeat(
            Effect.raceFirst(PubSub.take(wake), Effect.sleep("1 second"))
          ).pipe(Stream.flatMap(() =>
            readPages(reader.cursor)
          ))
          return Stream.concat(historical, live)
        })()
      )

    /**
     * The owner fence for the fenced append, for checkpoint, and for
     * compaction: the injected strategy's commit-time admission (R3),
     * evaluated inside the caller's write transaction. `DurableWriter`
     * serializes write transactions, so no reclaim can commit between the
     * guard and the statements that run beside it in the same transaction.
     * A strategy that cannot answer is a sink failure, never a lost fence;
     * its cause is preserved so the writer's retry classification still sees
     * a transient conflict through the wrapper.
     */
    const fenceGuard = (
      runId: RunId,
      owner: OwnerId
    ): Effect.Effect<void, JournalError> =>
      consensus.guard(runId, owner).pipe(
        Effect.mapError((cause) =>
          cause.code === "fence_lost"
            ? error("fence_lost", cause.message)
            : error("sink_failed", "consensus guard failed", cause)
        )
      )

    /**
     * Reads the row or compacted identity a duplicate emit collides with.
     * The insert guard in migration 0004 extends the event table's unique
     * constraints to identities retained by compaction. Tombstones return
     * only a receipt sequence and never produce a replayable entry.
     *
     * On the queued channel this runs only AFTER the insert, on the row that
     * insert's `ON CONFLICT DO NOTHING` actually refused: the unique index is
     * the admission decision there, so a batch of entries that collide with
     * nothing costs no lookups at all, and the one a collision costs happens
     * inside the writer's own transaction. See {@link insertOne} for why the
     * durable channel still asks first.
     *
     * The lookup covers BOTH unique constraints the insert can conflict on:
     * `UNIQUE (event_id)` and `UNIQUE (run_id, source_id, source_seq)`. It is
     * tempting to keep only the first, because `makeEventId` is injective in
     * exactly that triple, but that argument holds only for rows this
     * journal minted. `TimeTravelStore.createFork` copies a parent's rows
     * under the child's `run_id` with `'fork:' || run_id || ':' || event_id`,
     * so a forked run carries rows whose triple is live and whose event id it
     * will never mint. Looking those up by event id alone finds nothing, and
     * the caller reports the resulting empty insert as `fence_lost`, a
     * healthy fork failing with "someone else owns this run".
     */
    const selectExisting = (
      queued: QueuedEntry
    ): Effect.Effect<Commit | undefined, JournalError | SqlError.SqlError> =>
      Effect.gen(function*() {
        const existing = yield* sql<JournalRow & { readonly content_hash: string | null }>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json, NULL AS content_hash
            FROM flows_journal_events
            WHERE event_id = ${queued.eventId}
              OR (
                run_id = ${queued.runId}
                AND source_id = ${queued.sourceId}
                AND source_seq = ${queued.sourceSeq}
              )
            UNION ALL
            SELECT run_id, seq, event_id, source_id, source_seq, 0 AS emitted_at_ms,
              '' AS event_type, '' AS payload_json, '' AS meta_json, content_hash
            FROM flows_journal_dedup
            WHERE event_id = ${queued.eventId}
              OR (
                run_id = ${queued.runId}
                AND source_id = ${queued.sourceId}
                AND source_seq = ${queued.sourceSeq}
              )
            ORDER BY seq ASC
            LIMIT 1
          `
        if (existing.length === 0) {
          return undefined
        }
        const row = existing[0]!
        if (
          queued.dedupe !== "identity" && (
            row.content_hash === null
              ? row.event_type !== queued.eventType ||
                row.payload_json !== queued.payloadJson ||
                row.meta_json !== queued.metaJson
              : row.content_hash !==
                (yield* contentFingerprint(queued.eventType, queued.payloadJson, queued.metaJson))
          )
        ) {
          return yield* Effect.fail(
            error(
              "idempotency_conflict",
              `source event ${queued.sourceId}:${queued.sourceSeq} for run ${queued.runId} was reused with different content`
            )
          )
        }
        return {
          entry: row.content_hash === null ? yield* decodeRow(row) : { seq: Number(row.seq) as Seq },
          inserted: false
        }
      })

    /**
     * When the fence is `Owned` the insert is admitted by the consensus
     * strategy's `guard` in the same serialized write transaction, following
     * Temporal's shard `rangeID` check
     * (`service/history/shard/context_impl.go`, `renewRangeLocked`): a
     * zombie owner whose run was reclaimed cannot append, and fails with
     * `fence_lost` before any row is written.
     *
     * The fence outranks dedup. The guard runs BEFORE the INSERT, so a
     * fenced insert consults the dedup index only for an owner the strategy
     * has confirmed; Temporal conditions every request on the `rangeID`
     * before anything else. Answering a zombie's resubmission from the dedup
     * index would launder its lost fence into a `Duplicate` receipt for work
     * the live owner committed; a confirmed owner's conflict, by contrast,
     * is a genuine duplicate (its own earlier commit, or a forked run's
     * copied row).
     *
     * The queued channel is decided by the constraint alone. The ownerless
     * DURABLE path keeps its up-front lookup, and the reason is measured
     * rather than aesthetic: with two connections open on one file, removing
     * it left `emitDurableUnfenced` transactions overlapping, so one of them
     * blocked in SQLite's synchronous busy wait until the driver's
     * `busy_timeout` expired. The two-connection case in `JournalDurable`
     * went from 17 ms and no write retries to 5.4 s and one, three runs each
     * way. That is a read this channel is buying scheduling room with, and
     * it is affordable here: a durable emit already reads its allocation
     * floor in the same transaction, and its caller is by definition not
     * flushing from inside somebody else's.
     */
    const insertOne = (
      queued: QueuedEntry,
      fence: Fence,
      enforceCompactionFloor = false
    ): Effect.Effect<Commit, JournalError | SqlError.SqlError> =>
      Effect.gen(function*() {
        if (fence._tag === "Owned") {
          yield* fenceGuard(queued.runId, fence.owner)
        } else if (!enforceCompactionFloor) {
          const duplicate = yield* selectExisting(queued)
          if (duplicate !== undefined) {
            return duplicate
          }
        }
        // Admission reservations are provisional. Allocate above the durable
        // tail in this transaction so a queued entry can never commit behind
        // a reader's cursor, even when another connection overtook it.
        const insert = enforceCompactionFloor
          ? sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              )
              SELECT
                ${queued.runId},
                (SELECT ${Dialect.greatest(sql)}(${queued.seq}, COALESCE(MAX(seq), -1) + 1)
                  FROM flows_journal_events WHERE run_id = ${queued.runId}),
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              WHERE NOT EXISTS (
                SELECT 1 FROM flows_journal_checkpoints
                WHERE run_id = ${queued.runId}
                  AND compacted_at_ms IS NOT NULL
                  AND seq >= ${queued.seq}
              ) AND NOT EXISTS (
                SELECT 1 FROM flows_journal_events
                WHERE run_id = ${queued.runId} AND seq >= ${Number.MAX_SAFE_INTEGER - 1}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
          : sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
        const inserted = yield* insert
        if (inserted.length > 0) {
          return {
            entry: yield* decodeRow(inserted[0]!),
            inserted: true
          }
        }
        // The INSERT produced no row, so a unique constraint fired: the
        // guard above already confirmed a fenced owner, so this collision
        // is a genuine duplicate, never a laundered lost fence.
        const racedDuplicate = yield* selectExisting(queued)
        if (racedDuplicate !== undefined) {
          return racedDuplicate
        }
        // The insert produced no row and names no committed identity. Before
        // reporting sequence exhaustion, ask whether compaction moved the
        // floor above this reservation: that is a drop, and
        // the caller needs the floor to resync from. A durable write cannot
        // reach this case, because it allocates above the surviving
        // checkpoint row, so the read costs nothing on that path.
        {
          const floor = yield* compactionFloor(queued.runId)
          if (floor !== undefined && queued.seq <= floor) {
            return yield* Effect.fail(
              new JournalError({
                code: "compacted",
                message:
                  `queued sequence ${queued.seq} for run ${queued.runId} was dropped below compaction floor ${floor}`,
                checkpointSeq: floor as Seq
              })
            )
          }
        }
        return yield* Effect.fail(
          error(
            "invalid_event",
            "journal sequence is outside the allocatable safe integer range"
          )
        )
      })

    /** Shared transactional insert path; the caller already owns SQL. */
    const insertBatch = (batch: ReadonlyArray<QueuedEntry>): Effect.Effect<BatchOutcome, SqlError.SqlError> =>
      Effect.gen(function*() {
        const results = yield* Effect.forEach(
          batch,
          (queued) => Effect.map(Effect.result(insertOne(queued, unfenced, true)), (result) => ({ queued, result }))
        )
        const commits: Array<SettledCommit> = []
        const losses: Array<EntryLoss> = []
        for (const settled of results) {
          if (Result.isSuccess(settled.result)) {
            commits.push({ queued: settled.queued, commit: settled.result.success })
          } else if (isJournalError(settled.result.failure)) {
            losses.push({ queued: settled.queued, cause: settled.result.failure })
          } else {
            return yield* Effect.fail(settled.result.failure)
          }
        }
        return { commits, losses }
      })

    // Transaction first, run permits second. Admissions read floors before
    // taking a permit; compaction also acquires SQL before its run locks.
    // No holder of a run permit or closed gate can wait on this batch's
    // connection (see `admitFromIndex` and `withCompactionBarrier`).
    const persistBatch = (
      batch: ReadonlyArray<QueuedEntry>
    ): Effect.Effect<BatchOutcome, JournalError> =>
      writer.write(withRunPermits(
        batch.map((queued) => queued.runId),
        insertBatch(batch)
      )).pipe(
        // Every per-entry `JournalError` is settled inside the transaction
        // above, so the only failure that escapes is the transaction itself:
        // a database outage, which is what `sink_failed` names.
        Effect.mapError((cause) => error("sink_failed", "journal sink failed", cause))
      )

    const publish = (commits: ReadonlyArray<Commit>): Effect.Effect<void> =>
      Effect.forEach(
        commits,
        (commit) => {
          if (!commit.inserted) {
            return Effect.void
          }
          return PubSub.publish(changes, freezePublished(commit.entry)).pipe(
            Effect.andThen(
              Effect.forEach(
                wakes.get(commit.entry.runId) ?? [],
                (wake) => PubSub.publish(wake, undefined),
                { discard: true }
              )
            ),
            Effect.asVoid
          )
        },
        { discard: true }
      )

    const rememberCommitted = (queued: QueuedEntry, seq: Seq): void => {
      retain(sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq), {
        seq,
        eventType: queued.eventType,
        payloadJson: queued.payloadJson,
        metaJson: queued.metaJson,
        status: "committed"
      })
      raiseSequenceFloor(queued.runId, seq)
      raiseSourceSequenceFloor(queued.runId, queued.sourceId, queued.sourceSeq)
    }

    /**
     * Reads the durable allocation floor for a run (or a producer). Durable
     * allocation calls this inside its transaction; lossy admission calls
     * it before taking any run permit.
     *
     * The pinned Node SQLite driver begins IMMEDIATE transactions, acquiring
     * the writer lock before this floor read. A caller-supplied SQL client
     * may instead use DEFERRED transactions, whose lock upgrade can fail
     * with SQLITE_BUSY_SNAPSHOT. In either case DurableWriter retries the
     * whole transaction, floor read included, against committed state.
     * The cross-connection allocation invariant is exercised by
     * `packages/smithers/flows/journal/test/JournalDurable.test.ts` ("emitDurable never
     * collides when two connections write one run concurrently").
     *
     * Governing design: `packages/smithers/flows/journal/docs/concepts/two-channels.md`.
     */
    const nextDurable = (
      column: "seq" | "source_seq",
      runId: RunId,
      sourceId: SourceId | undefined
    ): Effect.Effect<number, SqlError.SqlError> =>
      Effect.map(
        column === "seq"
          ? sql<{ readonly next: number | null }>`
              SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
            `
          : sql<{ readonly next: number | null }>`
              SELECT MAX(source_seq) + 1 AS next FROM (
                SELECT MAX(source_seq) AS source_seq FROM flows_journal_events
                WHERE run_id = ${runId} AND source_id = ${sourceId!}
                UNION ALL
                SELECT MAX(source_seq) AS source_seq FROM flows_journal_dedup
                WHERE run_id = ${runId} AND source_id = ${sourceId!}
              )
            `,
        (rows) => Number(rows[0]?.next ?? 0)
      )

    /**
     * Reads a run's durable allocation floors when the in-process cache has
     * not observed them yet.
     *
     * `emitLossy` allocates from the index alone, it queues rather than
     * writing, so it cannot read the database mid-allocation, which is why
     * the floors used to be seeded for every run at construction. Reading
     * them on first use instead keeps the index proportional to the runs this
     * process touches rather than to total history, and the durable read is
     * the same `MAX(...) + 1` the seed computed.
     *
     * This function never mutates the cache. Its SQL reads deliberately run
     * without the allocator and without the run permit; the caller later
     * takes the run permit and then the short allocator permit, re-checks
     * the monotonic cache, and reserves both sequences in one synchronous
     * step. A floor read outside the permit is a lower bound: every
     * in-process writer raises the cache at allocation time, and the only
     * cache invalidation is `JournalGeneration.forget`, whose contract
     * requires quiescent producers and flushed admissions, so it cannot
     * overlap this read-to-reservation interval. Retention evicts committed
     * identities only; run retirement and compaction leave allocation floors
     * intact. Compaction also preserves the checkpoint entry and producer
     * dedup rows for cold reads. Reading under the permit is what deadlocked
     * against the batch writer; see `admitFromIndex`.
     *
     * A producer that supplies its own `sourceSeq` allocates nothing from
     * the producer floor, so that floor is not read for it. This is what
     * makes the explicit path readless end to end once the run's own `seq`
     * floor is known, which it is from the first entry any producer writes
     * for the run.
     */
    const ensureFloors = (
      input: Input
    ): Effect.Effect<{ readonly seq: number; readonly sourceSeq: number }, JournalError> =>
      Effect.suspend(() => {
        const runId = input.runId
        const key = sourceKey(runId, input.sourceId)
        const seq = state.sequences.get(runId)
        const sourceSeq = input.sourceSeq === undefined ? state.sourceSequences.get(key) : 0
        if (seq !== undefined && sourceSeq !== undefined) {
          return Effect.succeed({ seq, sourceSeq })
        }
        return Effect.all({
          seq: seq === undefined ? nextDurable("seq", runId, undefined) : Effect.succeed(seq),
          sourceSeq: sourceSeq === undefined
            ? nextDurable("source_seq", runId, input.sourceId)
            : Effect.succeed(sourceSeq)
        }).pipe(
          Effect.mapError((cause) => error("sink_failed", "could not read journal allocation floor", cause)),
          Effect.flatMap((floors) => {
            if (
              !Number.isSafeInteger(floors.seq) ||
              floors.seq < 0 ||
              !Number.isSafeInteger(floors.sourceSeq) ||
              floors.sourceSeq < 0
            ) {
              return Effect.fail(
                error("invalid_event", "journal sequence is outside the allocatable safe integer range")
              )
            }
            return Effect.succeed(floors)
          })
        )
      })

    /**
     * Records a committed entry in the in-process index and publishes it,
     * immediately outside a transaction, or deferred to its owning writer.
     * A raw SQL transaction has no managed commit boundary: skip this optional
     * publication rather than exposing uncommitted data. Database replay stays
     * authoritative, including for tail subscribers.
     */
    const settleCommit = (
      queued: QueuedEntry,
      commit: Commit,
      restoreMaintenance: (effect: Effect.Effect<void>) => Effect.Effect<void>
    ): Effect.Effect<Effect.Effect<void>> =>
      Effect.gen(function*() {
        const mandatory = Effect.sync(() => rememberCommitted(queued, commit.entry.seq)).pipe(
          Effect.andThen(publish([commit]))
        )
        // Restore the durable caller's policy, not unconditional interruption.
        // A cancellation finalizer may journal before releasing resources;
        // even interruptible(void) here re-delivers its pending interruption
        // after COMMIT and abandons that cleanup. Ordinary callers still make
        // a slow capture interruptible when the writer publishes after COMMIT.
        const maintenance = restoreMaintenance(noteCommitted(queued.runId, commit.inserted ? 1 : 0))
        const enclosing = yield* Effect.serviceOption(sql.transactionService)
        if (Option.isNone(enclosing)) {
          yield* mandatory
          return maintenance
        }
        yield* afterCommit(mandatory.pipe(Effect.andThen(maintenance)), sql)
        return Effect.void
      })

    /**
     * Opens (or joins) the write transaction that keeps the logical WAL
     * atomic with the executable state it describes.
     *
     * The shared writer owns publication across retries, nested savepoint
     * rollbacks, and transactions opened by other stores on the same client.
     */
    const transact: Service["transact"] = <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | JournalError, R> =>
      writer.write(effect).pipe(
        Effect.catchIf(
          (cause): cause is DatabaseError => cause instanceof DatabaseError,
          (cause) => Effect.fail(error("sink_failed", "journal transaction failed", cause))
        )
      )

    const writeDurable = (
      input: Input,
      fence: Fence
    ): Effect.Effect<DurableReceipt, JournalError> =>
      Effect.uninterruptibleMask((restoreMaintenance) =>
        restoreMaintenance(Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: input.runId,
            sourceId: input.sourceId,
            eventType: input.eventType
          })
          const emittedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
          const prepared = yield* Effect.fromResult(prepare(input, emittedAtMs))
          const committed = yield* Effect.gen(function*() {
            const { metaJson, payloadJson, validated } = prepared
            return yield* Effect.uninterruptibleMask((restore) =>
              restore(writer.write(withActiveRunWrite(
                prepared.validated.runId,
                Effect.gen(function*() {
                  // Read only for a producer that allocates from this floor. A
                  // supplied sequence is not allocated, so reading the floor
                  // for it costs a query whose answer is discarded.
                  const durableSourceSeq = validated.sourceSeq === undefined
                    ? yield* nextDurable("source_seq", validated.runId, validated.sourceId)
                    : 0
                  const durableSeq = yield* nextDurable("seq", validated.runId, undefined)
                  const reserved = yield* allocation.withPermit(Effect.fromResult(Result.gen(function*() {
                    const key = sourceKey(validated.runId, validated.sourceId)
                    const sourceSeq: SourceSeq = validated.sourceSeq ??
                      (Math.max(
                        durableSourceSeq,
                        state.sourceSequences.get(key) ?? 0
                      ) as SourceSeq)
                    if (
                      !Number.isSafeInteger(sourceSeq) ||
                      sourceSeq < 0 ||
                      sourceSeq === Number.MAX_SAFE_INTEGER
                    ) {
                      return yield* Result.fail(
                        error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                      )
                    }
                    const seq = Math.max(
                      durableSeq,
                      state.sequences.get(validated.runId) ?? 0
                    ) as Seq
                    if (!Number.isSafeInteger(seq) || seq === Number.MAX_SAFE_INTEGER) {
                      return yield* Result.fail(
                        error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                      )
                    }
                    // Claim the seq NOW, not at commit: a concurrent `emitLossy`
                    // allocates from this floor alone, and `settleCommit` parks
                    // the commit-time raise until the outermost COMMIT.
                    // Re-entering the transaction body is idempotent because the
                    // floor only rises. An abandoned attempt leaves the number
                    // unused, which is a gap: allocation is `MAX(seq) + 1` and
                    // replay is `ORDER BY seq`, so neither reads a gap as anything.
                    raiseSequenceFloor(validated.runId, seq)
                    // Claim the producer sequence at the same allocation seam.
                    // Without this, a lossy emit from the same producer can read
                    // the pre-transaction source floor and reuse this identity
                    // while an enclosing `transact` is still open.
                    raiseSourceSequenceFloor(validated.runId, validated.sourceId, sourceSeq)
                    return { seq, sourceSeq }
                  })))
                  const { seq, sourceSeq } = reserved
                  const queued: QueuedEntry = {
                    runId: validated.runId,
                    seq,
                    eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                    sourceId: validated.sourceId,
                    sourceSeq,
                    emittedAtMs,
                    eventType: validated.eventType,
                    payloadJson,
                    metaJson,
                    dedupe: validated.dedupe ?? "content"
                  }
                  const commit = yield* insertOne(queued, fence)
                  return { commit, queued, sourceSeq }
                })
              ))).pipe(
                /**
                 * `writer.write` is a retrying transaction: its body replays on
                 * `SQLITE_BUSY(_SNAPSHOT)` and can still abort at COMMIT after the
                 * body succeeded. Cache mutation and publication therefore happen
                 * strictly after the transaction returns, so subscribers never
                 * observe a rolled-back entry and a replayed body never publishes
                 * twice. Mirrors the queued path, which publishes in a `.tap`
                 * outside `persistBatch`. Only the transaction is restored: an
                 * interruption that lands after it returns waits for the index
                 * update and publication, so a committed row always reaches
                 * `changes`.
                 *
                 * Under `transact` "after the transaction returns" is not yet
                 * "after COMMIT": this write is a savepoint of the caller's
                 * transaction, so `settleCommit` parks both effects until the
                 * outermost transaction commits. The active-write reference
                 * is released before that outer commit, which lets automatic
                 * compaction drain the run before its maintenance transaction.
                 */
                Effect.flatMap((written) =>
                  Effect.gen(function*() {
                    const maintenance = yield* settleCommit(written.queued, written.commit, restoreMaintenance)
                    const receipt: DurableReceipt = written.commit.inserted
                      ? { _tag: "Accepted", seq: written.commit.entry.seq, sourceSeq: written.sourceSeq }
                      : {
                        _tag: "Duplicate",
                        seq: written.commit.entry.seq,
                        sourceSeq: written.sourceSeq,
                        status: "committed"
                      }
                    yield* Metric.update(JournalMetrics.durable[receipt._tag], 1)
                    return { maintenance, receipt }
                  })
                )
              )
            )
          }).pipe(
            Effect.mapError((cause) =>
              isJournalError(cause) ? cause : error("sink_failed", "durable journal write failed", cause)
            )
          )
          yield* committed.maintenance
          return committed.receipt
        }))
      )

    const emitDurable: Service["emitDurable"] = Effect.fn("Journal.emitDurable")((
      input: Input,
      owner: OwnerId
    ) =>
      Effect.flatMap(
        Effect.fromResult(requireFence(owner, "emitDurable")),
        (fence) => writeDurable(input, fence)
      )
    )

    const emitDurableUnfenced: Service["emitDurableUnfenced"] = Effect.fn("Journal.emitDurableUnfenced")((
      input: Input
    ) => writeDurable(input, unfenced))

    const emitLossy: Service["emitLossy"] = queuedEmit

    const checkpointInternal = (
      checkpointOptions: CheckpointOptions,
      fence: Fence
    ): Effect.Effect<Checkpoint, JournalError> =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: checkpointOptions.runId,
          seq: checkpointOptions.seq
        })
        yield* Effect.fromResult(Result.mapError(
          decodeCheckpointOptions(checkpointOptions),
          (cause) => error("invalid_event", "checkpoint options violate the journal contract", cause)
        ))
        // The state round-trips verbatim: it is replay input, so redaction
        // deliberately does not apply, rewriting it would resume the run
        // with the wrong data. A secret that must not persist belongs in a
        // `Redacted` field of the caller's own state schema.
        const stateJson = yield* Effect.fromResult(encodeJson(checkpointOptions.state, "state"))
        const receiptState = yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(stateJson).pipe(
          Effect.mapError(
            /* v8 ignore next -- encodeJson produced these valid JSON bytes immediately above */
            (cause) => error("decode_failed", "could not decode persisted checkpoint state", cause)
          )
        )
        const createdAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        return yield* writer.write(Effect.gen(function*() {
          if (fence._tag === "Owned") {
            yield* fenceGuard(checkpointOptions.runId, fence.owner)
          }
          // The target must be a committed entry: the surviving row is what
          // keeps the run's durable `MAX(seq)` allocation floor at or above
          // the compaction boundary, so a process restarted after
          // compaction can never re-allocate a truncated sequence.
          const target = yield* sql<{ readonly ok: number }>`
              SELECT 1 AS ok FROM flows_journal_events
              WHERE run_id = ${checkpointOptions.runId} AND seq = ${checkpointOptions.seq}
            `
          if (target.length === 0) {
            return yield* Effect.fail(error(
              "checkpoint_invalid",
              `checkpoint sequence ${checkpointOptions.seq} names no committed entry of run ${checkpointOptions.runId}`
            ))
          }
          const floor = yield* compactionFloor(checkpointOptions.runId)
          if (floor !== undefined && checkpointOptions.seq <= floor) {
            return yield* Effect.fail(
              new JournalError({
                code: "checkpoint_invalid",
                message: `run ${checkpointOptions.runId} is already compacted through sequence ${floor}`,
                checkpointSeq: floor as Seq
              })
            )
          }
          yield* sql`
              INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms)
              VALUES (${checkpointOptions.runId}, ${checkpointOptions.seq}, ${stateJson}, ${createdAtMs})
              ON CONFLICT (run_id, seq) DO UPDATE SET
                state_json = excluded.state_json,
                created_at_ms = excluded.created_at_ms
            `
          return new Checkpoint({
            runId: checkpointOptions.runId,
            seq: checkpointOptions.seq,
            state: receiptState,
            createdAtMs,
            compactedAtMs: null
          })
        })).pipe(
          Effect.mapError((cause) =>
            isJournalError(cause) ? cause : error("sink_failed", "durable checkpoint write failed", cause)
          )
        )
      })

    const checkpoint: Service["checkpoint"] = Effect.fn("Journal.checkpoint")((
      checkpointOptions: CheckpointOptions,
      owner: OwnerId
    ) =>
      Effect.flatMap(
        Effect.fromResult(requireFence(owner, "checkpoint")),
        (fence) => checkpointInternal(checkpointOptions, fence)
      )
    )

    const latestCheckpoint: Service["latestCheckpoint"] = Effect.fn("Journal.latestCheckpoint")((runId: RunId) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ runId })
        yield* Effect.fromResult(Result.mapError(
          decodeRunId(runId),
          (cause) => error("invalid_event", "runId violates the journal identifier contract", cause)
        ))
        const rows = yield* sql<CheckpointRow>`
            SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
            FROM flows_journal_checkpoints
            WHERE run_id = ${runId}
            ORDER BY seq DESC
            LIMIT 1
          `.pipe(Effect.mapError((cause) => error("read_failed", "durable checkpoint read failed", cause)))
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(yield* decodeCheckpointRow(row))
      })
    )

    const compactInternal = (
      compactOptions: CompactOptions,
      fence: Fence
    ): Effect.Effect<Compacted, JournalError> =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: compactOptions.runId,
          ...(compactOptions.upTo === undefined ? {} : { upTo: compactOptions.upTo })
        })
        yield* Effect.fromResult(Result.mapError(
          decodeCompactOptions(compactOptions),
          (cause) => error("invalid_event", "compact options violate the journal contract", cause)
        ))
        const compactedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        return yield* withCompactionBarrier(
          compactOptions.runId,
          Effect.gen(function*() {
            if (fence._tag === "Owned") {
              yield* fenceGuard(compactOptions.runId, fence.owner)
            }
            const upTo = compactOptions.upTo
            const rows = upTo === undefined
              ? yield* sql<CheckpointRow>`
                SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
                FROM flows_journal_checkpoints
                WHERE run_id = ${compactOptions.runId}
                ORDER BY seq DESC
                LIMIT 1
              `
              : yield* sql<CheckpointRow>`
                SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
                FROM flows_journal_checkpoints
                WHERE run_id = ${compactOptions.runId} AND seq = ${upTo}
              `
            const row = rows[0]
            if (row === undefined) {
              return yield* Effect.fail(error(
                "checkpoint_invalid",
                `run ${compactOptions.runId} has no checkpoint${
                  upTo === undefined ? "" : ` at sequence ${upTo}`
                } to compact to`
              ))
            }
            const checkpointSeq = Number(row.seq) as Seq
            if (row.compacted_at_ms !== null) {
              // A retried compaction: the floor is already here and the rows
              // below it are already gone.
              return { runId: compactOptions.runId, checkpointSeq, deleted: 0 } satisfies Compacted
            }
            for (const reader of readers.get(compactOptions.runId) ?? []) {
              if (reader.cursor < checkpointSeq - 1) {
                return yield* Effect.fail(
                  new JournalError({
                    code: "reader_behind",
                    message:
                      `a live stream of run ${compactOptions.runId} still needs sequences below checkpoint ${checkpointSeq}`,
                    checkpointSeq
                  })
                )
              }
            }
            const doomed = yield* sql<{ readonly total: number }>`
              SELECT COUNT(*) AS total FROM flows_journal_events
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
            // Retain identities atomically with deletion, in bounded pages.
            // These records never participate in replay, but preserve exact
            // retries and producer allocation floors after a fresh open.
            let after = -1
            while (true) {
              const retiring = yield* sql<JournalRow>`
                  SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                    event_type, payload_json, meta_json
                  FROM flows_journal_events
                  WHERE run_id = ${compactOptions.runId} AND seq > ${after} AND seq < ${checkpointSeq}
                  ORDER BY seq ASC LIMIT 256
                `
              if (retiring.length === 0) break
              for (const entry of retiring) {
                const fingerprint = yield* contentFingerprint(entry.event_type, entry.payload_json, entry.meta_json)
                yield* sql`
                    INSERT INTO flows_journal_dedup (run_id, source_id, source_seq, event_id, seq, content_hash)
                    VALUES (${entry.run_id}, ${entry.source_id}, ${entry.source_seq}, ${entry.event_id},
                      ${entry.seq}, ${fingerprint})
                  `
              }
              after = Number(retiring[retiring.length - 1]!.seq)
            }
            // Strictly below the checkpoint: the checkpointed entry survives,
            // holding the run's `MAX(seq)` allocation floor. Superseded
            // checkpoints go with their entries; the truncation and the floor
            // advance are one transaction, so a crash between them is
            // unrepresentable.
            yield* sql`
              DELETE FROM flows_journal_events
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
            yield* sql`
              DELETE FROM flows_journal_checkpoints
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
            yield* sql`
              UPDATE flows_journal_checkpoints
              SET compacted_at_ms = ${compactedAtMs}
              WHERE run_id = ${compactOptions.runId} AND seq = ${checkpointSeq}
            `
            return {
              runId: compactOptions.runId,
              checkpointSeq,
              deleted: Number(doomed[0]?.total ?? 0)
            } satisfies Compacted
          })
        ).pipe(
          Effect.mapError((cause) =>
            isJournalError(cause) ? cause : error("sink_failed", "journal compaction failed", cause)
          )
        )
      })

    const compact: Service["compact"] = Effect.fn("Journal.compact")((
      compactOptions: CompactOptions,
      owner: OwnerId
    ) =>
      Effect.flatMap(
        Effect.fromResult(requireFence(owner, "compact")),
        (fence) => compactInternal(compactOptions, fence)
      )
    )

    const compactionPolicy = options.compaction

    const countEntries = (runId: RunId): Effect.Effect<number, SqlError.SqlError> =>
      Effect.map(
        sql<{ readonly total: number }>`
            SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${runId}
          `,
        (rows) => Number(rows[0]?.total ?? 0)
      )

    /**
     * One automatic checkpoint-and-compact attempt at the run's durable
     * tail. Runs post-commit; a failure or refusal is logged and damped,
     * the counter restarts, so the next attempt waits for another
     * `entryThreshold` commits, and is never surfaced to the emit whose
     * settlement crossed the threshold.
     */
    const policyCompact = (policy: CompactionPolicy, runId: RunId): Effect.Effect<void> =>
      Effect.gen(function*() {
        const tail = yield* sql<{ readonly last: number | null }>`
            SELECT MAX(seq) AS last FROM flows_journal_events WHERE run_id = ${runId}
          `
        const last = tail[0]?.last
        if (last === null || last === undefined) {
          return
        }
        const upTo = Number(last) as Seq
        const captured = yield* Effect.timeoutOrElse(policy.capture(runId, upTo), {
          duration: compactionCaptureTimeout,
          orElse: () =>
            Effect.fail(
              new Error(
                `journal compaction capture for run ${runId} exceeded ${compactionCaptureTimeout}`
              )
            )
        })
        // The policy is the journal's OWN post-commit maintenance, not a
        // caller's mutating entrypoint: it owns no run and holds no fence,
        // so it drives the internal channel. The attempt only ever
        // truncates below a tail the run's own commits produced, a retry is
        // idempotent (a re-attempt after a reclaim compacts the same
        // committed prefix the live owner also sees), and every failure is
        // damped below, never surfaced to the emit that crossed the
        // threshold.
        yield* checkpointInternal({ runId, seq: upTo, state: captured }, unfenced)
        yield* compactInternal({ runId, upTo }, unfenced)
        compactionCounts.set(runId, yield* countEntries(runId))
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.sync(() => {
              compactionCounts.set(runId, 0)
            }).pipe(
              Effect.andThen(
                Effect.logWarning("journal auto-compaction failed; retrying after the next threshold", cause)
              )
            )
        )
      )

    /**
     * Counts a run's committed entries toward the compaction policy and
     * triggers an attempt at the threshold. Lossy settlements register and
     * fork it; durable settlements await it. Registration and handoff are
     * uninterruptible so cancellation cannot leak the maintenance count.
     *
     * The count is seeded lazily from the durable COUNT on the run's first
     * committed entry in this process, mirroring `ensureFloors`, so a
     * restarted process still compacts a long pre-existing history. The
     * durable COUNT already includes the rows the caller is reporting: they
     * committed before this settlement ran.
     *
     * The read-modify-write runs under the run's `maintenance` permit because
     * the seeding COUNT is an awaited SQL read. Without the permit two
     * settlements that overlapped both observed an unseeded counter, both
     * issued the COUNT, and the later reply overwrote the newer count with a
     * stale one: measured with `entryThreshold: 10`, ten committed events
     * produced zero capture calls and no checkpoint. A settlement that
     * commits BETWEEN the seeding COUNT and the counter write is now counted
     * twice instead, which only brings an attempt forward, and
     * {@link policyCompact} re-seeds the counter from a fresh COUNT when it
     * finishes, so the error does not accumulate.
     *
     * The permit is released before the compaction runs. Holding it across
     * `policyCompact` would make a slow `capture` block every other
     * settlement of the same run, which is the stall {@link settleCommit}
     * moved this work off the allocation permit to avoid.
     */
    const noteCommitted = (runId: RunId, committed: number, background = false): Effect.Effect<void> => {
      const policy = compactionPolicy
      if (policy === undefined || committed <= 0) {
        return Effect.void
      }
      return Effect.uninterruptibleMask((restore) =>
        withRunBarrier(runId, (barrier) =>
          restore(barrier.maintenance.withPermit(
            Effect.gen(function*() {
              if (compactingRuns.has(runId)) {
                return false
              }
              const known = compactionCounts.get(runId)
              const current = known === undefined ? yield* countEntries(runId) : known + committed
              compactionCounts.set(runId, current)
              if (current < policy.entryThreshold) {
                return false
              }
              compactingRuns.add(runId)
              pendingMaintenance += 1
              return true
            })
          )).pipe(
            Effect.flatMap((triggered) => {
              if (!triggered) return Effect.void
              const attempt = policyCompact(policy, runId).pipe(Effect.ensuring(Effect.sync(() => {
                compactingRuns.delete(runId)
                pendingMaintenance -= 1
                if (state.pending === 0 && pendingMaintenance === 0) completeFlushWaiters(Effect.void)
              })))
              // The sole queue consumer must never await a compaction barrier:
              // that barrier may need another batch from this very consumer.
              return background
                ? Effect.asVoid(Effect.forkIn(Effect.interruptible(attempt), maintenanceScope))
                : restore(attempt)
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.logWarning("journal compaction policy bookkeeping failed", cause)
            )
          ))
      )
    }

    const recordCommits = (
      commits: ReadonlyArray<SettledCommit>
    ): void => {
      for (const { commit, queued } of commits) {
        rememberCommitted(queued, commit.entry.seq)
      }
    }

    const settle = (count: number): void => {
      state.pending = Math.max(0, state.pending - count)
      if (state.pending === 0 && pendingMaintenance === 0) {
        completeFlushWaiters(Effect.void)
      }
    }

    /** Reports entries that left the queue without durable commits. */
    const reportLoss = (cause: JournalError, batch: ReadonlyArray<QueuedEntry>): void => {
      for (const queued of batch) {
        const identity = sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq)
        // Allocation is serialized until this batch settles, so no newer
        // admission can replace this exact identity before the deletion.
        state.sourceEvents.delete(identity)
      }
      state.sinkFailure = cause
      state.lossEpoch += 1
      state.pending = Math.max(0, state.pending - batch.length)
      // A waiter that is already registered is the flush the loss belongs
      // to, so reporting it there spends the report; only a loss nobody was
      // waiting on is left for the next flush to pick up.
      if (state.flushWaiters.size > 0) {
        state.flushedLossEpoch = state.lossEpoch
      }
      completeFlushWaiters(Effect.fail(cause))
      for (const subscribers of wakes.values()) {
        for (const wake of subscribers) {
          PubSub.publishUnsafe(wake, undefined)
        }
      }
    }

    /**
     * Makes a lost batch visible to an operator. `reportLoss` only reaches a
     * flush caller or a live stream, and a telemetry producer usually has
     * neither, so the loss is also logged and counted here.
     */
    // Callers supply one refused entry or a batch taken with a minimum of one.
    const observeLoss = (cause: JournalError, batch: ReadonlyArray<QueuedEntry>): Effect.Effect<void> =>
      Effect.andThen(
        Metric.update(JournalMetrics.lost(cause.code), batch.length),
        Effect.logWarning(
          `journal lost ${batch.length} lossy entries (${cause.code}) for runs ${
            [...new Set(batch.map((queued) => queued.runId))].join(", ")
          }`,
          cause
        )
      )

    // A failed transaction loses the whole batch. Release its per-run drain
    // counts before reporting the failure so a waiting compactor can retry
    // against the same database outage instead of waiting forever.
    const failSink = (cause: JournalError, batch: ReadonlyArray<QueuedEntry>): void => {
      settleRunPending(batch)
      reportLoss(cause, batch)
    }

    // One failed batch loses that batch and is reported as such; it never
    // ends the writer. Only interruption (scope closure) stops the loop, so
    // the queue keeps draining as soon as the database is healthy again.
    const writeBatch = Queue.takeBetween(queue, 1, batchSize).pipe(
      Effect.flatMap((batch) =>
        persistBatch(batch).pipe(
          Effect.tap((outcome) => Effect.sync(() => recordCommits(outcome.commits))),
          Effect.tap((outcome) => publish(outcome.commits.map(({ commit }) => commit))),
          // The transaction has committed and publication is complete. Drop
          // the barrier counts before policy compaction takes this run's
          // permit. Maintenance has its own global flush count.
          Effect.tap(() => Effect.sync(() => settleRunPending(batch))),
          // Register maintenance BEFORE settling the batch, so flush cannot
          // observe a gap between queued work and its policy attempt.
          Effect.tap((outcome) => {
            const perRun = new Map<RunId, number>()
            outcome.commits.forEach(({ commit, queued }) => {
              if (!commit.inserted) {
                return
              }
              perRun.set(queued.runId, (perRun.get(queued.runId) ?? 0) + 1)
            })
            return Effect.forEach(perRun, ([runId, committed]) => noteCommitted(runId, committed, true), {
              discard: true
            })
          }),
          Effect.tap((outcome) =>
            // Observed before it is reported, so a flush the report wakes
            // already sees the loss in the log and the registry.
            Effect.uninterruptible(Effect.andThen(
              Effect.forEach(outcome.losses, (loss) => observeLoss(loss.cause, [loss.queued]), { discard: true }),
              Effect.sync(() => {
                for (const loss of outcome.losses) {
                  reportLoss(loss.cause, [loss.queued])
                }
                settle(outcome.commits.length)
              })
            ))
          ),
          Effect.catch((cause) =>
            Effect.uninterruptible(
              Effect.andThen(observeLoss(cause, batch), Effect.sync(() => failSink(cause, batch)))
            )
          ),
          // Defects only: an interruption is scope closure, and it must end
          // the writer rather than be reported as a lost batch.
          Effect.catchDefect((defect) => {
            const cause = error("sink_failed", "journal writer failed", Cause.die(defect))
            return Effect.uninterruptible(
              Effect.andThen(observeLoss(cause, batch), Effect.sync(() => failSink(cause, batch)))
            )
          })
        )
      )
    )

    const drain = Effect.forever(writeBatch)

    yield* Effect.forkScoped(drain)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        // A scope finalizer runs once, and nothing else moves the status, so
        // the journal is always `open` here.
        yield* Effect.sync(() => {
          state.status = "closing"
        })
        // The last flush is the last chance to say that queued entries were
        // lost; nothing is left to report the failure to once this returns.
        yield* flushInternal.pipe(
          Effect.catch((cause) => Effect.logWarning("journal final flush failed while closing", cause))
        )
        yield* Effect.sync(() => {
          state.status = "closed"
        })
        yield* Queue.shutdown(queue)
        yield* PubSub.shutdown(changes)
        wakes.clear()
      })
    )

    const project = <S, E, R>(
      projection: Projection<S, E, R>,
      streamOptions: StreamOptions
    ): Stream.Stream<S, JournalError, R> =>
      Stream.unwrap(
        Effect.fn("Journal.project")(
          <S2, E2, R2>(
            activeProjection: Projection<S2, E2, R2>,
            activeOptions: StreamOptions
          ) =>
            Effect.annotateCurrentSpan({
              projection: activeProjection.name,
              runId: activeOptions.runId,
              ...(activeOptions.afterSequence === undefined ? {} : { afterSequence: activeOptions.afterSequence })
            }).pipe(Effect.andThen(Effect.succeed(
              stream(activeOptions).pipe(
                Stream.scanEffect(activeProjection.initial, (state, entry) =>
                  Effect.suspend(() => activeProjection.reduce(state, entry)).pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.failCause(cause as Cause.Cause<never>)
                        : Effect.fail(
                          error(
                            "projection_failed",
                            `projection ${activeProjection.name} failed`,
                            cause
                          )
                        )
                    )
                  ))
              )
            )))
        )(projection, streamOptions)
      )

    yield* JournalGeneration.onTruncate((runIds) => {
      for (const runId of runIds) {
        state.sequences.delete(runId as RunId)
        const prefix = `${runId.length}:${runId}`
        for (const key of state.sourceSequences.keys()) {
          if (key.startsWith(prefix)) state.sourceSequences.delete(key)
        }
        for (const key of state.sourceEvents.keys()) {
          if (key.startsWith(prefix)) state.sourceEvents.delete(key)
        }
      }
    })

    return makeJournal({
      generation: (runId) =>
        sql<{ readonly generation: number; readonly afterSeq: number }>`
          SELECT generation, after_seq AS "afterSeq" FROM flows_journal_generations WHERE run_id = ${runId}
        `.pipe(
          Effect.map((rows) => rows[0] ?? { generation: 0, afterSeq: -1 }),
          Effect.mapError((cause) => error("read_failed", "could not read journal generation", cause))
        ),
      emitLossy,
      emitDurable,
      emitDurableUnfenced,
      transact,
      whenCommitted: (update) =>
        Effect.flatMap(
          Effect.serviceOption(sql.transactionService),
          (transaction) => Option.isNone(transaction) ? Effect.as(update, true) : afterCommit(update, sql)
        ),
      stream,
      entries: readPage,
      changes: PubSub.subscribe(changes),
      project,
      flush: Effect.fn("Journal.flush")(() =>
        Effect.suspend(() => Effect.annotateCurrentSpan({ pending: state.pending })).pipe(
          Effect.andThen(flushInternal)
        )
      )(),
      checkpoint,
      latestCheckpoint,
      compact
    })
  })

/**
 * Provides the SQL journal over an explicitly injected consensus strategy.
 *
 * The strategy in context arbitrates the owner fence: `emitDurable`,
 * `checkpoint`, and `compact` join its `guard` inside their write
 * transaction. Provide the SAME strategy instance to every service that must
 * agree on ownership — `RunStore.layerWith` in particular — because
 * `Consensus.layerLocal` keeps its leases per layer build.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWith = (
  options: SqlJournalOptions
): Layer.Layer<Journal, JournalError, Consensus | DurableWriter | SqlClient.SqlClient> =>
  Layer.effect(Journal, make(options))

/**
 * Provides the SQL journal fenced by the database-backed strategy,
 * `SqlConsensus`, over the same client. Use {@link layerWith} to inject a
 * different strategy.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: SqlJournalOptions
): Layer.Layer<Journal, JournalError, DurableWriter | SqlClient.SqlClient> =>
  layerWith(options).pipe(Layer.provide(SqlConsensus.layer))
