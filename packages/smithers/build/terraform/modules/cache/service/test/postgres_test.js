/*
 * The integration seam: the same storage, on a real Postgres.
 *
 * The other suites run against fakes, which is what makes them deterministic,
 * and a fake cannot tell you that `FOR NO KEY UPDATE`, the locking CTE in the
 * reference insert, or `FOR UPDATE SKIP LOCKED` in the release functions are
 * statements Postgres actually accepts and actually honours. This file answers
 * that, and only that.
 *
 * It is skipped unless SMITHERS_CACHE_TEST_DATABASE_URL names a database, so
 * `bun test` needs no service. The `//packages/smithers/build:cacheServicePostgres`
 * target runs it with a digest-pinned Postgres declared as a service; this is
 * the manual equivalent:
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_DB=smithers_build_cache_test --name smithers-build-cache-test postgres:17.6-alpine
 *   SMITHERS_CACHE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/smithers_build_cache_test \
 *     bun test test/postgres_test.js
 *
 * Point it at a throwaway database. Setup drops and recreates every `smithers_build_`
 * object the migration defines, and nothing else.
 */
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createStorage } from "../storage.js"

const databaseUrl = process.env.SMITHERS_CACHE_TEST_DATABASE_URL ?? ""

const migration = await Bun.file(new URL("../../migrations/0001_initial.sql", import.meta.url)).text()

const reset = `
  DROP VIEW IF EXISTS smithers_build_unreferenced_artifact CASCADE;
  DROP TABLE IF EXISTS smithers_build_cache_entry_artifact, smithers_build_cache_entry, smithers_build_artifact, smithers_build_cache_schema CASCADE;
  DROP FUNCTION IF EXISTS smithers_build_release_entries(timestamptz, integer);
  DROP FUNCTION IF EXISTS smithers_build_release_artifacts(timestamptz, integer);
`

const blobBytes = new TextEncoder().encode("artifact bytes")
const blob = new Bun.CryptoHasher("sha256").update(blobBytes).digest("hex")

const publicationOf = (resultJson, digests = [blob]) => ({
  body: `{"result":${resultJson}}`,
  resultJson,
  createdAtMs: 1_700_000_000_000,
  recordedRunId: "run-1",
  recordedEventSeq: 7,
  digests
})

