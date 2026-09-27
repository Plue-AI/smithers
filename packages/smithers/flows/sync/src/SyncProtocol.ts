/**
 * The wire contract shared by the sync server and the browser-safe client.
 *
 * Every message is schema-backed so the same definitions serve the RPC group,
 * the HTTP transport, and replay tooling.
 *
 * @since 0.1.0
 */

import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Schema from "effect/Schema"
import { ShareCapability } from "./BranchProtocol.ts"

/**
 * Wire revision requiring explicit generations in server positions.
 * Missing request versions decode so the server can return a typed refusal.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const protocolVersion = 1

/**
 * Selects every run in the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export const WorkspaceScope = Schema.TaggedStruct("Workspace", {})

/**
 * Selects a single run.
 *
 * @category models
 * @since 0.1.0
 */
export const RunScope = Schema.TaggedStruct("Run", { runId: JournalEvent.RunId })

/**
 * The set of runs a request covers.
 *
 * @category models
 * @since 0.1.0
 */
export const Scope = Schema.Union([WorkspaceScope, RunScope])

/**
 * The set of runs a request covers.
 *
 * @category models
 * @since 0.1.0
 */
export type Scope = typeof Scope.Type

/**
 * The last sequence one run has been DELIVERED to a client through.
 *
 * "Delivered", not "applied": {@link SyncClient}'s default follow advances a
 * cursor as it hands the entry to the consumer, so a consumer whose own apply
 * step then fails must not treat the cursor as an acknowledgement of that
 * apply. A consumer that needs the stronger meaning supplies
 * `SubscribeOptions.apply`, which the client runs to success before the cursor
 * moves. `Progress.applied` records that application claim; a bare wire
 * cursor never acknowledges application to the server.
 *
 * `generation` identifies the run's current history after rewinds. Requests may
 * omit it for persisted generation-zero cursors. Server responses must include
 * it in exactly one cursor for every run represented in Read entries. Clients
 * refuse missing cursor rows or generations before delivery; persist a returned
 * generation with its sequence.
 * Sequence ordering is meaningful only within one generation.
 *
 * @category models
 * @since 0.1.0
 */
