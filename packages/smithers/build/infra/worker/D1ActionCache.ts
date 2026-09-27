/**
 * D1 adapter for the action-cache contract.
 *
 * @since 0.1.0
 */

import { CacheFailure } from "./cache-failure.ts"
import { type ActionCache, type ActionCachePublication, canonicalJson, maxCanonicalJsonBytes } from "./protocol.ts"

interface KeyRow {
  readonly key_digest: string
}

interface EntryRow {
  readonly entry_json: string
  /** `1` when the row's last access is older than {@link readTouchDays}. */
  readonly stale: number
}

interface ResultRow {
  readonly result_json: string
}

const maxPublicationAttempts = 3

/**
 * How long a read leaves an entry's access metadata alone.
 *
 * `GET /ac/{key}` is the read credential's route, and the read credential is
 * public within the organization, so a read must not be a write: one that
 * updated its row on every hit would let any reader drive metered D1 writes
 * and keep an entry alive past retention one request at a time. A read
 * touches `last_accessed_at` only when the row's last access is older than
 * this, so a hot key costs one write a day and an entry read daily still
 * stays inside `retentionDays`.
 *
 * @category constants
 * @since 0.1.0
 */
export const readTouchDays = 1

const staleReadCutoff = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${readTouchDays} days')`

const validateStoredResult = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxCanonicalJsonBytes
  ) throw new CacheFailure("D1_RESULT_INVALID", "actionCache.put", "D1 returned an invalid action-cache discriminator")
  let canonical: string
  try {
    canonical = canonicalJson(JSON.parse(value) as unknown)
  } catch {
    throw new CacheFailure("D1_RESULT_INVALID", "actionCache.put", "D1 returned an invalid action-cache discriminator")
  }
  if (canonical !== value) {
    throw new CacheFailure(
      "D1_RESULT_NON_CANONICAL",
      "actionCache.put",
      "D1 returned a non-canonical action-cache discriminator"
    )
  }
  return value
}

const insertEntry = (
  database: D1Database,
  keyDigest: string,
  publication: ActionCachePublication
): Promise<KeyRow | null> =>
  database
    .prepare(
      `INSERT INTO smithers_build_cache_entry (
        key_digest,
        entry_json,
        result_json,
        created_at_ms,
        recorded_run_id,
        recorded_event_seq
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (key_digest) DO NOTHING
      RETURNING key_digest`
    )
    .bind(
      keyDigest,
      publication.body,
      publication.resultJson,
      publication.createdAtMs,
      publication.recordedRunId,
      publication.recordedEventSeq
    )
    .first<KeyRow>()

/** Refreshes a row's access metadata where `condition` holds and returns one column. */
const touchEntry = <Row>(
  database: D1Database,
  keyDigest: string,
  condition: string,
  returning: string
): Promise<Row | null> =>
  database
    .prepare(
      `UPDATE smithers_build_cache_entry
      SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE key_digest = ?${condition}
      RETURNING ${returning}`
    )
    .bind(keyDigest)
    .first<Row>()

const readAndTouchStoredResult = (database: D1Database, keyDigest: string): Promise<ResultRow | null> =>
  touchEntry<ResultRow>(database, keyDigest, "", "result_json")

/**
 * Refreshes the access metadata of a row a read found stale.
 *
 * The cutoff is repeated in the predicate, so two readers that both found the
 * row stale write it once, and a row deleted between the read and the touch
 * stays deleted.
 */
const touchStaleEntry = (database: D1Database, keyDigest: string): Promise<KeyRow | null> =>
  touchEntry<KeyRow>(database, keyDigest, ` AND last_accessed_at < ${staleReadCutoff}`, "key_digest")

/**
 * Adapts D1 to result-only, first-writer-wins head arbitration.
 *
 * The HTTP protocol refuses new journal identities. Existing provenance
 * columns remain available for fenced deletion of legacy rows; this adapter
 * does not retain an immutable journal-identity ledger.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeActionCache = (database: D1Database): ActionCache => ({
  async get(keyDigest) {
    // A read is a row read; it becomes a row write only once a day per key.
    const row = await database
      .prepare(
        `SELECT entry_json, last_accessed_at < ${staleReadCutoff} AS stale
        FROM smithers_build_cache_entry
        WHERE key_digest = ?`
      )
      .bind(keyDigest)
      .first<EntryRow>()
    if (row === null) return null
    if (row.stale === 1) await touchStaleEntry(database, keyDigest)
    return row.entry_json
  },
  async put(keyDigest, publication) {
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      if ((await insertEntry(database, keyDigest, publication)) !== null) return "inserted"
      const stored = await readAndTouchStoredResult(database, keyDigest)
      if (stored !== null) {
        return validateStoredResult(stored.result_json) === publication.resultJson ? "identical" : "conflict"
      }
    }
    throw new CacheFailure("D1_PUBLICATION_LOST", "actionCache.put", "action-cache publication lost its row repeatedly")
  },
  async delete(keyDigest, fence) {
    const row = fence === null
      ? await database
        .prepare("DELETE FROM smithers_build_cache_entry WHERE key_digest = ? RETURNING key_digest")
        .bind(keyDigest)
        .first<KeyRow>()
      : await database
        .prepare(
          `DELETE FROM smithers_build_cache_entry
              WHERE key_digest = ?
                AND recorded_run_id = ?
                AND recorded_event_seq = ?
              RETURNING key_digest`
        )
        .bind(keyDigest, fence.runId, fence.eventSeq)
        .first<KeyRow>()
    return row !== null
  }
})
