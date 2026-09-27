/**
 * Durable generations distinguish histories that reuse journal sequences.
 *
 * @since 1.0.0-rc.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Installs the generation table idempotently. Both the SQL journal and time
 * travel initialize it, including databases whose migration ladder already
 * passed the journal's reserved block.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export const initialize = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS flows_journal_generations (
      run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) > 0),
      generation ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`generation`)
  } AND generation > 0 AND generation <= 9007199254740991),
      after_seq ${Dialect.integer(sql)} NOT NULL CHECK (${
    Dialect.isInteger(sql, sql`after_seq`)
  } AND after_seq >= -1 AND after_seq <= 9007199254740991)
    )
  `
})

const journals = new WeakMap<SqlClient.SqlClient, Set<(runIds: ReadonlyArray<string>) => void>>()

/**
 * Registers a live journal's cache invalidation until its scope closes.
 * Multiple journals over the same SQL client must observe the same rewind.
 *
 * @category lifecycle
 * @since 1.0.0-rc.0
 */
export const onTruncate = (forget: (runIds: ReadonlyArray<string>) => void) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    let listeners = journals.get(sql)
    if (listeners === undefined) {
      listeners = new Set()
      journals.set(sql, listeners)
    }
    const registered = listeners
    yield* Effect.acquireRelease(
      Effect.sync(() => registered.add(forget)),
      () =>
        Effect.sync(() => {
          registered.delete(forget)
        })
    )
  })

/**
 * Forgets cached identities and allocation floors after a committed truncation.
 * The rewinder must quiesce producers and flush pending admissions first.
 * Database rows remain authoritative; this operation changes no durable data.
 *
 * @category lifecycle
 * @since 1.0.0-rc.0
 */
export const forget = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.sync(() => {
      for (const invalidate of journals.get(sql) ?? []) invalidate(runIds)
    })
  })
