import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, expectTypeOf, it } from "vitest"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import type * as Namespace from "../src/Namespace.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import { causeMessages, namespace, run, runWithDatabase } from "./fixtures/MemoryStoreHarness.ts"

describe("MemoryStore", () => {
  it("exposes only the plural tag-group input", () => {
    expectTypeOf<MemoryStore.ListNotesInput>().not.toHaveProperty("tagGroup")
  })

  it("applies the authoritative and projection schemas idempotently", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        yield* MemoryStore.MemoryStore
        yield* MemoryStore.make
        yield* MemoryStore.make
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${TestDatabase.catalog(sql)}
          WHERE type = 'table' AND name LIKE 'memory_%'
          ORDER BY name
        `
        return rows.map((row) => row.name)
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(tables).toEqual([
      "memory_facts",
      "memory_fts_kinds",
      "memory_messages",
      "memory_note_supersedes",
      "memory_notes",
      "memory_threads",
      "memory_vectors"
    ])
  })

  it("accepts validated bank strings uniformly across namespace-bearing operations", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace: "agent-team", key: "fact", value: "value", provenance: {} })
      const fact = yield* store.getFact({ namespace: "agent-team", key: "fact" })
      const facts = yield* store.listFacts({ namespace: "agent-team" })
      const thread = yield* store.createThread({ id: "thread-bank", namespace: "agent-team" })
      const threads = yield* store.listThreads({ namespace: "agent-team" })
      const note = yield* store.putNote({
        namespace: "agent-team",
        id: "note-bank",
        text: "note",
        tags: [],
        provenance: {}
      })
      const deleted = yield* store.deleteFact({ namespace: "agent-team", key: "fact" })
      return { fact, facts, thread, threads, note, deleted }
    }))

    expect(result.fact?.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.facts).toHaveLength(1)
    expect(result.thread.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-bank"])
    expect(result.note.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.deleted).toBe(true)
  })

  it("supports the complete fact, thread, note, and message contract", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "delete-me", value: "value", provenance: {} })
      const allFacts = yield* store.listAllFacts
      const deletedFact = yield* store.deleteFact({ namespace, key: "delete-me" })
      const thread = yield* store.createThread({
        id: "thread-crud",
        namespace,
        title: "Review",
        metadata: { branch: "main" }
      })
      yield* store.appendMessage({
        threadId: thread.id,
        id: "message-1",
        role: "user",
        text: "hello",
        at: 1
      })
      const count = yield* store.countMessages({ threadId: thread.id })
      const fetched = yield* store.getThread({ threadId: thread.id })
      const threads = yield* store.listThreads({ namespace })
      yield* store.putNote({
        namespace,
        id: "get-note",
        text: "note",
        tags: [],
        provenance: {}
      })
      const note = yield* store.getNote({ id: "get-note" })
      const deletedThread = yield* store.deleteThread({ threadId: thread.id })
      const missing = yield* store.getThread({ threadId: thread.id })
      return {
        allFacts,
        deletedFact,
        count,
        fetched,
        threads,
        note,
        deletedThread,
        missing
      }
    }))

    expect(result.allFacts.map((fact) => fact.key)).toEqual(["delete-me"])
    expect(result.deletedFact).toBe(true)
    expect(result.count).toBe(1)
    expect(result.fetched).toMatchObject({ title: "Review", metadata: { branch: "main" } })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-crud"])
    expect(result.note).toMatchObject({ id: "get-note", text: "note" })
    expect(result.deletedThread).toBe(true)
    expect(result.missing).toBeUndefined()
  })

  it("keeps equal record ids authoritative across namespaces without implicit vectors", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.putFact({
          namespace: { kind: "flow", id: "one" },
          key: "shared",
          value: "first",
          provenance: {}
        })
        yield* store.putFact({
          namespace: { kind: "flow", id: "two" },
          key: "shared",
          value: "second",
          provenance: {}
        })
        const rows = yield* sql<{ readonly namespace_id: string }>`
          SELECT namespace_id FROM memory_vectors
          WHERE record_kind = 'fact' AND record_id = 'shared'
          ORDER BY namespace_id
        `
        const facts = yield* Effect.all([
          store.getFact({ namespace: { kind: "flow", id: "one" }, key: "shared" }),
          store.getFact({ namespace: { kind: "flow", id: "two" }, key: "shared" })
        ])
        return { rows, facts }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.rows).toEqual([])
    expect(result.facts.map((fact) => fact?.value)).toEqual(["first", "second"])
  })

  it("validates namespaces, identifiers, tags, and times before touching the database", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const overCap = Array.from({ length: 17 }, (_, index) => `scope:${index}`) as unknown as Namespace.Tags
      return [
        yield* Effect.flip(
          store.putFact({ namespace: { kind: "flow", id: "" }, key: "k", value: 1, provenance: {} })
        ),
        yield* Effect.flip(store.putFact({ namespace, key: "", value: 1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: -1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: 1.5, provenance: {} })),
        yield* Effect.flip(
          store.putNote({
            namespace,
            id: "n",
            text: "t",
            tags: ["vendor:x"] as unknown as Namespace.Tags,
            provenance: {}
          })
        ),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: overCap, provenance: {} })),
        yield* Effect.flip(store.putNote({ namespace, id: "", text: "t", tags: [], provenance: {} })),
        yield* Effect.flip(store.createThread({ namespace, id: "" })),
        yield* Effect.flip(store.appendMessage({ threadId: "", id: "m", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: -1 })),
        yield* Effect.flip(store.getFact({ namespace, key: "" })),
        yield* Effect.flip(store.deleteFact({ namespace, key: "" })),
        yield* Effect.flip(store.getThread({ threadId: "" })),
        yield* Effect.flip(store.deleteThread({ threadId: "" })),
        yield* Effect.flip(store.listMessages({ threadId: "" })),
        yield* Effect.flip(store.countMessages({ threadId: "" })),
        yield* Effect.flip(store.deleteMessages({ threadId: "", ids: ["a"] })),
        yield* Effect.flip(store.getNote({ id: "" })),
        yield* Effect.flip(store.setNoteStatus({ id: "", status: "accepted" })),
        yield* Effect.flip(store.supersede({ supersederId: "", targetId: "t" })),
        yield* Effect.flip(store.supersede({ supersederId: "s", targetId: "" }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_namespace", undefined],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["ttlMs"]],
      ["invalid_argument", ["ttlMs"]],
      ["invalid_tag", undefined],
      ["invalid_tag", undefined],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["role"]],
      ["invalid_argument", ["at"]],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["supersederId"]],
      ["invalid_argument", ["targetId"]]
    ])
    expect(failures.every((error) => error.cause === undefined)).toBe(true)
  })

  it("refuses a value, provenance, or metadata JSON cannot represent", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const unserializable = { runId: 1n as unknown as string }
      return [
        yield* Effect.flip(store.putFact({ namespace, key: "absent", value: undefined, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "big", value: 1n, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, provenance: unserializable })),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: [], provenance: unserializable })),
        yield* Effect.flip(store.createThread({ namespace, metadata: 1n }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path, error.cause])).toEqual([
      ["invalid_argument", ["value"], undefined],
      ["invalid_argument", ["value"], undefined],
      ["invalid_argument", ["provenance"], undefined],
      ["invalid_argument", ["provenance"], undefined],
      ["invalid_argument", ["metadata"], undefined]
    ])
  })

  // A driver that reports neither `changes` nor `rowsAffected` reads as "no row
  // written", which sends createThread down its read-back branch with nothing
  // to read. It must fail typed rather than return a half-built thread.
  it("fails typed when the driver reports no write and the row is absent", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // Neither a scalar nor an object without a row count tells the store a
        // row landed; both must take the read-back branch.
        const answers = [Effect.succeed("opaque driver answer"), Effect.succeed({ ok: true })]
        const opaqueSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("INSERT INTO memory_threads")
              ? { raw: answers.shift() ?? Effect.succeed({}) }
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, opaqueSql))
        return [
          yield* Effect.flip(store.createThread({ id: "opaque-scalar", namespace })),
          yield* Effect.flip(store.createThread({ id: "opaque-object", namespace }))
        ]
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failures.map((failure) => [failure.code, failure.message])).toEqual([
      ["store", "created memory thread could not be read back"],
      ["store", "created memory thread could not be read back"]
    ])
  })

  it("summarizes a non-Error failure cause without leaking an unbounded value", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("FROM memory_notes")
              ? Effect.fail("x".repeat(2_000))
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, failingSql))
        return yield* Effect.flip(store.listNotes({ namespace }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure.code).toBe("store")
    expect(failure.cause).toBe("x".repeat(1_024))
  })

  it("keeps an Error cause whole so its SQL code survives", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const driverError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("FROM memory_notes")
              ? Effect.fail(driverError)
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, failingSql))
        return { driverError, failure: yield* Effect.flip(store.listNotes({ namespace })) }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure.failure.code).toBe("store")
    expect(failure.failure.cause).toBe(failure.driverError)
  })

  // DurableWriter's contract: the outermost write classifies retry by walking
  // the cause chain, even after a nested store wrapped the failure in a domain
  // error. A memory write nested in a host transaction must replay on a
  // transient busy failure exactly like a plain nested write does.
  it("replays a host write that nests a memory write over one transient busy failure", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const real = yield* DurableWriter.DurableWriter
        let attempts = 0
        const busy = () =>
          new SqlError.SqlError({
            reason: new SqlError.LockTimeoutError({
              cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
            })
          })
        const injected = DurableWriter.DurableWriter.of({
          write: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            real.write(Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? (Effect.fail(busy()) as unknown as Effect.Effect<A, E, R>) : effect
            }))
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(DurableWriter.DurableWriter, injected))

        attempts = 0
        const control = yield* Effect.exit(real.write(injected.write(sql`SELECT 1`)))
        const controlAttempts = attempts

        attempts = 0
        const nested = yield* Effect.exit(
          real.write(store.putFact({ namespace, key: "nested", value: "v", provenance: {} }))
        )
        const stored = yield* store.getFact({ namespace, key: "nested" })
        return {
          control: [control._tag, controlAttempts],
          nested: [nested._tag, attempts],
          stored: stored?.value
        }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.control).toEqual(["Success", 2])
    expect(result.nested).toEqual(["Success", 2])
    expect(result.stored).toBe("v")
  })

  it.each(["role", "text", "at", "missing"] as const)(
    "rejects changed source %s without touching history",
    async (field) => {
      const result = await run(Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
        yield* store.appendMessage(source)
        yield* store.deleteMessages({ threadId: "thread", ids: [source.id] })
        if (field !== "missing") {
          yield* store.appendMessage({ ...source, [field]: field === "at" ? 2 : "changed" })
        }
        const before = yield* store.listMessages({ threadId: "thread" })
        const failure = yield* Effect.flip(store.compactMessages({
          threadId: "thread",
          summary: { threadId: "thread", id: "summary", role: "system", text: "stale", at: 0 },
          sourceMessages: [source]
        }))
        return { before, failure, after: yield* store.listMessages({ threadId: "thread" }) }
      }))

      expect(result.failure).toMatchObject({ code: "compaction_conflict", path: ["sourceMessages"] })
      expect(result.after).toEqual(result.before)
    }
  )

  it("resolves a bank name to a namespace and rejects an empty bank", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace: { kind: "agent", id: "fleet" },
        id: "agent-note",
        text: "a",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({ namespace: { kind: "flow", id: "flow-" }, id: "odd", text: "o", tags: [], provenance: {} })
      yield* store.putNote({
        namespace: { kind: "flow", id: "plain" },
        id: "plain-note",
        text: "p",
        tags: [],
        provenance: {}
      })
      const prefixed = yield* store.searchRows({ namespace: "agent-fleet" })
      const boundary = yield* store.searchRows({ namespace: "flow-" })
      const unprefixed = yield* store.searchRows({ namespace: "plain" })
      const structured = yield* store.searchRows({ namespace: { kind: "agent", id: "fleet" } })
      const empty = yield* Effect.flip(store.searchRows({ namespace: "" }))
      return { prefixed, boundary, unprefixed, structured, empty }
    }))

    expect(result.prefixed.map((row) => [row.bank, row.key])).toEqual([["agent-fleet", "agent-note"]])
    expect(result.boundary.map((row) => [row.bank, row.key])).toEqual([["flow-", "odd"]])
    expect(result.unprefixed.map((row) => [row.bank, row.key])).toEqual([["plain", "plain-note"]])
    expect(result.structured.map((row) => row.bank)).toEqual(["agent-fleet"])
    expect([result.empty.code, result.empty.message]).toEqual(["invalid_namespace", "memory bank must not be empty"])
  })

  it("fails every operation on the unavailable store and honours overrides", async () => {
    const noop = MemoryStore.makeNoop()
    const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, MemoryError>]> = [
      ["putFact", noop.putFact({ namespace, key: "k", value: 1, provenance: {} })],
      ["getFact", noop.getFact({ namespace, key: "k" })],
      ["deleteFact", noop.deleteFact({ namespace, key: "k" })],
      ["listFacts", noop.listFacts({ namespace })],
      ["listAllFacts", noop.listAllFacts],
      ["createThread", noop.createThread({ namespace })],
      ["getThread", noop.getThread({ threadId: "t" })],
      ["listThreads", noop.listThreads()],
      ["deleteThread", noop.deleteThread({ threadId: "t" })],
      ["appendMessage", noop.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: 0 })],
      ["listMessages", noop.listMessages({ threadId: "t" })],
      ["countMessages", noop.countMessages({ threadId: "t" })],
      ["messageStats", noop.messageStats({ threadId: "t" })],
      ["putNote", noop.putNote({ namespace, id: "n", text: "t", tags: [], provenance: {} })],
      ["getNote", noop.getNote({ id: "n" })],
      ["setNoteStatus", noop.setNoteStatus({ id: "n", status: "accepted" })],
      ["supersede", noop.supersede({ supersederId: "s", targetId: "t" })],
      ["listNotes", noop.listNotes({ namespace })],
      ["enableFts", noop.enableFts("flow")],
      ["searchFts", noop.searchFts({ namespace, query: "q" })],
      ["searchRows", noop.searchRows({ namespace })],
      ["deleteExpiredFacts", noop.deleteExpiredFacts],
      ["listThreadIds", noop.listThreadIds],
      ["deleteMessages", noop.deleteMessages({ threadId: "t", ids: ["m"] })],
      [
        "compactMessages",
        noop.compactMessages({
          threadId: "t",
          summary: { threadId: "t", id: "s", role: "system", text: "x", at: 0 },
          sourceMessages: [{ threadId: "thread", id: "m", role: "user", text: "a", at: 0 }]
        })
      ]
    ]
    const overridden = MemoryStore.makeNoop({
      getFact: () => Effect.succeed(undefined),
      listThreadIds: Effect.succeed(["kept"])
    })

    const messages = await Effect.runPromise(
      Effect.forEach(calls, ([name, effect]) => Effect.map(Effect.flip(effect), (error) => `${name}: ${error.message}`))
    )
    const kept = await Effect.runPromise(
      Effect.all([overridden.getFact({ namespace, key: "k" }), overridden.listThreadIds])
    )
    const stillUnavailable = await Effect.runPromise(
      Effect.flip(overridden.putFact({ namespace, key: "k", value: 1, provenance: {} }))
    )
    const layered = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => Effect.flip(store.listAllFacts)),
        Effect.provide(MemoryStore.layerNoop())
      )
    )
    const layeredOverride = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => store.listAllFacts),
        Effect.provide(MemoryStore.layerNoop({ listAllFacts: Effect.succeed([]) }))
      )
    )

    expect(messages).toEqual(calls.map(([name]) => `${name}: ${name} is unavailable`))
    expect(kept).toEqual([undefined, ["kept"]])
    expect(stillUnavailable.message).toBe("putFact is unavailable")
    expect(layered.message).toBe("listAllFacts is unavailable")
    expect(layeredOverride).toEqual([])
  })

  it("surfaces a typed store error when an authoritative table is gone", async () => {
    const failure = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_facts ${sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))}`
      return yield* Effect.flip(store.listFacts({ namespace }))
    }))

    expect([failure.code, failure.message]).toEqual(["store", "could not list memory facts"])
    expect(
      causeMessages(failure.cause).some((message) =>
        /no such table: memory_facts|relation "memory_facts" does not exist/.test(message)
      )
    ).toBe(
      true
    )
  })

  it("does not project vectors from authoritative writes by default", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "durable", value: "written", provenance: {} })
      yield* store.putNote({ namespace, id: "note", text: "written", tags: [], provenance: {} })
      const stored = yield* store.getFact({ namespace, key: "durable" })
      const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_vectors`
      return { stored, count: Number(rows[0]?.count ?? -1) }
    }))

    expect(result.stored?.value).toBe("written")
    expect(result.count).toBe(0)
  })

  it("wraps a forged memory error tag as a genuine store failure", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const forged = { _tag: "flows/memory/MemoryError" }
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const strings = argumentsList[0]
            if (Array.isArray(strings) && strings.join(" ").includes("FROM memory_facts")) {
              return Effect.fail(forged)
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql)
        )
        return yield* Effect.flip(store.listFacts({ namespace }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure).toBeInstanceOf(MemoryError)
    expect(failure).toMatchObject({ code: "store", message: "could not list memory facts" })
  })

  it("reports a stored row it cannot decode as a typed memory error", async () => {
    const failures = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'scalar', 'k', '1', NULL, '5', 0, 0)`
      const scalarProvenance = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "scalar" } }))
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'null-provenance', 'k', '1', NULL, 'null', 0, 0)`
      const nullProvenance = yield* Effect.flip(
        store.listFacts({ namespace: { kind: "flow", id: "null-provenance" } })
      )
      yield* sql`INSERT INTO memory_notes (
        id, namespace_kind, namespace_id, text, tags_json, provenance_json, status, created_at_ms
      ) VALUES ('bad-tags', 'flow', 'notes', 'text', '["vendor:x"]', '{}', 'accepted', 0)`
      const storedTags = yield* Effect.flip(store.getNote({ id: "bad-tags" }))
      yield* TestDatabase.checks(sql, false)
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'invalid-json', 'k', '{oops', NULL, '{}', 0, 0)`
      const invalidJson = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "invalid-json" } }))
      yield* sql`INSERT INTO memory_threads (
        thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms
      ) VALUES ('bad-thread', 'flow', 'threads', NULL, '{oops', 0, 0)`
      const invalidMetadata = yield* Effect.flip(store.getThread({ threadId: "bad-thread" }))
      return [scalarProvenance, nullProvenance, storedTags, invalidJson, invalidMetadata]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "stored provenance is not an object"],
      ["store", "stored provenance is not an object"],
      ["invalid_tag", "stored tags violate the memory vocabulary"],
      ["store", "could not decode fact value"],
      ["store", "could not decode thread metadata"]
    ])
  })
})
