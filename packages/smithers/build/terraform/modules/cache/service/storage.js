/*
 * The protocol's storage, on Postgres.
 *
 * Every statement is a Bun SQL tagged template, so every client value is a
 * bound parameter and never text spliced into SQL. The tables are the ones in
 * migrations/0001_initial.sql.
 *
 * `sql` arrives as an argument rather than as a module-level connection, so
 * these functions are testable against a fake and the module opens nothing on
 * import.
 *
 * Transaction assumptions
 * -----------------------
 * `actionCache.put` and `contentStore.put` need more than one statement, and
 * each runs its statements in one transaction. They assume the following,
 * all of which hold at Postgres' default
 * READ COMMITTED isolation, so the service never has to set an isolation level
 * and never has to retry a serialization failure:
 *
 *   1. `pg_advisory_xact_lock` is held to commit and is released by commit or
 *      by rollback, including a rollback the client never sees because the
 *      connection died. It is therefore safe to take it and never release it
 *      explicitly.
 *   2. Two publishers of one key fold to one advisory lock id, so at most one
 *      of them is between the insert and the commit at any moment. The id is a
 *      32-bit fold, so unrelated keys may collide; a collision costs
 *      serialization and never correctness.
 *   3. `SELECT ... FOR NO KEY UPDATE` conflicts with `DELETE`, so the row the
 *      classification describes cannot be released before this transaction
 *      commits. Under READ COMMITTED a row deleted by a transaction that
 *      committed first is dropped from the result rather than returned stale,
 *      which is what makes the vanished case observable as zero rows.
 *   4. `SELECT ... FOR KEY SHARE` on `smithers_build_artifact` conflicts with a
 *      release of those blobs, and under READ COMMITTED it drops a row a
 *      concurrent transaction already deleted. Reference recording therefore
 *      cannot raise a foreign-key violation against the artifact side, and
 *      cannot attach to an entry row this transaction does not hold.
 *   5. An error aborts the whole transaction. Nothing here catches one, so a
 *      failed publication writes nothing and reaches the client as a 503 it
 *      retries, never as a half-recorded entry.
 *
 * `get`, `delete`, `has`, and `presentDigests` are single statements, which
 * Postgres already executes atomically, so none of them opens a transaction.
 * The reads carry their access-record refresh in that same statement, as a
 * data-modifying CTE that fires only outside the grace window
 * (`lruTouchGraceSeconds`); they answer from the read, never from the update.
 */

import { waitForAbort } from "./protocol.js"

/**
 * Advisory-lock class for action-cache publication.
 *
 * `pg_advisory_xact_lock(classid, objid)` partitions the advisory space by the
 * first argument, so this constant keeps publication locks from colliding with
 * any other advisory lock an operator or a future job takes on the same
 * database.
 */
const publicationLockClass = 0x74666c77

/** Separate advisory-lock class for content-addressed publication. */
const artifactLockClass = 0x74666361

/** The only schema version this service binary understands. */
export const cacheSchemaVersion = 1

/**
 * How stale an access record may be before a read refreshes it.
 *
 * `last_accessed_at` is indexed in both stores, so writing it is never a HOT
 * update: each touch writes a new heap tuple, a new btree entry, WAL for both,
 * and a dead tuple for autovacuum. A cache read is overwhelmingly a hit on a
 * blob some other reader just took, so touching on every read spends that write
 * to move a timestamp by milliseconds.
 *
 * Reads therefore refresh the record only once per window and otherwise read
 * without writing. The record is never more than this far behind the read it
 * describes, which is the only property eviction needs: release orders by
 * `last_accessed_at` against a cutoff an operator chooses to be older than the
 * longest expected publication (migrations/0001_initial.sql), and this window
 * is smaller than that cutoff by orders of magnitude.
 *
 * `access_count` follows the same window, so it counts refreshes rather than
 * reads. Nothing reads it back as a read count; it is operator telemetry.
 *
 * Publication touches are deliberately not throttled: `touchEntry` and
 * `touchArtifact` run once per publication under a lock already held, and their
 * freshening is what fences a release against the publication in flight.
 */
const lruTouchGraceSeconds = 300