export const RunCursor = Schema.Struct({
  runId: JournalEvent.RunId,
  afterSeq: JournalEvent.Seq,
  // Omitted only for generation zero (persisted cursors from before rewind support).
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * The last sequence one run has been delivered to a client through.
 *
 * @category models
 * @since 0.1.0
 */
export type RunCursor = typeof RunCursor.Type

/**
 * A client's delivered position across the workspace.
 *
 * At most ONE cursor per run: a request carrying two cursors for the same run
 * is ambiguous about where the read starts, so the server refuses it with
 * `invalid_request` rather than picking one (see {@link duplicateCursorRunId}).
 *
 * @category models
 * @since 0.1.0
 */
export const WorkspaceCursor = Schema.Array(RunCursor)

/**
 * A client's delivered position across the workspace.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceCursor = typeof WorkspaceCursor.Type

/**
 * One run's delivered position as a SERVER states it.
 *
 * Identical to {@link RunCursor} except that `generation` is required: a
 * request may omit it for a persisted generation-zero cursor, a response may
 * not. Server positions are typed with this shape so an implementation that
 * omits a generation fails to compile rather than being refused at run time by
 * every client that reads it.
 *
 * The wire schemas stay lenient on purpose. {@link ReadResponse} and
 * {@link Frame} decode an absent generation so {@link SyncClient} can answer a
 * non-conforming server with a typed `protocol_violation` naming the missing
 * field, rather than a bare decode failure.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ServerCursor = Schema.Struct({
  ...RunCursor.fields,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * One run's delivered position as a server states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ServerCursor = typeof ServerCursor.Type

/**
 * The scope and cursor set every read and subscribe request carries.
 *
 * Server read, server subscribe and client subscribe each admit a
 * caller-built request against this one schema, so an envelope field is
 * declared once and every entry point agrees on what an admitted request is.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const RequestEnvelope = Schema.Struct({ scope: Scope, cursors: WorkspaceCursor })

/**
 * The scope and cursor set every read and subscribe request carries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RequestEnvelope = typeof RequestEnvelope.Type

/**
 * A client's delivery and application positions, as two cursor sets.
 *
 * `delivered` is transport delivery and never an application acknowledgement.
 * `applied` holds the positions committed after a successful `apply` or
 * `onResync` callback; consumers persist state and these positions in the
 * same transaction. The field names carry the distinction, so neither set is
 * wrapped in a tag.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Progress = Schema.Struct({ delivered: WorkspaceCursor, applied: WorkspaceCursor })

/** The value form of progress.
 * @category models
 * @since 1.0.0-rc.0
 */
export type Progress = typeof Progress.Type

/**
 * The first run named twice in a cursor set, or `undefined` when every run is
 * named at most once.
 *
 * The schema cannot express the uniqueness — `Schema.Array` has no such check
 * — so the one rule is stated once here and enforced by both request paths.
 *
 * @category predicates
 * @since 0.1.0
 */
export const duplicateCursorRunId = (cursors: WorkspaceCursor): JournalEvent.RunId | undefined => {
  const seen = new Set<JournalEvent.RunId>()
  for (const cursor of cursors) {
    if (seen.has(cursor.runId)) return cursor.runId
    seen.add(cursor.runId)
  }
  return undefined
}

/**
 * Where a follower must resume after the server refused a cursor that starts
 * below a run's compaction floor.
 *
 * Compaction deletes the entries below a checkpoint, so a cursor under the
 * floor names history that no longer exists. `checkpointSeq` is that floor:
 * the checkpoint's state subsumes every entry at or below it, so a follower
 * must restore a snapshot covering that sequence before reading forward.
 * Its applied cursor names that snapshot, which may be newer than this floor.
 *
 * This field carries no replacement state. The client fails closed without
 * an explicit recovery handler returning the cursor it actually restored.
 * `SnapshotRequest` fetches a separately selected public projection. Raw journal
 * checkpoints are unredacted and must not be exposed under history permission.
 *
 * @category models
 * @since 0.1.0
 */
export const Resync = Schema.Struct({
  runId: JournalEvent.RunId,
  checkpointSeq: JournalEvent.Seq
})

/**
 * Where a follower must resume after a compaction refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type Resync = typeof Resync.Type

// `protocolVersion` accepts any integer here for the same reason
// `ReadRequest` and `SubscribeRequest` do: a mismatch decodes so the boundary
// can answer it with a typed `protocol_violation` instead of a decode
// failure, and the accepted number lives only in `protocolVersion`.
const snapshotIdentity = {
  protocolVersion: Schema.Int,
  runId: JournalEvent.RunId,
  lineageId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  projection: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  projectionVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThan(Number.MAX_SAFE_INTEGER))
}

/**
 * Requests an explicitly public projection covering the missing prefix.
 * Identity and version must match exactly; this never requests raw engine state.
 * @category models
 * @since 1.0.0-rc.0
 */
export const SnapshotRequest = Schema.Struct({
  ...snapshotIdentity,
  atLeastSeq: JournalEvent.Seq,
  capability: Schema.optional(ShareCapability)
})

/** A decoded request for an explicitly public projection.
 * @category models
 * @since 1.0.0-rc.0
 */
export type SnapshotRequest = typeof SnapshotRequest.Type

/**
 * A complete public projection through `seq`, inclusive. Apply its state and
 * durable cursor atomically, then read entries strictly after `seq`.
 * @category models
 * @since 1.0.0-rc.0
 */
export const Snapshot = Schema.Struct({ ...snapshotIdentity, seq: JournalEvent.Seq, state: Schema.Json })

/** A complete, versioned public projection at one journal sequence.
 * @category models
 * @since 1.0.0-rc.0
 */
export type Snapshot = typeof Snapshot.Type

/**
 * Largest number of entries one {@link ReadRequest} may ask for.
 *
 * `limit` is request-controlled fan-out: the server passes it to the journal
 * as the page size, once per covered run, so an unbounded limit made one
 * workspace read materialize an unbounded number of rows per run. The frame
 * ceiling does not cover it — that drops entries AFTER they have been read.
 * A request above this bound is refused at the wire, and an in-process caller
 * that bypasses the schema is clamped to it.
 *
 * @category limits
 * @since 0.1.0
 */
export const maxReadLimit = 1024

/**
 * Largest number of frames one {@link SubscribeRequest} may hold open.
 *
 * Credit is a hard frame limit, so it is also how long one subscription may
 * pin a server-side fan-out. The bound keeps that lifetime a function of the
 * protocol rather than of what the caller asks for; a follower that wants
 * more resubscribes from the cursors it has, which is what
 * `SyncClient.defaultCredit` already does.
 *
 * @category limits
 * @since 0.1.0
 */
export const maxSubscribeCredit = 4096

/**
 * A durable catch-up request.
 *
 * `capability` authorizes branch runs: a run whose id maps to a shared branch
 * is only read when the capability verifies for that branch. Non-branch runs
 * ignore it.
 *
 * `limit` is bounded on both sides: at least one entry, at most
 * {@link maxReadLimit}.
 *
 * @category models
 * @since 0.1.0
 */
export const ReadRequest = Schema.Struct({
  protocolVersion: Schema.optional(Schema.Int),
  scope: Scope,
  cursors: WorkspaceCursor,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxReadLimit)),
  capability: Schema.optional(ShareCapability)
})

