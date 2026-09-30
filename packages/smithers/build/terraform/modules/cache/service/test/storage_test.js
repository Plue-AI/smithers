/*
 * Storage tests, run by `bun test`, against two fake SQL boundaries.
 *
 * `fakeSql` replays queued answers and records the bound parameters, which is
 * how the statement shapes, the parameter binding, and the transaction
 * boundaries are asserted. Every client value must arrive as a parameter; a
 * value spliced into the statement text would show up here as a missing one.
 *
 * `fakePostgres` interprets those statements against an in-memory table with
 * the locking rules storage.js documents: transaction-scoped advisory locks,
 * `FOR NO KEY UPDATE` row locks that block a delete, and `FOR KEY SHARE` locks
 * on blobs. It exists because publication is a concurrency protocol, and the
 * only honest test of one is to run the interleavings. The interleavings here
 * are scheduled by hand, so they are deterministic and not a race the suite
 * happens to lose.
 */
import { describe, expect, test } from "bun:test"
import { createStorage } from "../storage.js"

const collapse = (strings) => strings.join("?").replace(/\s+/g, " ").trim()

/**
 * A Bun SQL tagged template that replays queued answers.
 *
 * Each answer is either an array of rows or a function of the collapsed
 * statement text, which lets one fake serve the multi-statement paths.
 * `begin` runs its callback against the same template and brackets the
 * recorded calls with the marker the transaction tests read.
 */
const fakeSql = (answers) => {
  const calls = []
  const remaining = [...answers]
  const sql = (strings, ...values) => {
    const text = collapse(strings)
    calls.push({ text, values })
    const answer = remaining.shift()
    if (answer === undefined) throw new Error(`unexpected statement: ${text}`)
    if (typeof answer === "function") return Promise.resolve(answer(text, values))
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  }
  sql.begin = async (run) => {
    calls.push({ text: "BEGIN", values: [] })
    try {
      const value = await run(sql)
      calls.push({ text: "COMMIT", values: [] })
      return value
    } catch (cause) {
      calls.push({ text: "ROLLBACK", values: [] })
      throw cause
    }
  }
  return {
    sql,
    calls,
    get pending() {
      return remaining.length
    }
  }
}

/** The statement text of every call a fake recorded, transaction markers included. */
const texts = (fake) => fake.calls.map((call) => call.text)

/**
 * Reads back the Postgres array literal storage.js binds for a digest list.
 *
 * Bun serializes a JavaScript array by joining it with commas, which Postgres
 * refuses as a malformed array literal, so storage.js renders the literal
 * itself. Parsing it here is what keeps that rendering honest: the fakes see
 * the value the wire would carry, not the array it came from.
 */
const parseDigestArray = (literal) => {
  const elements = []
  const scanner = /"((?:[^"\\]|\\.)*)"/g
  let match = scanner.exec(literal)
  while (match !== null) {
    elements.push(match[1].replace(/\\(.)/g, "$1"))
    match = scanner.exec(literal)
  }
  return elements
}

/** A lock a transaction holds until it commits or rolls back. */
const lockTable = () => {
  const holder = new Map()
  const waiting = new Map()
  const held = new Map()

  const take = (id, transaction) => {
    holder.set(id, transaction)
    const own = held.get(transaction) ?? new Set()
    own.add(id)
    held.set(transaction, own)
  }

  return {
    acquire: (id, transaction) => {
      const current = holder.get(id)
      if (current === undefined) {
        take(id, transaction)
        return Promise.resolve()
      }
      if (current === transaction) return Promise.resolve()
      return new Promise((resolve) => {
        const queue = waiting.get(id) ?? []
        queue.push({ transaction, resolve })
        waiting.set(id, queue)
      })
    },
    releaseAll: (transaction) => {
      for (const id of held.get(transaction) ?? []) {
        holder.delete(id)
        const next = (waiting.get(id) ?? []).shift()
        if (next !== undefined) {
          take(id, next.transaction)
          next.resolve()
        }
      }
      held.delete(transaction)
    }
  }
}

/** A one-shot rendezvous: the test waits for `arrived`, then calls `release`. */
const latch = () => {
  let release
  let arrive
  const opened = new Promise((resolve) => {
    release = resolve
  })
  const arrived = new Promise((resolve) => {
    arrive = resolve
  })
  return { arrived, arrive, opened, release }
}

