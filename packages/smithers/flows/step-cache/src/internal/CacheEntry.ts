/**
 * The durable cache entry model: its key grammar, its provenance, and the
 * entry schema itself.
 *
 * Every tier reads and writes this one shape, so it lives beneath the service
 * module where the admission policy and the SQL and HTTP tiers can share it
 * without importing one another. `@smthrs/step-cache/CacheStore` re-exports it
 * as part of the public contract.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * A non-negative integer no larger than `Number.MAX_SAFE_INTEGER`.
 *
 * @private
 * @since 0.1.0
 */
export const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Maximum number of characters accepted in one cache-key digest.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumKeyDigestLength = 256

/**
 * One URL-segment-safe cache-key digest.
 *
 * The cache key is accepted at both SQL and HTTP boundaries. Restricting it
 * to this grammar makes `.` / `..`, separators, controls, and ill-formed
 * Unicode unrepresentable before either boundary is touched.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const KeyDigest = Schema.String.check(
  Schema.isMaxLength(maximumKeyDigestLength),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
    expected: "1-256 URL-safe letters, digits, underscores, or hyphens"
  })
)

/**
 * A validated cache-key digest.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type KeyDigest = typeof KeyDigest.Type

/**
 * Maximum number of UTF-16 code units accepted in a recording run id.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumRecordedRunIdLength = 1_024

const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return !value.includes("\0")
}

const wellFormedText = Schema.makeFilter(
  isWellFormedText,
  { title: "wellFormedText" }
)

/**
 * Run id carried by an immutable cache provenance record.
 *
 * Non-empty, well-formed text without a NUL, of at most
 * {@link maximumRecordedRunIdLength} code units. Other control characters are
 * admitted deliberately: the id is opaque here, it reaches SQL as a bound
 * parameter and the wire as a percent-encoded query value, and every stored
 * ledger row is read back through this schema, so narrowing it would make a row
 * an earlier build persisted undecodable.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RecordedRunId = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumRecordedRunIdLength),
  wellFormedText
)

/**
 * Exact journal event that recorded a cache result.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RecordedBy = Schema.Struct({
  runId: RecordedRunId,
  eventSeq: NonNegativeSafeInt
})

/**
 * Exact journal event that recorded a cache result.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RecordedBy = typeof RecordedBy.Type

/**
 * The durable data recorded for a cache key.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CacheEntry = Schema.Struct({
  keyDigest: KeyDigest,
  result: Schema.Unknown,
  meta: Schema.Unknown,
  createdAtMs: NonNegativeSafeInt,
  recordedRunId: RecordedRunId,
  recordedEventSeq: NonNegativeSafeInt
})

/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEntry = typeof CacheEntry.Type