/**
 * A durable catch-up request.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadRequest = typeof ReadRequest.Type

/**
 * One page of durable catch-up entries.
 *
 * `done` reports that the page reached the durable tail, which is the point at
 * which a client may switch from paging to following.
 *
 * @category models
 * @since 0.1.0
 */
export const ReadResponse = Schema.Struct({
  entries: Schema.Array(JournalEvent.Entry),
  cursors: WorkspaceCursor,
  done: Schema.Boolean
})

/**
 * One page of durable catch-up entries.
 *
 * @category models
 * @since 0.1.0
 */
export type ReadResponse = typeof ReadResponse.Type

/**
 * One page of durable catch-up entries as a SERVER states it.
 *
 * Every cursor carries its generation. {@link SyncServer.Service} answers with
 * this shape; {@link ReadResponse} is the lenient shape a client decodes an
 * untrusted server's page into before refusing a missing generation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ServerReadResponse = Schema.Struct({
  ...ReadResponse.fields,
  cursors: Schema.Array(ServerCursor)
})

/**
 * One page of durable catch-up entries as a server states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ServerReadResponse = typeof ServerReadResponse.Type

/**
 * A request to follow committed entries.
 *
 * `capability` authorizes branch runs exactly as on {@link ReadRequest}.
 *
 * `credit` is bounded on both sides: at least one frame, at most
 * {@link maxSubscribeCredit}. Zero is refused rather than served as an
 * immediately-empty stream, because the two readings of it — "open a window
 * of nothing" and "a caller computed its window wrong" — are
 * indistinguishable on the wire, and the second one busy-loops a follow that
 * replenishes by resubscribing.
 *
 * @category models
 * @since 0.1.0
 */
export const SubscribeRequest = Schema.Struct({
  protocolVersion: Schema.optional(Schema.Int),
  scope: Scope,
  cursors: WorkspaceCursor,
  credit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maxSubscribeCredit)),
  capability: Schema.optional(ShareCapability)
})

/**
 * A request to follow committed entries.
 *
 * @category models
 * @since 0.1.0
 */
export type SubscribeRequest = typeof SubscribeRequest.Type

/**
 * A contiguous batch of committed entries for one run.
 *
 * `fromSeq` and `toSeq` describe the interval the server covered, not the
 * sequences actually carried: dropped admissions leave legitimate holes.
 * `generation` identifies the history covering the interval and is mandatory
 * on server responses, including zero. Clients refuse its omission before
 * deduplicating by sequence. The optional schema permits a typed refusal.
 *
 * @category models
 * @since 0.1.0
 */
export const EntriesFrame = Schema.TaggedStruct("Entries", {
  runId: JournalEvent.RunId,
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  fromSeq: JournalEvent.Seq,
  toSeq: JournalEvent.Seq,
  entries: Schema.Array(JournalEvent.Entry)
})

/**
 * A contiguous batch of committed entries for one run.
 *
 * @category models
 * @since 0.1.0
 */
export type EntriesFrame = typeof EntriesFrame.Type