/**
 * An in-memory Postgres with the locking semantics publication relies on.
 *
 * `pause` is called after each statement produces its rows and before they are
 * returned, which is where a test interleaves another transaction.
 */
const fakePostgres = ({ pause = null } = {}) => {
  const entries = new Map()
  const artifacts = new Set()
  const references = new Set()
  const advisory = lockTable()
  const rows = lockTable()
  const statements = []
  let counter = 0

  const execute = async (transaction, text, values) => {
    if (text.startsWith("SELECT pg_advisory_xact_lock")) {
      await advisory.acquire(`${values[0]}/${values[1]}`, transaction)
      return []
    }
    if (text.startsWith("INSERT INTO smithers_build_cache_entry (")) {
      const [key, body, resultJson] = values
      if (entries.has(key)) return []
      await rows.acquire(key, transaction)
      entries.set(key, { body, resultJson, accessCount: 0 })
      transaction.undo.push(() => entries.delete(key))
      return [{ key_digest: key }]
    }
    if (text.startsWith("SELECT (result_canonical")) {
      const [resultJson, key] = values
      if (!entries.has(key)) return []
      // The lock is taken only when the statement asks for it, so a comparison
      // that dropped its locking clause reads exactly as unprotected here as it
      // would against Postgres.
      if (text.endsWith("FOR NO KEY UPDATE")) await rows.acquire(key, transaction)
      // Postgres rechecks after the wait, and a row a committed transaction
      // deleted meanwhile is dropped rather than returned stale.
      const entry = entries.get(key)
      if (entry === undefined) return []
      return [{ same: entry.resultJson === resultJson }]
    }
    if (text.startsWith("UPDATE smithers_build_cache_entry SET last_accessed_at")) {
      const key = values[0]
      if (!entries.has(key)) return []
      await rows.acquire(key, transaction)
      const entry = entries.get(key)
      if (entry === undefined) return []
      entry.accessCount += 1
      return [{ body: entry.body }]
    }
    if (text.startsWith("DELETE FROM smithers_build_cache_entry")) {
      const key = values[0]
      await rows.acquire(key, transaction)
      const entry = entries.get(key)
      if (entry === undefined) return []
      entries.delete(key)
      transaction.undo.push(() => entries.set(key, entry))
      return [{ key_digest: key }]
    }
    if (text.startsWith("WITH present AS")) {
      const [literal, key] = values
      for (const digest of parseDigestArray(literal).sort()) {
        if (!artifacts.has(digest)) continue
        if (text.includes("FOR KEY SHARE")) await rows.acquire(`artifact:${digest}`, transaction)
        if (!artifacts.has(digest)) continue
        references.add(`${key}/${digest}`)
        transaction.undo.push(() => references.delete(`${key}/${digest}`))
      }
      return []
    }
    throw new Error(`unsupported statement: ${text}`)
  }

  const run = async (name, body) => {
    const transaction = { name, undo: [] }
    const scoped = async (strings, ...values) => {
      const text = collapse(strings)
      const produced = await execute(transaction, text, values)
      statements.push({ transaction: name, text, values })
      if (pause !== null) await pause({ transaction: name, text, values })
      return produced
    }
    try {
      const value = await body(scoped)
      return value
    } catch (cause) {
      for (const undo of transaction.undo.reverse()) undo()
      throw cause
    } finally {
      advisory.releaseAll(transaction)
      rows.releaseAll(transaction)
    }
  }

  const sql = (strings, ...values) => run(`auto-${counter++}`, (tx) => tx(strings, ...values))
  sql.begin = (body) => run(`tx-${counter++}`, body)

  return { sql, entries, artifacts, references, statements }
}

const publication = {
  body: `{"keyDigest":"key","result":{"b":1,"a":2}}`,
  resultJson: `{"a":2,"b":1}`,
  createdAtMs: 1_700_000_000_000,
  recordedRunId: "run-1",
  recordedEventSeq: 7,
  digests: ["a".repeat(64)]
}

const otherPublication = { ...publication, body: `{"result":{"a":3}}`, resultJson: `{"a":3}` }

const postgresError = (code) => Object.assign(new Error("violation"), { code })

