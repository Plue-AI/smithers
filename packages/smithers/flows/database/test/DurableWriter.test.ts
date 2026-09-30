import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Random, Result } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as Dialect from "../src/Dialect.ts"
import type { WriteRetryOptions } from "../src/DurableWriter.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as WriteRetry from "../src/internal/WriteRetry.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const sqliteError = (code: string): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: SqlError.classifySqliteError(Object.assign(new Error(code), { code }))
  })

const unknownSqlError = (cause: unknown): SqlError.SqlError =>
  new SqlError.SqlError({
    reason: new SqlError.UnknownError({ cause })
  })

/**
 * The defect a driver rollback failure actually reaches a caller as.
 *
 * Effect's transaction wrapper runs `Effect.orDie(options.rollback(conn))`
 * (effect/unstable/sql/SqlClient.ts), and `rollback` fails with `SqlError`, so
 * the value on the defect channel is that `SqlError` — never a bare `Error`.
 */
const rollbackDefect = (): SqlError.SqlError => unknownSqlError(new Error("cannot rollback - no transaction is active"))

// Mimics the real client's transaction shape: `withTransaction` provides the
// client's transaction service, which is how `write` detects nesting.
const retryTransaction = SqlClient.TransactionConnection(-1)
const retrySql = {
  transactionService: retryTransaction,
  withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, retryTransaction, [undefined as never, 0])
} as SqlClient.SqlClient

const publicRetryOptions: WriteRetryOptions = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 }

