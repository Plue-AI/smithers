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
 * The reserved prefix of every companion stream id.
 *
 * A run id that begins with it names a companion stream, never a run: stores
 * that admit run ids (`@smthrs/run-store`'s `RunStore.create`) refuse it.
 *
 * @category constants
 * @since 1.0.0
 */
export const companionPrefix = "flows.companion/"

/** SHA-256 round constants: the first 32 bits of the cube roots of the first 64 primes. */
const sha256Rounds = Uint32Array.from([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2
])

const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits))

/**
 * SHA-256 of the UTF-8 encoding of `text`, as lowercase hex.
 *
 * Synchronous on purpose: companion ids are derived inside write
 * transactions, and an asynchronous digest would yield the event loop while
 * the writer is held.
 */
const sha256Hex = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  const length = ((bytes.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(length)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(length - 4, (bytes.length << 3) >>> 0)
  const hash = Uint32Array.from([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ])
  const words = new Uint32Array(64)
  for (let block = 0; block < length; block += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(block + index * 4)
    for (let index = 16; index < 64; index++) {
      const low = words[index - 15]!
      const high = words[index - 2]!
      const s0 = rotate(low, 7) ^ rotate(low, 18) ^ (low >>> 3)
      const s1 = rotate(high, 17) ^ rotate(high, 19) ^ (high >>> 10)
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0
    }
    let a = hash[0]!
    let b = hash[1]!
    let c = hash[2]!
    let d = hash[3]!
    let e = hash[4]!
    let f = hash[5]!
    let g = hash[6]!
    let h = hash[7]!
    for (let index = 0; index < 64; index++) {
      const choose = (e & f) ^ (~e & g)
      const t1 =
        (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + choose + sha256Rounds[index]! + words[index]!) >>> 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] = (hash[0]! + a) >>> 0
    hash[1] = (hash[1]! + b) >>> 0
    hash[2] = (hash[2]! + c) >>> 0
    hash[3] = (hash[3]! + d) >>> 0
    hash[4] = (hash[4]! + e) >>> 0
    hash[5] = (hash[5]! + f) >>> 0
    hash[6] = (hash[6]! + g) >>> 0
    hash[7] = (hash[7]! + h) >>> 0
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("")
}

/**
 * The id of the companion stream that carries one store's facts about a run.
 *
 * A companion stream is an ordinary journal stream with its own sequence
 * clock, kept beside the run's own stream rather than inside it. A consumer
 * that reads the run's stream by position never sees a companion fact, and a
 * rewind or compaction of the run's stream never truncates one. The id is
 * `flows.companion/<stream>/<sha-256 of the run id>`, so it stays within
 * {@link maxIdentifierLength} for every run id; each fact carries its run id
 * in its payload.
 *
 * @category constructors
 * @since 1.0.0
 */
export const companionRunId = (stream: string, runId: string): RunId =>
  `${companionPrefix}${stream}/${sha256Hex(runId)}` as RunId

/**
 * Whether a run id names a companion stream.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isCompanionRunId = (runId: string): boolean => runId.startsWith(companionPrefix)

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