describe("action cache reads", () => {
  test("returns the published document verbatim and freshens it in one statement", async () => {
    const { sql, calls } = fakeSql([[{ body: publication.body }]])
    const storage = createStorage(sql)
    expect(await storage.actionCache.get("key")).toBe(publication.body)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain("UPDATE smithers_build_cache_entry")
    expect(calls[0].text).toContain("last_accessed_at = now()")
    expect(calls[0].values).toEqual(["key", 300])
  })

  test("refreshes the access record only outside the grace window", async () => {
    const { sql, calls } = fakeSql([[{ body: publication.body }]])
    await createStorage(sql).actionCache.get("key")
    // last_accessed_at is indexed, so an unconditional touch makes every read a
    // non-HOT write. The update is gated on the row it writes being stale, so a
    // reader queued behind a rival's refresh re-checks that refresh (#2666), and
    // the answer comes from the read so a lost update is never reported a miss.
    expect(calls[0].text).toContain(
      "entry.last_accessed_at < now() - ?::double precision * interval '1 second'"
    )
    expect(calls[0].text).not.toContain("candidate.last_accessed_at")
    expect(calls[0].text).toContain("JOIN candidate ON candidate.key_digest = entry.key_digest")
    expect(calls[0].values[1]).toBe(300)
  })

  test("reports a miss as null rather than as a failure", async () => {
    const { sql } = fakeSql([[]])
    expect(await createStorage(sql).actionCache.get("key")).toBeNull()
  })

  test("propagates a storage failure instead of reporting a miss", async () => {
    const { sql } = fakeSql([new Error("connection reset")])
    await expect(createStorage(sql).actionCache.get("key")).rejects.toThrow("connection reset")
  })

  test("deletes unfenced and fenced, and reports whether a row went", async () => {
    const unfenced = fakeSql([[{ key_digest: "key" }]])
    const fenced = fakeSql([[]])

    expect(await createStorage(unfenced.sql).actionCache.delete("key", null)).toBe(true)
    expect(unfenced.calls[0].values).toEqual(["key"])
    expect(unfenced.calls[0].text).not.toContain("recorded_run_id")

    expect(await createStorage(fenced.sql).actionCache.delete("key", { runId: "run-1", eventSeq: 7 })).toBe(
      false
    )
    expect(fenced.calls[0].text).toContain("recorded_run_id")
    expect(fenced.calls[0].values).toEqual(["key", "run-1", 7])
  })
})

