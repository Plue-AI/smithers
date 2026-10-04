/**
 * Stable, schema-backed failures for the sync boundary.
 *
 * @since 0.1.0
 */

import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { Resync } from "./SyncProtocol.ts"

/** The literals behind {@link ErrorCode}, also read by {@link SyncError.is}. */
const errorCodes = [
  "invalid_request",
  "unsupported",
  "unauthorized",
  "not_found",
  "backpressure",
  "frame_too_large",
  "decode_failed",
  "transport_failed",
  "protocol_violation",
  "lineage_changed",
  "compacted",
  "closed",
  "unknown"
] as const

/**
 * Stable error codes returned by sync operations.
 *
 * `compacted` reports that the request's cursor for one run starts below that
 * run's compaction floor, so the entries it asks for have been deleted. It is
 * its own code rather than an `unknown` because it is RECOVERABLE and nothing
 * else here is: the accompanying {@link SyncError.resync} names the checkpoint
 * to resume from, and a follower that applies it converges. Folding it into
 * `unknown` cost the checkpoint, and with it every path back.
 *
 * @category models
 * @since 0.1.0
 */
export const ErrorCode = Schema.Literals(errorCodes).annotate({ identifier: "@smthrs/sync/ErrorCode" })

const codes: ReadonlySet<string> = new Set(errorCodes)

/**
 * Stable error code returned by a sync operation.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode = typeof ErrorCode.Type

const Rewind = Schema.Struct({
  runId: JournalEvent.RunId,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  afterSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1))
})

/**
 * Error raised by sync validation, transport, framing, or subscription work.
 *
 * `resync` is set only on `compacted`, and names the run and the checkpoint
 * sequence a follower resumes from. It is optional so every other code keeps
 * the shape it already had on the wire.
 *
 * `rewind` is set on server-side `lineage_changed` refusals and names the
 * current generation and archive boundary. The caller rebuilds its projection
 * from retained history and creates a fresh client; the client never retries this failure.
 *
 * `cause` is a bounded STRING, not the host object that failed. This error is
 * the declared error schema of every RPC in both groups, so whatever it
 * carries reaches a remote follower that may hold nothing but a branch share
 * link. A `Schema.Unknown` cause published the host's own failure verbatim —
 * a driver message with SQL text, a rejected credential — counted against no
 * size ceiling, and had no defined wire form for a class instance or a cyclic
 * value. `internal/CauseText` is the one renderer that fills it.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncError extends Schema.TaggedError<SyncError>()("@smthrs/sync/SyncError", {
  code: ErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.String),
  resync: Schema.optional(Resync),
  rewind: Schema.optional(Rewind)
}) {
  /**
   * Returns `true` when a value carries this error's shape: the tag, a `code`
   * this package declares, a string `message`, and a `resync` only alongside
   * `compacted`.
   *
   * It is a STRUCTURAL check, not a class check, deliberately. Everything that
   * reaches it on a shipped path has crossed a boundary that rebuilds the
   * value — the RPC client's schema-decoded error channel, or a browser
   * `postMessage` that keeps the fields and drops the prototype — and a check
   * that demanded the prototype would refuse an error the package itself sent.
   * What it does not verify is that the value was produced by this package: a
   * value constructed in-process with the right fields passes.
   *
   * It is TOTAL. The value is `unknown`, so ANY property read on it may be a
   * throwing getter — the tag included, which is the first one read and was
   * the one read outside the protection — and this guard decides whether a
   * follow reconnects and whether a cursor moves past a compaction floor: a
   * question about a value's shape must answer, never raise.
   *
   * @since 0.1.0
   */
  static readonly is = (value: unknown): value is SyncError => {
    try {
      if (!Predicate.isTagged(value, "@smthrs/sync/SyncError")) return false
      const candidate = value as {
        readonly code?: unknown
        readonly message?: unknown
        readonly resync?: unknown
        readonly rewind?: unknown
      }
      if (typeof candidate.message !== "string") return false
      if (typeof candidate.code !== "string" || !codes.has(candidate.code)) return false
      if (
        candidate.rewind !== undefined &&
        (candidate.code !== "lineage_changed" || !Schema.is(Rewind)(candidate.rewind))
      ) return false
      if (candidate.resync === undefined) return true
      return candidate.code === "compacted" && Schema.is(Resync)(candidate.resync)
    } catch {
      return false
    }
  }
}

/**
 * Terminal error raised when a server frame starts beyond the client's
 * covered cursor.
 *
 * @category errors
 * @since 0.1.0
 */
export class SyncGapError extends Schema.TaggedError<SyncGapError>()("@smthrs/sync/SyncGapError", {
  runId: JournalEvent.RunId,
  expectedFrom: JournalEvent.Seq,
  receivedFrom: JournalEvent.Seq
}) {}