/**
 * A liveness frame reserved for a future revision, which no rc.0 server emits.
 *
 * No server in this package constructs one at rc.0, and a client must not wait
 * for one: {@link SyncClient} tolerates the variant and ignores it, which is
 * the whole of the contract today. It stays in the {@link Frame} union so
 * adding the frame later is not a wire break, and so a third-party client
 * written against this schema already ignores it.
 *
 * Keepalive is a transport concern at rc.0. Emitting a heartbeat here would
 * spend the subscription's `credit`, which is a hard frame limit, so an idle
 * follow would resubscribe on a timer instead of staying quiet.
 *
 * @category models
 * @since 0.1.0
 */
export const HeartbeatFrame = Schema.TaggedStruct("Heartbeat", {})

/**
 * A terminal frame reporting that the server ended the subscription.
 *
 * @category models
 * @since 0.1.0
 */
export const ClosedFrame = Schema.TaggedStruct("Closed", {
  reason: Schema.optional(Schema.String)
})

/**
 * Any frame a subscription may emit.
 *
 * @category models
 * @since 0.1.0
 */
export const Frame = Schema.Union([EntriesFrame, HeartbeatFrame, ClosedFrame])

/**
 * Any frame a subscription may emit.
 *
 * @category models
 * @since 0.1.0
 */
export type Frame = typeof Frame.Type

/**
 * A contiguous batch of committed entries as a SERVER states it.
 *
 * `generation` is required here: a server that covers an interval knows the
 * history it read, so omitting it is a compile error rather than a run-time
 * refusal. {@link EntriesFrame} is the lenient shape a client decodes an
 * untrusted server's frame into.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ServerEntriesFrame = Schema.TaggedStruct("Entries", {
  runId: JournalEvent.RunId,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fromSeq: JournalEvent.Seq,
  toSeq: JournalEvent.Seq,
  entries: Schema.Array(JournalEvent.Entry)
})

/**
 * A contiguous batch of committed entries as a server states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ServerEntriesFrame = typeof ServerEntriesFrame.Type

/**
 * Any frame a subscription may emit, as a server states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ServerFrame = Schema.Union([ServerEntriesFrame, HeartbeatFrame, ClosedFrame])

/**
 * Any frame a subscription may emit, as a server states it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ServerFrame = typeof ServerFrame.Type

/**
 * Whether a scope covers a run.
 *
 * @category predicates
 * @since 0.1.0
 */
export const covers = (scope: Scope, runId: JournalEvent.RunId): boolean =>
  scope._tag === "Workspace" || scope.runId === runId

/**
 * Default ceiling on the encoded entries one frame or page may
 * carry, in bytes.
 *
 * Both ends enforce the sum of encoded journal entries, excluding the outer
 * RPC/frame envelope. Transports must allow their own envelope overhead.
 * Commands default to 1 MiB; the 2 MiB entry ceiling includes their durable
 * journal envelope and keeps already-admitted maximum commands consumable.
 *
 * @category limits
 * @since 0.1.0
 */
export const defaultMaxFrameBytes = 2 * 1024 * 1024

const utf8 = new TextEncoder()

/** The four bytes `null` occupies, which is what a value with no JSON text
 * costs once it is inside an encoded frame. */
const nullByteLength = 4

/**
 * The wire size of one value: the UTF-8 byte length of its JSON text.
 *
 * Ceilings measure this encoded form rather than in-memory object size, so a
 * limit tracks what a transport actually carries.
 *
 * The function is TOTAL, because every caller is a size guard whose whole job
 * is to produce a typed `frame_too_large` refusal rather than a defect:
 *
 * - A value with no JSON text at all — `undefined`, a function, a symbol —
 *   measures {@link nullByteLength}, the bytes it occupies once an enclosing
 *   array or object encodes it as `null`. It used to measure zero, which let
 *   an unencodable value pass every ceiling.
 * - A value `JSON.stringify` refuses — a cycle, a `bigint`, a throwing
 *   `toJSON` — measures `Infinity`, so it trips every ceiling instead of
 *   throwing a `TypeError` out of code that only ever fails typed.
 *
 * It measures the JSON text, so a `toJSON` method, a getter, or a proxy trap
 * on the value runs while the size is taken; the read path measures each
 * entry once per end. Entries that arrive over the wire are schema-decoded
 * data and have none of those.
 *
 * @category limits
 * @since 0.1.0
 */
export const encodedByteLength = (value: unknown): number => {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return Number.POSITIVE_INFINITY
  }
  return text === undefined ? nullByteLength : utf8.encode(text).length
}