describe("publication statement order", () => {
  const insertedAnswers = [[], [{ key_digest: "key" }], []]

  test("takes the advisory lock before it writes, and commits once", async () => {
    const fake = fakeSql(insertedAnswers)
    const { sql, calls } = fake
    expect(await createStorage(sql).actionCache.put("key", publication)).toBe("inserted")
    const order = texts(fake)
    expect(order[0]).toBe("BEGIN")
    expect(order[1]).toContain("pg_advisory_xact_lock")
    expect(order[2]).toContain("INSERT INTO smithers_build_cache_entry (")
    expect(order[3]).toContain("INSERT INTO smithers_build_cache_entry_artifact")
    expect(order.at(-1)).toBe("COMMIT")
    expect(order.filter((text) => text === "BEGIN")).toHaveLength(1)
    expect(order).not.toContain("ROLLBACK")
    // The lock is taken on two int4 arguments, so the overload Postgres picks
    // is the partitioned one and not the bigint one.
    expect(calls[1].text).toContain("::int4")
    expect(calls[1].values).toHaveLength(2)
    expect(calls[1].values.every((value) => Number.isSafeInteger(value))).toBe(true)
  })

  test("folds the same key to the same lock id and different keys apart", async () => {
    const lockOf = async (key) => {
      const { sql, calls } = fakeSql([[], [{ key_digest: key }], []])
      await createStorage(sql).actionCache.put(key, publication)
      return calls[1].values
    }
    expect(await lockOf("key")).toEqual(await lockOf("key"))
    expect(await lockOf("key")).not.toEqual(await lockOf("other-key"))
  })

  test("binds every publication value as a parameter", async () => {
    const { sql, calls } = fakeSql(insertedAnswers)
    await createStorage(sql).actionCache.put("key", publication)
    expect(calls[2].values).toEqual([
      "key",
      publication.body,
      publication.resultJson,
      publication.createdAtMs,
      publication.recordedRunId,
      publication.recordedEventSeq
    ])
    expect(calls[2].text).not.toContain(publication.body)
  })

  test("records references under a key-share lock on the blobs", async () => {
    const { sql, calls } = fakeSql(insertedAnswers)
    await createStorage(sql).actionCache.put("key", publication)
    expect(calls[3].text).toContain("FOR KEY SHARE")
    expect(calls[3].text).toContain("ON CONFLICT DO NOTHING")
    expect(calls[3].values).toEqual([`{"${publication.digests[0]}"}`, "key"])
    expect(parseDigestArray(calls[3].values[0])).toEqual(publication.digests)
  })

  test("renders the digest list as an array literal Postgres can parse", async () => {
    // Bun joins a JavaScript array with commas, which Postgres reads as one
    // malformed literal and refuses, so the reference insert and every
    // findMissing probe answered 503 instead of matching a blob.
    const hostile = [`a,b`, `c"d`, `e\\f`, "{}"]
    const fake = fakeSql([[], [{ key_digest: "key" }], []])
    await createStorage(fake.sql).actionCache.put("key", { ...publication, digests: hostile })
    const literal = fake.calls[3].values[0]

    expect(literal.startsWith("{")).toBe(true)
    expect(literal.endsWith("}")).toBe(true)
    expect(parseDigestArray(literal)).toEqual(hostile)
  })

  test("skips the reference statement when nothing is mentioned", async () => {
    const fake = fakeSql([[], [{ key_digest: "key" }]])
    await createStorage(fake.sql).actionCache.put("key", { ...publication, digests: [] })
    const order = texts(fake)
    expect(order).toEqual(["BEGIN", order[1], order[2], "COMMIT"])
  })

  test("locks the stored row before it classifies an identical re-publication", async () => {
    const fake = fakeSql([[], [], [{ same: true }], [], []])
    expect(await createStorage(fake.sql).actionCache.put("key", publication)).toBe("identical")
    const order = texts(fake)
    expect(order[3]).toContain("FOR NO KEY UPDATE")
    expect(fake.calls[3].values).toEqual([publication.resultJson, "key"])
    expect(order[4]).toContain("WHEN access_count < 9223372036854775807")
    expect(order[5]).toContain("INSERT INTO smithers_build_cache_entry_artifact")
    expect(order.at(-1)).toBe("COMMIT")
  })

  test("reports a conflict from the locked row and writes nothing more", async () => {
    const fake = fakeSql([[], [], [{ same: false }]])
    expect(await createStorage(fake.sql).actionCache.put("key", publication)).toBe("conflict")
    const order = texts(fake)
    expect(order).toHaveLength(5)
    expect(order.at(-1)).toBe("COMMIT")
    expect(order.join(" ")).not.toContain("smithers_build_cache_entry_artifact")
  })

  test("re-inserts inside the same transaction when the row vanished before the lock", async () => {
    const fake = fakeSql([[], [], [], [{ key_digest: "key" }], []])
    expect(await createStorage(fake.sql).actionCache.put("key", publication)).toBe("inserted")
    const order = texts(fake)
    expect(order.filter((text) => text === "BEGIN")).toHaveLength(1)
    expect(order.filter((text) => text.startsWith("SELECT pg_advisory_xact_lock"))).toHaveLength(1)
    expect(order.filter((text) => text.includes("INSERT INTO smithers_build_cache_entry ("))).toHaveLength(2)
  })

  test("gives up as a retryable failure rather than looping on repeated release", async () => {
    const fake = fakeSql([[], [], [], [], [], [], []])
    await expect(createStorage(fake.sql).actionCache.put("key", publication)).rejects.toThrow(
      "repeated release"
    )
    expect(texts(fake).at(-1)).toBe("ROLLBACK")
  })

  test("rolls the whole publication back when a statement fails", async () => {
    const fake = fakeSql([[], [{ key_digest: "key" }], postgresError("23503")])
    await expect(createStorage(fake.sql).actionCache.put("key", publication)).rejects.toThrow("violation")
    expect(texts(fake).at(-1)).toBe("ROLLBACK")
    expect(texts(fake)).not.toContain("COMMIT")
  })

  test("propagates a lock failure as a failure and never as a classification", async () => {
    const { sql } = fakeSql([new Error("connection reset")])
    await expect(createStorage(sql).actionCache.put("key", publication)).rejects.toThrow("connection reset")
  })
})

