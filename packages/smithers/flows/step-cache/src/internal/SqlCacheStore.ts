/**
 * The SQL tier: the durable `flows_step_cache` head and the append-only
 * `flows_step_cache_recorded` ledger beside it.
 *
 * This is the one module in the package that issues SQL. It implements the
 * `CacheStore.Service` contract and admits its input through the same policy
 * the HTTP tier uses; nothing else imports it except
 * `@smthrs/step-cache/CacheStore`, which re-exports {@link make} and builds
 * its SQL layer from it.
 *
 * @since 0.1.0
 */

import * as BoundedJson from "@smthrs/canonical/BoundedJson"
import { affectedRows, DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import type { Service } from "../CacheStore.ts"
import * as CacheStoreMetrics from "../CacheStoreMetrics.ts"
import {
  encodeCanonical,
  jsonLimits,
  maximumJsonBytes,
  snapshotEntry,
  validateAge,
  validateFence,
  validateKey,
  validateRecordedBy
} from "./CacheAdmission.ts"
import { type CacheEntry, KeyDigest, NonNegativeSafeInt, type RecordedBy, RecordedRunId } from "./CacheEntry.ts"
import { CacheStoreError, error } from "./CacheStoreError.ts"

const CacheRow = Schema.Struct({
  key_digest: KeyDigest,
  result_json: Schema.String,
  meta_json: Schema.String,
  created_at_ms: NonNegativeSafeInt,
  recorded_run_id: RecordedRunId,
  recorded_event_seq: NonNegativeSafeInt
})

type CacheRow = typeof CacheRow.Type

/**
 * Whether `value` encodes past `maximum` UTF-8 bytes. The byte limit is a
 * limit on bytes: a code-unit count admits up to three times as much text in
 * characters outside ASCII. A lone surrogate counts as the three bytes of its
 * replacement character.
 */
const exceedsUtf8Bytes = (value: string, maximum: number): boolean => {
  if (value.length > maximum) return true
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) bytes++
    else if (unit <= 0x7ff) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      index++
    } else bytes += 3
    if (bytes > maximum) return true
  }
  return false
}

const decode = (value: string, field: string): Effect.Effect<unknown, CacheStoreError> =>
  Effect.suspend(() => {
    if (exceedsUtf8Bytes(value, maximumJsonBytes)) {
      return Effect.fail(error("decode_failed", `${field} exceeds the ${maximumJsonBytes}-byte limit`))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return Effect.fail(error("decode_failed", `could not decode ${field}`))
    }
    const admitted = BoundedJson.admit(parsed, jsonLimits)
    return admitted.ok
      ? Effect.succeed(admitted.value)
      : Effect.fail(error("decode_failed", `${field} ${admitted.complaint}`))
  })

const mapPersistenceError = (cause: unknown): CacheStoreError => {
  if (Schema.is(CacheStoreError)(cause)) {
    return cause
  }
  const constraint = Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
  return error(
    constraint ? "constraint" : "persistence_failed",
    "cache persistence failed",
    cause
  )
}

const decodeRow = (input: unknown): Effect.Effect<CacheEntry, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheRow)(input).pipe(
    Effect.mapError((cause) => error("decode_failed", "could not decode flows_step_cache row", cause)),
    Effect.flatMap((row) =>
      Effect.all({ result: decode(row.result_json, "result_json"), meta: decode(row.meta_json, "meta_json") }).pipe(
        Effect.map(({ result, meta }) => ({
          keyDigest: row.key_digest,
          result,
          meta,
          createdAtMs: row.created_at_ms,
          recordedRunId: row.recorded_run_id,
          recordedEventSeq: row.recorded_event_seq
        }))
      )
    )
  )

