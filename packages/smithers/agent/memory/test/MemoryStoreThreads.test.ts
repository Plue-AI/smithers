import { Crypto, Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import { namespace, other, run } from "./fixtures/MemoryStoreHarness.ts"

describe("MemoryStore threads and messages", () => {
  it("reports generated thread id failure without writing a thread", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const crypto = yield* Crypto.Crypto
        const unavailable = new Error("random source unavailable")
        const failingCrypto = Object.assign(Object.create(crypto) as Crypto.Crypto, {
          randomUUIDv4: Effect.fail(unavailable)
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(Crypto.Crypto, failingCrypto))
        const failure = yield* Effect.flip(store.createThread({ namespace }))
        const threads = yield* store.listThreads({ namespace })
        return { failure, threads }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result.failure).toMatchObject({
      code: "store",
      message: "could not generate memory thread id",
      cause: expect.any(Error)
    })
    expect(result.threads).toEqual([])
  })

  it("rolls back an append when an unconfirmed duplicate cannot be read back", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const inconsistentSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            if (statement.includes("INSERT INTO memory_messages")) {
              const query = Reflect.apply(target, thisArg, argumentsList)
              return new Proxy(query, {
                get(queryTarget, property, receiver) {
                  return property === "raw"
                    ? Effect.succeed({ changes: 0 })
                    : Reflect.get(queryTarget, property, receiver)
                }
              })
            }
            if (statement.includes("FROM memory_messages") && statement.includes("WHERE thread_id")) {
              return Effect.succeed([])
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, inconsistentSql))
        const failure = yield* Effect.flip(store.appendMessage({
          threadId: "unconfirmed",
          id: "message",
          role: "user",
          text: "cannot confirm",
          at: 1
        }))
        const authoritative = yield* MemoryStore.MemoryStore
        return {
          failure,
          thread: yield* authoritative.getThread({ threadId: "unconfirmed" }),
          messages: yield* authoritative.listMessages({ threadId: "unconfirmed" })
        }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result.failure).toMatchObject({ code: "store", message: "existing memory message could not be read back" })
    expect(result.thread).toBeUndefined()
    expect(result.messages).toEqual([])
  })

  it("paginates messages by the stable at-and-id cursor", async () => {
    const pages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (
        const message of [
          { threadId: "paged", id: "a", role: "user", text: "a", at: 1 },
          { threadId: "paged", id: "b", role: "user", text: "b", at: 2 },
          { threadId: "paged", id: "c", role: "user", text: "c", at: 2 }
        ]
      ) yield* store.appendMessage(message)
      const first = yield* store.listMessages({ threadId: "paged", limit: 2 })
      const last = first.at(-1)!
      const second = yield* store.listMessages({
        threadId: "paged",
        limit: 2,
        cursor: { at: last.at, id: last.id }
      })
      return { first, second }
    }))

    expect(pages.first.map((message) => message.id)).toEqual(["a", "b"])
    expect(pages.second.map((message) => message.id)).toEqual(["c"])
  })

  it("appends ordered history and accepts an exact same-payload retry", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      return yield* store.listMessages({ threadId: "thread-1" })
    }))

    expect(messages).toEqual([
      { threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 },
      { threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 }
    ])
  })

  it("scopes message ids to their thread", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const first = { threadId: "thread-1", id: "shared", role: "user", text: "first", at: 1 } as const
      const second = { threadId: "thread-2", id: "shared", role: "assistant", text: "second", at: 2 } as const
      yield* store.appendMessage(first)
      yield* store.appendMessage(second)
      return yield* Effect.all([
        store.listMessages({ threadId: first.threadId }),
        store.listMessages({ threadId: second.threadId })
      ])
    }))

    expect(result).toEqual([
      [{ threadId: "thread-1", id: "shared", role: "user", text: "first", at: 1 }],
      [{ threadId: "thread-2", id: "shared", role: "assistant", text: "second", at: 2 }]
    ])
  })

  it("rejects same-thread message retries whose immutable fields differ", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const original = { threadId: "thread", id: "message", role: "user", text: "original", at: 1 } as const
      yield* store.appendMessage(original)
      return [
        yield* Effect.flip(store.appendMessage({ ...original, role: "assistant" })),
        yield* Effect.flip(store.appendMessage({ ...original, text: "changed" })),
        yield* Effect.flip(store.appendMessage({ ...original, at: 2 }))
      ]
    }))

    expect(failures.map((failure) => [failure.code, failure.path])).toEqual([
      ["idempotency_conflict", ["role"]],
      ["idempotency_conflict", ["text"]],
      ["idempotency_conflict", ["at"]]
    ])
  })

  it("creates a thread with a generated id and omits absent optional columns", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const bare = yield* store.createThread({ namespace })
      const fetched = yield* store.getThread({ threadId: bare.id })
      const duplicate = yield* Effect.flip(store.createThread({ id: bare.id, namespace: other, title: "ignored" }))
      const all = yield* store.listThreads()
      const scoped = yield* store.listThreads({ namespace: other })
      const ids = yield* store.listThreadIds
      const missing = yield* store.deleteThread({ threadId: "absent" })
      return { bare, fetched, duplicate, all, scoped, ids, missing }
    }))

    expect(result.bare.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.bare).not.toHaveProperty("title")
    expect(result.bare).not.toHaveProperty("metadata")
    expect(result.fetched).toEqual(result.bare)
    // A replaying caller must be able to tell "this thread already landed" from
    // "the database is broken", so the conflict carries its own code and path
    // rather than the generic backend failure.
    expect(result.duplicate).toMatchObject({
      code: "idempotency_conflict",
      path: ["threadId"],
      message: expect.stringContaining("different creation data")
    })
    expect(result.all).toEqual([result.bare])
    expect(result.scoped).toEqual([])
    expect(result.ids).toEqual([result.bare.id])
    expect(result.missing).toBe(false)
  })

  it("rolls back a generated thread when its transactional read back fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        let inserted = false
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            if (statement.includes("INSERT INTO memory_threads")) {
              inserted = true
            } else if (inserted && statement.includes("FROM memory_threads WHERE thread_id")) {
              return Effect.fail(new Error("injected thread read failure"))
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const failingStore = yield* MemoryStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql)
        )
        const failure = yield* Effect.flip(failingStore.createThread({ namespace }))
        const store = yield* MemoryStore.MemoryStore
        const retried = yield* store.createThread({ namespace })
        const threads = yield* store.listThreads({ namespace })
        return { failure, retried, threads }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.failure.code).toBe("store")
    expect(result.threads).toEqual([result.retried])
  })

  it("accepts equivalent thread metadata with a different key order", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const first = yield* store.createThread({
        id: "metadata-retry",
        namespace,
        metadata: { alpha: 1, nested: { left: true, right: false } }
      })
      const retried = yield* store.createThread({
        id: "metadata-retry",
        namespace,
        metadata: { nested: { right: false, left: true }, alpha: 1 }
      })
      return { first, retried, threads: yield* store.listThreads({ namespace }) }
    }))

    expect(result.retried).toEqual(result.first)
    expect(result.threads).toEqual([result.first])
  })

  it("answers a thread's message count and text-size bounds in one read", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const empty = yield* store.messageStats({ threadId: "absent" })
      yield* store.appendMessage({ threadId: "thread", id: "ascii", role: "user", text: "abc", at: 0 })
      const ascii = yield* store.messageStats({ threadId: "thread" })
      yield* store.appendMessage({ threadId: "thread", id: "emoji", role: "user", text: "é😀", at: 1 })
      yield* store.appendMessage({ threadId: "other", id: "other", role: "user", text: "zzzz", at: 0 })
      const mixed = yield* store.messageStats({ threadId: "thread" })
      const invalid = yield* Effect.flip(store.messageStats({ threadId: "" }))
      return { empty, ascii, mixed, invalid }
    }))

    expect(result.empty).toEqual({ messages: 0, codePoints: 0, bytes: 0 })
    expect(result.ascii).toEqual({ messages: 1, codePoints: 3, bytes: 3 })
    // "é😀" is 2 code points, 3 JavaScript code units, and 6 UTF-8 bytes.
    expect(result.mixed).toEqual({ messages: 2, codePoints: 5, bytes: 9 })
    expect([result.invalid.code, result.invalid.path]).toEqual(["invalid_argument", ["threadId"]])
  })

  it("counts, de-duplicates, chunks, and compacts messages at their boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const emptyCount = yield* store.countMessages({ threadId: "absent" })
      const noIds = yield* store.deleteMessages({ threadId: "thread", ids: [] })
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      yield* store.appendMessage({ threadId: "thread", id: "m-899", role: "user", text: "b", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "m-900", role: "user", text: "c", at: 2 })
      const duplicates = yield* store.deleteMessages({ threadId: "thread", ids: ["m-0", "m-0"] })
      const chunked = yield* store.deleteMessages({
        threadId: "thread",
        ids: Array.from({ length: 901 }, (_, index) => `m-${index}`)
      })
      const mismatched = yield* Effect.flip(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "other", id: "summary", role: "system", text: "s", at: 0 },
        sourceMessages: []
      }))
      const summaryOnly = yield* store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 0 },
        sourceMessages: [{ threadId: "thread", id: "summary", role: "system", text: "s", at: 0 }]
      })
      const unknownThread = yield* Effect.flip(store.compactMessages({
        threadId: "ghost",
        summary: { threadId: "ghost", id: "ghost-summary", role: "system", text: "s", at: 0 },
        sourceMessages: [{ threadId: "ghost", id: "ghost-message", role: "user", text: "s", at: 0 }]
      }))
      const remaining = yield* store.countMessages({ threadId: "thread" })
      return { emptyCount, noIds, duplicates, chunked, mismatched, summaryOnly, unknownThread, remaining }
    }))

    expect(result.emptyCount).toBe(0)
    expect(result.noIds).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.chunked).toBe(2)
    expect([result.mismatched.code, result.mismatched.path]).toEqual([
      "invalid_argument",
      ["summary", "threadId"]
    ])
    expect(result.summaryOnly).toBe(0)
    expect([result.unknownThread.code, result.unknownThread.message]).toEqual([
      "compaction_conflict",
      "source message \"ghost-message\" changed or disappeared before compaction"
    ])
    expect(result.remaining).toBe(0)
  })

  it.each([
    ["id", ""],
    ["role", ""],
    ["at", -5],
    ["at", Number.MAX_SAFE_INTEGER + 1],
    ["at", Number.NaN]
  ])("validates compaction summary %s=%s before writing", async (field, value) => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
      yield* store.appendMessage(source)
      const outcome = yield* Effect.result(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 0, [field]: value },
        sourceMessages: [source]
      }))
      return { outcome, source, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.outcome).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_argument", path: ["summary", field] }
    })
    expect(result.messages).toEqual([result.source])
  })

  it("captures compaction input before its Effect runs and de-duplicates sources", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
      yield* store.appendMessage(source)
      const input = {
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: [source, source]
      }
      const compact = store.compactMessages(input)
      input.threadId = "other"
      input.summary.text = "mutated"
      source.text = "mutated"
      input.sourceMessages.length = 0
      const deleted = yield* compact
      return { deleted, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.deleted).toBe(1)
    expect(result.messages).toEqual([{ threadId: "thread", id: "summary", role: "system", text: "s", at: 1 }])
  })

  it("rejects empty thread ids and sources belonging to another thread", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const summary = { threadId: "thread", id: "summary", role: "system", text: "s", at: 0 }
      return [
        yield* Effect.flip(store.compactMessages({ threadId: "", summary, sourceMessages: [] })),
        yield* Effect.flip(store.compactMessages({
          threadId: "thread",
          summary,
          sourceMessages: [{ threadId: "other", id: "source", role: "user", text: "s", at: 0 }]
        }))
      ]
    }))

    expect(failures.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "invalid_argument", path: ["threadId"] },
      { code: "invalid_argument", path: ["sourceMessages"] }
    ])
  })

  it("rejects an identical retry of a committed compaction", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "source", role: "user", text: "original", at: 1 })
      const input = {
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: yield* store.listMessages({ threadId: "thread" })
      }
      const deleted = yield* store.compactMessages(input)
      const failure = yield* Effect.flip(store.compactMessages(input))
      return { deleted, failure, summary: input.summary, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.deleted).toBe(1)
    expect(result.failure).toMatchObject({ code: "idempotency_conflict", path: ["summary", "id"] })
    expect(result.messages).toEqual([result.summary])
  })

  // A durable caller replaying a compaction after a crash has to tell "this
  // summary already exists" from "the database is broken".
  // Both used to answer `code: "store"`.
  it("names an already-written summary as an idempotency conflict", async () => {
    const conflict = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      yield* store.appendMessage({ threadId: "thread", id: "summary", role: "system", text: "s", at: 1 })
      return yield* Effect.flip(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: [{ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 }]
      }))
    }))

    expect([conflict.code, conflict.path]).toEqual(["idempotency_conflict", ["summary", "id"]])
  })
})