describe.skipIf(databaseUrl.length === 0)("storage on a real Postgres", () => {
  let sql
  let storage

  beforeAll(async () => {
    sql = new SQL(databaseUrl, { max: 8 })
    await sql.unsafe(reset)
    await sql.unsafe(migration)
    storage = createStorage(sql)
  })

  afterAll(async () => {
    await sql?.close?.()
  })

  const clear = async () => {
    await sql`DELETE FROM smithers_build_cache_entry_artifact`
    await sql`DELETE FROM smithers_build_cache_entry`
    await sql`DELETE FROM smithers_build_artifact`
  }

  const storeBlob = () => storage.contentStore.put(blob, blobBytes)

  test("applies the shipped schema, including the release functions", async () => {
    const rows = await sql`
      SELECT proname FROM pg_proc WHERE proname LIKE 'smithers_build_release_%' ORDER BY proname
    `
    expect(rows.map((row) => row.proname)).toEqual([
      "smithers_build_release_artifacts",
      "smithers_build_release_entries"
    ])
    expect(await storage.health()).toBe(true)
  })

  test("enforces artifact size and address integrity in the database", async () => {
    await clear()
    await expect((async () => {
      await sql`
        INSERT INTO smithers_build_artifact (digest, content, size_bytes)
        VALUES (${"a".repeat(64)}, ${blobBytes}, ${blobBytes.byteLength})
      `
    })()).rejects.toThrow()
    await expect((async () => {
      await sql`
        INSERT INTO smithers_build_artifact (digest, content, size_bytes)
        VALUES (${blob}, ${blobBytes}, ${blobBytes.byteLength + 1})
      `
    })()).rejects.toThrow()
    expect((await sql`SELECT count(*)::int AS count FROM smithers_build_artifact`)[0].count).toBe(0)
  })

  test("serializes rival CAS publishers and validates existing bytes", async () => {
    await clear()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => storage.contentStore.put(blob, blobBytes))
    )
    expect(outcomes.filter((outcome) => outcome === "inserted")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === "present")).toHaveLength(7)
    const rows =
      await sql`SELECT size_bytes, octet_length(content)::int AS measured, access_count FROM smithers_build_artifact`
    expect(Number(rows[0].size_bytes)).toBe(blobBytes.byteLength)
    expect(rows[0].measured).toBe(blobBytes.byteLength)
    expect(Number(rows[0].access_count)).toBe(7)
  })

  test("saturates access counters instead of overflowing bigint", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`, []))
    // Backdated so the reads below are outside the access-record grace window
    // and actually attempt the increment. Against fresh rows they would refresh
    // nothing and this would assert that a statement that never ran overflowed
    // nothing.
    await sql`
      UPDATE smithers_build_artifact
      SET access_count = 9223372036854775807, last_accessed_at = now() - interval '1 hour'
      WHERE digest = ${blob}
    `
    await sql`
      UPDATE smithers_build_cache_entry
      SET access_count = 9223372036854775807, last_accessed_at = now() - interval '1 hour'
      WHERE key_digest = 'key'
    `
    expect(await storage.contentStore.has(blob)).toBe(true)
    expect(await storage.actionCache.get("key")).not.toBeNull()
    const artifact = await sql`SELECT access_count::text AS count FROM smithers_build_artifact WHERE digest = ${blob}`
    const entry = await sql`SELECT access_count::text AS count FROM smithers_build_cache_entry WHERE key_digest = 'key'`
    expect(artifact[0].count).toBe("9223372036854775807")
    expect(entry[0].count).toBe("9223372036854775807")
  })

  /*
   * The access record is indexed in both stores, so writing it on every read
   * costs a new heap tuple, a new btree entry, WAL for both, and a dead tuple.
   * `xmin` is how that is observable: a row Postgres rewrote carries a new one.
   */
  const entryVersion = async () => {
    const rows = await sql`
      SELECT xmin::text AS version, last_accessed_at FROM smithers_build_cache_entry WHERE key_digest = 'key'
    `
    return rows[0]
  }

  const artifactVersion = async () => {
    const rows = await sql`SELECT xmin::text AS version FROM smithers_build_artifact WHERE digest = ${blob}`
    return rows[0].version
  }

  const backdate = () =>
    sql`
    UPDATE smithers_build_cache_entry SET last_accessed_at = now() - interval '1 hour' WHERE key_digest = 'key'
  `

  test("does not rewrite an entry whose access record is already fresh", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`))

    const before = await entryVersion()
    expect(await storage.actionCache.get("key")).not.toBeNull()
    expect((await entryVersion()).version).toBe(before.version)

    await backdate()
    const stale = await entryVersion()
    expect(await storage.actionCache.get("key")).not.toBeNull()
    const refreshed = await entryVersion()
    expect(refreshed.version).not.toBe(stale.version)
    expect(refreshed.last_accessed_at.getTime()).toBeGreaterThan(stale.last_accessed_at.getTime())
  })

  test("does not rewrite a blob whose access record is already fresh", async () => {
    await clear()
    await storeBlob()

    const before = await artifactVersion()
    expect(await storage.contentStore.has(blob)).toBe(true)
    expect(new TextDecoder().decode((await storage.contentStore.get(blob)).body)).toBe("artifact bytes")
    expect([...(await storage.contentStore.presentDigests([blob]))]).toEqual([blob])
    expect(await artifactVersion()).toBe(before)

    await sql`UPDATE smithers_build_artifact SET last_accessed_at = now() - interval '1 hour' WHERE digest = ${blob}`
    const stale = await artifactVersion()
    expect(await storage.contentStore.has(blob)).toBe(true)
    expect(await artifactVersion()).not.toBe(stale)
  })

  test("keeps a read out of the release cutoff's reach", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`, []))
    await backdate()
    expect(await storage.actionCache.get("key")).not.toBeNull()

    const released = await sql`SELECT smithers_build_release_entries(now() - interval '30 minutes', 10) AS count`
    expect(Number(released[0].count)).toBe(0)
    expect(await storage.actionCache.get("key")).not.toBeNull()
  })

  /*
   * The throttle must never be read as the answer. Rival readers of one stale
   * row all pass the staleness predicate against their own snapshot, and under
   * READ COMMITTED every loser's re-check sees the winner's fresh row and
   * updates nothing. A read that answered from the update's RETURNING would
   * report those losers a miss and send them off to rebuild a cached step.
   */
  test("answers every rival reader of one stale row", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    await backdate()
    await sql`UPDATE smithers_build_artifact SET last_accessed_at = now() - interval '1 hour' WHERE digest = ${blob}`

    const bodies = await Promise.all(Array.from({ length: 8 }, () => storage.actionCache.get("key")))
    expect(bodies.filter((body) => body !== null)).toHaveLength(8)

    const probes = await Promise.all(Array.from({ length: 8 }, () => storage.contentStore.presentDigests([blob])))
    expect(probes.filter((present) => present.has(blob))).toHaveLength(8)
  })

  /*
   * The throttle has to hold under contention too (#2666). Readers queued
   * behind a lock on one stale row must re-check the row they are about to
   * write, not the stale copy their statement first read, so only the first
   * of them refreshes it and every one still answers.
   */
  const contended = async (table, column, key, read) => {
    await sql`UPDATE ${sql(table)} SET access_count = 0, last_accessed_at = now() - interval '1 hour'
      WHERE ${sql(column)} = ${key}`
    let answers
    await sql.begin(async (holder) => {
      await holder`SELECT 1 FROM ${sql(table)} WHERE ${sql(column)} = ${key} FOR UPDATE`
      const pending = Promise.all(Array.from({ length: 4 }, read))
      for (let waiting = 0; waiting < 4;) {
        await Bun.sleep(10)
        const rows = await sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
        waiting = rows[0].waiting
      }
      answers = pending
    })
    const results = await answers
    const rows = await sql`SELECT access_count FROM ${sql(table)} WHERE ${sql(column)} = ${key}`
    return { results, refreshes: Number(rows[0].access_count) }
  }

  test("refreshes a contended stale row once, answering every queued reader, on all four read paths", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    const entry = (read) => contended("smithers_build_cache_entry", "key_digest", "key", read)
    const artifact = (read) => contended("smithers_build_artifact", "digest", blob, read)

    const get = await entry(() => storage.actionCache.get("key"))
    expect(get.results.every((body) => body === `{"result":{"a":1}}`)).toBe(true)
    expect(get.refreshes).toBe(1)

    const has = await artifact(() => storage.contentStore.has(blob))
    expect(has.results).toEqual([true, true, true, true])
    expect(has.refreshes).toBe(1)

    const download = await artifact(() => storage.contentStore.get(blob))
    expect(download.results.map(({ body }) => new TextDecoder().decode(body))).toEqual(
      Array(4).fill("artifact bytes")
    )
    expect(download.refreshes).toBe(1)

    const probe = await artifact(() => storage.contentStore.presentDigests([blob]))
    expect(probe.results.map((present) => [...present])).toEqual(Array(4).fill([blob]))
    expect(probe.refreshes).toBe(1)
  })

  test("leaves a fresh row's access record alone under concurrent reads", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    await sql`UPDATE smithers_build_cache_entry SET access_count = 0, last_accessed_at = now()`
    await sql`UPDATE smithers_build_artifact SET access_count = 0, last_accessed_at = now()`
    await Promise.all([
      ...Array.from({ length: 4 }, () => storage.actionCache.get("key")),
      ...Array.from({ length: 4 }, () => storage.contentStore.has(blob)),
      ...Array.from({ length: 4 }, () => storage.contentStore.get(blob)),
      ...Array.from({ length: 4 }, () => storage.contentStore.presentDigests([blob]))
    ])
    const entries = await sql`SELECT access_count FROM smithers_build_cache_entry`
    const artifacts = await sql`SELECT access_count FROM smithers_build_artifact`
    expect(Number(entries[0].access_count)).toBe(0)
    expect(Number(artifacts[0].access_count)).toBe(0)
  })

  test("classifies a publication, a re-publication, and a divergent result", async () => {
    await clear()
    await storeBlob()
    const first = await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    const again = await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    const other = await storage.actionCache.put("key", publicationOf(`{"a":2}`))

    expect([first, again, other]).toEqual(["inserted", "identical", "conflict"])
    const stored = await sql`SELECT result_canonical, access_count FROM smithers_build_cache_entry`
    expect(stored[0].result_canonical).toBe(`{"a":1}`)
    // The conflicting publisher touched nothing; the identical one freshened once.
    expect(Number(stored[0].access_count)).toBe(1)
    const references = await sql`SELECT key_digest, digest FROM smithers_build_cache_entry_artifact`
    expect(references).toHaveLength(1)
  })

  test("records only blobs that exist, without raising a foreign-key violation", async () => {
    await clear()
    await storeBlob()
    expect(await storage.actionCache.put("key", publicationOf(`{"a":1}`, [blob, "b".repeat(64)]))).toBe(
      "inserted"
    )
    const references = await sql`SELECT digest FROM smithers_build_cache_entry_artifact ORDER BY digest`
    expect(references.map((row) => row.digest.trim())).toEqual([blob])
  })

  test("admits exactly one of many rival publishers of one key", async () => {
    await clear()
    await storeBlob()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) => storage.actionCache.put("key", publicationOf(`{"a":${index}}`)))
    )

    expect(outcomes.filter((outcome) => outcome === "inserted")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(7)
    const rows = await sql`SELECT count(*)::int AS entries FROM smithers_build_cache_entry`
    expect(rows[0].entries).toBe(1)
  })

  test("blocks a delete on the row a publication is holding", async () => {
    await clear()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`, []))
    let blocked = false
    await sql.begin(async (holder) => {
      await holder`SELECT 1 FROM smithers_build_cache_entry WHERE key_digest = 'key' FOR NO KEY UPDATE`
      try {
        // A lock timeout is how the block is observed without waiting on one.
        await sql.begin(async (evictor) => {
          await evictor`SET LOCAL lock_timeout = '250ms'`
          await evictor`DELETE FROM smithers_build_cache_entry WHERE key_digest = 'key'`
        })
      } catch {
        blocked = true
      }
    })
    expect(blocked).toBe(true)
    expect(await storage.actionCache.get("key")).not.toBeNull()
  })

  test("releases entries and artifacts, skipping the rows somebody holds", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("held", publicationOf(`{"a":1}`, []))
    await storage.actionCache.put("free", publicationOf(`{"a":2}`, []))
    const future = new Date(Date.now() + 3_600_000)

    let released
    await sql.begin(async (holder) => {
      await holder`SELECT 1 FROM smithers_build_cache_entry WHERE key_digest = 'held' FOR NO KEY UPDATE`
      const rows = await sql`SELECT smithers_build_release_entries(${future}, 10) AS released`
      released = Number(rows[0].released)
    })

    expect(released).toBe(1)
    expect(await storage.actionCache.get("held")).not.toBeNull()
    expect(await storage.actionCache.get("free")).toBeNull()

    // The blob was never referenced, so it is a release candidate on its own.
    const artifacts = await sql`SELECT smithers_build_release_artifacts(${future}, 10) AS released`
    expect(Number(artifacts[0].released)).toBe(1)
  })

  test("never releases an artifact a live entry references", async () => {
    await clear()
    await storeBlob()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`))
    const future = new Date(Date.now() + 3_600_000)
    const rows = await sql`SELECT smithers_build_release_artifacts(${future}, 10) AS released`
    expect(Number(rows[0].released)).toBe(0)
  })

  test("deletes under a fence and refuses the wrong one", async () => {
    await clear()
    await storage.actionCache.put("key", publicationOf(`{"a":1}`, []))
    expect(await storage.actionCache.delete("key", { runId: "run-2", eventSeq: 7 })).toBe(false)
    expect(await storage.actionCache.delete("key", { runId: "run-1", eventSeq: 7 })).toBe(true)
    expect(await storage.actionCache.delete("key", null)).toBe(false)
  })
})