describe("DurableWriter", () => {
  it.effect("commits an uncontended finalizer write after its caller is interrupted", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* sql`CREATE TABLE cleanup_writes (value INTEGER NOT NULL)`
      const started = yield* Deferred.make<void>()
      const caller = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(writer.write(sql`INSERT INTO cleanup_writes VALUES (1)`).pipe(Effect.orDie)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      expect(yield* sql`SELECT value FROM cleanup_writes`).toEqual([{ value: 1 }])
    })).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("commits a contended finalizer write after its caller is interrupted", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* sql`CREATE TABLE contended_cleanup (${Dialect.rowId(sql)} value TEXT NOT NULL)`
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const holder = yield* writer.write(
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(sql`INSERT INTO contended_cleanup (value) VALUES ('holder')`)
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(held)
      // The settlement paths in the engine store write from `onExit` and
      // `ensuring` finalizers precisely so cancellation cannot strand a row.
      // Queueing behind another writer must not turn that write into a
      // dropped one.
      const caller = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(writer.write(sql`INSERT INTO contended_cleanup (value) VALUES ('cleanup')`).pipe(Effect.orDie)),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(started)
      caller.interruptUnsafe()
      yield* TestClock.adjust(0)
      expect(caller.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      const exit = yield* Fiber.await(caller)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* sql`SELECT value FROM contended_cleanup ORDER BY rowid`).toEqual([
        { value: "holder" },
        { value: "cleanup" }
      ])
    })).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("releases the writer before commit publication opens a transaction on another fiber", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* sql`CREATE TABLE published_writes (value INTEGER NOT NULL)`
      yield* writer.write(Effect.gen(function*() {
        yield* sql`INSERT INTO published_writes VALUES (1)`
        expect(
          yield* DurableWriter.afterCommit(
            writer.write(sql`INSERT INTO published_writes SELECT value + 1 FROM published_writes`).pipe(
              Effect.forkChild({ startImmediately: true }),
              Effect.flatMap(Fiber.join),
              Effect.orDie,
              Effect.asVoid
            ),
            sql
          )
        ).toBe(true)
      }))
      expect(yield* sql`SELECT value FROM published_writes ORDER BY value`).toEqual([{ value: 1 }, { value: 2 }])
    })).pipe(Effect.provide(TestDatabase.layer)))

  for (const boundary of ["caller interruption", "deadline"] as const) {
    it.effect(`acquires nothing on queued ${boundary}`, () =>
      Effect.scoped(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        let transactions = 0
        const writer = DurableWriter.make(
          new Proxy(sql, {
            get(target, key, receiver) {
              if (key === "withTransaction") {
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Effect.suspend(() => {
                    transactions++
                    return sql.withTransaction(effect)
                  })
              }
              return Reflect.get(target, key, receiver)
            }
          })
        )
        yield* sql`CREATE TABLE queued_writes (${Dialect.rowId(sql)} value TEXT NOT NULL)`
        const acquired = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* writer.write(Effect.gen(function*() {
          yield* sql`INSERT INTO queued_writes (value) VALUES ('holder')`
          yield* Deferred.succeed(acquired, undefined)
          yield* Deferred.await(release)
          yield* sql`INSERT INTO queued_writes (value) VALUES ('holder committed')`
        })).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(acquired)
        let entered = false
        const write = writer.write(Effect.gen(function*() {
          entered = true
          yield* sql`INSERT INTO queued_writes (value) VALUES ('cancelled')`
        }))
        const caller = yield* (boundary === "deadline" ? write.pipe(Effect.timeoutOption("1 second")) : write)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(0)
        if (boundary === "caller interruption") caller.interruptUnsafe()
        yield* TestClock.adjust("1 second")
        const beforeRelease = caller.pollUnsafe()
        const transactionsBeforeRelease = transactions
        const next = yield* writer.write(sql`INSERT INTO queued_writes (value) VALUES ('next')`).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(0)
        const nextBeforeRelease = next.pollUnsafe()
        // Release even on the broken implementation so the failure can be
        // reported without leaving its masked SQL acquisition hung.
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        const exit = yield* Fiber.await(caller)
        yield* Fiber.join(next)
        expect(beforeRelease).toBeDefined()
        expect(transactionsBeforeRelease).toBe(1)
        expect(nextBeforeRelease).toBeUndefined()
        expect(entered).toBe(false)
        expect(transactions).toBe(2)
        if (boundary === "deadline") {
          expect(exit).toEqual(Exit.succeed(Option.none()))
        } else {
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        expect(yield* sql`SELECT value FROM queued_writes ORDER BY rowid`).toEqual([
          { value: "holder" },
          { value: "holder committed" },
          { value: "next" }
        ])
      })).pipe(Effect.provide(TestDatabase.layer)))
  }

  it.effect("keeps a queued write that masked interruption, and commits it after the holder", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* sql`CREATE TABLE masked_writes (${Dialect.rowId(sql)} value TEXT NOT NULL)`
      const acquired = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const holder = yield* writer.write(
        Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(sql`INSERT INTO masked_writes (value) VALUES ('holder')`)
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(acquired)
      // The permit inherits the caller's interruptibility rather than forcing
      // its own. A caller that masked interruption asked for this write to
      // happen, so queueing must not turn it into a dropped write.
      const caller = yield* writer.write(sql`INSERT INTO masked_writes (value) VALUES ('masked')`).pipe(
        Effect.uninterruptible,
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust(0)
      caller.interruptUnsafe()
      yield* TestClock.adjust("1 second")
      expect(caller.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      const exit = yield* Fiber.await(caller)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* sql`SELECT value FROM masked_writes ORDER BY rowid`).toEqual([
        { value: "holder" },
        { value: "masked" }
      ])
    })).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("opens, queries, and commits a transaction through TestDatabase", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const writer = yield* DurableWriter.DurableWriter
          yield* sql`CREATE TABLE values_table (value INTEGER NOT NULL)`
          yield* writer.write(sql`INSERT INTO values_table (value) VALUES (${42})`)
          const rows = yield* sql<{ readonly value: number }>`SELECT value FROM values_table`
          return rows[0]?.value
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result).toBe(42)
    }))

  it.effect("reads the affected-row count from either dialect's raw result", () =>
    Effect.gen(function*() {
      const counts = yield* (
        Effect.all([
          DurableWriter.affectedRows({ changes: 3 }),
          DurableWriter.affectedRows({ rowCount: 0 }),
          DurableWriter.affectedRows({ changes: 3n }),
          DurableWriter.affectedRows({ rowCount: 0n }),
          // A driver that reports both wins on the SQLite field it already used.
          DurableWriter.affectedRows({ changes: 2, rowCount: 5 })
        ])
      )

      expect(counts).toEqual([3, 0, 3, 0, 2])
    }))

  it.effect("fails with unsupported rather than guessing when no affected-row count is readable", () =>
    Effect.gen(function*() {
      const shapes: ReadonlyArray<unknown> = [
        undefined,
        null,
        "1 row",
        {},
        { changes: "3" },
        { changes: -1 },
        { rowCount: 1.5 },
        { changes: -1n },
        { changes: BigInt(Number.MAX_SAFE_INTEGER) + 1n }
      ]
      const failures = yield* (
        Effect.forEach(shapes, (shape) => Effect.flip(DurableWriter.affectedRows(shape)))
      )

      expect(failures.map((failure) => failure.code)).toEqual(shapes.map(() => "unsupported"))
    }))

  it.effect("redacts an unsupported raw result to shape metadata", () =>
    Effect.gen(function*() {
      const raw = [{ secret: "journal-secret" }]
      const failure = yield* Effect.flip(DurableWriter.affectedRows(raw))

      expect(failure.cause).toEqual({ type: "array", keys: ["0"], length: 1 })
      expect(JSON.stringify(failure)).not.toContain("journal-secret")
    }))

  // A driver that returns a wide row object instead of a count would otherwise
  // put every column name it carries into the error, and a column name is user
  // data as much as a value is. The shape stops at eight keys and never reaches
  // a value, whatever the object's width.
  it.effect("truncates a wide raw result's key list and still carries no values", () =>
    Effect.gen(function*() {
      const raw = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`column_${index}`, `journal-secret-${index}`])
      )
      const failure = yield* Effect.flip(DurableWriter.affectedRows(raw))

      expect(failure.code).toBe("unsupported")
      expect(failure.cause).toEqual({
        type: "object",
        keys: Array.from({ length: 8 }, (_, index) => `column_${index}`),
        length: undefined
      })
      expect(JSON.stringify(failure)).not.toContain("journal-secret")
    }))

  it.effect("does not execute an accessor-backed affected-row field", () =>
    Effect.gen(function*() {
      let accesses = 0
      const raw = Object.defineProperty({}, "changes", {
        enumerable: true,
        get: () => {
          accesses += 1
          return 3
        }
      })
      const failure = yield* Effect.flip(DurableWriter.affectedRows(raw))

      expect(accesses).toBe(0)
      expect(failure).toMatchObject({ code: "unsupported" })
    }))

  it.effect("turns a throwing affected-row getter into a typed failure", () =>
    Effect.gen(function*() {
      const raw = Object.defineProperty({}, "changes", {
        enumerable: true,
        get: () => {
          throw new Error("getter must not run")
        }
      })
      let effect: Effect.Effect<number, DurableWriter.DatabaseError> | undefined

      expect(() => effect = DurableWriter.affectedRows(raw)).not.toThrow()
      const failure = yield* Effect.flip(effect!)
      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure.code).toBe("unsupported")
    }))

  it.effect("turns a proxy descriptor trap into a typed failure", () =>
    Effect.gen(function*() {
      const raw = new Proxy({}, {
        getOwnPropertyDescriptor: () => {
          throw new Error("descriptor trap failed")
        }
      })
      let effect: Effect.Effect<number, DurableWriter.DatabaseError> | undefined

      expect(() => effect = DurableWriter.affectedRows(raw)).not.toThrow()
      const failure = yield* Effect.flip(effect!)
      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure.code).toBe("unsupported")
    }))

  it.effect("rejects an affected-row count one past Number.MAX_SAFE_INTEGER", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(DurableWriter.affectedRows({ changes: Number.MAX_SAFE_INTEGER + 1 }))
      )

      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure.code).toBe("unsupported")
    }))

  it.effect("rejects NaN as an affected-row count", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(DurableWriter.affectedRows({ changes: Number.NaN }))
      )

      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure.code).toBe("unsupported")
    }))

  it.effect("reports bigint changes when SqlClient.SafeIntegers is enabled", () =>
    Effect.gen(function*() {
      const count = yield* (
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* DurableWriter.DurableWriter
          yield* sql`CREATE TABLE bigint_changes (id INTEGER PRIMARY KEY)`
          yield* sql`INSERT INTO bigint_changes (id) VALUES (1)`
          return yield* writer.write(
            sql`DELETE FROM bigint_changes WHERE id = 1`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows))
          )
        }).pipe(
          Effect.provideService(SqlClient.SafeIntegers, true),
          Effect.provide(TestDatabase.layer)
        )
      )

      expect(count).toBe(1)
    }))

  it.effect("rejects a prototype-inherited affected-row count", () =>
    Effect.gen(function*() {
      const raw = Object.create({ changes: 3 }) as object
      const failure = yield* (Effect.flip(DurableWriter.affectedRows(raw)))

      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure.code).toBe("unsupported")
    }))

  it("normalizes SQLite errors into stable DatabaseError codes", () => {
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_BUSY"))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_CONSTRAINT"))).toMatchObject({ code: "constraint" })
    expect(DurableWriter.fromSqlError(sqliteError("SQLITE_IOERR"))).toMatchObject({ code: "io" })
    expect(
      DurableWriter.fromSqlError(
        new SqlError.SqlError({
          reason: new SqlError.UniqueViolation({ cause: {}, constraint: "unique_key" })
        })
      )
    ).toMatchObject({ code: "constraint" })
    expect(DurableWriter.fromSqlError(unknownSqlError("plain failure"))).toMatchObject({ code: "unknown" })
    expect(DurableWriter.fromSqlError(unknownSqlError({}))).toMatchObject({ code: "unknown" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: 5, message: "disk I/O error" }))).toMatchObject({
      code: "io"
    })
    expect(DurableWriter.fromSqlError(unknownSqlError({ cause: { code: "SQLITE_IOERR_NOMEM" } }))).toMatchObject({
      code: "io"
    })

    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(DurableWriter.fromSqlError(unknownSqlError(cyclic))).toMatchObject({ code: "unknown" })
  })

  it("recognizes only structured transient SQLite write failures", () => {
    expect(WriteRetry.isRetryableWriteError("database is busy")).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError("plain failure"))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: 5, message: "database is locked" })))
      .toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "database is busy" }))).toBe(true)
    expect(
      WriteRetry.isRetryableWriteError(unknownSqlError({ message: "cannot rollback - no transaction is active" }))
    ).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "disk I/O error" }))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "SQLITE_IOERR_FSYNC" }))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ cause: { code: "SQLITE_LOCKED_SHAREDCACHE" } })))
      .toBe(true)

    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(WriteRetry.isRetryableWriteError(unknownSqlError(cyclic))).toBe(false)
  })

  it("keeps busy classification aligned across top-level and nested SQL causes", () => {
    const busyCauses = [
      { message: "database is locked" },
      { message: "database is busy" },
      { message: "cannot rollback - no transaction is active" },
      { message: "could not serialize access" },
      { message: "deadlock detected" },
      { code: "SQLITE_BUSY" },
      { code: "SQLITE_BUSY_SNAPSHOT" },
      { code: "SQLITE_LOCKED" },
      { code: "SQLITE_LOCKED_SHAREDCACHE" },
      { code: "40001" },
      { code: "40P01" },
      { code: "55P03" }
    ]

    for (const busy of busyCauses) {
      for (const cause of [busy, { cause: busy }]) {
        const error = unknownSqlError(cause)
        expect(DurableWriter.fromSqlError(error).code).toBe("busy")
        expect(WriteRetry.isRetryableWriteError(error)).toBe(true)
        expect(WriteRetry.isBusyCause(error)).toBe(true)
      }
    }
  })

  // The two used to be read from different code: `fromSqlError` gave I/O
  // precedence while the retry gate asked only whether SOME busy cause existed,
  // so a disk failure whose chain also mentioned a lock was reported as `io`
  // and replayed anyway. One classifier decides both now, in either nesting
  // order, because the I/O failure is the real fault wherever it sits.
  it.each([
    { label: "an I/O code above a busy cause", cause: { code: "SQLITE_IOERR", cause: { code: "SQLITE_BUSY" } } },
    { label: "a busy code above an I/O cause", cause: { code: "SQLITE_BUSY", cause: { code: "SQLITE_IOERR" } } },
    {
      label: "busy text above I/O text",
      cause: { message: "database is locked", cause: { message: "disk I/O error" } }
    }
  ])("classifies $label as io and never replays it", ({ cause }) => {
    const error = unknownSqlError(cause)

    expect(DurableWriter.fromSqlError(error).code).toBe("io")
    expect(WriteRetry.isRetryableWriteError(error)).toBe(false)
  })

  it("keeps a constraint violation non-transient even when its cause reads like a lock", () => {
    const error = new SqlError.SqlError({
      reason: new SqlError.ConstraintError({ cause: { message: "database is locked" }, message: "runs_pkey" })
    })

    expect(DurableWriter.fromSqlError(error).code).toBe("constraint")
    expect(WriteRetry.isRetryableWriteError(error)).toBe(false)
  })

  it.effect("does not replay a write whose I/O failure carries a busy cause", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const failure = yield* Effect.flip(writer.write(Effect.suspend(() => {
        attempts += 1
        return Effect.fail(unknownSqlError({ code: "SQLITE_IOERR", cause: { code: "SQLITE_BUSY" } }))
      })))

      expect(failure).toMatchObject({ code: "io" })
      expect(attempts).toBe(1)
    }))

  it("keeps nested SQLite I/O causes classified as io and non-retryable", () => {
    const ioCauses = [
      { message: "disk I/O error" },
      { code: "SQLITE_IOERR_FSYNC" }
    ]

    for (const io of ioCauses) {
      for (const cause of [io, { cause: io }]) {
        const error = unknownSqlError(cause)
        expect(DurableWriter.fromSqlError(error).code).toBe("io")
        expect(WriteRetry.isRetryableWriteError(error)).toBe(false)
        expect(WriteRetry.isIoCause(error)).toBe(true)
      }
    }
  })

  // `DurableWriter.make` accepts any SqlClient, so a caller can already supply a
  // Postgres or PGlite client. Classification keyed only off SQLite codes made
  // the retry silently inert there, so a serialization failure surfaced as a
  // hard write error instead of being replayed (issue #78).
  it("recognizes transient Postgres write failures by SQLSTATE", () => {
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "40001" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "40P01" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "55P03" }))).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ cause: { code: "40001" } }))).toBe(true)
    // A serialization failure raised as text by PGlite, which does not always
    // carry a SQLSTATE through the wire-less driver.
    expect(
      WriteRetry.isRetryableWriteError(
        unknownSqlError({ message: "could not serialize access due to concurrent update" })
      )
    ).toBe(true)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ message: "deadlock detected" }))).toBe(true)
    // Not transient: a unique violation must stay a first-writer-wins signal,
    // and 42P01 is a missing relation.
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "23505" }))).toBe(false)
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "42P01" }))).toBe(false)
  })

  it("normalizes transient Postgres failures into the busy code", () => {
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "40001" }))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "40P01" }))).toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ message: "cannot rollback - no transaction is active" })))
      .toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "42P01" }))).toMatchObject({ code: "schema" })
  })

  // A store written by an older schema answers a newer binary's statement with
  // a missing table or column; that is its own category, never replayed.
  it("classifies a missing table or column as schema on either backend", () => {
    for (const cause of [{ code: "42P01" }, { code: "42703" }]) {
      expect(DurableWriter.fromSqlError(unknownSqlError(cause))).toMatchObject({ code: "schema" })
    }
    for (const message of ["no such table: control_plans", "no such column: meta_json"]) {
      expect(DurableWriter.fromSqlError(unknownSqlError(new Error(message)))).toMatchObject({ code: "schema" })
      expect(DurableWriter.fromSqlError(unknownSqlError({ cause: { message } }))).toMatchObject({ code: "schema" })
    }
    expect(WriteRetry.isRetryableWriteError(unknownSqlError({ code: "42703" }))).toBe(false)
    // A busy or I/O cause outranks a schema text quoted beside it.
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "40001", message: "no such table: t" })))
      .toMatchObject({ code: "busy" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "SQLITE_IOERR", message: "no such table: t" })))
      .toMatchObject({ code: "io" })
    expect(DurableWriter.fromSqlError(unknownSqlError({ code: "42601", message: "syntax error" })))
      .toMatchObject({ code: "unknown" })
  })

  it("reads the code a failure carries through wrapping and redacting domain errors", () => {
    expect(DurableWriter.codeOf(unknownSqlError({ code: "42P01" }))).toBe("schema")
    expect(DurableWriter.codeOf({ cause: { cause: unknownSqlError({ code: "42703" }) } })).toBe("schema")
    expect(DurableWriter.codeOf({ cause: new DurableWriter.DatabaseError({ code: "schema" }) })).toBe("schema")
    expect(DurableWriter.codeOf({ cause: new DurableWriter.DatabaseError({ code: "busy" }) })).toBe("busy")
    expect(DurableWriter.codeOf(new Error("no such table: t"))).toBeUndefined()
    expect(DurableWriter.codeOf(undefined)).toBeUndefined()
    expect(DurableWriter.codeOf({ _tag: "@smthrs/database/DatabaseError", code: "invalid" })).toBeUndefined()
  })

  it.effect("classifies a real SQLite statement against a missing table or column as schema", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE present (id INTEGER)`
      const table = yield* Effect.flip(sql`SELECT * FROM absent`)
      const column = yield* Effect.flip(sql`SELECT missing FROM present`)
      expect(DurableWriter.codeOf(table)).toBe("schema")
      expect(DurableWriter.codeOf(column)).toBe("schema")
      expect(DurableWriter.fromSqlError(table).code).toBe("schema")
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("retries a Postgres serialization failure through the same schedule", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return attempts < 3 ? Effect.fail(unknownSqlError({ code: "40001" })) : Effect.succeed("written")
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(yield* program).toBe("written")
      expect(attempts).toBe(3)
    }))

  it.effect("retries transient write errors using TestClock", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return attempts < 3 ? Effect.fail(sqliteError("SQLITE_BUSY")) : Effect.succeed("written")
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(yield* program).toBe("written")
      expect(attempts).toBe(3)
    }))

  it.effect("surfaces busy after a permanently busy write exhausts its retry budget", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.fail(sqliteError("SQLITE_BUSY"))
          })
        ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(TestClock.layer()),
        Random.withSeed(1)
      )

      const failure = yield* program
      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      if (failure instanceof DurableWriter.DatabaseError) {
        expect(failure.code).toBe("busy")
      }
      expect(attempts).toBe(3)
    }))

  it.effect.each([
    0,
    -5,
    1.7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1
  ])(
    "clamps maxAttempts $maxAttempts to one attempt",
    (maxAttempts) =>
      Effect.gen(function*() {
        let attempts = 0
        const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts })
        const program = Effect.gen(function*() {
          const fiber = yield* writer.write(
            Effect.suspend(() => {
              attempts += 1
              return Effect.fail(sqliteError("SQLITE_BUSY"))
            })
          ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* TestClock.adjust("1 second")
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer()))

        const failure = yield* program
        expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
        if (failure instanceof DurableWriter.DatabaseError) {
          expect(failure.code).toBe("busy")
        }
        expect(attempts).toBe(1)
      })
  )

  it.effect("surfaces a SQLite I/O failure without replaying the write body", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 10 })
      const failure = yield* Effect.flip(writer.write(Effect.suspend(() => {
        attempts += 1
        return Effect.fail(sqliteError("SQLITE_IOERR_FSYNC"))
      })))

      expect(failure).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(failure).toMatchObject({ code: "io" })
      expect(attempts).toBe(1)
    }))

  it.effect("caps every exponential retry delay at maxDelayMs under TestClock", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 4, maxDelayMs: 5, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.fail(sqliteError("SQLITE_BUSY"))
          })
        ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(attempts).toBe(1)
        yield* TestClock.adjust("4 millis")
        expect(attempts).toBe(2)
        yield* TestClock.adjust("5 millis")
        expect(attempts).toBe(3)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(TestClock.layer()),
        Random.withSeed(1)
      )

      const exit = yield* program
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("retries retryable driver defects through the same schedule", () =>
    Effect.gen(function*() {
      let attempts = 0
      const defectSql = {
        ...retrySql,
        withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.suspend(() => {
            attempts += 1
            return attempts < 3
              ? Effect.die(rollbackDefect())
              : retrySql.withTransaction(effect)
          })
      } as unknown as SqlClient.SqlClient
      const writer = DurableWriter.make(defectSql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(Effect.succeed("written")).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(yield* program).toBe("written")
      expect(attempts).toBe(3)
    }))

  it.effect("keeps an exhausted retryable driver failure on the defect channel", () =>
    Effect.gen(function*() {
      let attempts = 0
      const defect = rollbackDefect()
      const defectSql = {
        ...retrySql,
        withTransaction: <A, E, R>(_effect: Effect.Effect<A, E, R>) =>
          Effect.suspend(() => {
            attempts += 1
            return Effect.die(defect)
          })
      } as unknown as SqlClient.SqlClient
      const writer = DurableWriter.make(defectSql, publicRetryOptions)
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(Effect.succeed("unreached")).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      const exit = yield* program
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Result.getOrUndefined(Cause.findDefect(exit.cause))).toBe(defect)
      expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true)
      expect(attempts).toBe(3)
    }))

  it.effect("preserves every failure in a mixed cause after retry exhaustion", () =>
    Effect.gen(function*() {
      let attempts = 0
      const mixed = Cause.combine(
        Cause.fail(sqliteError("SQLITE_BUSY")),
        Cause.fail(new Error("application failed"))
      )
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.failCause(mixed)
          })
        ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      const exit = yield* program
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).toContain("application failed")
      expect(rendered).toContain("SQLITE_BUSY")
      expect(attempts).toBe(3)
    }))

  it.effect.each([
    {
      label: "typed I/O before typed busy",
      makeCause: () =>
        Cause.combine(
          Cause.fail(sqliteError("SQLITE_IOERR")),
          Cause.fail(sqliteError("SQLITE_BUSY"))
        )
    },
    {
      label: "typed busy before typed I/O",
      makeCause: () =>
        Cause.combine(
          Cause.fail(sqliteError("SQLITE_BUSY")),
          Cause.fail(sqliteError("SQLITE_IOERR"))
        )
    },
    {
      label: "typed I/O beside a busy defect",
      makeCause: () =>
        Cause.combine(
          Cause.fail(sqliteError("SQLITE_IOERR")),
          Cause.die({ code: "SQLITE_BUSY" })
        )
    },
    {
      label: "raw I/O defect beside typed busy",
      makeCause: () =>
        Cause.combine(
          Cause.die({ code: "SQLITE_IOERR" }),
          Cause.fail(sqliteError("SQLITE_BUSY"))
        )
    }
  ])("does not replay a parallel cause with $label", ({ makeCause }) =>
    Effect.gen(function*() {
      let attempts = 0
      const original = makeCause()
      const program = Effect.gen(function*() {
        const fiber = yield* WriteRetry.withWriteRetry(
          Effect.suspend(() => {
            attempts += 1
            return Effect.failCause(original)
          }),
          { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 }
        ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      const exit = yield* program
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(exit.cause).toBe(original)
      expect(attempts).toBe(1)
    }))

  it.effect.each([
    {
      label: "code getter",
      makeFailure: () =>
        Object.defineProperty({}, "code", {
          get: () => {
            throw new Error("code getter ran")
          }
        })
    },
    {
      label: "message getter",
      makeFailure: () =>
        Object.defineProperty({}, "message", {
          get: () => {
            throw new Error("message getter ran")
          }
        })
    },
    {
      label: "cause getter",
      makeFailure: () =>
        Object.defineProperty({}, "cause", {
          get: () => {
            throw new Error("cause getter ran")
          }
        })
    },
    {
      label: "hostile Proxy traps",
      makeFailure: () =>
        new Proxy({}, {
          getOwnPropertyDescriptor: () => {
            throw new Error("descriptor trap ran")
          },
          has: () => {
            throw new Error("has trap ran")
          }
        })
    }
  ])("keeps a typed failure with a throwing $label on the typed channel", ({ makeFailure }) =>
    Effect.gen(function*() {
      let attempts = 0
      const original = makeFailure()
      const exit = yield* Effect.exit(WriteRetry.withWriteRetry(
        Effect.suspend(() => {
          attempts += 1
          return Effect.fail(original)
        }),
        publicRetryOptions
      ))

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Result.getOrUndefined(Cause.findError(exit.cause)) === original).toBe(true)
      expect(Result.isFailure(Cause.findDefect(exit.cause))).toBe(true)
      expect(attempts).toBe(1)
    }))

  // Order dependence was the defect: the classifier read only the FIRST failure
  // in the cause, so the same parallel pair replayed or did not depending on
  // which effect lost the race first. Both orders must replay, and both halves
  // must survive the exhaustion.
  it.effect.each([
    { first: "busy", label: "the busy failure first" },
    { first: "application", label: "the application failure first" }
  ])("replays a mixed parallel cause with $label", ({ first }) =>
    Effect.gen(function*() {
      let attempts = 0
      const busy = Cause.fail(sqliteError("SQLITE_BUSY"))
      const application = Cause.fail(new Error("application failed"))
      const mixed = first === "busy" ? Cause.combine(busy, application) : Cause.combine(application, busy)
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.failCause(mixed)
          })
        ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      const exit = yield* program
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).toContain("application failed")
      expect(rendered).toContain("SQLITE_BUSY")
      expect(attempts).toBe(3)
    }))

  it.effect("replays a retryable defect that arrives behind an application failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const mixed = Cause.combine(
        Cause.fail(new Error("application failed")),
        Cause.die(rollbackDefect())
      )
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.failCause(mixed)
          })
        ).pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(Exit.isFailure(yield* program)).toBe(true)
      expect(attempts).toBe(3)
    }))

  // The defect channel is read without SQL provenance, so it needs the same
  // I/O exclusion the typed path has: a raw throw that names a disk failure is
  // not replayed just because a lock is mentioned under it.
  it.effect("does not replay a driver defect whose I/O failure carries a busy cause", () =>
    Effect.gen(function*() {
      let attempts = 0
      const defectSql = {
        ...retrySql,
        withTransaction: <A, E, R>(_effect: Effect.Effect<A, E, R>) =>
          Effect.suspend(() => {
            attempts += 1
            return Effect.die({ code: "SQLITE_IOERR", cause: { code: "SQLITE_BUSY" } })
          })
      } as unknown as SqlClient.SqlClient
      const writer = DurableWriter.make(defectSql, publicRetryOptions)

      expect(Exit.isFailure(yield* Effect.exit(writer.write(Effect.succeed("unreached"))))).toBe(true)
      expect(attempts).toBe(1)
    }))

  it.effect("preserves interruption inside a write body without retrying", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      const exit = yield* Effect.exit(writer.write(Effect.suspend(() => {
        attempts += 1
        return Effect.failCause(Cause.interrupt(123))
      })))

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(attempts).toBe(1)
    }))

  it.effect.each([
    "database is locked",
    "database is busy",
    "could not serialize access",
    "deadlock detected",
    "cannot rollback - no transaction is active"
  ])("does not retry an application Error containing %s", (message) =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      yield* Effect.exit(writer.write(Effect.suspend(() => {
        attempts += 1
        return Effect.fail(new Error(`${message} by application policy`))
      })))

      expect(attempts).toBe(1)
    }))

  // The defect channel reads the same provenance the typed channel does. It
  // used to match on text alone, so an application `Effect.die` that merely
  // quoted lock text spent the whole retry budget.
  it.effect.each([
    "database is locked",
    "database is busy",
    "could not serialize access",
    "deadlock detected",
    "cannot rollback - no transaction is active"
  ])("does not retry an application defect containing %s", (message) =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, publicRetryOptions)
      yield* Effect.exit(writer.write(Effect.suspend(() => {
        attempts += 1
        return Effect.die(new Error(`${message} by application policy`))
      })))

      expect(attempts).toBe(1)
    }))

  it("classifies a transient failure through a wrapping domain error's cause chain", () => {
    expect(WriteRetry.isRetryableWriteError({ _tag: "StoreError", cause: sqliteError("SQLITE_BUSY") })).toBe(true)
    expect(WriteRetry.isRetryableWriteError({ _tag: "StoreError", cause: sqliteError("SQLITE_CONSTRAINT") }))
      .toBe(false)
    expect(
      WriteRetry.isRetryableWriteError(
        DurableWriter.fromSqlError(sqliteError("SQLITE_BUSY"))
      )
    ).toBe(true)
  })

  it.each(["busy", "io", "constraint", "schema", "unknown", "unsupported"] as const)(
    "classifies a payload-free DatabaseError with code %s through domain causes",
    (code) => {
      const error = { cause: new DurableWriter.DatabaseError({ code }) }
      expect(WriteRetry.isRetryableWriteError(error)).toBe(code === "busy")
    }
  )

  it("does not treat an untagged busy category or an invalid database code as retry provenance", () => {
    expect(WriteRetry.isRetryableWriteError({ cause: { code: "busy" } })).toBe(false)
    expect(WriteRetry.isRetryableWriteError({ _tag: "@smthrs/database/DatabaseError", code: "invalid" }))
      .toBe(false)
  })

  it.effect.each([false, true])(
    "redacted I/O failures veto retry on either channel (defect=%s)",
    (defect) =>
      Effect.gen(function*() {
        const io = { cause: new DurableWriter.DatabaseError({ code: "io" }) }
        const original = Cause.combine(
          Cause.fail(new DurableWriter.DatabaseError({ code: "busy" })),
          defect ? Cause.die(io) : Cause.fail(io)
        )
        let attempts = 0
        const exit = yield* Effect.exit(WriteRetry.withWriteRetry(
          Effect.suspend(() => {
            attempts += 1
            return Effect.failCause(original)
          }),
          publicRetryOptions
        ))
        expect(attempts).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(exit.cause).toBe(original)
      })
  )

  it.effect("does not retry a nested write; only the outermost transaction replays", () =>
    Effect.gen(function*() {
      let outerBodies = 0
      let innerBodies = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            outerBodies += 1
            return writer.write(
              Effect.suspend(() => {
                innerBodies += 1
                return innerBodies < 3 ? Effect.fail(sqliteError("SQLITE_BUSY")) : Effect.succeed("written")
              })
            )
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(yield* program).toBe("written")
      // Each transient conflict replays the whole outer transaction; the nested
      // write never replays its savepoint alone.
      expect(outerBodies).toBe(3)
      expect(innerBodies).toBe(3)
    }))

  it.effect("replays the outermost transaction when a domain error wraps the transient failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3 })
      const program = Effect.gen(function*() {
        const fiber = yield* writer.write(
          Effect.suspend(() => {
            attempts += 1
            return attempts < 3
              ? Effect.fail({ _tag: "StoreError", cause: sqliteError("SQLITE_BUSY") } as const)
              : Effect.succeed("written")
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 second")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))

      expect(yield* program).toBe("written")
      expect(attempts).toBe(3)
    }))

  it.effect("does not retry constraint failures", () =>
    Effect.gen(function*() {
      let attempts = 0
      const writer = DurableWriter.make(retrySql, { maxAttempts: 3 })
      const exit = yield* Effect.exit(
        writer.write(
          Effect.suspend(() => {
            attempts += 1
            return Effect.fail(sqliteError("SQLITE_CONSTRAINT"))
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(attempts).toBe(1)
    }))

  it.effect("layerNoop fails writes with unsupported", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          const writer = yield* DurableWriter.DurableWriter
          return yield* writer.write(Effect.void)
        }).pipe(Effect.provide(DurableWriter.layerNoop))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.findError(exit.cause)
        expect(Result.isSuccess(error)).toBe(true)
        if (Result.isSuccess(error)) {
          expect(error.success.code).toBe("unsupported")
        }
      }
    }))

  it.effect("makeNoop fails writes with unsupported", () =>
    Effect.gen(function*() {
      const writer = DurableWriter.makeNoop()
      const exit = yield* Effect.exit(writer.write(Effect.void))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const found = Cause.findError(exit.cause)
        expect(Result.isSuccess(found) && found.success instanceof DurableWriter.DatabaseError).toBe(true)
        if (Result.isSuccess(found) && found.success instanceof DurableWriter.DatabaseError) {
          expect(found.success.code).toBe("unsupported")
        }
      }
    }))
})