describe("publication concurrency", () => {
  test("classifies the row it protects when an eviction and a rival race it", async () => {
    // The defect this reproduces: A loses the insert to an identical row, an
    // eviction releases that row, B publishes a different result under the same
    // key, and A's follow-up statements land on B's row while A answers
    // `identical`. Everything below is scheduled by hand, so the interleaving
    // is the one described and not a coincidence.
    const reachedInsert = latch()
    const db = fakePostgres({
      pause: async (event) => {
        if (event.transaction !== "tx-0") return
        if (!event.text.startsWith("INSERT INTO smithers_build_cache_entry (")) return
        reachedInsert.arrive()
        await reachedInsert.opened
      }
    })
    db.artifacts.add(publication.digests[0])
    db.entries.set("key", { body: publication.body, resultJson: publication.resultJson, accessCount: 0 })
    const storage = createStorage(db.sql)

    const first = storage.actionCache.put("key", publication)
    await reachedInsert.arrived
    // A holds the advisory lock but no row lock yet, so the eviction wins.
    expect(await storage.actionCache.delete("key", null)).toBe(true)
    const rival = createStorage(db.sql).actionCache.put("key", otherPublication)
    reachedInsert.release()

    expect(await first).toBe("inserted")
    expect(await rival).toBe("conflict")
    // A described the row it went on to hold, and only A's references exist.
    expect(db.entries.get("key").resultJson).toBe(publication.resultJson)
    expect([...db.references]).toEqual([`key/${publication.digests[0]}`])
  })

  test("holds the classified row against an eviction until it commits", async () => {
    const reachedLock = latch()
    const db = fakePostgres({
      pause: async (event) => {
        if (event.transaction !== "tx-0") return
        if (!event.text.startsWith("SELECT (result_canonical")) return
        reachedLock.arrive()
        await reachedLock.opened
      }
    })
    db.artifacts.add(publication.digests[0])
    db.entries.set("key", { body: publication.body, resultJson: publication.resultJson, accessCount: 0 })
    const storage = createStorage(db.sql)

    const publishing = storage.actionCache.put("key", publication)
    await reachedLock.arrived
    let evicted = null
    const eviction = storage.actionCache.delete("key", null).then((gone) => {
      evicted = gone
    })
    // The eviction is blocked on the row lock the classification took. Draining
    // the microtask queue is what proves it: an unblocked delete would have
    // resolved several turns ago.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect(evicted).toBeNull()

    reachedLock.release()
    expect(await publishing).toBe("identical")
    await eviction
    expect(evicted).toBe(true)
    expect([...db.references]).toEqual([`key/${publication.digests[0]}`])
  })

  test("admits exactly one of two rival publishers and refuses the other", async () => {
    const db = fakePostgres()
    db.artifacts.add(publication.digests[0])
    const storage = createStorage(db.sql)
    const outcomes = await Promise.all([
      storage.actionCache.put("key", publication),
      storage.actionCache.put("key", otherPublication)
    ])

    expect(outcomes.filter((outcome) => outcome === "inserted")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(1)
    expect(db.entries.size).toBe(1)
    // The loser is the one whose result is not stored, and it recorded nothing.
    expect([...db.references]).toEqual([`key/${publication.digests[0]}`])
  })

  test("serializes identical rival publishers on the advisory lock", async () => {
    const db = fakePostgres()
    const storage = createStorage(db.sql)
    const outcomes = await Promise.all([
      storage.actionCache.put("key", publication),
      storage.actionCache.put("key", publication),
      storage.actionCache.put("key", publication)
    ])

    expect(outcomes.filter((outcome) => outcome === "inserted")).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome === "identical")).toHaveLength(2)
    expect(db.entries.get("key").accessCount).toBe(2)
    const advisoryLocks = db.statements.filter((statement) => statement.text.startsWith("SELECT pg_advisory_xact_lock"))
    expect(advisoryLocks).toHaveLength(3)
  })

  test("records nothing at all when the publication fails", async () => {
    const db = fakePostgres({
      pause: (event) => {
        if (event.text.startsWith("WITH present AS")) throw postgresError("40001")
      }
    })
    db.artifacts.add(publication.digests[0])
    const storage = createStorage(db.sql)

    await expect(storage.actionCache.put("key", publication)).rejects.toThrow("violation")
    expect(db.entries.size).toBe(0)
    expect(db.references.size).toBe(0)
    // The advisory lock went with the rollback, so the next publisher proceeds.
    expect(await createStorage(fakePostgres().sql).actionCache.put("key", publication)).toBe("inserted")
  })

  test("only references blobs that exist", async () => {
    const db = fakePostgres()
    const storage = createStorage(db.sql)
    expect(await storage.actionCache.put("key", publication)).toBe("inserted")
    expect(db.references.size).toBe(0)
  })
})