/**
 * Folds a key to the advisory-lock object id publication serializes on.
 *
 * This is FNV-1a over UTF-16 code units, not a cryptographic digest. The lock
 * only has to be the same 32-bit value for the same key string, and two keys
 * that collide are merely serialized against each other.
 */
const publicationLockKey = (keyDigest) => {
  let hash = 0x811c9dc5
  for (let index = 0; index < keyDigest.length; index += 1) {
    hash ^= keyDigest.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

/**
 * How many times one publication re-inserts after an eviction released the row
 * it was about to classify.
 *
 * With the advisory lock held, no other publisher of this key can be inside
 * the protocol, so only a release can send it around again, and a release can
 * only do so before the row lock is taken. Two attempts already exhaust the
 * benign case; the third exists so a pathological release loop ends as a
 * retryable 503 rather than as an unbounded transaction.
 */
const maxPublicationAttempts = 3
const maxArtifactPublicationAttempts = 3

/**
 * Renders a list of digests as the array literal a bound parameter carries.
 *
 * Bun's SQL client serializes a JavaScript array by joining its elements with
 * commas, which Postgres rejects as a malformed array literal (SQLSTATE 22P02)
 * rather than reading as an array. Passing the array straight into
 * `= ANY($1::char(64)[])` therefore never matched a blob and never recorded a
 * reference: it failed the statement, so every publication that mentioned an
 * artifact and every `findMissing` probe answered 503. The literal is built
 * here instead.
 *
 * This is still exactly one bound parameter, so nothing is spliced into the
 * statement and a value the caller did not validate can at worst produce a
 * parse error. Quoting each element keeps a value containing a comma, a brace,
 * a quote, or a backslash from being read as array syntax.
 */
const digestArray = (digests) =>
  `{${digests.map((digest) => `"${String(digest).replace(/[\\"]/g, "\\$&")}"`).join(",")}}`

/**
 * Creates the action-cache and content-store implementations.
 *
 * @category constructors
 */
