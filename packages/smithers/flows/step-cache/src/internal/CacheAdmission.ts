/**
 * The admission policy every cache tier applies at its input boundary: JSON
 * budgets, canonical encoding, argument validation, and entry snapshots.
 *
 * The SQL tier and the HTTP tier both admit a caller's input through these
 * operations, so a value one tier refuses the other refuses identically. The
 * policy depends on the entry model and the error alone, never on a tier.
 * `@smthrs/step-cache/CacheStore` re-exports it as part of the public contract.
 *
 * @since 0.1.0
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"
import { Canonical } from "@smthrs/canonical/Canonical"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CacheEntry, KeyDigest, RecordedBy } from "./CacheEntry.ts"
import { type CacheStoreError, error } from "./CacheStoreError.ts"

/**
 * Maximum encoded bytes admitted for one `result` or `meta` JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonBytes = 4 * 1024 * 1024

/**
 * Maximum nesting admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonDepth = 128

/**
 * Maximum values admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonNodes = 100_000

/**
 * Maximum members admitted by one cache JSON array or object.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonMembers = 100_000

/**
 * Cache values always carry a finite byte budget and finite per-container
 * member, string, and key budgets, so every limit the shared boundary leaves
 * optional is required here. `maxTotalMembers` is omitted: the cache bounds
 * each container, and a whole tree by `maxNodes` and `maxBytes`.
 */
type CacheJsonLimits = Required<Omit<BoundedJson.Limits, "maxTotalMembers">>

/**
 * The admission policy for one `result` or `meta` tree. The SQL tier decodes
 * stored JSON under it too, so a row it wrote always reads back.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const jsonLimits: CacheJsonLimits = {
  maxBytes: maximumJsonBytes,
  maxDepth: maximumJsonDepth,
  maxMembers: maximumJsonMembers,
  maxNodes: maximumJsonNodes,
  maxStringBytes: maximumJsonBytes,
  maxKeyBytes: 16 * 1024
}

/**
 * The admission policy for a whole wire entry: each field's own budget, plus
 * the envelope itself. The envelope adds one nesting level above `result` and
 * `meta`, and five nodes (the entry object and its four scalar members), while
 * `maximumJsonBytes` still bounds the whole encoding. Remote reads admit an
 * entry field-by-field under `jsonLimits` with the same whole-entry byte
 * bound, so encoding under these allowances keeps publication symmetric with
 * lookup: an entry a `get` returned always fits a `put`.
 */
const entryJsonLimits: CacheJsonLimits = {
  ...jsonLimits,
  maxDepth: maximumJsonDepth + 1,
  maxNodes: 2 * maximumJsonNodes + 5
}

const encodeBounded = (
  value: unknown,
  field: string,
  limits: CacheJsonLimits
): Effect.Effect<string, CacheStoreError> =>
  Effect.suspend(() => {
    const admitted = BoundedJson.admit(value, limits)
    return admitted.ok
      ? Schema.decodeUnknownEffect(Canonical)(admitted.value).pipe(
        /* v8 ignore next -- bounded inert JSON is exactly Canonical's accepted domain */
        Effect.mapError(() => error("invalid_cache", `${field} must have a bounded canonical JSON form`))
      )
      : Effect.fail(error("invalid_cache", `${field} ${admitted.complaint}`))
  })

/**
 * Encodes a stored value as RFC 8785 canonical JSON.
 *
 * `put` decides `ExistingSame` versus `Conflict` by comparing `result_json`
 * text. `JSON.stringify` output depends on key insertion order, so two
 * structurally equal results built in different orders compared unequal, and
 * `ActionPersistence` routes `Conflict` to the `Inconsistency` receiver whose
 * core default verdict is `fail` — the run failed with `CacheConflictDetected`
 * naming a divergence that did not exist. Canonicalizing on the way in makes
 * the text comparison a structural one, which is what `@smthrs/canonical`
 * exists for.
 *
 * `RemoteCacheStore.put` runs the same check before serializing an entry onto
 * the wire, so a value with no JSON form is refused identically by both tiers.
 *
 * @category serialization
 * @since 1.0.0-rc.0
 */
export const encodeCanonical = (value: unknown, field: string): Effect.Effect<string, CacheStoreError> =>
  encodeBounded(value, field, jsonLimits)

