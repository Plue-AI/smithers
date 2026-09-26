import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const busy = new SqlError.SqlError({
  reason: SqlError.classifySqliteError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))
})

describe("DurableWriter.afterCommit", () => {
  it.effect("rejects another database's commit owner", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const sql = yield* SqlClient.SqlClient
      const other = yield* Layer.build(Layer.fresh(TestDatabase.layer))
      const otherWriter = Context.get(other, DurableWriter.DurableWriter)
      const otherSql = Context.get(other, SqlClient.SqlClient)
      const published: Array<string> = []
      yield* writer.write(Effect.gen(function*() {
        yield* otherWriter.write(Effect.gen(function*() {
          expect(
            yield* DurableWriter.afterCommit(
              Effect.sync(() => {
                published.push("wrong owner")
              }),
              sql
            )
          ).toBe(false)
          expect(
            yield* DurableWriter.afterCommit(
              Effect.sync(() => {
                published.push("inner")
              }),
              otherSql
            )
          ).toBe(true)
        }))
        expect(published).toEqual(["inner"])
        expect(
          yield* DurableWriter.afterCommit(
            Effect.sync(() => {
              published.push("outer")
            }),
            sql
          )
        ).toBe(true)
      }))
      expect(published).toEqual(["inner", "outer"])
    }).pipe(Effect.scoped, Effect.provide(TestDatabase.layer)))

  it.effect("publishes nested updates in order, only after the outer commit", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const sql = yield* SqlClient.SqlClient
      const published: Array<number> = []
      const publish = (n: number) =>
        DurableWriter.afterCommit(Effect.sync(() => {
          published.push(n)
        }))
      yield* sql`CREATE TABLE commits (value INTEGER)`
      const value = yield* writer.write(Effect.gen(function*() {
        yield* sql`INSERT INTO commits VALUES (1)`
        expect(yield* publish(1)).toBe(true)
        yield* writer.write(publish(2))
        expect(yield* publish(3)).toBe(true)
        expect(published).toEqual([])
        return "committed"
      }))
      expect(value).toBe("committed")
      expect(published).toEqual([1, 2, 3])
      expect(yield* sql`SELECT * FROM commits`).toHaveLength(1)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("discards a caught savepoint rollback but preserves its parent's updates", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const published: Array<string> = []
      const publish = (s: string) =>
        DurableWriter.afterCommit(Effect.sync(() => {
          published.push(s)
        }))
      yield* writer.write(Effect.gen(function*() {
        yield* publish("before")
        const failed = yield* writer.write(Effect.gen(function*() {
          yield* publish("rolled back")
          yield* writer.write(publish("rolled back grandchild"))
          return yield* Effect.fail("reject")
        })).pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        yield* writer.write(publish("successful sibling"))
        yield* publish("after")
      }))
      expect(published).toEqual(["before", "successful sibling", "after"])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("discards all successful savepoints when their parent rolls back", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      let published = 0
      yield* writer.write(Effect.gen(function*() {
        yield* writer.write(DurableWriter.afterCommit(Effect.sync(() => {
          published++
        })))
        return yield* Effect.fail("outer rollback")
      })).pipe(Effect.exit)
      expect(published).toBe(0)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("does not publish outside an owned transaction or inside raw savepoints", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const sql = yield* SqlClient.SqlClient
      let published = 0
      const publish = DurableWriter.afterCommit(Effect.sync(() => {
        published++
      }))
      expect(yield* publish).toBe(false)
      expect(yield* sql.withTransaction(publish)).toBe(false)
      expect(yield* sql.withTransaction(writer.write(publish))).toBe(false)
      yield* writer.write(Effect.gen(function*() {
        expect(yield* sql.withTransaction(publish)).toBe(false)
        expect(yield* sql.withTransaction(writer.write(publish))).toBe(false)
        expect(yield* publish).toBe(true)
      }))
      expect(published).toBe(1)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("discards retry attempts and publishes the committed attempt exactly once", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql, { baseDelayMs: 1, maxDelayMs: 1 })
      const published: Array<number> = []
      let attempts = 0
      yield* sql`CREATE TABLE retries (value INTEGER)`
      const fiber = yield* writer.write(Effect.gen(function*() {
        const attempt = ++attempts
        yield* sql`INSERT INTO retries VALUES (${attempt})`
        yield* DurableWriter.afterCommit(Effect.sync(() => {
          published.push(attempt)
        }))
        if (attempt < 3) return yield* Effect.fail(busy)
      })).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestDatabase.until(TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined)))
      yield* Fiber.join(fiber)
      expect(attempts).toBe(3)
      expect(published).toEqual([3])
      expect(yield* sql`SELECT value FROM retries`).toEqual([{ value: 3 }])
    }).pipe(Effect.provide(TestDatabase.layer), Effect.provide(TestClock.layer())))

  it.effect("does not retry SQL when post-commit publication defects", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      let attempts = 0
      let published = false
      yield* sql`CREATE TABLE once_only (value INTEGER)`
      const exit = yield* writer.write(Effect.gen(function*() {
        attempts++
        yield* sql`INSERT INTO once_only VALUES (1)`
        yield* DurableWriter.afterCommit(Effect.die(busy))
        yield* DurableWriter.afterCommit(Effect.sync(() => {
          published = true
        }))
      })).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(attempts).toBe(1)
      expect(published).toBe(true)
      expect(yield* sql`SELECT * FROM once_only`).toHaveLength(1)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("discards publication when a transaction is interrupted", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const ready = yield* Deferred.make<void>()
      let published = false
      const fiber = yield* writer.write(Effect.gen(function*() {
        yield* DurableWriter.afterCommit(Effect.sync(() => {
          published = true
        }))
        yield* Deferred.succeed(ready, undefined)
        yield* Effect.never
      })).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      expect(published).toBe(false)
    }).pipe(Effect.provide(TestDatabase.layer)))
})
