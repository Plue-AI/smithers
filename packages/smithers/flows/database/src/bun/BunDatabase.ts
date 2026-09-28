/// <reference types="bun" />
/** Bun SQLite driver using the same SQL, migration and write contracts as Node.
 * @since 1.0.0
 */

import type * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Database } from "bun:sqlite"
import { Effect, Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { statSync } from "node:fs"
import * as BunSqliteClient from "../internal/BunSqliteClient.ts"
import * as PostgresSelection from "../internal/PostgresSelection.ts"
import * as SqliteOpen from "../internal/SqliteOpen.ts"

export { isUnsupportedDatabase, UnsupportedDatabase, UnsupportedDatabaseCode } from "../internal/SqliteOpen.ts"

/** Connection settings; migrations and DurableWriter are composed above the driver.
 * @since 1.0.0
 * @category models
 */
export interface BunDatabaseOptions {
  readonly filename: string
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

const readTableNames = (filename: string): ReadonlyArray<string> | undefined => {
  let db: Database | undefined
  try {
    if (!filename.startsWith("file:") && !statSync(filename).isFile()) return undefined
    db = new Database(filename, { readonly: true, create: false })
    return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  } catch (error) {
    if (SqliteOpen.isLockedError(error)) throw error
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Creates the file after the guard has inspected an existing database, with
 * the same owner-only default as NodeDatabase. Bun's driver would otherwise
 * create it, and its sidecars, under the process umask.
 */
const client = (options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    const sqlite = options.sqlite
    SqliteOpen.createDatabaseFile(
      options.filename,
      sqlite?.readonly !== true && sqlite?.readwrite !== false && sqlite?.create !== false
    )
    return BunSqliteClient.layer({ ...sqlite, filename: options.filename })
  }))

/** Provides a scoped Bun SQL client; no Node subprocess or secondary ledger.
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: BunDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  PostgresSelection.layer(options.filename) ?? SqliteOpen.layer(
    options.filename,
    readTableNames,
    client(options),
    options.sqlite?.spanAttributes
  )