/**
 * Encodes a whole cache entry as RFC 8785 canonical JSON for the wire.
 *
 * The entry is admitted under the whole-entry policy documented on
 * `entryJsonLimits`: the two field budgets plus the envelope's one nesting
 * level and five nodes, with `maximumJsonBytes` bounding the encoding as a
 * whole. A remote lookup reads an entry back under exactly that policy, so a
 * publication that re-validates each field and then encodes here never
 * refuses an entry a `get` could have returned.
 *
 * @category serialization
 * @since 1.0.0-rc.0
 */
export const encodeEntryCanonical = (entry: CacheEntry): Effect.Effect<string, CacheStoreError> =>
  encodeBounded(entry, "cache entry", entryJsonLimits)

/**
 * Validates a cache-key digest before any statement or request is issued.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateKey = (keyDigest: string): Effect.Effect<void, CacheStoreError> =>
  Schema.decodeUnknownEffect(KeyDigest)(keyDigest).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => error("invalid_cache", "keyDigest violates the cache-key contract", cause))
  )

/**
 * Validates a provenance selector before a store performs I/O and returns the
 * schema-decoded copy (or `undefined`). Returning that detached value lets the
 * operation decode once and never reread caller-owned accessors.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateRecordedBy = (
  recordedBy: RecordedBy | undefined,
  field = "recordedBy"
): Effect.Effect<RecordedBy | undefined, CacheStoreError> =>
  recordedBy === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(RecordedBy)(recordedBy).pipe(
      Effect.mapError((cause) => error("invalid_cache", `${field} violates the provenance contract`, cause))
    )

/**
 * Refuses a malformed eviction fence before any statement or request is
 * issued. A fence naming an empty run or a sequence number no journal can
 * record is a compare-and-swap no row could ever satisfy; running it anyway
 * would misreport the caller's mistake as an ordinary "nothing matched".
 * It returns the decoded fence (or `undefined`) so the guarded delete uses
 * exactly the value that validation observed, including its inner fields.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateFence = (
  fence: RecordedBy | undefined
): Effect.Effect<RecordedBy | undefined, CacheStoreError> => validateRecordedBy(fence, "eviction fence")

/**
 * Refuses an age bound no row could satisfy before any statement is issued.
 * A negative or fractional millisecond count is a caller mistake, and running
 * it anyway would report that mistake as an ordinary miss.
 * It returns the checked primitive (or `undefined`) so an operation reads an
 * option accessor once and computes its age floor from that same value.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateAge = (
  field: string,
  value: number | undefined
): Effect.Effect<number | undefined, CacheStoreError> =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0)
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_cache", `${field} must be a non-negative safe integer`))

/**
 * Takes an inert, detached snapshot of a cache entry at effect start.
 * Schema decoding builds a new top-level object, so the returned entry is
 * frozen after decoding; freezing only the provisional input would leave the
 * shell received by callers mutable.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const snapshotEntry = (input: CacheEntry): Effect.Effect<CacheEntry, CacheStoreError> =>
  Effect.suspend(() => {
    try {
      if (typeof input !== "object" || input === null) throw new TypeError("entry")
      const names = ["keyDigest", "result", "meta", "createdAtMs", "recordedRunId", "recordedEventSeq"] as const
      const values = Object.create(null) as Record<(typeof names)[number], unknown>
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("entry")
        }
        values[name] = descriptor.value
      }
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !(names as ReadonlyArray<string>).includes(key)) {
          if (Object.getOwnPropertyDescriptor(input, key)?.enumerable) throw new TypeError("entry")
        }
      }
      const result = BoundedJson.admit(values.result, jsonLimits)
      const meta = BoundedJson.admit(values.meta, jsonLimits)
      if (!result.ok || !meta.ok) {
        return Effect.fail(error(
          "invalid_cache",
          !result.ok ? `result ${result.complaint}` : `meta ${(meta as { readonly complaint: string }).complaint}`
        ))
      }
      const snapshot = Object.freeze({
        keyDigest: values.keyDigest,
        result: result.value,
        meta: meta.value,
        createdAtMs: values.createdAtMs,
        recordedRunId: values.recordedRunId,
        recordedEventSeq: values.recordedEventSeq
      })
      return Schema.decodeUnknownEffect(CacheEntry)(snapshot).pipe(
        Effect.map((entry) => Object.freeze(entry)),
        Effect.mapError(() => error("invalid_cache", "cache entry violates the persistence contract"))
      )
    } catch {
      return Effect.fail(error("invalid_cache", "cache entry cannot be inspected as inert data"))
    }
  })
