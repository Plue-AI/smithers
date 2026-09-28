/** Node SQLite driver. Domain stores depend on Effect SqlClient, not this module.
 * @since 1.0.0
 */

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { type Duration, Effect, Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as PostgresSelection from "../internal/PostgresSelection.ts"
import * as ReleasePolicy from "../internal/ReleasePolicy.ts"
import * as SqliteOpen from "../internal/SqliteOpen.ts"

export { isUnsupportedDatabase, UnsupportedDatabase, UnsupportedDatabaseCode } from "../internal/SqliteOpen.ts"

/** Connection settings; write policy is supplied separately by DurableWriter.
 * @since 1.0.0
 * @category models
 */
export interface NodeDatabaseOptions {
  readonly filename: string
  /** Creation mode for new plain-path files, subject to umask. Defaults to 0o600. */
  readonly mode?: number | undefined
  /** Synchronous lock wait. Defaults to zero; overrides sqlite.busyTimeout when supplied. */
  readonly busyTimeout?: Duration.Input | undefined
  readonly sqlite?: Omit<SqliteClient.SqliteClientConfig, "filename"> | undefined
}

const readTableNames = (filename: string): ReadonlyArray<string> | undefined => {
  let db: DatabaseSync | undefined
  try {
    if (!filename.startsWith("file:") && !statSync(filename).isFile()) return undefined
    db = new DatabaseSync(filename, { readOnly: true })
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => String((row as { readonly name: unknown }).name))
  } catch (error) {
    if (SqliteOpen.isLockedError(error)) throw error
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Creates the file as part of building the client, so it happens after the
 * guard has inspected an existing database and never for an open the guard or
 * the runtime check refused.
 */
const client = (options: NodeDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    SqliteOpen.createDatabaseFile(options.filename, !options.sqlite?.readonly, options.mode)
    return SqliteClient.layer({
      ...options.sqlite,
      busyTimeout: options.busyTimeout ?? options.sqlite?.busyTimeout ?? 0,
      filename: options.filename
    })
  }))

/** Provides the Node SQLite client with the shared schema guard and open retries.
 * @since 1.0.0
 * @category layers
 */
export const layer = (options: NodeDatabaseOptions): Layer.Layer<SqlClient.SqlClient> =>
  Layer.unwrap(Effect.sync(() => {
    if (process.versions.bun !== undefined) {
      throw new SqliteOpen.UnsupportedDatabase({
        code: "unsupported_runtime",
        message:
          `Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js ${ReleasePolicy.nodeFloor}`
      })
    }
    const postgres = PostgresSelection.layer(options.filename)
    if (postgres !== undefined) return postgres
    return SqliteOpen.layer(
      options.filename,
      readTableNames,
      client(options),
      options.sqlite?.spanAttributes
    )
  }))