const storageQueries = (sql) => {
  /**
   * Records which stored blobs a published entry mentions.
   *
   * The insert selects the blobs `FOR KEY SHARE`, which pins them for the rest
   * of the transaction: a concurrent release cannot delete one out from under
   * the foreign key, and a blob some other transaction already released is
   * dropped from the result instead of raising a violation. Ordering the lock
   * acquisition by digest keeps two publications from taking the same blobs in
   * opposite orders.
   *
   * The caller runs this only while it holds the entry row, so the references
   * attach to the row it classified and never to a row that replaced it.
   */
  const recordReferences = (tx, keyDigest, digests) => {
    if (digests.length === 0) return Promise.resolve()
    return tx`
      WITH present AS (
        SELECT a.digest
        FROM smithers_build_artifact AS a
        WHERE a.digest = ANY(${digestArray(digests)}::char(64)[])
        ORDER BY a.digest
        FOR KEY SHARE
      )
      INSERT INTO smithers_build_cache_entry_artifact (key_digest, digest)
      SELECT ${keyDigest}, present.digest
      FROM present
      ON CONFLICT DO NOTHING
    `
  }

  const touchEntry = (tx, keyDigest) =>
    tx`
      UPDATE smithers_build_cache_entry
      SET last_accessed_at = now(),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE key_digest = ${keyDigest}
    `

  const insertEntry = (tx, keyDigest, publication) =>
    tx`
      INSERT INTO smithers_build_cache_entry (
        key_digest, body, result_canonical, created_at_ms, recorded_run_id, recorded_event_seq
      ) VALUES (
        ${keyDigest}, ${publication.body}, ${publication.resultJson},
        ${publication.createdAtMs}, ${publication.recordedRunId}, ${publication.recordedEventSeq}
      )
      ON CONFLICT (key_digest) DO NOTHING
      RETURNING key_digest
    `

  /**
   * Locks the stored entry and asks whether it records the same result.
   *
   * The lock is what makes the answer usable: without it the row could be
   * released and replaced between the comparison and everything the caller
   * decides from it, so a publication could report `identical` about a row that
   * no longer exists and attach its references to somebody else's result.
   *
   * The comparison is on the canonical rendering the protocol derived, so it is
   * independent of member order in the published document.
   */
  const lockEntry = (tx, keyDigest, publication) =>
    tx`
      SELECT (result_canonical = ${publication.resultJson}) AS same
      FROM smithers_build_cache_entry
      WHERE key_digest = ${keyDigest}
      FOR NO KEY UPDATE
    `

  const actionCache = {
    /**
     * Returns the published document verbatim.
     *
     * The read is also the access record, in one statement, so tracking cannot
     * drift from the reads it is supposed to describe. `candidate` finds the
     * row the outer select answers from, and the update fires only when the
     * row it is about to write is older than the grace window.
     *
     * The staleness test reads the target row, not `candidate`. Rival readers
     * of one stale row queue on its lock; under READ COMMITTED each loser
     * re-checks the target's newest version, sees the winner's refresh, and
     * writes nothing, so a burst pays one refresh. `candidate` keeps the
     * snapshot copy, which would stay stale and let every loser rewrite it.
     *
     * The answer never comes from the update's own `RETURNING`: a loser's
     * update touches nothing, and reading the answer from there would report a
     * present entry as a miss.
     */
    get: async (keyDigest) => {
      const rows = await sql`
        WITH candidate AS (
          SELECT key_digest
          FROM smithers_build_cache_entry
          WHERE key_digest = ${keyDigest}
        ), touched AS (
          UPDATE smithers_build_cache_entry AS entry
          SET last_accessed_at = now(),
              access_count = CASE
                WHEN access_count < 9223372036854775807 THEN access_count + 1
                ELSE access_count
              END
          FROM candidate
          WHERE entry.key_digest = candidate.key_digest
            AND entry.last_accessed_at < now() - ${lruTouchGraceSeconds}::double precision * interval '1 second'
          RETURNING entry.key_digest
        )
        SELECT entry.body
        FROM smithers_build_cache_entry AS entry
        JOIN candidate ON candidate.key_digest = entry.key_digest
      `
      return rows.length === 0 ? null : rows[0].body
    },

    /**
     * Publishes one entry and classifies the row it left behind.
     *
     * The whole protocol is one transaction, because the classification is a
     * claim about a specific row and the caller acts on it: it turns into 201,
     * 200, or the 409 a client escalates as a hermeticity violation, and it
     * decides whose references are recorded. Classifying in separate
     * statements lets a release and a second publisher replace the row in
     * between, so the answer would describe a row that is gone and the
     * references would land on a result this publication never saw.
     *
     * The advisory lock excludes every other publisher of this key. The insert
     * either wins, and holds its own new row to commit, or loses, and the
     * classifying select takes the row lock that keeps the winner's row alive
     * to commit. A release that gets in before the row lock leaves no row to
     * classify, which is a retry rather than a conflict: an eviction racing a
     * publication is not a hermeticity violation.
     */
    put: (keyDigest, publication) =>
      sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${publicationLockClass}::int4, ${publicationLockKey(keyDigest)}::int4)`
        for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
          const inserted = await insertEntry(tx, keyDigest, publication)
          if (inserted.length > 0) {
            await recordReferences(tx, keyDigest, publication.digests)
            return "inserted"
          }
          const existing = await lockEntry(tx, keyDigest, publication)
          if (existing.length === 0) continue
          // First writer wins. An identical re-publication is not a conflict; a
          // different result under one content address is, and the client
          // routes it to its inconsistency receiver. A conflict records no
          // references, because the stored row is not this publication's.
          if (existing[0].same !== true) return "conflict"
          await touchEntry(tx, keyDigest)
          await recordReferences(tx, keyDigest, publication.digests)
          return "identical"
        }
        throw new Error("publication lost the entry row to repeated release")
      }),

    delete: async (keyDigest, fence) => {
      const rows = fence === null
        ? await sql`DELETE FROM smithers_build_cache_entry WHERE key_digest = ${keyDigest} RETURNING key_digest`
        : await sql`
          DELETE FROM smithers_build_cache_entry
          WHERE key_digest = ${keyDigest}
            AND recorded_run_id = ${fence.runId}
            AND recorded_event_seq = ${fence.eventSeq}
          RETURNING key_digest
        `
      return rows.length > 0
    }
  }

  const insertArtifact = (tx, digest, bytes) =>
    tx`
      INSERT INTO smithers_build_artifact (digest, content, size_bytes)
      VALUES (${digest}, ${bytes}, ${bytes.byteLength})
      ON CONFLICT (digest) DO NOTHING
      RETURNING digest
    `

  const lockArtifact = (tx, digest, bytes) =>
    tx`
      SELECT
        size_bytes = ${bytes.byteLength}::bigint AS same_size,
        octet_length(content) = size_bytes AS stored_size_valid,
        digest = encode(sha256(content), 'hex') AS stored_digest_valid,
        content = ${bytes}::bytea AS same_content
      FROM smithers_build_artifact
      WHERE digest = ${digest}
      FOR NO KEY UPDATE
    `

  const touchArtifact = (tx, digest) =>
    tx`
      UPDATE smithers_build_artifact
      SET last_accessed_at = now(),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE digest = ${digest}
    `

  const repairArtifact = (tx, digest, bytes) =>
    tx`
      UPDATE smithers_build_artifact
      SET content = ${bytes},
          size_bytes = ${bytes.byteLength},
          last_accessed_at = now(),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE digest = ${digest}
      RETURNING digest
    `

  const contentStore = {
    has: async (digest) => {
      const rows = await sql`
        WITH candidate AS (
          SELECT digest
          FROM smithers_build_artifact
          WHERE digest = ${digest}
        ), touched AS (
          UPDATE smithers_build_artifact AS artifact
          SET last_accessed_at = now(),
              access_count = CASE
                WHEN access_count < 9223372036854775807 THEN access_count + 1
                ELSE access_count
              END
          FROM candidate
          WHERE artifact.digest = candidate.digest
            AND artifact.last_accessed_at < now() - ${lruTouchGraceSeconds}::double precision * interval '1 second'
          RETURNING artifact.digest
        )
        SELECT octet_length(artifact.content) = artifact.size_bytes AS valid
        FROM smithers_build_artifact AS artifact
        JOIN candidate ON candidate.digest = artifact.digest
      `
      if (rows.length === 0) return false
      if (rows[0].valid !== true) throw new Error("stored artifact failed its integrity check")
      return true
    },

    /**
     * Returns the stored bytes.
     *
     * The check is on length, the same one `has` uses, and not on a re-hash of
     * the content. The address is a database invariant: the table's
     * `smithers_build_artifact_content_address_is_valid` CHECK evaluates
     * `digest = encode(sha256(content), 'hex')` on every insert and every
     * update, and `put` re-verifies a stored row and repairs it before it
     * reports one present. Re-hashing here would spend a SHA-256 over up to
     * 16 MiB per download to re-derive what no write can have violated.
     *
     * `candidate` carries the key only, so the blob is never copied into a CTE
     * tuplestore on its way to the client.
     */
    get: async (digest) => {
      const rows = await sql`
        WITH candidate AS (
          SELECT digest
          FROM smithers_build_artifact
          WHERE digest = ${digest}
        ), touched AS (
          UPDATE smithers_build_artifact AS artifact
          SET last_accessed_at = now(),
              access_count = CASE
                WHEN access_count < 9223372036854775807 THEN access_count + 1
                ELSE access_count
              END
          FROM candidate
          WHERE artifact.digest = candidate.digest
            AND artifact.last_accessed_at < now() - ${lruTouchGraceSeconds}::double precision * interval '1 second'
          RETURNING artifact.digest
        )
        SELECT artifact.content, artifact.size_bytes,
          octet_length(artifact.content) = artifact.size_bytes AS valid
        FROM smithers_build_artifact AS artifact
        JOIN candidate ON candidate.digest = artifact.digest
      `
      if (rows.length === 0) return null
      const row = rows[0]
      if (
        !(row.content instanceof Uint8Array) ||
        Number(row.size_bytes) !== row.content.byteLength ||
        row.valid !== true
      ) {
        throw new Error("stored artifact failed its integrity check")
      }
      return { body: row.content }
    },

    put: (digest, bytes) =>
      sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${artifactLockClass}::int4, ${publicationLockKey(digest)}::int4)`
        for (let attempt = 0; attempt < maxArtifactPublicationAttempts; attempt += 1) {
          const inserted = await insertArtifact(tx, digest, bytes)
          if (inserted.length > 0) return "inserted"
          const existing = await lockArtifact(tx, digest, bytes)
          if (existing.length === 0) continue
          const row = existing[0]
          if (row.stored_size_valid === true && row.stored_digest_valid === true) {
            if (row.same_size !== true || row.same_content !== true) {
              throw new Error("content-address collision in artifact store")
            }
            await touchArtifact(tx, digest)
            return "present"
          }
          const repaired = await repairArtifact(tx, digest, bytes)
          if (repaired.length > 0) return "repaired"
        }
        throw new Error("artifact publication lost its row to repeated release")
      }),

    /**
     * Freshens and reports the blobs that are present.
     *
     * A successful probe is publication evidence. Freshening present blobs
     * fences an age-based release until the client can publish its entry. The
     * grace window bounds how far behind that evidence can be, so the cutoff an
     * operator releases against has to be older than the longest expected
     * publication plus that window rather than the publication alone.
     */
    presentDigests: async (digests) => {
      const rows = await sql`
        WITH candidate AS (
          SELECT digest
          FROM smithers_build_artifact
          WHERE digest = ANY(${digestArray(digests)}::char(64)[])
        ), touched AS (
          UPDATE smithers_build_artifact AS artifact
          SET last_accessed_at = now(),
              access_count = CASE
                WHEN access_count < 9223372036854775807 THEN access_count + 1
                ELSE access_count
              END
          FROM candidate
          WHERE artifact.digest = candidate.digest
            AND artifact.last_accessed_at < now() - ${lruTouchGraceSeconds}::double precision * interval '1 second'
          RETURNING artifact.digest
        )
        SELECT artifact.digest, octet_length(artifact.content) = artifact.size_bytes AS valid
        FROM smithers_build_artifact AS artifact
        JOIN candidate ON candidate.digest = artifact.digest
      `
      if (rows.some((row) => row.valid !== true)) {
        throw new Error("stored artifact failed its integrity check")
      }
      return new Set(rows.map((row) => row.digest))
    }
  }

  const health = async () => {
    const rows = await sql`
      SELECT schema_version
      FROM smithers_build_cache_schema
      WHERE singleton = true
    `
    if (rows.length !== 1 || Number(rows[0].schema_version) !== cacheSchemaVersion) {
      throw new Error("cache database schema version is unsupported")
    }
    return true
  }

  return { actionCache, contentStore, health }
}

