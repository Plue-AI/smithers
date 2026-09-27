/**
 * Durable event-envelope schemas for the journal.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A UTF-16 surrogate with no partner: a high surrogate not followed by a low
 * one, or a low surrogate not preceded by a high one. `String.isWellFormed`
 * answers the same question but needs the ES2024 lib, which this package does
 * not target.
 */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * A NUL anywhere in an identifier.
 *
 * SQLite's `length()` counts the characters BEFORE the first NUL, and every
 * identifier column carries `CHECK (length(...) > 0)`, so a leading-NUL run id
 * measures zero and the write fails the constraint. Measured on this tree, an
 * emit with a leading-NUL run id came back as `sink_failed` with a
 * `DatabaseError` cause, which tells the caller the database is down when the
 * real fault is the identifier it just supplied. A NUL after the first
 * character is refused on the same terms: it makes the column's own length
 * check disagree with the identifier's length.
 *
 * Built from a code point rather than written as a pattern literal: a control
 * character in a regex is exactly the typo `no-control-regex` exists to catch,
 * and no reader can see one in the source.
 */
const embeddedNul = new RegExp(String.fromCharCode(0))

/**
 * Longest identifier the journal persists.
 *
 * A run id, a source id and an event type are index columns of a permanent
 * table and are held in per-run maps for the layer's lifetime, so an
 * unbounded one costs durable index space and heap that nothing ever
 * reclaims. Every identifier this repository mints is a uuid or a short
 * dotted name, two orders of magnitude below this bound, so the ceiling
 * refuses only the shapes that were never identifiers.
 *
 * @since 1.0.0
 * @category constants
 */
export const maxIdentifierLength = 1024

/**
 * A persistable identifier: non-empty, and representable in the store.
 *
 * SQLite binds a lone UTF-16 surrogate as U+FFFD, so two ill-formed
 * identifiers that differ only in their surrogates land on ONE persisted key.
 * The second run's first event then dedupes into the first run's row and reads
 * by either id return the same history, which destroys run isolation at the
 * persistence boundary. Rejecting ill-formed text at the schema keeps the
 * identifier the caller decoded and the identifier the database stores the
 * same value.
 *
 * A NUL is rejected for the reason {@link embeddedNul} gives: the column's own
 * length check cannot see past one, so the store refuses the identifier as a
 * constraint violation and the caller is told the sink failed.
 *
 * The empty string is rejected for a plainer reason: it names nothing, and the
 * journal used to accept it at decode and then reject it at the service, so a
 * caller could hold a "valid" identifier the next call refused.
 * The length is bounded because every identifier occupies permanent index
 * space and layer-lifetime heap.
 */
const identifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maxIdentifierLength),
  Schema.makeFilter((value: string) => !loneSurrogate.test(value), { title: "wellFormedIdentifier" }),
  Schema.makeFilter((value: string) => !embeddedNul.test(value), { title: "nulFreeIdentifier" })
)

/**
 * Schema for an identifier of one durable run.
 *
 * Between 1 and 1,024 UTF-16 code units, free of unpaired UTF-16 surrogates
 * because the store cannot tell two ill-formed identifiers apart, and free of
 * NUL because the store's own length check cannot see past one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunId = identifier.pipe(Schema.brand("@smthrs/journal/JournalEvent/RunId"))

/**
 * Branded identifier of one durable run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type

/**
 * Schema for the canonical, durable sequence number within a run.
 *
 * `Number.MAX_SAFE_INTEGER` is excluded because the journal must always be
 * able to allocate the next sequence. `Number.MAX_SAFE_INTEGER + 1` is not a
 * distinct integer, so the maximum is not an allocatable sequence.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Seq = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER)
).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/Seq")
)

/**
 * Canonical durable per-run sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type Seq = typeof Seq.Type

/**
 * Schema for an event producer identifier.
 *
 * The same shape `RunId` accepts, on the same terms: the pair identifies a
 * producer's retries in the database.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SourceId = identifier.pipe(Schema.brand("@smthrs/journal/JournalEvent/SourceId"))

/**
 * Identifier of an event producer.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceId = typeof SourceId.Type

/**
 * Schema for a producer-local event sequence number.
 *
 * `Number.MAX_SAFE_INTEGER` is excluded because the journal must always be
 * able to allocate the next sequence. `Number.MAX_SAFE_INTEGER + 1` is not a
 * distinct integer, so the maximum is not an allocatable sequence.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SourceSeq = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER)
).pipe(
  Schema.brand("@smthrs/journal/JournalEvent/SourceSeq")
)

/**
 * Producer-local event sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceSeq = typeof SourceSeq.Type

/**
 * Schema for what a re-emitted `(runId, sourceId, sourceSeq)` identity means.
 *
 * `content` is the default and the strict reading: the identity names one set
 * of bytes, so a producer that re-emits it with different bytes has a bug and
 * the journal says so with `idempotency_conflict`.
 *
 * `identity` is for a producer that derives the sequence from the event
 * itself. There a collision IS the same event observed twice, and the bytes
 * that differ between the two observations are metadata ABOUT the observation
 * rather than the event: when a replayed frame was re-recorded, how long a
 * step took the second time a durable engine served it from its record. The
 * first admitted row stands and the re-emission settles as `Duplicate`. Only
 * declare it with a sequence derived from the event's own content, because
 * the journal then has nothing else with which to notice two different events
 * wearing one identity.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Dedupe = Schema.Literals(["content", "identity"])

/**
 * What a re-emitted producer identity means.
 *
 * @category models
 * @since 0.1.0
 */
export type Dedupe = typeof Dedupe.Type

