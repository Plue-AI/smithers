/** PostgreSQL adapter for the same injected SQL and durable-write services.
 * @since 1.0.0
 */

import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgTypes from "@effect/sql-pg/PgTypes"
import { Effect, Layer, Redacted, Result, Scope } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Compiler } from "effect/unstable/sql/Statement"
import * as ReadOnly from "../internal/ReadOnly.ts"
import { UnsupportedDatabase } from "../internal/SqliteOpen.ts"

/**
 * PostgreSQL connection and schema configuration.
 *
 * @category models
 * @since 1.0.0
 */
export interface PostgresDatabaseOptions {
  readonly url: string
  readonly schema?: string | undefined
  readonly postgres?: Omit<PgClient.PgPoolConfig, "url" | "types"> | undefined
  /**
   * Reads an existing schema only: no schema creation, no writer lock, and
   * every session and transaction is `READ ONLY`.
   */
  readonly readOnly?: boolean | undefined
}

/** Provides PostgreSQL with serialized transactions and exact safe-number reads.
 * A dedicated schema keeps flow state separate from backend product tables.
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: PostgresDatabaseOptions): Layer.Layer<SqlClient.SqlClient> => {
  const schema = options.schema ?? "smithers_flows"
  if (schema.length === 0 || schema.includes("\0") || new TextEncoder().encode(schema).length > 63) {
    throw new UnsupportedDatabase({
      code: "postgres_schema_invalid",
      message: "PostgreSQL schema must contain 1 to 63 UTF-8 bytes and no NUL"
    })
  }
  const readOnly = options.readOnly === true
  const types = PgTypes.makeRegistry()
  for (const oid of [PgTypes.OID.int8, PgTypes.OID.numeric]) {
    types.register(oid, {
      encode: (value: unknown) =>
        PgTypes.encode(oid === PgTypes.OID.numeric ? String(value) : BigInt(value as number), oid),
      decode: (bytes) =>
        Result.flatMap(PgTypes.decode(bytes, oid, 1), (value) => {
          const number = Number(value)
          return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER
            ? Result.succeed(number)
            : Result.fail(new PgTypes.CodecError({ message: "Stored SQL number exceeds the safe numeric range" }))
        })
    })
  }
  return Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const pg = yield* PgClient.make({ ...options.postgres, url: Redacted.make(options.url), types })
      if (!readOnly) {
        yield* pg.withTransaction(Effect.gen(function*() {
          yield* pg`SELECT pg_advisory_xact_lock(hashtextextended(${schema}, 2099))`
          yield* pg`CREATE SCHEMA IF NOT EXISTS ${pg(schema)}`
        }))
      }
      const baseCompiler = PgClient.makeCompiler()
      const compiler: Compiler = {
        dialect: "pg",
        withoutTransform: baseCompiler,
        compile: (statement, withoutTransform) => {
          const [query, parameters] = baseCompiler.compile(statement, withoutTransform)
          // The native driver infers unsafe integral numbers as float8, whose
          // numeric cast rounds to 15 digits and can evade a safe-integer CHECK.
          return [
            query,
            parameters.map((value) =>
              typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
                ? PgTypes.numeric(String(value)) :
                value
            )
          ]
        }
      }
      Object.defineProperty(compiler, "withoutTransform", { value: compiler })
      const sql = yield* SqlClient.make({
        acquirer: pg.reserve.pipe(Effect.tap((conn) =>
          conn.executeUnprepared(
            `SET search_path TO "${schema.replaceAll("\"", "\"\"")}"`,
            [],
            undefined
          ).pipe(
            Effect.andThen(
              readOnly
                ? conn.executeUnprepared("SET default_transaction_read_only = on", [], undefined)
                : Effect.void
            )
          )
        )),
        compiler,
        spanAttributes: [["db.system.name", "postgresql"]]
      })
      // A transaction-scoped lock preserves SQLite's one-writer semantics across
      // processes. READ COMMITTED takes each snapshot after the lock is acquired.
      const withTransaction = SqlClient.makeWithTransaction({
        transactionService: sql.transactionService,
        spanAttributes: [["db.system.name", "postgresql"]],
        acquireConnection: Effect.gen(function*() {
          const reservation = yield* Scope.make()
          const conn = yield* Scope.provide(sql.reserve, reservation).pipe(
            Effect.onExit((exit) => exit._tag === "Failure" ? Scope.close(reservation, exit) : Effect.void)
          )
          return [reservation, conn] as const
        }),
        // A reader needs one snapshot and no writer lock.
        begin: (conn) =>
          (readOnly
            ? conn.executeUnprepared("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", [], undefined)
            : conn.executeUnprepared("BEGIN ISOLATION LEVEL READ COMMITTED", [], undefined).pipe(
              Effect.andThen(conn.executeUnprepared(
                "SELECT pg_advisory_xact_lock(hashtextextended(current_schema(), 2099))",
                [],
                undefined
              ))
            )).pipe(
              Effect.onError(() => conn.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.orDie))
            ),
        savepoint: (conn, id) => conn.executeUnprepared(`SAVEPOINT effect_sql_${id}`, [], undefined),
        commit: (conn) =>
          conn.executeUnprepared("COMMIT", [], undefined).pipe(
            Effect.onError(() => conn.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.orDie))
          ),
        rollback: (conn) => conn.executeUnprepared("ROLLBACK", [], undefined),
        rollbackSavepoint: (conn, id) => conn.executeUnprepared(`ROLLBACK TO SAVEPOINT effect_sql_${id}`, [], undefined)
      })
      Object.assign(sql, { withTransaction })
      if (readOnly) ReadOnly.mark(sql)
      return sql
    })
  ).pipe(Layer.provide(Reactivity.layer), Layer.orDie)
}