describe("content store", () => {
  test("probes, freshens, and serves blobs", async () => {
    const present = fakeSql([[{ valid: true }]])
    const absent = fakeSql([[]])
    const fetched = fakeSql([[{
      content: new Uint8Array([1, 2, 3]),
      size_bytes: 3,
      valid: true
    }]])
    const store = (fake) => createStorage(fake.sql).contentStore

    expect(await store(present).has("a".repeat(64))).toBe(true)
    expect(await store(absent).has("a".repeat(64))).toBe(false)
    expect(await store(fetched).get("a".repeat(64))).toEqual({ body: new Uint8Array([1, 2, 3]) })
    expect(fetched.calls[0].text).toContain("WHEN access_count < 9223372036854775807")
  })

  test("serves a blob on its length check rather than by re-hashing it", async () => {
    const fetched = fakeSql([[{ content: new Uint8Array([1, 2, 3]), size_bytes: 3, valid: true }]])
    await createStorage(fetched.sql).contentStore.get("a".repeat(64))
    // The address is a CHECK constraint the table enforces on every write, so a
    // download must not spend a SHA-256 over the blob to re-derive it.
    expect(fetched.calls[0].text).not.toContain("sha256")
    expect(fetched.calls[0].text).toContain("octet_length(artifact.content) = artifact.size_bytes AS valid")
  })

  test("reports a missing blob as null", async () => {
    const { sql } = fakeSql([[]])
    expect(await createStorage(sql).contentStore.get("a".repeat(64))).toBeNull()
  })

  test("inserts new bytes and freshens bytes that are already there", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const inserted = fakeSql([[], [{ digest: "a".repeat(64) }]])
    const existing = fakeSql([
      [],
      [],
      [{ same_size: true, stored_size_valid: true, stored_digest_valid: true, same_content: true }],
      []
    ])

    expect(await createStorage(inserted.sql).contentStore.put("a".repeat(64), bytes)).toBe("inserted")
    expect(inserted.calls[2].values).toEqual(["a".repeat(64), bytes, 3])
    expect(await createStorage(existing.sql).contentStore.put("a".repeat(64), bytes)).toBe("present")
    expect(existing.calls[4].text).toContain("UPDATE smithers_build_artifact")
    expect(texts(existing).at(-1)).toBe("COMMIT")
  })

  test("answers a batched probe with the digests that are present", async () => {
    const digests = ["a".repeat(64), "b".repeat(64)]
    const { sql, calls } = fakeSql([[{ digest: digests[1], valid: true }]])
    const present = await createStorage(sql).contentStore.presentDigests(digests)

    expect(present.has(digests[0])).toBe(false)
    expect(present.has(digests[1])).toBe(true)
    expect(parseDigestArray(calls[0].values[0])).toEqual(digests)
  })

  test("repairs a corrupt row from digest-verified bytes under a row lock", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const fake = fakeSql([
      [],
      [],
      [{ same_size: false, stored_size_valid: false, stored_digest_valid: false, same_content: false }],
      [{ digest: "a".repeat(64) }]
    ])
    expect(await createStorage(fake.sql).contentStore.put("a".repeat(64), bytes)).toBe("repaired")
    expect(fake.calls[3].text).toContain("FOR NO KEY UPDATE")
    expect(fake.calls[4].text).toContain("SET content")
    expect(texts(fake).at(-1)).toBe("COMMIT")
  })

  test("treats distinct valid bytes under one address as a collision", async () => {
    const fake = fakeSql([
      [],
      [],
      [{ same_size: true, stored_size_valid: true, stored_digest_valid: true, same_content: false }]
    ])
    await expect(
      createStorage(fake.sql).contentStore.put("a".repeat(64), new Uint8Array([1]))
    ).rejects.toThrow("collision")
    expect(texts(fake).at(-1)).toBe("ROLLBACK")
  })

  test("retries a row released before classification and then stops", async () => {
    const fake = fakeSql([[], [], [], [], [], [], []])
    await expect(
      createStorage(fake.sql).contentStore.put("a".repeat(64), new Uint8Array([1]))
    ).rejects.toThrow("repeated release")
    expect(texts(fake).filter((text) => text.startsWith("INSERT INTO smithers_build_artifact"))).toHaveLength(3)
    expect(texts(fake).at(-1)).toBe("ROLLBACK")
  })

  test("fails reads and probes when a stored row violates its address", async () => {
    const corruptHas = fakeSql([[{ valid: false }]])
    // Two independent failures, so neither masks the other: the row the
    // database judged invalid, and a row whose bytes disagree with the length
    // it reported on the wire.
    const corruptGet = fakeSql([[{
      content: new Uint8Array([1, 2, 3]),
      size_bytes: 3,
      valid: false
    }]])
    const shortGet = fakeSql([[{
      content: new Uint8Array([1]),
      size_bytes: 2,
      valid: true
    }]])
    const corruptBatch = fakeSql([[{ digest: "a".repeat(64), valid: false }]])
    await expect(createStorage(corruptHas.sql).contentStore.has("a".repeat(64))).rejects.toThrow("integrity")
    await expect(createStorage(corruptGet.sql).contentStore.get("a".repeat(64))).rejects.toThrow("integrity")
    await expect(createStorage(shortGet.sql).contentStore.get("a".repeat(64))).rejects.toThrow("integrity")
    await expect(
      createStorage(corruptBatch.sql).contentStore.presentDigests(["a".repeat(64)])
    ).rejects.toThrow("integrity")
  })
})

