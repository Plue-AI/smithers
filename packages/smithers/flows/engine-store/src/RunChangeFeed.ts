/**
 * Coalesced execution catch-up with permanent deletion evidence.
 *
 * @since 1.0.0
 */

import { RunStoreError } from "@smthrs/run-store/RunStore"
import { Context, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Position } from "./ExecutionSnapshot.ts"
import * as Read from "./internal/ExecutionSnapshotRead.ts"

/**
 * A live-row change or retained tombstone.
 *
 * @category models
 * @since 1.0.0
 */
export interface Change extends Position {
  readonly runId: string
  readonly deleted: boolean
}
/**
 * One catch-up page at an engine watermark.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page extends Position {
  readonly changes: ReadonlyArray<Change>
  /** Resume here, including across gaps from coalesced changes. */
  readonly nextRevision: number
  readonly hasMore: boolean
}
/**
 * Bounded state-feed operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly current: Effect.Effect<Position, RunStoreError>
  readonly changesSince: (options: Position & { readonly limit: number }) => Effect.Effect<Page, RunStoreError>
}
/**
 * Durable change-feed service.
 *
 * @category services
 * @since 1.0.0
 */
export class RunChangeFeed extends Context.Service<RunChangeFeed, Service>()("@smthrs/engine-store/RunChangeFeed") {}
/**
 * Maximum change-feed page size.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumPageSize = 1000
const Options = Schema.Struct({
  source: Read.Source,
  revision: Read.Natural,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumPageSize }))
})
const ChangeRow = Schema.Struct({ run_id: Read.Identifier, revision: Read.Natural, deleted: Schema.Literals([0, 1]) })

/**
 * Constructs the feed without polling or retention timers.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return {
      current: Read.boundary("RunChangeFeed.current", Read.position(sql)),
      changesSince: (options) =>
        Read.boundary(
          "RunChangeFeed.changesSince",
          Effect.gen(function*() {
            const input = yield* Read.decode(Options, options)
            return yield* Read.transaction(
              sql,
              Effect.gen(function*() {
                const at = yield* Read.position(sql)
                if (input.source !== at.source || input.revision > at.revision) {
                  return yield* Effect.fail(
                    new RunStoreError({
                      method: "RunChangeFeed.changesSince",
                      code: "invalid_run",
                      message: "change cursor requires an explicit source rebuild",
                      cause: { requested: input, observed: at }
                    })
                  )
                }
                const rows = yield* sql`SELECT run_id, revision, deleted FROM flows_run_changes
          WHERE revision > ${input.revision} AND revision <= ${at.revision}
          ORDER BY revision LIMIT ${input.limit + 1}`
                const decoded = yield* Effect.forEach(rows, (row) => Read.decode(ChangeRow, row))
                const changes = decoded.slice(0, input.limit).map((row) => ({
                  runId: row.run_id,
                  source: at.source,
                  revision: row.revision,
                  deleted: row.deleted === 1
                }))
                const hasMore = decoded.length > input.limit
                return {
                  ...at,
                  changes,
                  hasMore,
                  nextRevision: hasMore ? changes[changes.length - 1]!.revision : at.revision
                }
              })
            )
          })
        )
    }
  })
/**
 * Provides the SQL feed.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<RunChangeFeed, never, SqlClient.SqlClient> = Layer.effect(RunChangeFeed)(make())