/** Binds cancellation to each statement and waits for transaction rollback. */
export const createStorage = (sql) => {
  const bind = (service, name) => (...args) => {
    const parent = args.at(-1) instanceof globalThis.AbortSignal ? args.pop() : undefined
    const controller = new globalThis.AbortController()
    const signal = parent === undefined ? controller.signal : globalThis.AbortSignal.any([parent, controller.signal])
    const scoped = (connection) => {
      const query = (...parameters) => {
        signal.throwIfAborted()
        return waitForAbort(connection(...parameters), signal)
      }
      query.begin = (run) => {
        signal.throwIfAborted()
        return connection.begin(async (tx) => {
          signal.throwIfAborted()
          const result = await run(scoped(tx))
          signal.throwIfAborted()
          return result
        })
      }
      return query
    }
    const methods = storageQueries(scoped(sql))
    const work = (service === null ? methods[name] : methods[service][name])(...args)
    // The signal cancels the current statement. Exposing cancel tells the
    // protocol to drain this promise, including BEGIN/COMMIT/ROLLBACK, before
    // releasing admission. No later statement may start after cancellation.
    work.cancel = () => controller.abort(new globalThis.DOMException("storage operation cancelled", "AbortError"))
    return work
  }
  return {
    actionCache: Object.fromEntries(["get", "put", "delete"].map((name) => [name, bind("actionCache", name)])),
    contentStore: Object.fromEntries(
      ["get", "has", "put", "presentDigests"].map((name) => [name, bind("contentStore", name)])
    ),
    health: bind(null, "health")
  }
}