describe("schema health", () => {
  test("accepts only the schema version this binary understands", async () => {
    const current = fakeSql([[{ schema_version: 1 }]])
    const old = fakeSql([[{ schema_version: 0 }]])
    const missing = fakeSql([[]])
    expect(await createStorage(current.sql).health()).toBe(true)
    await expect(createStorage(old.sql).health()).rejects.toThrow("schema version")
    await expect(createStorage(missing.sql).health()).rejects.toThrow("schema version")
  })
})

describe("SQL cancellation", () => {
  test("cancels every single-statement route and waits for SQL to settle", async () => {
    const routes = [
      (storage, signal) => storage.actionCache.get("key", signal),
      (storage, signal) => storage.actionCache.delete("key", null, signal),
      (storage, signal) => storage.contentStore.get("digest", signal),
      (storage, signal) => storage.contentStore.has("digest", signal),
      (storage, signal) => storage.contentStore.presentDigests(["digest"], signal),
      (storage, signal) => storage.health(signal)
    ]
    for (const route of routes) {
      let finish
      let cancelled = 0
      const query = new Promise((_resolve, reject) => {
        finish = reject
      })
      query.cancel = () => {
        cancelled += 1
      }
      const controller = new globalThis.AbortController()
      const work = route(createStorage(() => query), controller.signal)
      let settled = false
      const checked = work.catch(() => {
        settled = true
      })
      controller.abort()
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
      expect(cancelled).toBe(1)
      expect(settled).toBe(false)
      finish(new Error("SQL cancelled"))
      await checked
      expect(settled).toBe(true)
    }
  })

  test("cancels publication and drains rollback without starting another statement", async () => {
    for (
      const publish of [
        (storage, signal) => storage.actionCache.put("key", publication, signal),
        (storage, signal) => storage.contentStore.put("digest", new Uint8Array([1]), signal)
      ]
    ) {
      const controller = new globalThis.AbortController()
      let statements = 0
      let cancelled = 0
      let finishQuery
      let finishRollback
      const query = new Promise((_resolve, reject) => {
        finishQuery = reject
      })
      query.cancel = () => {
        cancelled += 1
        finishQuery(new Error("cancelled"))
      }
      const rollback = new Promise((resolve) => {
        finishRollback = resolve
      })
      const sql = () => {
        statements += 1
        return query
      }
      sql.begin = async (run) => {
        try {
          return await run(sql)
        } catch (cause) {
          await rollback
          throw cause
        }
      }
      let settled = false
      const work = publish(createStorage(sql), controller.signal)
      const checked = work.catch(() => {
        settled = true
      })
      controller.abort()
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve()
      expect(cancelled).toBe(1)
      expect(statements).toBe(1)
      expect(settled).toBe(false)
      finishRollback()
      await checked
      expect(settled).toBe(true)
    }
  })

  test("does not start SQL for an already aborted request", async () => {
    const controller = new globalThis.AbortController()
    controller.abort()
    let calls = 0
    const storage = createStorage(() => {
      calls += 1
      return Promise.resolve([])
    })
    await expect(storage.actionCache.get("key", controller.signal)).rejects.toThrow()
    expect(calls).toBe(0)
  })
})
