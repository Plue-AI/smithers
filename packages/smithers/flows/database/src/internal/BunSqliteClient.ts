/// <reference types="bun" />
/**
 * Bun SQLite client whose raw writes report affected rows.
 *
 * Adapted from `@effect/sql-sqlite-bun@4.0.0-rc.115` `SqliteClient.make`. That
 * driver runs every statement through `.all()`, so `.raw` on INSERT, UPDATE and
 * DELETE yields `[]` and `DurableWriter.affectedRows` fails `unsupported`
 * (issue #2419). Like `@effect/sql-sqlite-node`, a statement without result
 * columns runs through `.run()` here and `.raw` returns
 * `{ changes, lastInsertRowid }`. Delete this module once the upstream driver
 * does the same. `BunSqliteClient.test.ts` measures it over a `bun:sqlite` shim;
 * agent/memory `NativeBunAffectedRows.test.ts` runs it under real Bun.
 *
 * @since 1.0.0
 */

import type { SqliteClientConfig } from "@effect/sql-sqlite-bun/SqliteClient"
import { Database } from "bun:sqlite"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"

const MAX_BUSY_TIMEOUT = 2_147_483_647

const make = (
  options: SqliteClientConfig
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const readonly = options.readonly === true
    const db = new Database(options.filename, {
      readonly,
      readwrite: readonly ? false : options.readwrite ?? true,
      create: readonly ? false : options.create ?? true
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
    const busyTimeout = Math.min(
      MAX_BUSY_TIMEOUT,
      Math.max(0, Math.round(Duration.toMillis(options.busyTimeout ?? Duration.seconds(5))))
    )
    db.run(`PRAGMA busy_timeout = ${busyTimeout};`)
    if (options.disableWAL !== true && !readonly) db.run("PRAGMA journal_mode = WAL;")

    const execute = <A>(
      operation: string,
      sql: string,
      params: ReadonlyArray<unknown>,
      run: (statement: ReturnType<Database["query"]>, params: Array<any>) => A
    ) =>
      Effect.withFiber<A, SqlError>((fiber) => {
        try {
          const statement = db.query(sql)
          // @ts-expect-error bun-types lacks safeIntegers; fixed in oven-sh/bun#26627.
          statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
          return Effect.succeed(run(statement, params as Array<any>))
        } catch (cause) {
          return Effect.fail(
            new SqlError({ reason: classifySqliteError(cause, { message: "Failed to execute statement", operation }) })
          )
        }
      })

    const rows = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("execute", sql, params, (statement, values) => statement.all(...values) as Array<any>)
    const values = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("executeValues", sql, params, (statement, values) => (statement.values(...values) ?? []) as Array<any>)
    const raw = (sql: string, params: ReadonlyArray<unknown> = []) =>
      execute("execute", sql, params, (statement, values): unknown => {
        if (statement.columnNames.length > 0) return statement.all(...values)
        const result = statement.run(...values)
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      })

    const connection: Connection = {
      execute: (sql, params, transformRows) =>
        transformRows ? Effect.map(rows(sql, params), transformRows) : rows(sql, params),
      executeRaw: raw,
      executeValues: values,
      executeValuesUnprepared: values,
      executeUnprepared: (sql, params, transformRows) => connection.execute(sql, params, transformRows),
      executeStream: () => Stream.die("executeStream not implemented")
    }

    const semaphore = yield* Semaphore.make(1)
    return yield* Client.make({
      acquirer: semaphore.withPermits(1)(Effect.succeed(connection)),
      compiler: Statement.makeCompilerSqlite(options.transformQueryNames),
      transactionAcquirer: Effect.uninterruptibleMask((restore) => {
        const scope = Context.getUnsafe(Fiber.getCurrent()!.context, Scope.Scope)
        return Effect.as(
          Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
          connection
        )
      }),
      beginTransaction: readonly ? "BEGIN" : "BEGIN IMMEDIATE",
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        ["db.system.name", "sqlite"]
      ],
      transformRows: options.transformResultNames
        ? Statement.defaultTransforms(options.transformResultNames).array
        : undefined
    })
  })

/** Provides the Bun `SqlClient`; `.raw` on a write returns `{ changes, lastInsertRowid }`.
 * @since 1.0.0
 * @category layers
 */
export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer))
