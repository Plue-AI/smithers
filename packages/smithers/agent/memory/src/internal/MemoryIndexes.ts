/**
 * The second memory migration: the indexes its hot reads actually use.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Replaces the unusable `(updated_at_ms, ttl_ms)` expiry index with one over
 * the `updated_at_ms + ttl_ms` expression the sweep filters on, and adds the
 * reverse edge index the supersession filter of every default note read
 * looks up. Databases created by the current `initial` already hold both, so
 * every statement is idempotent.
 *
 * @category migrations
 * @since 1.0.0
 */
export const indexes = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP INDEX IF EXISTS memory_facts_expiry_idx`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_facts_expires_at_idx
    ON memory_facts ((updated_at_ms + ttl_ms)) WHERE ttl_ms IS NOT NULL`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_note_supersedes_target_idx
    ON memory_note_supersedes (target_id, superseder_id)`
})