/**
 * Builds the SQL-backed cache store.
 *
 * A cache hit is returned as the step's result, so cached values are
 * executable state and are persisted verbatim; rewriting them here would
 * serve a different value than the one the step produced (issue #72).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  const get: Service["get"] = Effect.fn("CacheStore.get")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* validateKey(keyDigest)
      yield* Effect.annotateCurrentSpan({ keyDigest })
      const maxAgeMs = yield* validateAge("maxAgeMs", options?.maxAgeMs)
      const recordedBy = yield* validateRecordedBy(options?.recordedBy)
      // The age floor is resolved once, from the injected clock, so both reads
      // below judge the same instant and a row cannot be fresh for the ledger
      // read and stale for the head read of one lookup. The validated value,
      // not the caller's option object, is the only value this computation reads.
      const floorMs = maxAgeMs === undefined
        ? undefined
        : (yield* Clock.currentTimeMillis) - maxAgeMs
      const withinBound = (row: CacheEntry): boolean => floorMs === undefined || row.createdAtMs >= floorMs
      if (recordedBy !== undefined) {
        // The ledger row is the durable evidence a replay of that exact event
        // must read; the head is only the fallback for entries recorded under
        // another provenance (a fork sharing the parent's keys, a shared-tier
        // write-back, a pre-ledger row).
        const recorded = yield* sql<Record<string, unknown>>`
          SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          FROM flows_step_cache_recorded
          WHERE key_digest = ${keyDigest}
            AND recorded_run_id = ${recordedBy.runId}
            AND recorded_event_seq = ${recordedBy.eventSeq}
        `.pipe(Effect.mapError(mapPersistenceError))
        if (recorded.length > 0) {
          const entry = yield* decodeRow(recorded[0]!)
          if (withinBound(entry)) {
            yield* Metric.update(CacheStoreMetrics.hit, 1)
            return Option.some(entry)
          }
          // The exact row exists and is older than the bound, so the answer is
          // a miss. Falling through to the head here would hand a replay of
          // that event whatever a later run recorded under the same key, which
          // is a different result than the one the caller asked to read.
          yield* Metric.update(CacheStoreMetrics.miss, 1)
          return Option.none()
        }
      }
      const rows = yield* sql<Record<string, unknown>>`
        SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        FROM flows_step_cache WHERE key_digest = ${keyDigest}
      `.pipe(Effect.mapError(mapPersistenceError))
      if (rows.length === 0) {
        yield* Metric.update(CacheStoreMetrics.miss, 1)
        return Option.none()
      }
      const entry = yield* decodeRow(rows[0]!)
      if (!withinBound(entry)) {
        yield* Metric.update(CacheStoreMetrics.miss, 1)
        return Option.none()
      }
      yield* Metric.update(CacheStoreMetrics.hit, 1)
      return Option.some(entry)
    })
  )

  const put: Service["put"] = Effect.fn("CacheStore.put")((candidate) =>
    Effect.gen(function*() {
      const entry = yield* snapshotEntry(candidate)
      yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
      const result = yield* encodeCanonical(entry.result, "result")
      const meta = yield* encodeCanonical(entry.meta, "meta")
      return yield* writer.write(
        Effect.gen(function*() {
          // The provenance row is immutable. If another write already used
          // this exact journal identity, its complete bytes decide whether
          // this attempt is a retry or a conflict before a mutable head can
          // be created or restored.
          const recorded = yield* sql`
            INSERT INTO flows_step_cache_recorded (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest, recorded_run_id, recorded_event_seq) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          if ((yield* affectedRows(recorded)) === 0) {
            const ledger = yield* sql<CacheRow>`
              SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
              FROM flows_step_cache_recorded
              WHERE key_digest = ${entry.keyDigest}
                AND recorded_run_id = ${entry.recordedRunId}
                AND recorded_event_seq = ${entry.recordedEventSeq}
            `.pipe(Effect.mapError(mapPersistenceError))
            /* v8 ignore next -- the row blocked this insert in the same serialized transaction */
            if (ledger.length === 0) {
              return yield* Effect.fail(error("unknown", "cache provenance disappeared during put"))
            }
            const existing = ledger[0]!
            if (
              existing.result_json !== result ||
              existing.meta_json !== meta ||
              existing.created_at_ms !== entry.createdAtMs
            ) {
              return { _tag: "Conflict" } as const
            }
          }
          const inserted = yield* sql`
            INSERT INTO flows_step_cache (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          if ((yield* affectedRows(inserted)) > 0) {
            return { _tag: "Inserted" } as const
          }
          const rows = yield* sql<Pick<CacheRow, "result_json">>`
            SELECT result_json FROM flows_step_cache WHERE key_digest = ${entry.keyDigest}
          `.pipe(Effect.mapError(mapPersistenceError))
          /* v8 ignore next -- the conflicting row is read in the same serialized write transaction */
          if (rows.length === 0) {
            return yield* Effect.fail(error("unknown", "cache entry disappeared during put"))
          }
          return rows[0]!.result_json === result
            ? { _tag: "ExistingSame" } as const
            : { _tag: "Conflict" } as const
        })
      ).pipe(
        Effect.mapError(mapPersistenceError),
        Effect.tap((outcome) => Metric.update(CacheStoreMetrics.put[outcome._tag], 1))
      )
    })
  )

  const evict: Service["evict"] = Effect.fn("CacheStore.evict")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* validateKey(keyDigest)
      yield* Effect.annotateCurrentSpan({ keyDigest })
      const fenced = yield* validateFence(options?.ifRecordedBy)
      // The provenance predicate rides in the DELETE itself (issue #119):
      // a read-then-delete leaves a window in which another *process* records
      // a fresh row under the same key, and the unconditional delete would
      // drop it. Temporal fences its mutable-state writes the same way — the
      // guard is part of the write, never a prior read. The statement reads the
      // decoded fence, never the caller's provenance object.
      const deleted = yield* writer.write(
        fenced === undefined
          ? sql`DELETE FROM flows_step_cache WHERE key_digest = ${keyDigest}`.raw
          : sql`
            DELETE FROM flows_step_cache
            WHERE key_digest = ${keyDigest}
              AND recorded_run_id = ${fenced.runId}
              AND recorded_event_seq = ${fenced.eventSeq}
          `.raw
      ).pipe(
        Effect.flatMap(affectedRows),
        Effect.mapError(mapPersistenceError)
      )
      return deleted > 0
    })
  )

  const sweepExpired: Service["sweepExpired"] = Effect.fn("CacheStore.sweepExpired")((olderThanMs, options) =>
    Effect.gen(function*() {
      yield* validateAge("olderThanMs", olderThanMs)
      const floorMs = (yield* Clock.currentTimeMillis) - olderThanMs
      yield* Effect.annotateCurrentSpan({ floorMs })
      const canReclaimRecorded = options?.canReclaimRecorded
      const deleted = yield* writer.write(Effect.gen(function*() {
        const heads = yield* sql`DELETE FROM flows_step_cache WHERE created_at_ms < ${floorMs}`.raw.pipe(
          Effect.flatMap(affectedRows)
        )
        if (canReclaimRecorded !== undefined) {
          // Keyset pagination bounds memory without starving later imports
          // behind a page of retained evidence. The empty key sorts before
          // every admitted digest. Keep the cursor even when its row is deleted.
          type ReferenceRow = Pick<CacheRow, "key_digest" | "recorded_run_id" | "recorded_event_seq">
          let cursor: ReferenceRow = { key_digest: "", recorded_run_id: "", recorded_event_seq: 0 }
          while (true) {
            const rows = yield* sql<ReferenceRow>`
              SELECT key_digest, recorded_run_id, recorded_event_seq
              FROM flows_step_cache_recorded
              WHERE created_at_ms < ${floorMs}
                AND (key_digest, recorded_run_id, recorded_event_seq) >
                  (${cursor.key_digest}, ${cursor.recorded_run_id}, ${cursor.recorded_event_seq})
              ORDER BY key_digest, recorded_run_id, recorded_event_seq
              LIMIT 100
            `
            if (rows.length === 0) break
            for (const row of rows) {
              const reclaim = yield* canReclaimRecorded({
                keyDigest: row.key_digest,
                recordedRunId: row.recorded_run_id,
                recordedEventSeq: row.recorded_event_seq
              })
              if (reclaim) {
                yield* sql`
                  DELETE FROM flows_step_cache_recorded
                  WHERE key_digest = ${row.key_digest}
                    AND recorded_run_id = ${row.recorded_run_id}
                    AND recorded_event_seq = ${row.recorded_event_seq}
                    AND created_at_ms < ${floorMs}
                `
              }
            }
            cursor = rows[rows.length - 1]!
          }
        }
        return heads
      })).pipe(Effect.mapError(mapPersistenceError))
      return deleted
    })
  )

  return { get, put, evict, sweepExpired }
})

/**
 * The durable identity of one recorded ledger row: the key and the
 * `(runId, eventSeq)` journal event that recorded it.
 *
 * @category models
 * @since 1.0.0
 */
export type RecordedRef = Pick<CacheEntry, "keyDigest" | "recordedRunId" | "recordedEventSeq">

/**
 * Rebuilds the `flows_step_cache` heads from the append-only
 * `flows_step_cache_recorded` ledger.
 *
 * The heads are a materialization: the journal decides which recorded row
 * may serve each key, and this writes them. Every existing head is deleted,
 * then each candidate whose ledger row still exists is copied into the head
 * byte for byte, so payload limits and provenance are the ones admitted when
 * it was recorded. A candidate whose ledger row is gone is skipped.
 *
 * Every candidate is validated before the writer transaction opens, and two
 * candidates for one key fail `invalid_cache`: a key has one head. The delete
 * and the inserts commit together. Returns the number of heads written.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rebuildHeads = Effect.fn("CacheStore.rebuildHeads")(function*(candidates: Iterable<RecordedRef>) {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  const admitted = new Map<string, RecordedBy>()
  for (const candidate of candidates) {
    yield* validateKey(candidate.keyDigest)
    const recordedBy = yield* validateRecordedBy(
      { runId: candidate.recordedRunId, eventSeq: candidate.recordedEventSeq },
      "rebuild candidate"
    )
    if (admitted.has(candidate.keyDigest)) {
      return yield* Effect.fail(error("invalid_cache", "rebuild candidates name one key twice"))
    }
    admitted.set(candidate.keyDigest, recordedBy!)
  }
  yield* Effect.annotateCurrentSpan({ candidates: admitted.size })
  return yield* writer.write(Effect.gen(function*() {
    yield* sql`DELETE FROM flows_step_cache`
    let written = 0
    for (const [keyDigest, recordedBy] of admitted) {
      written += yield* sql`
        INSERT INTO flows_step_cache (
          key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        )
        SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        FROM flows_step_cache_recorded
        WHERE key_digest = ${keyDigest}
          AND recorded_run_id = ${recordedBy.runId}
          AND recorded_event_seq = ${recordedBy.eventSeq}
      `.raw.pipe(Effect.flatMap(affectedRows))
    }
    return written
  })).pipe(Effect.mapError(mapPersistenceError))
})