/**
 * Schema for an event submitted to the journal.
 *
 * Event types and values intentionally remain an open envelope. The durable
 * core never closes this into an interpreter-specific union.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Input extends Schema.Class<Input>("@smthrs/journal/JournalEvent/Input")({
  runId: RunId,
  sourceId: SourceId,
  sourceSeq: Schema.optional(SourceSeq),
  /** How a collision on this event's identity is settled. Defaults to `content`. */
  dedupe: Schema.optional(Dedupe),
  /** Non-empty, NUL-free, well-formed UTF-16 of at most 1,024 code units. */
  eventType: identifier,
  payload: Schema.Unknown,
  meta: Schema.optional(Schema.Unknown)
}) {}

/**
 * Schema for a committed durable journal row.
 *
 * `seq` is allocated synchronously at journal admission and is the only
 * sequence used for replay and durable provenance. `sourceSeq` identifies
 * retries from one producer.
 *
 * @category schemas
 * @since 0.1.0
 */
export class Entry extends Schema.Class<Entry>("@smthrs/journal/JournalEvent/Entry")({
  runId: RunId,
  seq: Seq,
  /**
   * Derived by {@link makeEventId} from the other three identity members, never
   * supplied by a caller, so it carries no check of its own.
   */
  eventId: Schema.String,
  sourceId: SourceId,
  sourceSeq: SourceSeq,
  emittedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * The same bounded identifier `Input.eventType` accepts. It used to be a bare
   * `Schema.String` here, so a consumer decoding an `Entry` accepted an empty,
   * over-long, NUL-bearing, or ill-formed-UTF-16 event type that no emit could
   * ever have produced.
   */
  eventType: identifier,
  payload: Schema.Unknown,
  meta: Schema.Unknown
}) {}

/**
 * Makes a collision-free deterministic event identifier from the idempotency
 * key `(runId, sourceId, sourceSeq)`.
 *
 * Length prefixes preserve tuple boundaries even when identifiers contain the
 * separator. The value is deliberately not random: retrying the same source
 * event must produce the same durable id.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeEventId = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `flows:event:${runId.length}:${runId}${sourceId.length}:${sourceId}${sourceSeq}`

/**
 * Bounded durable text shared by namespace contracts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Identifier = identifier

/**
 * A lineage coordinate, distinct from the run that currently hosts it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LineageId = identifier.pipe(Schema.brand("@smthrs/journal/LineageId"))
/**
 * A lineage coordinate.
 *
 * @category models
 * @since 1.0.0
 */
export type LineageId = typeof LineageId.Type

/**
 * A concrete wait identity.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WaitId = identifier.pipe(Schema.brand("@smthrs/journal/WaitId"))
/**
 * A concrete wait identity.
 *
 * @category models
 * @since 1.0.0
 */
export type WaitId = typeof WaitId.Type

/**
 * An admitted command identity.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommandId = identifier.pipe(Schema.brand("@smthrs/journal/CommandId"))
/**
 * An admitted command identity.
 *
 * @category models
 * @since 1.0.0
 */
export type CommandId = typeof CommandId.Type

/**
 * A plan identity, never interchangeable with a dispatch or artifact.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PlanId = identifier.pipe(Schema.brand("@smthrs/journal/PlanId"))
/**
 * A plan identity.
 *
 * @category models
 * @since 1.0.0
 */
export type PlanId = typeof PlanId.Type

/**
 * A dispatch identity. Branding does not verify its digest.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DispatchId = identifier.pipe(Schema.brand("@smthrs/journal/DispatchId"))
/**
 * A dispatch identity.
 *
 * @category models
 * @since 1.0.0
 */
export type DispatchId = typeof DispatchId.Type

/**
 * An artifact identity. Branding does not verify content.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ArtifactId = identifier.pipe(Schema.brand("@smthrs/journal/ArtifactId"))
/**
 * An artifact identity.
 *
 * @category models
 * @since 1.0.0
 */
export type ArtifactId = typeof ArtifactId.Type

/**
 * Integer quantities in the inclusive safe range, including zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export const NonNegativeQuantity = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Integer quantities in the inclusive safe range, excluding zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PositiveQuantity = NonNegativeQuantity.check(Schema.isGreaterThan(0))

/**
 * Non-negative integral milliseconds since the Unix epoch.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TimestampMs = NonNegativeQuantity.pipe(Schema.brand("@smthrs/journal/TimestampMs"))
/**
 * Non-negative integral milliseconds since the Unix epoch.
 *
 * @category models
 * @since 1.0.0
 */
export type TimestampMs = typeof TimestampMs.Type

/**
 * Decode a run id without a cast; schema failures retain their issue.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeRunId = Schema.decodeUnknownEffect(RunId)
/**
 * Decode a lineage id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeLineageId = Schema.decodeUnknownEffect(LineageId)
/**
 * Decode a wait id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeWaitId = Schema.decodeUnknownEffect(WaitId)
/**
 * Decode a command id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeCommandId = Schema.decodeUnknownEffect(CommandId)
/**
 * Decode a plan id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodePlanId = Schema.decodeUnknownEffect(PlanId)
/**
 * Decode a dispatch id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeDispatchId = Schema.decodeUnknownEffect(DispatchId)
/**
 * Decode an artifact id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeArtifactId = Schema.decodeUnknownEffect(ArtifactId)
/**
 * Decode an absolute timestamp without coercion.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeTimestampMs = Schema.decodeUnknownEffect(TimestampMs)
/**
 * Decode a budget that permits zero. Units belong to the field.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeNonNegativeQuantity = Schema.decodeUnknownEffect(NonNegativeQuantity)
/**
 * Decode a budget that requires positive capacity.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodePositiveQuantity = Schema.decodeUnknownEffect(PositiveQuantity)
